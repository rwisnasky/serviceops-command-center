/**
 * matchingService.js
 *
 * Attempts to match an inbound call to an existing ServiceTitan customer and/or job.
 *
 * Current strategy (phone-number lookup):
 *   1. Normalize the caller's phone number
 *   2. Search ServiceTitan customers by phone
 *   3. If a customer is found, find their jobs and pick one that falls within
 *      a ±JOB_WINDOW_DAYS window of today. Jobs outside that window are
 *      returned as `candidateJobs` for manual review on the page — they're
 *      still surfaced to the dispatcher, but we don't auto-assign to a stale
 *      or far-future job.
 *   4. Return matchedCustomerId, matchedJobId, matchConfidence, candidateJobs
 *
 * This is designed to be extended later with:
 *   - Name-based matching from transcript
 *   - Address-based matching
 *   - Job number extracted from transcript
 *   - Fuzzy matching fallback
 */

const st = require("../api/servicetitan");
const employeeRepo = require("../db/employeeRepository");

// Jobs within ±14 days of "now" are eligible for auto-assign.
// Jobs further out than that are surfaced as candidates for manual review.
const JOB_WINDOW_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Try to match a call to a customer and/or job in ServiceTitan.
 *
 * @param {string|null} callerPhone - Caller's phone number (any format)
 * @param {object}      [meta]      - Additional context from the call/transcript
 * @param {string}      [meta.transcriptText] - Used for future name/address extraction
 *
 * @returns {Promise<MatchResult>}
 *
 * @typedef {object} MatchResult
 * @property {number|null} matchedCustomerId
 * @property {string|null} matchedCustomerName
 * @property {number|null} matchedJobId
 * @property {string|null} matchedJobNumber
 * @property {number}      matchConfidence  0.0–1.0
 * @property {string}      matchMethod      how the match was made
 */
async function matchCallToCustomer(callerPhone, meta = {}) {
  // ── No phone number — can't match ────────────────────────────────────────────
  if (!callerPhone) {
    console.log("[Matching] No caller phone — returning null match");
    return nullMatch("no_phone");
  }

  const normalized = normalizePhone(callerPhone);
  if (!normalized) {
    console.log(`[Matching] Could not normalize phone "${callerPhone}" — returning null match`);
    return nullMatch("invalid_phone");
  }

  // ── Step 0: caller-is-an-employee short-circuit ──────────────────────────────
  // If the number belongs to someone on our roster, we skip the ST customer
  // search entirely — the call is internal, not a lead/customer call.
  try {
    const employee = employeeRepo.lookupEmployeeByPhone(normalized);
    if (employee) {
      console.log(
        `[Matching] Caller ${normalized} matched internal employee ` +
          `"${employee.employeeName}" (${employee.trade || "—"}${employee.truckNumber ? ` · truck ${employee.truckNumber}` : ""}) — skipping ST customer lookup`
      );
      return {
        matchedCustomerId: null,
        matchedCustomerName: null,
        matchedJobId: null,
        matchedJobNumber: null,
        matchConfidence: 1.0,
        matchMethod: "employee_call",
        candidateJobs: [],
        jobWindowDays: JOB_WINDOW_DAYS,
        internalEmployee: {
          name: employee.employeeName,
          trade: employee.trade || null,
          extension: employee.extension || null,
          truckNumber: employee.truckNumber || null,
          phoneType: employee.phoneType || null,
        },
      };
    }
  } catch (err) {
    // Non-fatal — fall through to regular matching
    console.warn(`[Matching] Employee lookup failed: ${err.message}`);
  }

  console.log(`[Matching] Looking up phone ${normalized} in ServiceTitan`);

  // ── Step 1: search customers by phone (main customer-level phone) ────────────
  let customers = [];
  try {
    customers = await st.searchCustomersByPhone(normalized);
  } catch (err) {
    console.warn(`[Matching] Customer phone lookup failed: ${err.message}`);
    return nullMatch("lookup_error");
  }

  let customer = customers[0] || null;
  let matchConfidence = customer ? (customers.length === 1 ? 0.9 : 0.7) : 0;
  let matchMethod = customer ? "phone_lookup" : null;

  // ── Step 1b: fallback — search customer CONTACTS by phone ────────────────────
  // Many callers are household members stored as a contact on an existing
  // customer record, not as their own customer. This catches those.
  if (!customer) {
    let contacts = [];
    try {
      contacts = await st.searchContactsByPhone(normalized);
    } catch (err) {
      console.warn(`[Matching] Contact phone lookup failed: ${err.message}`);
    }

    const parentCustomerId = contacts[0]?.customerId || null;
    if (parentCustomerId) {
      try {
        const parent = await st.getCustomer(parentCustomerId);
        if (parent) {
          customer = parent;
          // Slightly lower confidence — contact match is less direct than customer-level
          matchConfidence = contacts.length === 1 ? 0.8 : 0.6;
          matchMethod = "contact_phone_lookup";
          console.log(`[Matching] Matched via contact → customer ${parent.id} (${parent.name})`);
        }
      } catch (err) {
        console.warn(`[Matching] getCustomer(${parentCustomerId}) failed: ${err.message}`);
      }
    }
  }

  if (!customer) {
    console.log(`[Matching] No customer found for phone ${normalized} (tried customer + contact lookups)`);
    return nullMatch("no_match");
  }

  console.log(`[Matching] Matched customer ${customer.id} (${customer.name}) | confidence=${matchConfidence}`);

  // ── Step 2: find the best job within the ±14 day window ──────────────────────
  // We fetch a handful of recent jobs, then split them into:
  //   - inWindow:     jobs whose relevance date is within ±JOB_WINDOW_DAYS of today
  //   - outOfWindow:  jobs for the same customer that fall outside that window
  // We auto-assign from inWindow only. outOfWindow is returned so the dispatcher
  // can review and manually assign if appropriate.
  let allJobs = [];
  try {
    // Pull a few more than before so we can see the out-of-window ones too
    allJobs = await st.getRecentJobsForCustomer(customer.id, { pageSize: 10 });
  } catch (err) {
    console.warn(`[Matching] Job lookup for customer ${customer.id} failed: ${err.message}`);
    // Non-fatal — we still have the customer match
  }

  const now = Date.now();
  const windowed = allJobs.map((j) => {
    const relevanceDate = getJobRelevanceDate(j);
    const ts = relevanceDate ? Date.parse(relevanceDate) : NaN;
    const ageDays = isNaN(ts) ? null : Math.round((now - ts) / MS_PER_DAY);
    const inWindow =
      !isNaN(ts) && Math.abs(ageDays) <= JOB_WINDOW_DAYS;
    return { job: j, relevanceDate, ageDays, inWindow };
  });

  const inWindow = windowed.filter((w) => w.inWindow);
  const outOfWindow = windowed.filter((w) => !w.inWindow);

  // Pick the best in-window job. Prefer active statuses, then nearest to today.
  let job = null;
  if (inWindow.length > 0) {
    const active = inWindow.find(
      (w) => w.job.jobStatus === "InProgress" || w.job.jobStatus === "Scheduled"
    );
    const nearest = [...inWindow].sort(
      (a, b) => Math.abs(a.ageDays ?? 9999) - Math.abs(b.ageDays ?? 9999)
    )[0];
    job = (active || nearest || inWindow[0]).job;
  }

  // Candidate jobs for the UI — only the *outside the window* ones, since
  // in-window jobs are already auto-assigned (or picked as the match).
  const candidateJobs = outOfWindow.map((w) => summarizeCandidateJob(w));

  if (job) {
    console.log(
      `[Matching] Matched job ${job.id} (#${job.jobNumber}) for customer ${customer.id} ` +
      `(in-window; ${inWindow.length} in-window, ${outOfWindow.length} out-of-window)`
    );
  } else if (outOfWindow.length > 0) {
    console.log(
      `[Matching] Customer ${customer.id} matched but no job within ±${JOB_WINDOW_DAYS} days — ` +
      `${outOfWindow.length} out-of-window candidates flagged for review`
    );
  } else {
    console.log(`[Matching] No jobs found for customer ${customer.id}`);
  }

  return {
    matchedCustomerId: customer.id,
    matchedCustomerName: customer.name || null,
    matchedJobId: job?.id || null,
    // ST returns the human-readable number as `jobNumber`, not `number`
    matchedJobNumber: job?.jobNumber ? String(job.jobNumber) : null,
    matchConfidence,
    matchMethod,
    candidateJobs,
    jobWindowDays: JOB_WINDOW_DAYS,
    internalEmployee: null,
  };
}

/**
 * Best-available date for deciding whether a job is "recent / upcoming."
 * ST jobs don't always have a scheduled-start date on the top-level object,
 * so we fall back through several candidates.
 */
function getJobRelevanceDate(job) {
  return (
    job.firstAppointmentDate ||
    job.startDate ||
    job.scheduledDate ||
    job.modifiedOn ||
    job.createdOn ||
    null
  );
}

function summarizeCandidateJob({ job, relevanceDate, ageDays }) {
  return {
    jobId: job.id,
    jobNumber: job.jobNumber ? String(job.jobNumber) : null,
    status: job.jobStatus || null,
    summary: job.summary || null,
    relevanceDate: relevanceDate || null,
    ageDays, // negative = future, positive = past; null = unknown
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Normalize a phone number to 10-digit US format (digits only).
 * Returns null if the number can't be parsed.
 */
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");

  // Handle +1 country code
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }
  if (digits.length === 10) {
    return digits;
  }
  return null;
}

function nullMatch(reason) {
  return {
    matchedCustomerId: null,
    matchedCustomerName: null,
    matchedJobId: null,
    matchedJobNumber: null,
    matchConfidence: 0,
    matchMethod: reason,
    candidateJobs: [],
    jobWindowDays: JOB_WINDOW_DAYS,
    internalEmployee: null,
  };
}

module.exports = { matchCallToCustomer, JOB_WINDOW_DAYS };
