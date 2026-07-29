const st = require("../api/servicetitan");
const ghl = require("../api/gohighlevel");
const { getDb } = require("../db/index");

// ── Dedupe guard ──────────────────────────────────────────────────────────────
// The daily 6am cron re-scans an overlapping 2-day window, so without this the
// same (job, new-appointment) pair gets enrolled in the GHL workflow and given
// a pipeline opportunity 2-3 times. Track processed pairs so each is handled once.
function ensureReturnVisitTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS processed_return_visits (
      key            TEXT PRIMARY KEY,
      job_id         TEXT,
      appointment_id TEXT,
      processed_at   TEXT
    )
  `);
}
function rvKey(jobId, apptId) {
  return `${jobId}:${apptId}`;
}
function isReturnVisitProcessed(jobId, apptId) {
  ensureReturnVisitTable();
  return !!getDb()
    .prepare("SELECT 1 FROM processed_return_visits WHERE key = ?")
    .get(rvKey(jobId, apptId));
}
function markReturnVisitProcessed(jobId, apptId) {
  ensureReturnVisitTable();
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO processed_return_visits (key, job_id, appointment_id, processed_at) VALUES (?, ?, ?, ?)"
    )
    .run(rvKey(jobId, apptId), String(jobId), String(apptId), new Date().toISOString());
}

/**
 * Called when a new appointment is created on a job that already has appointments.
 * This means a return visit has been scheduled.
 *
 * Flow:
 * 1. Get the job and all its appointments
 * 2. Identify the original technician (first appointment)
 * 3. Find or create the customer in GHL
 * 4. Tag them as "Return Visit"
 * 5. Trigger the GHL return visit workflow
 * 6. Create/update a pipeline opportunity
 * 7. Add a note with job details
 */
async function handleReturnVisit(jobId, newAppointmentId) {
  console.log(`[ReturnVisit] Processing job ${jobId}, new appt ${newAppointmentId}`);

  // Skip if we've already enrolled this exact (job, appointment) pair — stops
  // the overlapping daily cron from re-triggering the workflow / duplicating
  // the opportunity for the same return visit.
  if (isReturnVisitProcessed(jobId, newAppointmentId)) {
    console.log(`[ReturnVisit] Job ${jobId} appt ${newAppointmentId} already processed — skipping`);
    return { skipped: true, reason: "Already processed" };
  }

  try {
    // 1. Get job details
    const job = await st.getJob(jobId);
    const appointments = await st.getJobAppointments(jobId);

    if (appointments.length <= 1) {
      console.log(`[ReturnVisit] Job ${jobId} only has 1 appointment — not a return visit`);
      return { skipped: true, reason: "Only one appointment" };
    }

    // 2. Sort appointments to find the original tech
    const sorted = [...appointments].sort((a, b) => new Date(a.start) - new Date(b.start));
    const originalAppt = sorted[0];
    const originalTech = originalAppt?.technician;
    const newAppt = appointments.find((a) => a.id === newAppointmentId) || sorted[sorted.length - 1];

    // 3. Get customer info from ServiceTitan
    if (!job.customer?.id) {
      console.log(`[ReturnVisit] Job ${jobId} has no customer — skipping`);
      return { skipped: true, reason: "No customer on job" };
    }

    const customer = await st.getCustomer(job.customer.id);
    const customerName = customer?.name || job.customer?.name || "";
    const customerPhone = customer?.contacts?.find((c) => c.type === "Phone")?.value;
    const customerEmail = customer?.contacts?.find((c) => c.type === "Email")?.value;

    if (!customerPhone && !customerEmail) {
      console.log(`[ReturnVisit] Job ${jobId} customer has no phone or email — skipping`);
      return { skipped: true, reason: "No contact info for customer" };
    }

    const [firstName, ...lastParts] = customerName.split(" ");
    const lastName = lastParts.join(" ");

    // 4. Create or update GHL contact
    const { contact, created } = await ghl.createOrUpdateContact({
      firstName,
      lastName,
      phone: customerPhone,
      email: customerEmail,
      customFields: {
        servicetitan_customer_id: String(job.customer?.id || ""),
        servicetitan_job_id: String(jobId),
        original_technician: originalTech?.name || "Unknown",
        return_visit_count: String(sorted.length - 1),
        last_job_type: job.type?.name || "",
        last_job_date: originalAppt?.start?.split("T")[0] || "",
      },
    });

    console.log(`[ReturnVisit] Contact ${created ? "created" : "updated"}: ${contact.id}`);

    // 5. Tag as Return Visit
    const tags = ["Return Visit"];
    if (originalTech?.name) tags.push(`Tech: ${originalTech.name}`);
    await ghl.addTagToContact(contact.id, tags);

    // 6. Trigger workflow
    await ghl.triggerWorkflow(contact.id, process.env.GHL_RETURN_VISIT_WORKFLOW_ID);

    // 7. Create pipeline opportunity
    await ghl.createOrUpdateOpportunity({
      contactId: contact.id,
      name: `Return Visit — ${customerName} (Job #${jobId})`,
      pipelineId: process.env.GHL_PIPELINE_ID,
      stageId: process.env.GHL_RETURN_VISIT_STAGE_ID,
      monetaryValue: job.total || 0,
    });

    // 8. Add note
    const noteBody = `
🔁 RETURN VISIT DETECTED via ServiceTitan

Job ID: ${jobId}
Customer: ${customerName}
Job Type: ${job.type?.name || "N/A"}
Original Technician: ${originalTech?.name || "Unknown"}
Original Appointment: ${originalAppt?.start?.split("T")[0] || "N/A"}
New Appointment Scheduled: ${newAppt?.start?.split("T")[0] || "N/A"}
Total Appointments on This Job: ${appointments.length}
Job Total: $${job.total || 0}

This contact was automatically flagged and enrolled in the Return Visit workflow.
    `.trim();

    await ghl.addNoteToContact(contact.id, noteBody);

    // Record success so re-scans skip this pair.
    markReturnVisitProcessed(jobId, newAppointmentId);

    console.log(`[ReturnVisit] Successfully processed return visit for job ${jobId}`);

    return {
      success: true,
      jobId,
      customerName,
      originalTech: originalTech?.name,
      appointmentCount: appointments.length,
      ghlContactId: contact.id,
    };
  } catch (err) {
    console.error(`[ReturnVisit] Error processing job ${jobId}:`, err.response?.data || err.message);
    throw err;
  }
}

/**
 * Manually scan the last N days for return visit jobs and sync them to GHL.
 * Useful for backfilling or running on a schedule.
 */
async function syncReturnVisitsForDateRange(startDate, endDate) {
  console.log(`[Sync] Scanning for return visits: ${startDate} → ${endDate}`);

  const returnVisitJobs = await st.findReturnVisitJobs(startDate, endDate);
  console.log(`[Sync] Found ${returnVisitJobs.length} return visit jobs`);

  const results = [];
  for (const { job, appointments } of returnVisitJobs) {
    try {
      const lastAppt = appointments.sort((a, b) => new Date(b.start) - new Date(a.start))[0];
      const result = await handleReturnVisit(job.id, lastAppt.id);
      results.push(result);
    } catch (err) {
      results.push({ jobId: job.id, error: err.message });
    }
  }

  return results;
}

module.exports = { handleReturnVisit, syncReturnVisitsForDateRange };
