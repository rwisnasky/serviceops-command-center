/**
 * backflowReportService.js
 * ────────────────────────────────────────────────────────────────────────────
 * Builds the Backflow Details report — a date-bounded list of every job whose
 * job type is "Backflow Test", shaped to match the columns of the office
 * team's daily Excel log:
 *
 *   COMP DATE | CUSTOMER | TOTAL HR | PRICE CHARGED | PRICE/TECH TIME |
 *   TECHNICIAN | DISPATCHED MIN | WORKING MIN | JOB# | # OF BK FLOW |
 *   JOB TYPE | NOTES
 *
 * Data sources (all live from ServiceTitan):
 *   • /jpm/v2/jobs                — primary list, filtered by jobTypeIds + completion date
 *   • /jpm/v2/appointments        — for technician + dispatched/working minutes
 *   • /accounting/v2/invoices     — for "price charged" + per-line backflow qty
 *   • /payroll/v2/jobs/timesheets — for total hours worked
 *   • /crm/v2/customers/{id}      — for customer name
 *   • /settings/v2/job-types      — to resolve "Backflow Test" → jobTypeId
 *
 * Performance note: pulling per-job invoice/appointment/timesheet/customer for
 * a large date range is N×4 API calls. We parallelize with a small concurrency
 * cap and cap the date range to 366 days in the route layer.
 * ────────────────────────────────────────────────────────────────────────────
 */

const axios = require("axios");
const st = require("../api/servicetitan");

const BACKFLOW_TYPE_NAME = "Backflow Test";

// ── Rate-limit handling ────────────────────────────────────────────────────
// ServiceTitan responds with 429 once tenant quotas are exceeded. The right
// move is to honor the Retry-After header (seconds) and back off, not to keep
// hammering. `withRetry` wraps any async ST call and re-tries up to 4 times
// on 429 / transient 5xx with exponential backoff.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { tries = 4, label = "" } = {}) {
  let attempt = 0;
  let lastErr;
  while (attempt < tries) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const transient = status === 429 || (status >= 500 && status < 600);
      if (!transient || attempt === tries - 1) throw err;

      // Honor server-provided backoff if present (seconds or HTTP-date).
      let waitMs;
      const ra = err.response?.headers?.["retry-after"];
      if (ra) {
        const asInt = parseInt(ra, 10);
        if (Number.isFinite(asInt)) waitMs = asInt * 1000;
        else {
          const dateMs = Date.parse(ra);
          if (!isNaN(dateMs)) waitMs = Math.max(0, dateMs - Date.now());
        }
      }
      if (!waitMs) waitMs = Math.min(15000, 800 * Math.pow(2, attempt));
      // Tiny jitter so parallel callers don't unison-retry.
      waitMs += Math.floor(Math.random() * 250);

      console.warn(
        `[Backflow] ${status} on ${label || "ST call"} — retrying in ${waitMs}ms (attempt ${attempt + 1}/${tries})`
      );
      await sleep(waitMs);
      attempt++;
    }
  }
  throw lastErr;
}

// ── Job type lookup cache (refreshed hourly) ───────────────────────────────
let _jobTypeCache = { at: 0, ids: null, names: null };

async function getBackflowJobTypeIds() {
  if (_jobTypeCache.ids && Date.now() - _jobTypeCache.at < 60 * 60 * 1000) {
    return { ids: _jobTypeCache.ids, names: _jobTypeCache.names };
  }
  const tenant = process.env.ST_TENANT_ID;

  let allTypes = [];
  let page = 1;
  while (page <= 20) {
    const res = await withRetry(async () => {
      const token = await st.getAccessToken();
      return axios.get(
        `https://api.servicetitan.io/jpm/v2/tenant/${tenant}/job-types`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "ST-App-Key": process.env.ST_APP_KEY,
          },
          params: { tenant, page, pageSize: 100, active: "True" },
        }
      );
    }, { label: `job-types page ${page}` });
    const batch = res.data?.data || [];
    allTypes = allTypes.concat(batch);
    if (!res.data?.hasMore) break;
    page++;
  }

  // Match "Backflow Test" exactly first, fall back to any type whose name
  // starts with the keyword (e.g. "Backflow Test - Repair") so tenants that
  // sub-type by repair flavor still surface here.
  const norm = (s) => String(s || "").trim().toLowerCase();
  const target = norm(BACKFLOW_TYPE_NAME);
  const exact = allTypes.filter((t) => norm(t.name) === target);
  const matched = exact.length ? exact : allTypes.filter((t) => norm(t.name).startsWith(target));

  const ids = matched.map((t) => t.id);
  const names = new Map(matched.map((t) => [String(t.id), t.name]));
  _jobTypeCache = { at: Date.now(), ids, names };
  return { ids, names };
}

// ── ST jobs page-walker with the params we need ────────────────────────────
async function fetchJobsForRange({ jobTypeIds, completedOnOrAfter, completedBefore }) {
  const tenant = process.env.ST_TENANT_ID;

  let all = [];
  let page = 1;
  while (page <= 100) {
    const res = await withRetry(async () => {
      const token = await st.getAccessToken();
      return axios.get(
        `https://api.servicetitan.io/jpm/v2/tenant/${tenant}/jobs`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "ST-App-Key": process.env.ST_APP_KEY,
          },
          params: {
            tenant,
            page,
            pageSize: 50,
            completedOnOrAfter,
            completedBefore,
            jobTypeIds: jobTypeIds.join(","),
          },
        }
      );
    }, { label: `jobs page ${page}` });
    const batch = res.data?.data || [];
    all = all.concat(batch);
    if (!res.data?.hasMore) break;
    page++;
  }
  return all;
}

// ── Concurrency-capped Promise.all ─────────────────────────────────────────
async function mapWithLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); }
      catch (err) { out[i] = { _error: err.message || String(err) }; }
    }
  });
  await Promise.all(workers);
  return out;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function minutesBetween(a, b) {
  if (!a || !b) return null;
  const da = new Date(a), db = new Date(b);
  if (isNaN(da) || isNaN(db)) return null;
  return Math.round((db - da) / 60000);
}

function pickCompletionDate(job) {
  // ST exposes completedOn on completed jobs; some tenants only fill `modifiedOn`.
  return job.completedOn || job.completed || job.modifiedOn || null;
}

function countBackflowsFromInvoice(invoice) {
  // Sum quantity across every item whose description or SKU looks like a
  // backflow line. This is best-effort — if the tenant uses non-obvious SKU
  // naming, the count may need a tweak. Falls back to 1 if no match (one job
  // = at least one backflow tested).
  const items = invoice?.items || [];
  let count = 0;
  for (const it of items) {
    const blob = `${it.description || ""} ${it.skuName || ""} ${it.name || ""}`.toLowerCase();
    if (/back[\s-]?flow|\bbf\b|\brpz\b|\bpvb\b|\bdcv\b|\bdcvap\b|\bdc\b/.test(blob)) {
      count += Number(it.quantity) || 0;
    }
  }
  return count > 0 ? count : 1;
}

function priceFromInvoice(invoice) {
  // Prefer subtotal (pre-tax) to match how the daily log records "price charged".
  return Number(invoice?.subtotal ?? invoice?.total ?? 0) || 0;
}

// ── Main entry ─────────────────────────────────────────────────────────────
/**
 * Build the backflow details report for [from, to] (ISO date strings).
 * Returns { rows, summary, meta }.
 *
 * Rows match the office team's Excel columns. Numbers come out as numbers
 * (not strings) so the page can format/totals them.
 */
async function buildBackflowReport({ from, to }) {
  if (!from || !to) throw new Error("buildBackflowReport: from + to required");

  const startedAt = Date.now();
  const { ids: jobTypeIds, names: jobTypeNames } = await getBackflowJobTypeIds();
  if (!jobTypeIds.length) {
    return {
      rows: [],
      summary: emptySummary(),
      meta: {
        from, to,
        jobTypeIds: [],
        jobTypeMatched: BACKFLOW_TYPE_NAME,
        elapsedMs: Date.now() - startedAt,
        warning: `No active ST job type matches "${BACKFLOW_TYPE_NAME}".`,
      },
    };
  }

  // Inputs are already YYYY-MM-DD. Anchor the range to the user's local day
  // bounds in UTC. (ST's completedOn/-Before is exclusive on the upper end.)
  const fromISO = new Date(`${from}T00:00:00Z`).toISOString();
  const toISO = new Date(`${to}T23:59:59.999Z`).toISOString();

  // Pull every backflow-type job completed in the range.
  const rawJobs = await fetchJobsForRange({
    jobTypeIds,
    completedOnOrAfter: fromISO,
    completedBefore: toISO,
  });

  // Defensive client-side filter. ST has been observed to silently drop
  // unknown / mis-named query params (see the modifiedOnOrBefore note in
  // servicetitan.js#getJobs), and we've seen non-backflow jobs slip through
  // when the jobTypeIds filter didn't take. Keeping this here guarantees the
  // report only ever contains rows whose jobTypeId is in our matched set.
  const allowedIds = new Set(jobTypeIds.map(String));
  const jobs = rawJobs.filter((j) => allowedIds.has(String(j.jobTypeId)));
  const droppedNonBackflow = rawJobs.length - jobs.length;

  // Per-job fan-out: appointments, invoices, timesheets, customer.
  const techMap = await withRetry(() => st.getTechniciansMap(), { label: "technicians" }).catch(() => new Map());

  // Concurrency 2 keeps us well under ST's per-tenant burst quota even when
  // every job triggers 4 downstream calls. Each call is independently retried
  // on 429, so a momentary throttle slows the report without failing it.
  const partial = { customerFails: 0, invoiceFails: 0, timesheetFails: 0, apptFails: 0 };

  const rows = await mapWithLimit(jobs, 2, async (job) => {
    const jobId = job.id;
    const jobNumber = job.jobNumber || String(jobId);

    const [appts, invoices, timesheets, customer] = await Promise.all([
      withRetry(() => st.getJobAppointments(jobId), { label: `appointments ${jobId}` })
        .catch((e) => { partial.apptFails++; console.warn(`[Backflow] appts ${jobId}: ${e.message}`); return []; }),
      withRetry(() => st.getInvoicesForJob(jobNumber, jobId), { label: `invoices ${jobNumber}` })
        .catch((e) => { partial.invoiceFails++; console.warn(`[Backflow] inv ${jobNumber}: ${e.message}`); return []; }),
      withRetry(() => st.getJobTimesheets(jobId), { label: `timesheets ${jobId}` })
        .catch((e) => { partial.timesheetFails++; console.warn(`[Backflow] ts ${jobId}: ${e.message}`); return []; }),
      job.customerId
        ? withRetry(() => st.getCustomer(job.customerId), { label: `customer ${job.customerId}` })
            .catch((e) => { partial.customerFails++; console.warn(`[Backflow] cust ${job.customerId}: ${e.message}`); return null; })
        : Promise.resolve(null),
    ]);

    // Time math — payroll timesheet rows carry dispatchedOn / arrivedOn /
    // doneOn for each tech-leg of the job. That's the authoritative source
    // for both "dispatched min" (drive time) and "working min" (wrench time).
    // If a tech had multiple visits to the same job, we sum across rows so
    // the totals match the office team's manual roll-up.
    let dispatchedMin = 0;
    let workingMin = 0;
    const techNames = new Set();

    for (const ts of timesheets || []) {
      const drive = minutesBetween(ts.dispatchedOn, ts.arrivedOn);
      if (drive != null && drive > 0) dispatchedMin += drive;
      const work = minutesBetween(ts.arrivedOn, ts.doneOn);
      if (work != null && work > 0) workingMin += work;

      const name = techMap.get(String(ts.technicianId));
      if (name) techNames.add(name);
    }

    // Fallback for technician names if no timesheets came back (some tenants
    // restrict the Payroll scope) — walk appointments, then the job itself.
    if (!techNames.size) {
      for (const a of appts) {
        const ids = Array.isArray(a.technicianIds) ? a.technicianIds : [];
        for (const id of ids) {
          const n = techMap.get(String(id));
          if (n) techNames.add(n);
        }
      }
    }
    if (!techNames.size) {
      if (Array.isArray(job.technicians) && job.technicians.length) {
        for (const t of job.technicians) {
          const n = typeof t === "string" ? t : t?.name || techMap.get(String(t?.id || t));
          if (n) techNames.add(n);
        }
      } else if (job.leadTechnicianId) {
        const n = techMap.get(String(job.leadTechnicianId));
        if (n) techNames.add(n);
      }
    }
    const primaryTechName = Array.from(techNames).join(", ");

    // Total hours — prefer payroll timesheet paid hours; fall back to working
    // minutes if the Payroll scope isn't available.
    let totalHours = 0;
    if (Array.isArray(timesheets) && timesheets.length) {
      totalHours = timesheets.reduce(
        (sum, ts) => sum + (Number(ts.paidDurationHours) || 0),
        0
      );
    }
    if (!totalHours && workingMin > 0) totalHours = workingMin / 60;

    // Invoice → price + backflow count.
    const inv = Array.isArray(invoices) && invoices.length ? invoices[0] : null;
    const priceCharged = inv ? priceFromInvoice(inv) : Number(job.total || 0);
    const numBackflows = inv ? countBackflowsFromInvoice(inv) : 1;
    const pricePerTechTime =
      totalHours > 0 ? Math.round((priceCharged / totalHours) * 100) / 100 : null;

    const completed = pickCompletionDate(job);
    // The client-side filter above guarantees jobTypeId is one we matched, so
    // jobTypeNames.get() should always hit. Keep job.jobTypeName as a final
    // safety net so a rename mid-run still renders something useful.
    const jobTypeName =
      jobTypeNames.get(String(job.jobTypeId)) ||
      job.jobTypeName ||
      `Type ${job.jobTypeId}`;

    return {
      compDate: completed ? completed.slice(0, 10) : null,
      customer: customer?.name || job.customerName || "",
      totalHr: round(totalHours, 2),
      priceCharged: round(priceCharged, 2),
      pricePerTechTime: pricePerTechTime,
      technician: primaryTechName,
      dispatchedMin: dispatchedMin,
      workingMin: workingMin,
      jobNumber,
      numBackflows,
      jobType: jobTypeName,
      notes: (job.summary || "").trim(),
      // Internal fields for the UI to deep-link, ignored by the table renderer.
      _jobId: jobId,
      _customerId: job.customerId || null,
      _invoiceId: inv?.id || null,
      _status: job.jobStatus || job.status || null,
    };
  });

  // Sort newest-first by completion date.
  rows.sort((a, b) => String(b.compDate || "").localeCompare(String(a.compDate || "")));

  const summary = summarize(rows);

  return {
    rows,
    summary,
    meta: {
      from, to,
      jobTypeIds,
      jobTypeMatched: Array.from(jobTypeNames.values()),
      jobsScanned: jobs.length,
      rawJobsFromST: rawJobs.length,
      droppedNonBackflow,
      elapsedMs: Date.now() - startedAt,
      partial,
    },
  };
}

function emptySummary() {
  return {
    jobCount: 0,
    backflowCount: 0,
    totalHours: 0,
    totalPrice: 0,
    customers: 0,
    technicians: 0,
    avgPricePerJob: 0,
    avgPricePerBackflow: 0,
  };
}

function summarize(rows) {
  if (!rows.length) return emptySummary();
  const distinctCust = new Set();
  const distinctTech = new Set();
  let bf = 0, hrs = 0, price = 0;
  for (const r of rows) {
    if (r.customer) distinctCust.add(r.customer.trim().toLowerCase());
    if (r.technician) {
      for (const t of r.technician.split(",")) distinctTech.add(t.trim().toLowerCase());
    }
    bf += Number(r.numBackflows) || 0;
    hrs += Number(r.totalHr) || 0;
    price += Number(r.priceCharged) || 0;
  }
  return {
    jobCount: rows.length,
    backflowCount: bf,
    totalHours: round(hrs, 2),
    totalPrice: round(price, 2),
    customers: distinctCust.size,
    technicians: distinctTech.size,
    avgPricePerJob: rows.length ? round(price / rows.length, 2) : 0,
    avgPricePerBackflow: bf ? round(price / bf, 2) : 0,
  };
}

function round(n, p) {
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, p);
  return Math.round(n * f) / f;
}

module.exports = {
  buildBackflowReport,
  getBackflowJobTypeIds,
};
