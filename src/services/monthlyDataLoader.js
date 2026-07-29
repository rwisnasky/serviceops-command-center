/**
 * monthlyDataLoader.js
 * ────────────────────────────────────────────────────────────────────────────
 * Loads jobs[] and timesheets[] for a given (year, month) from one of:
 *
 *   1. Local cache: data/monthly-cache/{year}-{month}/jobs.json + timesheets.json
 *      (preferred — fast, deterministic, works for past months we've imported)
 *
 *   2. Live ServiceTitan API (fallback — for the current month or any month
 *      not yet cached). Requires the ST timesheet API scope.
 *
 * Use scripts/import-monthly-xlsx.js to seed the cache from the WIP and
 * timesheet xlsx exports the office team produces.
 * ────────────────────────────────────────────────────────────────────────────
 */

const fs = require("fs");
const path = require("path");

const CACHE_ROOT = path.join(__dirname, "..", "..", "data", "monthly-cache");

function cacheDir(year, month) {
  return path.join(CACHE_ROOT, `${year}-${String(month).padStart(2, "0")}`);
}

function readCache(year, month) {
  const dir = cacheDir(year, month);
  const jobsPath = path.join(dir, "jobs.json");
  const tsPath   = path.join(dir, "timesheets.json");
  const apptPath = path.join(dir, "appointments.json");
  if (!fs.existsSync(jobsPath) || !fs.existsSync(tsPath)) return null;
  const jobs = JSON.parse(fs.readFileSync(jobsPath, "utf8"));
  return {
    jobs:         applyReviewOverrides(jobs),
    timesheets:   JSON.parse(fs.readFileSync(tsPath, "utf8")),
    appointments: fs.existsSync(apptPath) ? JSON.parse(fs.readFileSync(apptPath, "utf8")) : [],
    source:       "cache",
  };
}

/**
 * Read the raw on-disk jobs[] for a month WITHOUT applying review overrides.
 * Used by the merge-with-live flow so we don't risk persisting status/jobType
 * corrections back into jobs.json (they're meant to live in the SQLite review
 * repo and overlay at read-time only). Returns [] when no cache exists.
 */
function readCachedJobsRaw(year, month) {
  const jobsPath = path.join(cacheDir(year, month), "jobs.json");
  if (!fs.existsSync(jobsPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(jobsPath, "utf8"));
  } catch (e) {
    console.warn(`[monthlyDataLoader] Failed to parse cached jobs.json for ${year}-${month}: ${e.message}`);
    return [];
  }
}

/**
 * Merge a freshly-pulled live jobs[] with what's already on disk so we never
 * destroy WIP/JC xlsx-imported cost data when the "Refresh from ServiceTitan"
 * button is pressed.
 *
 *  Strategy per job (keyed by jobNumber):
 *    • Job exists in cache with cost data (_hasCostData === true OR _source
 *      came from an xlsx import)  → keep cached row, only refresh the fast-
 *      changing fields from live (status, summary, technicians, _stId).
 *      Live `billed` is preserved as a fallback for jobs that had `billed===0`
 *      cached (e.g. completed-after-cutoff WIP rows).
 *    • Job exists in cache but has no cost data → take live as-is, tag with
 *      _source: "live-overlay" so we know it's the cheap path.
 *    • Job is new (not in cache) → take live as-is, tag with
 *      _source: "live-only".
 *    • Job is in cache but NOT in live → preserve the cached row untouched
 *      (live API's modifiedOnOrAfter window can miss closed jobs).
 *
 *  Net effect: pressing Refresh updates statuses and adds new jobs without
 *  wiping out materials/labor/hours/GM that only the xlsx exports provide.
 */
function mergeLiveWithCache(year, month, liveJobs) {
  const cachedJobs = readCachedJobsRaw(year, month);
  if (!cachedJobs.length) return liveJobs;

  const byJobNumber = new Map();
  for (const j of cachedJobs) {
    if (j && j.jobNumber) byJobNumber.set(String(j.jobNumber), j);
  }

  const seen = new Set();
  const merged = [];

  for (const live of liveJobs) {
    const key = String(live.jobNumber);
    seen.add(key);
    const cached = byJobNumber.get(key);

    if (!cached) {
      // Brand new job — take live as-is
      merged.push({ ...live, _source: live._source || "live-only" });
      continue;
    }

    const hasCostData =
      cached._hasCostData === true ||
      (typeof cached._source === "string" && cached._source !== "live-only" && cached._source !== "live-overlay");

    if (hasCostData) {
      // Preserve every cost-bearing field from the xlsx-imported row.
      // Only let live refresh the fast-changing fields a job's lifecycle
      // touches: status, customer-facing summary, tech assignment, and the
      // internal ST id (in case it wasn't captured at import time).
      merged.push({
        ...cached,
        status:      live.status      || cached.status,
        summary:     live.summary     || cached.summary,
        technicians: live.technicians || cached.technicians,
        _stId:       live._stId       || cached._stId,
        // If the xlsx import had $0 billed (job hadn't been invoiced yet by
        // the time the report was run) but live just found an invoice, prefer
        // live's billed. We do NOT touch materialCost / laborCost / hours /
        // gm — those only come from WIP / JC and live mode can't replace them.
        billed: (num(cached.billed) === 0 && num(live.billed) > 0) ? live.billed : cached.billed,
      });
    } else {
      // Cached row had no cost data anyway — overwrite with live.
      merged.push({ ...live, _source: "live-overlay" });
    }
  }

  // Carry over any cached jobs that live didn't return (jobs not modified in
  // the live query window but still part of this month's data).
  for (const [key, cached] of byJobNumber.entries()) {
    if (!seen.has(key)) merged.push(cached);
  }

  return merged;
}

/**
 * Overlay corrected_status / corrected_job_type from job_review_status onto
 * the cached job rows. This is the "read-time merge" that keeps jobs.json
 * untouched (so re-imports from the office's Excel exports are safe) while
 * letting reviewer-applied corrections show up immediately on the
 * dashboard.
 *
 * Each modified job gets a small `_corrections` breadcrumb so the UI can
 * render a "corrected" badge and show the original value on hover.
 */
function applyReviewOverrides(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return jobs;
  let repo;
  try {
    repo = require("../db/jobReviewRepository");
  } catch (_) {
    return jobs;  // DB not initialized (e.g. CLI scripts) — leave untouched
  }
  let byJob;
  try {
    byJob = repo.list();
  } catch (_) {
    return jobs;  // best-effort; never break the dashboard for an overlay miss
  }
  return jobs.map(j => {
    const row = byJob[j.jobNumber];
    if (!row) return j;
    const corrections = {};
    let next = j;
    if (row.corrected_status && row.corrected_status !== j.status) {
      corrections.status = { from: j.status, to: row.corrected_status };
      next = { ...next, status: row.corrected_status };
    }
    if (row.corrected_job_type && row.corrected_job_type !== j.jobType) {
      corrections.jobType = { from: j.jobType, to: row.corrected_job_type };
      next = { ...next, jobType: row.corrected_job_type };
    }
    if (Object.keys(corrections).length > 0) {
      next = { ...next, _corrections: corrections };
    }
    return next;
  });
}

function writeCache(year, month, jobs, timesheets, appointments = null) {
  const dir = cacheDir(year, month);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "jobs.json"), JSON.stringify(jobs, null, 2));
  fs.writeFileSync(path.join(dir, "timesheets.json"), JSON.stringify(timesheets, null, 2));
  if (appointments) {
    fs.writeFileSync(path.join(dir, "appointments.json"), JSON.stringify(appointments, null, 2));
  }
  fs.writeFileSync(path.join(dir, "imported-at.json"), JSON.stringify({
    importedAt: new Date().toISOString(),
    jobsCount: jobs.length,
    timesheetCount: timesheets.length,
    appointmentCount: appointments ? appointments.length : 0,
  }, null, 2));
}

/**
 * Write JUST the appointments cache for a month (used by the appointment-fetch
 * script after jobs/timesheets are already imported). Doesn't touch the other
 * cache files.
 */
function writeAppointmentsCache(year, month, appointments) {
  const dir = cacheDir(year, month);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "appointments.json"), JSON.stringify(appointments, null, 2));
}

/**
 * Pull jobs from ServiceTitan live API for a specific month.
 * Used for the home-page "current month" widget where live data matters.
 *
 * Note: ServiceTitan's job endpoints expose totals & costs but the WIP
 * report's specific "Materials + Equip + PO/Bill Costs" and "Total Hours
 * Worked" figures require additional aggregation across appointments and
 * invoice items. We pull what we can from /jpm/v2/jobs and supplement with
 * /accounting/v2/invoices for the billed total per job.
 */
async function loadLiveJobsForMonth(year, month) {
  const st = require("../api/servicetitan");
  const { startISO, endISO } = monthBounds(year, month);

  // Page through ServiceTitan's /jpm/v2/jobs endpoint. Note: getJobs returns
  // the full response body { data: [...], hasMore, page, totalCount } — NOT
  // a flat array. We have to unwrap .data and use .hasMore for pagination.
  let allJobs = [];
  let page = 1;
  while (true) {
    const resp = await st.getJobs({
      modifiedOnOrAfter: startISO,
      // ST's spec uses `modifiedBefore` (exclusive upper bound). The pair
      // `modifiedOnOrAfter` / `modifiedOnOrBefore` is NOT a valid combo —
      // ST silently drops `modifiedOnOrBefore`, which left current-month
      // queries unbounded and produced $0 billing on the live dashboard.
      modifiedBefore: endISO,
      page,
      pageSize: 50,
    });
    const batch = (resp && resp.data) || [];
    if (!batch.length) break;
    allJobs = allJobs.concat(batch);
    if (!resp.hasMore) break;
    page++;
    if (page > 100) break; // safety cap — shouldn't normally hit this
  }

  // Build base shape from the job endpoint. ST's /jobs response gives us
  // status, type, technician assignment, dates, summary — but NOT totals,
  // materials, labor cost, or hours worked. Those live on invoices and
  // labor records and need separate fetches (next step below).
  const mapped = allJobs.map(j => ({
    _stId:        j.id,
    jobNumber:    j.jobNumber || String(j.id),
    jobType:      j.jobTypeName || j.jobType || "Unknown",
    status:       normalizeStatus(j.jobStatus || j.status),
    billed:       0,                       // filled below from invoices
    materialCost: 0,                       // not available in live mode
    laborCost:    0,                       // not available in live mode
    hours:        0,                       // not available in live mode
    gm:           0,
    customerId:   j.customerId ? String(j.customerId) : null,
    technicians:  Array.isArray(j.technicians) ? j.technicians.join(", ") : "",
    createdDate:  j.createdOn || j.createdDate,
    summary:      j.summary || "",
  }));

  // Best-effort: fetch invoice totals for completed jobs so the dashboard's
  // "$ billed" tile is meaningful. We cap at 200 fetches to avoid timing out
  // the request — for early in a month, every completed job will have an
  // invoice; later in the month, we'll prefer cached xlsx imports anyway.
  // Cap the number of invoice fetches so a big month can't time out the request.
  // Previously a hard 200 that SILENTLY undercounted revenue past that point.
  // Now configurable, and it logs loudly when it truncates so an undercount is
  // visible rather than silent. (Past months use the cached xlsx import; this
  // live path is the current month.)
  const INVOICE_FETCH_CAP = parseInt(process.env.LIVE_INVOICE_FETCH_CAP) || 300;
  const allCompleted = mapped.filter(j => j.status === "Completed");
  const completed = allCompleted.slice(0, INVOICE_FETCH_CAP);
  if (allCompleted.length > INVOICE_FETCH_CAP) {
    console.warn(
      `[monthlyDataLoader] ${year}-${month}: ${allCompleted.length} completed jobs exceeds the live invoice-fetch cap of ${INVOICE_FETCH_CAP}. ` +
      `Billing total covers the first ${INVOICE_FETCH_CAP} and WILL UNDERCOUNT — use the xlsx import for a complete figure, or raise LIVE_INVOICE_FETCH_CAP.`
    );
  }
  let invFetchOk = 0, invFetchFail = 0;
  let firstErr = null;
  // Throttled fetch. This was previously an unbounded ~200-wide Promise.all
  // burst that tripped ServiceTitan's rate limit and made every invoice read
  // fail → the "all jobs show $0 billed" incident. Cap concurrency so the ST
  // retry/backoff (in servicetitan.js) can actually recover instead of the
  // whole burst 429-ing at once.
  const INVOICE_FETCH_CONCURRENCY = 6;
  let _invIdx = 0;
  async function _invWorker() {
    while (_invIdx < completed.length) {
      const j = completed[_invIdx++];
      try {
        const invs = await st.getInvoicesForJob(j.jobNumber, j._stId);
        const list = (invs && invs.data) || invs || [];
        let total = 0;
        for (const inv of list) {
          total += num(inv.total) || num(inv.subtotal) || 0;
        }
        j.billed = total;
        j.gm = total; // material/labor not available, so GM == billed in live mode
        invFetchOk++;
      } catch (e) {
        // Invoice fetch failed — leave billed = 0 and capture the first error so
        // we can surface it in the server log. Silently swallowing every failure
        // is what masked the "all jobs show $0 billed" issue on Apr 2026.
        invFetchFail++;
        if (!firstErr) firstErr = e?.response?.data?.title || e?.message || String(e);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(INVOICE_FETCH_CONCURRENCY, completed.length) }, _invWorker)
  );
  if (completed.length > 0) {
    console.log(`[monthlyDataLoader] live ${year}-${month} invoice fetch: ${invFetchOk}/${completed.length} ok, ${invFetchFail} failed${firstErr ? ` (first error: ${firstErr})` : ""}`);
    if (invFetchFail === completed.length && completed.length > 0) {
      console.warn(`[monthlyDataLoader] WARNING: every invoice fetch failed for ${year}-${month} — billing totals will be \$0 in live mode. Likely cause: ST Accounting API scope missing or rate-limited.`);
    }
  }

  return mapped;
}

/**
 * Live timesheet pull. ServiceTitan's Payroll API exposes
 * /payroll/v2/tenant/{tenant}/timesheets/non-job-codes for activities and
 * /payroll/v2/tenant/{tenant}/jobs/splits for job-attached labor.
 *
 * Wiring this requires the Payroll scope. Until then, this stub returns []
 * — meaning the live current-month widget will show billing/job KPIs but
 * not utilization. Past months continue to work via the cached xlsx imports.
 */
async function loadLiveTimesheetsForMonth(/* year, month */) {
  // TODO: implement using /payroll/v2/... endpoints once ST Payroll scope
  // is granted. See README addition under "ServiceTitan API scopes".
  return [];
}

/**
 * Live appointments pull. Uses the existing
 * /jpm/v2/tenant/{tenant}/appointments endpoint to fetch every appointment
 * scheduled to start in the given month. Each appointment has the real
 * scheduled `start` time plus `arrivalWindowStart`/`arrivalWindowEnd` for
 * the customer-promised window. This is the source of truth for on-time
 * performance — far more reliable than parsing dispatch notes from job
 * summaries.
 *
 * Returns an array of { jobId, jobNumber, scheduledStart, arrivalWindowStart,
 * arrivalWindowEnd, technicianIds, status }.
 */
async function loadLiveAppointmentsForMonth(year, month) {
  const st = require("../api/servicetitan");
  const { startISO, endISO } = monthBounds(year, month);
  const raw = await st.getAllAppointmentsForDateRange(startISO, endISO);
  return raw.map(a => ({
    appointmentId:       a.id,
    jobId:               a.jobId,
    jobNumber:           a.appointmentNumber ? a.appointmentNumber.split("-")[0] : null,
    // `start` is the dispatch-board-truth — auto-updates whenever CSRs
    // reschedule. This is the field we measure on-time against.
    scheduledStart:      a.start,
    scheduledEnd:        a.end,
    // arrivalWindowStart/End is the customer-promised window. It does NOT
    // auto-update on rescheduling in most ST configurations, so we keep it
    // separate (for "customer-promise" reporting) but DON'T use it as the
    // primary scheduled time.
    customerWindowStart: a.arrivalWindowStart || null,
    customerWindowEnd:   a.arrivalWindowEnd   || null,
    technicianIds:       a.technicianIds || [],
    status:              a.status,
    specialInstructions: a.specialInstructions || "",
  }));
}

function monthBounds(year, month) {
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const end   = new Date(Date.UTC(year, month,     1, 0, 0, 0));
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}
function normalizeStatus(s) {
  if (!s) return "Unknown";
  const v = String(s).trim();
  if (/^InProgress$/i.test(v)) return "In Progress";
  return v.charAt(0).toUpperCase() + v.slice(1);
}
function num(x) { return typeof x === "number" && !isNaN(x) ? x : 0; }

/**
 * Top-level loader. Tries cache first; for "current month" or when cache is
 * missing, falls back to live ST API.
 */
async function loadMonth(year, month, { preferLive = false } = {}) {
  if (!preferLive) {
    const cached = readCache(year, month);
    if (cached) return cached;
  }
  const [jobs, timesheets, appointments] = await Promise.all([
    loadLiveJobsForMonth(year, month),
    loadLiveTimesheetsForMonth(year, month),
    loadLiveAppointmentsForMonth(year, month).catch(e => {
      console.warn(`[MonthlyReview] Live appointment fetch failed: ${e.message}`);
      return [];
    }),
  ]);
  // Apply review overrides on the live path too — corrections should
  // still be visible even when we're not reading from the cached jobs.json.
  return { jobs: applyReviewOverrides(jobs), timesheets, appointments, source: "live" };
}

module.exports = {
  loadMonth,
  readCache,
  readCachedJobsRaw,
  writeCache,
  writeAppointmentsCache,
  loadLiveJobsForMonth,
  loadLiveAppointmentsForMonth,
  mergeLiveWithCache,
  cacheDir,
  CACHE_ROOT,
};
