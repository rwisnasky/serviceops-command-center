const axios = require("axios");
const { getAccessToken } = require("../api/servicetitan");
const st = require("../api/servicetitan");
const ghl = require("../api/gohighlevel");
const { isHappyReviewProcessed, markHappyReviewProcessed } = require("../db/index");

const HAPPY_REVIEW_FORM_ID = 1406;

// Holds the last submission returned by previewLatestSubmission so "Post to GHL"
// can process exactly what was previewed without re-fetching
let lastPreviewedSubmission = null;

// ── ServiceTitan Form Submissions ──────────────────────────────────────────────

async function getFormSubmissions({ formId, submittedOnOrAfter, submittedOnOrBefore, page = 1, pageSize = 50 } = {}) {
  const token = await getAccessToken();
  const tenantId = process.env.ST_TENANT_ID;

  // ST API uses "formIds" (plural, comma-separated) and "submittedBefore" (not submittedOnOrBefore)
  const params = { page, pageSize };
  if (formId) params.formIds = formId;
  if (submittedOnOrAfter) params.submittedOnOrAfter = submittedOnOrAfter;
  if (submittedOnOrBefore) params.submittedBefore = submittedOnOrBefore;

  const res = await axios.get(
    `https://api.servicetitan.io/forms/v2/tenant/${tenantId}/submissions`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "ST-App-Key": process.env.ST_APP_KEY,
      },
      params,
    }
  );
  return res.data;
}

async function getRecentHappyReviewSubmissions(hours = 1) {
  const since = new Date();
  since.setHours(since.getHours() - hours);
  return getRecentHappyReviewSubmissionsSince(since.toISOString());
}

/**
 * Cursor-based fetch: pull every Happy Review submission with
 * submittedOn >= sinceIso. Used by the forms poll service.
 */
async function getRecentHappyReviewSubmissionsSince(sinceIso) {
  let allSubmissions = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const data = await getFormSubmissions({
      formId: HAPPY_REVIEW_FORM_ID,
      submittedOnOrAfter: sinceIso,
      page,
      pageSize: 50,
    });
    // Double-check: only keep submissions from the Happy Review form
    const page_results = (data.data || []).filter(s => s.formId === HAPPY_REVIEW_FORM_ID);
    allSubmissions = allSubmissions.concat(page_results);
    hasMore = data.hasMore || false;
    page++;
  }

  return allSubmissions;
}

// ── Extract form units by index ────────────────────────────────────────────────
// Form 1406 unit mapping:
//   units[0] = Customer Name
//   units[1] = Job ID
//   units[2] = Email
//   units[3] = Phone
//   units[4] = Technician

function unitValue(submission, index) {
  return (submission.units?.[index]?.value || "").trim();
}

// Normalize casing: "JOHN DOE" → "John Doe"
function toTitleCase(str) {
  return str.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// ── Central enrichment — gathers all fields from form + ST lookups ────────────
/**
 * Given a raw form submission, resolves all data fields needed for GHL.
 * Returns a flat `fields` object used by both preview and processSubmission.
 * No GHL writes happen here.
 */
async function enrichSubmission(submission) {
  // ── Pull raw values from form units ──────────────────────────────────────
  const rawName    = unitValue(submission, 0);
  const jobNumber  = unitValue(submission, 1);
  const email      = unitValue(submission, 2).toLowerCase();
  const phone      = unitValue(submission, 3);
  const techName   = toTitleCase(unitValue(submission, 4));

  const fullName   = toTitleCase(rawName) || "";
  const nameParts  = fullName.split(" ");
  const firstName  = nameParts[0] || "";
  const lastName   = nameParts.slice(1).join(" ") || "";

  // ── ServiceTitan: job lookup ──────────────────────────────────────────────
  let job = null, jobError = null;
  if (jobNumber) {
    try { job = await st.getJobByNumber(jobNumber); }
    catch (err) { jobError = err.message; }
  }

  // ── ServiceTitan: invoice lookup ──────────────────────────────────────────
  // ── Customer ID + location ID come directly from the job object
  // Job response has flat fields: customerId (int64) and locationId (int64)
  const customerId    = String(job?.customerId || submission.owners?.[0]?.id || "");
  const jobInternalId = job?.id ? String(job.id) : null;
  const jobLocationId = job?.locationId ? String(job.locationId) : null;

  // ── Invoice lookup: use internal jobId first (most reliable), fallback to jobNumber
  let invoice = null, invoiceError = null;
  if (jobInternalId || jobNumber) {
    try {
      const invoices = await st.getInvoicesForJob(jobNumber, jobInternalId);
      invoice = invoices?.[0] || null;
    } catch (err) { invoiceError = err.message; }
  }

  // Invoice summary: use the top-level summary field (HTML), strip tags for plain text
  let invoiceSummary = null;
  if (invoice?.summary) {
    invoiceSummary = invoice.summary.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null;
  }

  // One-line summary: use job.summary if available, fallback to tech name
  const jobSummary = job?.summary ||
    (techName ? `Tech: ${techName}` : null) || null;

  // ── Location address: fetch directly by location ID from the job object
  let streetAddress = null, city = null, state = null, locationId = null;

  if (jobLocationId) {
    try {
      const loc = await st.getLocationById(jobLocationId);
      if (loc) {
        locationId    = String(loc.id || jobLocationId);
        const addr    = loc.address;
        if (addr) {
          streetAddress = toTitleCase(addr.street || addr.streetAddress || "");
          city          = toTitleCase(addr.city || "");
          state         = (addr.state || addr.stateCode || "").toUpperCase();
        }
      }
    } catch (err) {
      console.warn(`[HappyReview] Location lookup failed for location ID ${jobLocationId}:`, err.message);
    }
  }

  // Fallback: search by customer ID if job had no location
  if (!locationId && customerId) {
    try {
      const locations = await st.getLocationsByCustomer(customerId);
      const loc = locations[0];
      if (loc) {
        locationId    = String(loc.id || "");
        const addr    = loc.address;
        if (addr) {
          streetAddress = toTitleCase(addr.street || addr.streetAddress || "");
          city          = toTitleCase(addr.city || "");
          state         = (addr.state || addr.stateCode || "").toUpperCase();
        }
      }
    } catch (err) {
      console.warn(`[HappyReview] Fallback location lookup failed for customer ${customerId}:`, err.message);
    }
  }

  return {
    // Form-sourced fields
    jobNumber:       jobNumber || null,
    firstName,
    lastName,
    fullName,
    email:           email || null,
    phone:           phone || null,
    installTech:     techName || null,

    // ST-enriched fields
    invoiceId:       invoice?.id ? String(invoice.id) : null,
    invoiceTotal:    invoice?.total != null ? `$${invoice.total}` : null,
    invoiceSummary:  invoiceSummary || null,
    jobSummary:  jobSummary || null,
    customerId:      customerId || null,
    locationId:      locationId || null,
    streetAddress:   streetAddress || null,
    city:            city || null,
    state:           state || null,

    // Lookup meta (for preview diagnostics)
    _jobFound:       !!job,
    _jobType:        job?.type?.name || null,
    _jobInternalId:  job?.id ? String(job.id) : null,
    _invoiceFound:   !!invoice,
    _jobError:       jobError,
    _invoiceError:   invoiceError,
  };
}

// ── Process a single submission → GHL ─────────────────────────────────────────

async function processSubmission(submission) {
  console.log(`[HappyReview] Processing submission ${submission.id}`);

  const f = await enrichSubmission(submission);

  console.log(`[HappyReview] ${f.fullName} | job: ${f.jobNumber} | phone: ${f.phone || "none"} | email: ${f.email || "none"} | tech: ${f.installTech}`);

  // POST to GHL inbound webhook — handles contact create/update + workflow trigger in one call
  const webhookUrl = process.env.GHL_HAPPY_REVIEW_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("GHL_HAPPY_REVIEW_WEBHOOK_URL is not set in environment variables");
  }

  const webhookPayload = {
    firstName:        f.firstName      || "",
    lastName:         f.lastName       || "",
    phone:            f.phone          || "",
    email:            f.email          || "",
    address1:         f.streetAddress  || "",
    city:             f.city           || "",
    state:            f.state          || "",
    contact_job_number:       f.jobNumber      || "",
    customerid:               f.customerId     || "",
    servicetitan_location_id: f.locationId     || "",
    invoice_id:               f.invoiceId      || "",
    invoice_summary:          f.invoiceSummary || "",
    job_summary:              f.jobSummary     || "",
    install_technician:       f.installTech    || "",
    tags:             "Happy Review,Small Repair",
    source:           "ServiceTitan Happy Review Form",
    submissionId:     String(submission.id),
    submittedOn:      submission.submittedOn || submission.createdOn || "",
  };

  const webhookRes = await axios.post(webhookUrl, webhookPayload, {
    headers: { "Content-Type": "application/json" },
  });

  console.log(`[HappyReview] Webhook posted for ${f.fullName} — status ${webhookRes.status}`);

  return { submissionId: submission.id, contactId: null, name: f.fullName, jobNumber: f.jobNumber, created: true };
}

// ── Dry-run preview (no GHL writes) ───────────────────────────────────────────

/**
 * Fetches the most recent Happy Review submission(s) and returns what WOULD
 * be sent to GHL — without creating, updating, or triggering anything.
 * Used to verify data before enabling automatic processing.
 */
async function previewLatestSubmission(hours = 2) {
  const submissions = await getRecentHappyReviewSubmissions(hours);

  if (submissions.length === 0) {
    return { found: false, message: `No Happy Review submissions found in the last ${hours} hour(s)` };
  }

  // Use the most recent submission — save it so processLastPreviewed can use it
  const submission = submissions[submissions.length - 1];
  lastPreviewedSubmission = submission;
  const f = await enrichSubmission(submission);

  return {
    found: true,
    totalInWindow: submissions.length,
    submissionId: submission.id,
    submittedOn: submission.submittedOn || submission.createdOn,
    rawData: submission,
    fields: {
      jobNumber:      { value: f.jobNumber,      source: "Form",          found: !!f.jobNumber },
      invoiceId:      { value: f.invoiceId,       source: "ServiceTitan",  found: !!f.invoiceId,      error: f._invoiceError },
      customerId:     { value: f.customerId,      source: "ServiceTitan",  found: !!f.customerId },
      locationId:     { value: f.locationId,      source: "ServiceTitan",  found: !!f.locationId },
      firstName:      { value: f.firstName,       source: "Form",          found: !!f.firstName },
      lastName:       { value: f.lastName,        source: "Form",          found: !!f.lastName },
      email:          { value: f.email,           source: "Form",          found: !!f.email },
      phone:          { value: f.phone,           source: "Form",          found: !!f.phone },
      installTech:    { value: f.installTech,     source: "Form",          found: !!f.installTech },
      invoiceSummary: { value: f.invoiceSummary,  source: "ServiceTitan",  found: !!f.invoiceSummary, error: f._invoiceError },
      jobSummary: { value: f.jobSummary,  source: "Computed",      found: !!f.jobSummary },
      streetAddress:  { value: f.streetAddress,   source: "ServiceTitan",  found: !!f.streetAddress },
      city:           { value: f.city,            source: "ServiceTitan",  found: !!f.city },
      state:          { value: f.state,           source: "ServiceTitan",  found: !!f.state },
    },
    workflow: process.env.GHL_HAPPY_REVIEW_WORKFLOW_ID
      ? `Would trigger workflow ID: ${process.env.GHL_HAPPY_REVIEW_WORKFLOW_ID}`
      : "⚠ GHL_HAPPY_REVIEW_WORKFLOW_ID not set — workflow would be skipped",
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

async function processHappyReviews(hours = 1) {
  const submissions = await getRecentHappyReviewSubmissions(hours);
  console.log(`[HappyReview] Found ${submissions.length} submission(s) in the last ${hours}h`);

  const results = [];
  for (const sub of submissions) {
    if (isHappyReviewProcessed(sub.id)) {
      console.log(`[HappyReview] Skipping already-processed submission ${sub.id}`);
      results.push({ submissionId: sub.id, skipped: true });
      continue;
    }
    try {
      const result = await processSubmission(sub);
      markHappyReviewProcessed(sub.id, result.name, result.jobNumber);
      results.push(result);
    } catch (err) {
      const errDetail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`[HappyReview] Error processing submission ${sub.id}: ${errDetail}`);
      results.push({ submissionId: sub.id, error: errDetail });
    }
  }

  return results;
}

async function processLastPreviewed() {
  if (!lastPreviewedSubmission) {
    throw new Error("No previewed submission on record — run Preview first");
  }
  return processSubmission(lastPreviewedSubmission);
}

module.exports = {
  getRecentHappyReviewSubmissions,
  getRecentHappyReviewSubmissionsSince,
  processHappyReviews,
  processSubmission,
  previewLatestSubmission,
  processLastPreviewed,
};
