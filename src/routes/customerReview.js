/**
 * routes/customerReview.js
 * ────────────────────────────────────────────────────────────────────────────
 * Per-customer cost/benefit review across all of that customer's locations.
 *
 *   GET /api/customer-review/search?q=<name>            → typeahead picker
 *   GET /api/customer-review/customer/:id               → customer + locations
 *   GET /api/customer-review/report?customerId=…
 *                                  &startDate=YYYY-MM-DD
 *                                  &endDate=YYYY-MM-DD
 *                                  &expectedHourlyRate=NNN  (optional)
 *
 * Pulls live from ServiceTitan (no cache dependency — works for any date
 * range, not just months we've imported xlsx for). For each completed job
 * we fetch the invoice(s) so the billing tile is accurate; line items are
 * walked to break revenue into materials vs labor when ST returns them on
 * the invoice payload.
 *
 * Rate adherence: if the caller passes expectedHourlyRate we compute
 *   expectedBilling = totalServiceHours × expectedHourlyRate
 * and surface the variance against actualBilling. Hours come from
 * /payroll/v2 labor splits (only available with the ST Payroll scope —
 * falls back to 0 gracefully).
 * ────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const router = express.Router();
const st = require("../api/servicetitan");
const loader = require("../services/monthlyDataLoader");

// Activities we count as "billable hours" when summing tech time on a job.
//
// We deliberately drop "Idle" here even though Scoreboard includes it,
// because the two views answer different questions. Scoreboard shows
// "where did this single job's day go?" so idle minutes count. Customer
// Review is summing across many jobs to answer "$/hr on this customer," so
// idle time misattributed by the dispatch board to a canceled or stale job
// (e.g. job 2603162 logging 4,462 idle hours after cancelation) would
// destroy the rate calculation. Working + Driving + Job Prep covers wrench
// time + the travel-to-call we're billing the customer for.
const JOB_ACTIVITIES = new Set(["Working", "Driving", "Job Prep"]);

// Reject any single timesheet row claiming more than this many hours — no
// real entry exceeds a long shift, so anything larger is a known artifact
// (Monthly Review's aggregator uses the same 50h cap). 24h is stricter
// since a per-entry duration above one full day is always wrong.
const MAX_ENTRY_HOURS = 24;

// Per-job sanity cap. If we somehow sum past this even after the per-entry
// filter, log a warning and clamp — better to undercount than show
// thousands-of-hours noise in a customer report.
const MAX_JOB_HOURS = 200;

// Cached timesheet index — { Map<jobNumberString, [entries]>, builtAt }.
// Built lazily from data/monthly-cache/*/timesheets.json and re-used across
// every job in a single /report call. The xlsx imports cover months going
// back to Oct 2025, so any older job will resolve from cache for free
// (no ST Payroll API roundtrip needed).
let _tsIndex = null;
const TS_INDEX_TTL_MS = 5 * 60 * 1000;

// Cached jobs.json index — Map<jobNumberString, {materialCost, laborCost,
// gm, billed, hours, _source}>. This is the same data the Monthly Review
// page renders, sourced from the WIP and Job Completed xlsx exports.
// Customer Review uses it to pull authoritative per-job cost figures —
// ST's /accounting/v2/invoices line-item categorization is unreliable
// (items[] often missing or skuType blank), but the xlsx columns
// "Materials + Equip. + PO/Bill Costs" and "Total Labor Costs" are the
// ground truth your accounting team trusts.
let _jobsIndex = null;
const JOBS_INDEX_TTL_MS = 5 * 60 * 1000;

function getCachedJobsIndex() {
  if (_jobsIndex && Date.now() - _jobsIndex.builtAt < JOBS_INDEX_TTL_MS) return _jobsIndex.map;
  const map = new Map();
  try {
    if (fs.existsSync(loader.CACHE_ROOT)) {
      for (const dir of fs.readdirSync(loader.CACHE_ROOT)) {
        const jobsPath = path.join(loader.CACHE_ROOT, dir, "jobs.json");
        if (!fs.existsSync(jobsPath)) continue;
        let jobs;
        try { jobs = JSON.parse(fs.readFileSync(jobsPath, "utf8")); }
        catch (e) { console.warn(`[customer-review] failed to parse ${jobsPath}: ${e.message}`); continue; }
        for (const j of jobs) {
          if (!j?.jobNumber) continue;
          const key = String(j.jobNumber).trim();
          // If a job appears in multiple cached months (rare — usually it's
          // imported once per its completion month), prefer the row that
          // has cost data. The xlsx import sets _hasCostData on rows with
          // valid materials/labor figures.
          const existing = map.get(key);
          if (existing && existing._hasCostData && !j._hasCostData) continue;
          map.set(key, {
            materialCost: Number(j.materialCost) || 0,
            laborCost:    Number(j.laborCost)    || 0,
            gm:           Number(j.gm)           || 0,
            billed:       Number(j.billed)       || 0,
            hours:        Number(j.hours)        || 0,
            _source:      j._source || null,
            _hasCostData: j._hasCostData === true,
          });
        }
      }
    }
  } catch (e) {
    console.warn(`[customer-review] cached jobs index build failed: ${e.message}`);
  }
  _jobsIndex = { map, builtAt: Date.now() };
  return map;
}

function getCachedTimesheetIndex() {
  if (_tsIndex && Date.now() - _tsIndex.builtAt < TS_INDEX_TTL_MS) return _tsIndex.map;
  const map = new Map();
  try {
    if (fs.existsSync(loader.CACHE_ROOT)) {
      for (const dir of fs.readdirSync(loader.CACHE_ROOT)) {
        const tsPath = path.join(loader.CACHE_ROOT, dir, "timesheets.json");
        if (!fs.existsSync(tsPath)) continue;
        let ts;
        try { ts = JSON.parse(fs.readFileSync(tsPath, "utf8")); }
        catch (e) { console.warn(`[customer-review] failed to parse ${tsPath}: ${e.message}`); continue; }
        for (const e of ts) {
          if (!e || !e.jobNumber) continue;
          const key = String(e.jobNumber).trim();
          if (!map.has(key)) map.set(key, []);
          map.get(key).push(e);
        }
      }
    }
  } catch (e) {
    console.warn(`[customer-review] cached timesheet index build failed: ${e.message}`);
  }
  _tsIndex = { map, builtAt: Date.now() };
  return map;
}

function hoursFromCache(jobNumber, tsIndex) {
  const key = String(jobNumber).trim();
  const rows = tsIndex.get(key);
  if (!rows || !rows.length) return { hours: 0, source: null };
  let hours = 0;
  let rejected = 0;
  for (const e of rows) {
    if (!JOB_ACTIVITIES.has(e.activity)) continue;
    const dur = Number(e.durationHours) || 0;
    if (dur <= 0) continue;
    if (dur > MAX_ENTRY_HOURS) {
      // This is the protection that stopped job 2603162 from showing 4,462
      // cached hours. Anything claiming more than a day per entry is
      // dispatch-board noise (idle blocks misattributed to the job, etc.).
      rejected++;
      continue;
    }
    hours += dur;
  }
  if (hours > MAX_JOB_HOURS) {
    // Don't clamp — that disguises bad data as a legitimate "200hr job".
    // Reject the whole calculation and let the caller try the next source.
    console.warn(`[customer-review] job ${key} cached hours ${hours.toFixed(1)} > ${MAX_JOB_HOURS}h cap — rejecting as unreliable (${rejected} artifact row${rejected === 1 ? "" : "s"} already dropped)`);
    return { hours: 0, source: null };
  }
  return hours > 0 ? { hours, source: "cached-timesheets" } : { hours: 0, source: null };
}

/**
 * Defensive matcher: Scoreboard discovered that ST's Payroll endpoints
 * sometimes return rows that don't belong to the requested jobId — tenants
 * vary in how `?jobIds=` is honored. We always filter the response
 * client-side before summing to avoid summing other jobs' hours into ours.
 */
function payrollRowMatchesJob(row, jobId, jobNumber) {
  const wantedId  = jobId  != null ? String(jobId)  : null;
  const wantedNum = jobNumber != null ? String(jobNumber) : null;
  const candidates = [
    row.jobId, row.JobId, row.parentJobId,
    row.job?.id, row.job?.jobId,
    row.jobNumber, row.JobNumber, row.job?.number, row.job?.jobNumber,
  ];
  return candidates.some(c => c != null && (
    (wantedId  && String(c) === wantedId) ||
    (wantedNum && String(c) === wantedNum)
  ));
}

/**
 * Resolve a single job's worked-hours via the same hierarchy Scoreboard uses:
 *   1. Cached timesheet rows (xlsx imports) — fastest, no API call
 *   2. /payroll/v2/jobs/timesheets           — derived from dispatchedOn/arrivedOn/doneOn
 *   3. /payroll/v2/jobs/splits               — hoursWorked
 *   4. /payroll/v2/gross-pay-items           — paidDurationHours / hoursWorked / regularHours
 *
 * Each Payroll endpoint can fail with 401/403 (scope not granted) — we
 * swallow per-call errors and continue; the cache path will still produce
 * data for any month we've imported.
 */
async function resolveJobHours(job, tsIndex) {
  // Skip canceled jobs entirely — any hours logged against them are either
  // pre-cancellation work (already invoiced separately) or post-cancel
  // idle/misallocation noise. Either way they distort $/hr on the customer.
  const status = String(job.jobStatus || job.status || "").toLowerCase();
  if (status.includes("cancel")) return { hours: 0, source: "skipped-canceled" };

  // 1) Cache first
  const cached = hoursFromCache(job.jobNumber || String(job.id), tsIndex);
  if (cached.hours > 0) return cached;

  if (!job.id) return { hours: 0, source: null };

  const jn = job.jobNumber || null;

  // Helper: per-source plausibility check. Anything that sums above the
  // per-job cap is treated as cross-contamination from the Payroll endpoint
  // (e.g. unrelated splits leaking through `jobIds=` filter). We log it and
  // try the next source instead of clamping — clamping is what made job
  // 2602513 show a fake 200 hours when ST itself shows 0.
  const isPlausible = (h, sourceLabel) => {
    if (h <= 0) return false;
    if (h > MAX_JOB_HOURS) {
      console.warn(`[customer-review] job ${jn || job.id} ${sourceLabel} hours ${h.toFixed(1)} > ${MAX_JOB_HOURS}h cap — rejecting source as unreliable`);
      return false;
    }
    return true;
  };

  // 2) Try the three Payroll endpoints in order. Each response is filtered
  //    by job id/number before summing — ST returns extra rows on some
  //    tenants when `jobIds=` isn't honored as a strict filter.
  try {
    const ts = await st.getJobTimesheets(job.id);
    if (Array.isArray(ts) && ts.length > 0) {
      const filtered = ts.filter(r => payrollRowMatchesJob(r, job.id, jn));
      let h = 0;
      for (const row of filtered) {
        const disp = row.dispatchedOn;
        const arr  = row.arrivedOn;
        const done = row.doneOn;
        if (disp && done) {
          const start = arr || disp;
          const dt = (Date.parse(done) - Date.parse(start)) / 3600000;
          if (dt > 0 && dt <= MAX_ENTRY_HOURS) h += dt;
        }
      }
      if (isPlausible(h, "payroll-timesheets")) return { hours: h, source: "payroll-timesheets" };
    }
  } catch (_) {}

  try {
    const splits = await st.getJobLaborSplits(job.id);
    if (Array.isArray(splits) && splits.length > 0) {
      const filtered = splits.filter(r => payrollRowMatchesJob(r, job.id, jn));
      let h = 0;
      for (const s of filtered) {
        const v = Number(s.hoursWorked ?? s.hours ?? s.paidDurationHours) || 0;
        if (v > 0 && v <= MAX_ENTRY_HOURS) h += v;
      }
      if (isPlausible(h, "payroll-splits")) return { hours: h, source: "payroll-splits" };
    }
  } catch (_) {}

  try {
    const gp = await st.getJobGrossPayItems(job.id);
    if (Array.isArray(gp) && gp.length > 0) {
      const filtered = gp.filter(r => payrollRowMatchesJob(r, job.id, jn));
      let h = 0;
      for (const r of filtered) {
        const v = Number(r.paidDurationHours ?? r.hoursWorked ?? r.regularHours) || 0;
        if (v > 0 && v <= MAX_ENTRY_HOURS) h += v;
      }
      if (isPlausible(h, "payroll-gross-pay")) return { hours: h, source: "payroll-gross-pay" };
    }
  } catch (_) {}

  return { hours: 0, source: null };
}

// Concurrency cap for the per-job invoice/labor fetch fan-out. Higher = faster
// but more likely to hit ST's per-tenant rate limit (which caps around
// ~10 req/sec on most plans). 6 has held up reliably in the Monthly Review
// loader for a year+.
const CONCURRENCY = 6;

async function mapWithConcurrency(items, fn, concurrency = CONCURRENCY) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        out[i] = { __error: e?.response?.data?.title || e?.message || String(e) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

// ─── Date helpers ────────────────────────────────────────────────────────────
// Inputs come in as YYYY-MM-DD from the date picker. We convert them to UTC
// ISO strings so the ST query bounds are unambiguous.
function dateToISO(s, endOfDay = false) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const [_, y, mo, d] = m;
  // endDate is exclusive on the ST side — we pass the start of the *next* day
  // so the user's intuitive "to 2026-04-30" actually includes 2026-04-30 jobs.
  const day = endOfDay ? Number(d) + 1 : Number(d);
  return new Date(Date.UTC(Number(y), Number(mo) - 1, day, 0, 0, 0)).toISOString();
}

function num(x) {
  if (x === null || x === undefined || x === "") return 0;
  const n = typeof x === "number" ? x : parseFloat(String(x).replace(/[$,]/g, ""));
  return isNaN(n) ? 0 : n;
}

// ─── /search ─────────────────────────────────────────────────────────────────
router.get("/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ customers: [] });

    // Classify the input. Customer IDs in this tenant are 7+ pure digits with
    // no formatting — e.g. 7078147, 7059918. Phone numbers either come with
    // formatting (parens, dashes, dots, spaces between digits) or are exactly
    // 10/11 digits. Earlier "7-digit = phone" rule misrouted IDs to the phone
    // search and returned nothing.
    const digits         = q.replace(/\D/g, "");
    const hasFmtChars    = /[\s().\-+]/.test(q);
    const isPureNumeric  = /^\d+$/.test(q);
    const looksLikePhone = hasFmtChars || (isPureNumeric && (digits.length === 10 || digits.length === 11));

    let customers = [];

    if (isPureNumeric && !hasFmtChars) {
      // Try the customer-ID path first for anything that could plausibly be
      // an ID (anyone typing "7078147" expects to find customer #7078147).
      try {
        const c = await st.getCustomer(q);
        if (c && c.id) customers = [c];
      } catch (_) {}
    }

    // If the ID lookup found nothing AND the input still looks phone-shaped,
    // fall back to phone search. This covers the case where the user pastes
    // a 10-digit phone with no formatting.
    if (customers.length === 0 && looksLikePhone) {
      try {
        customers = await st.searchCustomersByPhone(digits);
      } catch (_) {}
    }

    // Non-numeric / formatted input → name search.
    if (customers.length === 0 && !isPureNumeric) {
      customers = await st.searchCustomersByName(q, { pageSize: 15 });
    }

    res.json({
      customers: (customers || []).map(c => ({
        id: c.id,
        name: c.name,
        type: c.type,
        balance: c.balance,
        address: c.address && c.address.street
          ? `${c.address.street}, ${c.address.city || ""}`.trim().replace(/,\s*$/, "")
          : null,
      })),
    });
  } catch (e) {
    console.error("[customer-review/search]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── /customer/:id ───────────────────────────────────────────────────────────
router.get("/customer/:id", async (req, res) => {
  try {
    const id = String(req.params.id).trim();
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: "Invalid customer ID" });

    const [customer, locations] = await Promise.all([
      st.getCustomer(id).catch(() => null),
      st.getLocationsByCustomer(id).catch(() => []),
    ]);
    if (!customer) return res.status(404).json({ error: `Customer ${id} not found` });

    res.json({
      customer: {
        id: customer.id,
        name: customer.name,
        type: customer.type,
        balance: customer.balance,
        address: customer.address || null,
      },
      locations: (locations || []).map(l => ({
        id: l.id,
        name: l.name,
        address: l.address || null,
      })),
    });
  } catch (e) {
    console.error("[customer-review/customer]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── /report ─────────────────────────────────────────────────────────────────
// The main analytical endpoint. Pulls jobs in the date range, fans out for
// invoices + (best-effort) labor hours, then aggregates by location.
router.get("/report", async (req, res) => {
  const t0 = Date.now();
  try {
    const customerId = String(req.query.customerId || "").trim();
    if (!/^\d+$/.test(customerId)) return res.status(400).json({ error: "customerId required" });

    const startISO = dateToISO(req.query.startDate, false);
    const endISO   = dateToISO(req.query.endDate, true);
    if (!startISO || !endISO) return res.status(400).json({ error: "startDate and endDate required (YYYY-MM-DD)" });
    if (new Date(startISO) >= new Date(endISO)) return res.status(400).json({ error: "endDate must be after startDate" });

    const expectedHourlyRate = num(req.query.expectedHourlyRate);
    // Default to `modified` because ST's `completedOn` is unreliable on this
    // tenant — many completed jobs leave it null and the filter excludes
    // them. `modifiedOn` is set on every status change and is what the
    // existing monthly cache loader uses successfully.
    const requestedDateField = req.query.dateField === "completed" ? "completed" : "modified";

    // 1) Customer + locations (parallel)
    const [customer, locationsList] = await Promise.all([
      st.getCustomer(customerId).catch(() => null),
      st.getLocationsByCustomer(customerId).catch(() => []),
    ]);
    if (!customer) return res.status(404).json({ error: `Customer ${customerId} not found` });

    const locationMap = new Map();
    for (const l of locationsList || []) {
      locationMap.set(l.id, l);
    }

    // 2) Jobs in range. If the requested date field returns 0 jobs we retry
    //    with the OTHER field — `completedOn` is null on plenty of completed
    //    jobs in this tenant, and `modifiedOn` is the safer fallback. The
    //    response captures which field actually produced the data so the UI
    //    can show that to the user.
    let dateField = requestedDateField;
    let rawJobs = await st.getJobsForCustomerInRange(customerId, startISO, endISO, { dateField });
    const primaryCount = rawJobs.length;
    let fallbackUsed = false;
    if (rawJobs.length === 0) {
      const altField = requestedDateField === "modified" ? "completed" : "modified";
      const alt = await st.getJobsForCustomerInRange(customerId, startISO, endISO, { dateField: altField });
      if (alt.length > 0) {
        rawJobs = alt;
        dateField = altField;
        fallbackUsed = true;
      }
    }
    // As a last resort, also try the no-date-filter form so we can at least
    // tell the user how many jobs the customer DOES have in ST — useful when
    // the date range is just too narrow.
    let totalCustomerJobsInST = null;
    if (rawJobs.length === 0) {
      try {
        const recent = await st.getRecentJobsForCustomer(customerId, { pageSize: 100 });
        totalCustomerJobsInST = recent.length;
      } catch (_) {}
    }

    if (rawJobs.length === 0) {
      return res.json({
        customer: { id: customer.id, name: customer.name, type: customer.type },
        period: { startDate: req.query.startDate, endDate: req.query.endDate, dateField: requestedDateField },
        locations: [],
        jobs: [],
        totals: emptyTotals(),
        rateAdherence: expectedHourlyRate > 0 ? emptyRate(expectedHourlyRate) : null,
        diagnostics: {
          elapsedMs: Date.now() - t0,
          jobsPulled: 0,
          jobsKept: 0,
          jobErrors: 0,
          requestedDateField,
          primaryCount,
          fallbackTried: true,
          fallbackCount: 0,
          totalCustomerJobsInST,
          emptyReason: totalCustomerJobsInST > 0
            ? `Customer has ${totalCustomerJobsInST}+ jobs in ServiceTitan but none fall inside ${req.query.startDate}–${req.query.endDate} using either date field. Widen the date range.`
            : totalCustomerJobsInST === 0
              ? "ServiceTitan has zero jobs on file for this customer ID — confirm the ID is correct."
              : "Could not determine whether the customer has any jobs in ServiceTitan.",
        },
      });
    }

    // 3a) Resolve jobTypeId → name once for the whole batch. ST's /jpm/v2/jobs
    //     doesn't include jobTypeName; without this every row would render
    //     "Unknown" in the Type column.
    const jobTypeMap = await st.getJobTypeNamesById().catch(() => new Map());

    // 3b) Build the cached-timesheet + cached-jobs indexes once. Most jobs
    //     will resolve hours + COST from these without any extra API call
    //     (xlsx imports cover Oct 2025 onward). The jobs index gives us
    //     trustworthy materialCost / laborCost / gm — ST's invoice line
    //     items aren't reliable for that breakdown.
    const tsIndex   = getCachedTimesheetIndex();
    const jobsIndex = getCachedJobsIndex();

    // Track per-source counts for the diagnostics block.
    const hoursSourceCounts = {
      "cached-timesheets": 0,
      "payroll-timesheets": 0,
      "payroll-splits": 0,
      "payroll-gross-pay": 0,
      "skipped-canceled": 0,
      "none": 0,
    };
    const costSourceCounts = { "cached-wip": 0, "no-cost-data": 0 };

    // Track PO availability for the diagnostics block.
    let poAvailableJobs = 0;
    let poUnavailable = false;

    // 3) For each job, fetch invoices + purchase orders + hours in parallel.
    const enriched = await mapWithConcurrency(rawJobs, async (j) => {
      const [invoices, purchaseOrders, hoursResult] = await Promise.all([
        st.getInvoicesForJob(j.jobNumber || String(j.id), j.id).catch(() => []),
        st.getPurchaseOrdersForJob(j.id).catch((e) => { poUnavailable = true; return []; }),
        resolveJobHours(j, tsIndex).catch(() => ({ hours: 0, source: null })),
      ]);

      // Invoice totals — the authoritative billed figure (live from ST).
      let billed = 0;
      const invList = Array.isArray(invoices) ? invoices : (invoices?.data || []);
      for (const inv of invList) {
        billed += num(inv.total) || num(inv.subtotal) || 0;
      }

      // PO totals — live from ST inventory. This is the actual vendor cost
      // attributed to this job (what we paid for materials). Different from
      // the cached materialCost, which is the WIP report's aggregate
      // "Materials + Equip + PO/Bill Costs" column.
      let poCost = 0;
      const poList = Array.isArray(purchaseOrders) ? purchaseOrders : (purchaseOrders?.data || []);
      for (const po of poList) {
        poCost += num(po.total) || num(po.subTotal) || 0;
      }
      if (poList.length > 0) poAvailableJobs++;

      // COST breakdown — prefer the cached WIP-import data. ST's invoice
      // line items would let us split *revenue* by sku category, but on
      // this tenant items[] is mostly empty so that split is garbage. The
      // WIP xlsx (already imported into data/monthly-cache/) has real
      // Materials + Equip + PO costs and Total Labor Costs per job.
      const jobNumberKey = String(j.jobNumber || j.id).trim();
      const cachedCosts = jobsIndex.get(jobNumberKey);
      let materialCost = 0, laborCost = 0, otherCost = 0, gm = null;
      let cachedBilled = null; // for cross-check / fallback if live invoice fetch returned nothing
      let costSource = "no-cost-data";
      if (cachedCosts && cachedCosts._hasCostData) {
        materialCost = cachedCosts.materialCost;
        laborCost    = cachedCosts.laborCost;
        cachedBilled = cachedCosts.billed;
        gm           = cachedCosts.gm;
        // ST's "Jobs Gross Margin" column accounts for sub/fees/equipment
        // tracked separately. Residual = what we billed minus what shows
        // in materials + labor + GM. Almost always near zero.
        const calcGm = (cachedBilled || billed) - materialCost - laborCost;
        otherCost = Math.max(0, calcGm - gm);
        costSource = "cached-wip";
      }
      costSourceCounts[costSource]++;

      // If the live invoice fetch came back empty but the cached row has a
      // billed amount, fall back to the cached billed — better to show the
      // accounting-team's number than $0.
      if (billed === 0 && cachedBilled != null && cachedBilled > 0) {
        billed = cachedBilled;
      }

      // Margin = billed - materials - labor - other (residual). Only
      // meaningful when we had cost data; otherwise leave it null so the UI
      // shows a dash instead of "$0".
      const margin    = (costSource === "cached-wip") ? (billed - materialCost - laborCost - otherCost) : null;
      const marginPct = (margin != null && billed > 0) ? (margin / billed) * 100 : null;

      const hours = hoursResult.hours || 0;
      const hoursKey = hoursResult.source || "none";
      hoursSourceCounts[hoursKey] = (hoursSourceCounts[hoursKey] || 0) + 1;

      // jobTypeName → jobType (legacy) → resolve from id map → fallback.
      // The id-map path is what fires for real ST data on this tenant.
      const resolvedJobType =
        j.jobTypeName
        || j.jobType
        || (j.jobTypeId != null ? jobTypeMap.get(String(j.jobTypeId)) : null)
        || "Unknown";

      return {
        jobNumber:      j.jobNumber || String(j.id),
        jobId:          j.id,
        jobType:        resolvedJobType,
        status:         j.jobStatus || j.status,
        hoursSource:    hoursResult.source || null,
        costSource,
        locationId:     j.locationId || null,
        completedOn:    j.completedOn || null,
        createdOn:      j.createdOn  || null,
        summary:        j.summary    || "",
        invoiceCount:   invList.length,
        poCount:        poList.length,
        billed,
        materialCost,
        laborCost,
        otherCost,
        poCost,
        margin,
        marginPct,
        hours,
        // dollarsPerHour is what we ACTUALLY charged on this job per
        // service-hour worked — the apples-to-apples comparison against
        // expectedHourlyRate.
        dollarsPerHour: hours > 0 ? billed / hours : null,
      };
    });

    // Drop any rows where the fan-out reported __error so they don't poison
    // totals — but keep a count for the response.
    const errored = enriched.filter(j => j && j.__error).length;
    const jobs = enriched.filter(j => j && !j.__error);

    // 4) Pull location names for any locationId we saw that's not in the
    //    customer-level location list (e.g. the customer has > 5 locations
    //    or this job's location was archived).
    const missingLocIds = new Set(
      jobs.map(j => j.locationId).filter(id => id && !locationMap.has(id))
    );
    if (missingLocIds.size > 0 && missingLocIds.size <= 25) {
      await Promise.all(
        Array.from(missingLocIds).map(async id => {
          try {
            const l = await st.getLocationById(id);
            if (l) locationMap.set(id, l);
          } catch (_) {}
        })
      );
    }

    // 5) Group by location. Cost fields only roll up where the cached WIP
    //    import had cost data — otherwise leaving them null keeps the UI
    //    honest about which figures are real.
    const byLocation = {};
    for (const j of jobs) {
      const key = j.locationId || "no-location";
      const bucket = byLocation[key] = byLocation[key] || {
        locationId: j.locationId || null,
        locationName: locationMap.get(j.locationId)?.name || (j.locationId ? `Location ${j.locationId}` : "(no location)"),
        address: formatAddress(locationMap.get(j.locationId)?.address),
        jobCount: 0, billed: 0, hours: 0,
        materialCost: 0, laborCost: 0, otherCost: 0, poCost: 0, margin: 0,
        jobs: [],
      };
      bucket.jobCount++;
      bucket.billed       += j.billed;
      bucket.hours        += j.hours;
      bucket.materialCost += j.materialCost;
      bucket.laborCost    += j.laborCost;
      bucket.otherCost    += j.otherCost;
      bucket.poCost       += j.poCost;
      if (j.margin != null) bucket.margin += j.margin;
      bucket.jobs.push(j);
    }

    const locations = Object.values(byLocation)
      .map(loc => ({
        ...loc,
        dollarsPerHour: loc.hours > 0 ? loc.billed / loc.hours : null,
        marginPct: loc.billed > 0 ? (loc.margin / loc.billed) * 100 : null,
      }))
      .sort((a, b) => b.billed - a.billed);

    // 6) Totals across everything
    const totals = jobs.reduce((acc, j) => {
      acc.jobCount++;
      acc.billed       += j.billed;
      acc.hours        += j.hours;
      acc.materialCost += j.materialCost;
      acc.laborCost    += j.laborCost;
      acc.otherCost    += j.otherCost;
      acc.poCost       += j.poCost;
      if (j.margin != null) acc.margin += j.margin;
      return acc;
    }, emptyTotals());
    totals.dollarsPerHour = totals.hours > 0 ? totals.billed / totals.hours : null;
    totals.marginPct      = totals.billed > 0 ? (totals.margin / totals.billed) * 100 : null;
    totals.locationCount  = locations.length;

    // 7) Rate adherence (only when caller supplied a rate)
    let rateAdherence = null;
    if (expectedHourlyRate > 0) {
      const expectedBilling = totals.hours * expectedHourlyRate;
      const variance = totals.billed - expectedBilling;
      rateAdherence = {
        expectedHourlyRate,
        actualHours:      totals.hours,
        expectedBilling,
        actualBilling:    totals.billed,
        variance,
        variancePct:      expectedBilling > 0 ? (variance / expectedBilling) * 100 : null,
        actualHourlyRate: totals.dollarsPerHour,
      };
    }

    res.json({
      customer: {
        id: customer.id,
        name: customer.name,
        type: customer.type,
        balance: customer.balance,
      },
      period: {
        startDate: req.query.startDate,
        endDate:   req.query.endDate,
        dateField,
      },
      totals,
      rateAdherence,
      locations,
      jobs,
      diagnostics: {
        elapsedMs: Date.now() - t0,
        jobsPulled: rawJobs.length,
        jobsKept: jobs.length,
        jobErrors: errored,
        requestedDateField,
        effectiveDateField: dateField,
        fallbackUsed,
        hoursAvailable: totals.hours > 0,
        hoursSourceCounts,
        costSourceCounts,
        costDataNote: costSourceCounts["cached-wip"] > 0
          ? `Cost figures sourced from cached WIP imports (${costSourceCounts["cached-wip"]} job${costSourceCounts["cached-wip"] === 1 ? "" : "s"})${costSourceCounts["no-cost-data"] > 0 ? `; ${costSourceCounts["no-cost-data"]} job${costSourceCounts["no-cost-data"] === 1 ? "" : "s"} have no cost data yet (likely from months not yet imported)` : ""}.`
          : "No cost data available for any job in this window — import the WIP xlsx for these months via Monthly Review to enable margin analysis.",
        poAvailableJobs,
        poUnavailable,
        poDataNote: poUnavailable
          ? "Purchase-order data unavailable — ST Inventory scope not granted (POs require /inventory/v2 access)."
          : poAvailableJobs === 0
            ? "No purchase orders attached to any job in this window."
            : `Purchase orders found on ${poAvailableJobs} of ${jobs.length} jobs (live from ServiceTitan Inventory).`,
        // Friendlier note now that we try multiple sources. If everything
        // came back zero we explain the two likely causes: the month isn't
        // imported (no cached timesheets) AND the Payroll scope isn't
        // granted. If some hours surfaced we tell the user where they came
        // from so the $/hr figure is interpretable.
        hoursDataNote: totals.hours === 0
          ? "Hours unavailable — import the WIP + Timesheet xlsx for these months (Monthly Review → Import), or grant the ServiceTitan Payroll API scope."
          : `Hours sourced from ${
              Object.entries(hoursSourceCounts)
                .filter(([k, v]) => k !== "none" && v > 0)
                .map(([k, v]) => `${k} (${v} job${v === 1 ? "" : "s"})`).join(", ")
            }${hoursSourceCounts.none > 0 ? `; ${hoursSourceCounts.none} job${hoursSourceCounts.none === 1 ? "" : "s"} had no hours data anywhere` : ""}.`,
      },
    });
  } catch (e) {
    console.error("[customer-review/report]", e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

function emptyTotals() {
  return {
    jobCount: 0,
    billed: 0,
    hours: 0,
    materialCost: 0,
    laborCost:    0,
    otherCost:    0,
    poCost:       0,
    margin:       0,
    marginPct:    null,
    dollarsPerHour: null,
    locationCount: 0,
  };
}

function emptyRate(expectedHourlyRate) {
  return {
    expectedHourlyRate,
    actualHours: 0,
    expectedBilling: 0,
    actualBilling: 0,
    variance: 0,
    variancePct: null,
    actualHourlyRate: null,
  };
}

function formatAddress(addr) {
  if (!addr) return null;
  const parts = [addr.street, addr.city, addr.state, addr.zip].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

module.exports = router;
