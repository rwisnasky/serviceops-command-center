/**
 * routes/scoreboard.js
 * ────────────────────────────────────────────────────────────────────────────
 *   GET /api/scoreboard/:jobNumber
 *
 * Returns a single aggregated payload that the Scoreboard UI uses to render
 * a one-page review of a job:
 *
 *   • job basics + summary + customer + location/address
 *   • appointments (scheduled vs. actual arrival, with on-time verdict)
 *   • invoices (totals, line items)
 *   • per-technician hours from any cached monthly timesheet that contains
 *     activity for this job number (Working, Driving, Idle attached to the job)
 *
 * Designed to fail soft: each section is wrapped in try/catch so that a
 * missing scope or 404 on one piece doesn't kill the whole response. Fields
 * that couldn't be loaded are reported in a top-level `warnings` array.
 * ────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const fs      = require("fs");
const path    = require("path");

const router  = express.Router();
const st      = require("../api/servicetitan");
const loader  = require("../services/monthlyDataLoader");

// Activities we count as "on the job" when summing tech hours per job.
// These are the activity types ServiceTitan / Tenna report against a
// jobNumber on the timesheet feed.
const JOB_ACTIVITIES = new Set(["Working", "Driving", "Idle", "Job Prep"]);

// ── Per-tech labor-rate map, derived from cached WIP exports ───────────────
// The cached monthly jobs.json files contain laborCost + hours per job (sourced
// from "Total Labor Costs" in the WIP xlsx). When a job has a single tech we
// can attribute the entire labor cost to that tech, giving us their effective
// loaded rate. Averaging across many jobs yields a reasonably stable per-tech
// rate map that we can use for live jobs (not yet cached) where ST's API
// doesn't expose labor cost.
//
// Cache is computed once per process (cheap — only re-reads on restart).
let _rateCache = null;
function getLaborRateMap() {
  if (_rateCache) return _rateCache;
  const techRates = {};       // tech → [rate, rate, ...]
  let allRates    = [];        // for fleet median fallback
  try {
    if (!fs.existsSync(loader.CACHE_ROOT)) return (_rateCache = { perTech: new Map(), fleetMedian: 50, sampleSize: 0 });
    for (const dir of fs.readdirSync(loader.CACHE_ROOT)) {
      const jobsPath = path.join(loader.CACHE_ROOT, dir, "jobs.json");
      if (!fs.existsSync(jobsPath)) continue;
      const jobs = JSON.parse(fs.readFileSync(jobsPath, "utf8"));
      for (const j of jobs) {
        const lc  = Number(j.laborCost) || 0;
        const hrs = Number(j.hours)     || 0;
        if (lc <= 0 || hrs <= 0) continue;
        const techList = String(j.technicians || "").split(",").map(s => s.trim()).filter(Boolean);
        if (techList.length !== 1) {
          // Multi-tech jobs go into the fleet pool only — we can't attribute
          // labor cost cleanly without per-tech splits.
          allRates.push(lc / hrs);
          continue;
        }
        const rate = lc / hrs;
        if (rate < 20 || rate > 400) continue;   // sanity filter — drop obvious outliers
        (techRates[techList[0]] = techRates[techList[0]] || []).push(rate);
        allRates.push(rate);
      }
    }
  } catch (e) {
    console.warn("[scoreboard] getLaborRateMap failed:", e.message);
  }
  const median = arr => {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const perTech = new Map();
  for (const [tech, rates] of Object.entries(techRates)) {
    if (rates.length >= 2) perTech.set(tech, median(rates));
  }
  _rateCache = {
    perTech,
    fleetMedian: median(allRates) || 50,
    sampleSize:  allRates.length,
  };
  return _rateCache;
}

router.get("/:jobNumber", async (req, res) => {
  const jn = String(req.params.jobNumber || "").trim();
  if (!jn || !/^\d+$/.test(jn)) {
    return res.status(400).json({ error: "Invalid job number" });
  }

  const warnings = [];

  // ── 1. Job ──────────────────────────────────────────────────────────────
  let job;
  try {
    job = await st.getJobByNumber(jn);
  } catch (e) {
    console.error(`[scoreboard] getJobByNumber(${jn}) failed:`, e.message);
    return res.status(500).json({ error: `ST job lookup failed: ${e.message}` });
  }
  if (!job) return res.status(404).json({ error: `Job ${jn} not found in ServiceTitan` });

  // ── 2. Customer + Location (best-effort) ────────────────────────────────
  let customer = null, location = null;
  if (job.customerId) {
    try { customer = await st.getCustomer(job.customerId); }
    catch (e) { warnings.push(`customer lookup failed: ${e.message}`); }
  }
  if (job.locationId) {
    try { location = await st.getLocationById(job.locationId); }
    catch (e) { warnings.push(`location lookup failed: ${e.message}`); }
  }

  // ── 3. Appointments ─────────────────────────────────────────────────────
  let appointments = [];
  try {
    appointments = await st.getJobAppointments(job.id);
  } catch (e) {
    warnings.push(`appointment lookup failed: ${e.message}`);
  }

  // ── 4. Invoices + line items ────────────────────────────────────────────
  let invoices = [];
  try {
    const list = await st.getInvoicesForJob(jn, job.id);
    invoices = (list || []).map(inv => ({
      id:            inv.id,
      number:        inv.number || inv.invoiceNumber,
      invoiceDate:   inv.invoicedOn || inv.invoiceDate || inv.createdOn,
      total:         num(inv.total),
      subtotal:      num(inv.subtotal),
      tax:           num(inv.salesTax) || num(inv.tax),
      balance:       num(inv.balance),
      summary:       inv.summary || "",
      status:        (inv.status && (inv.status.name || inv.status.value)) || inv.statusName || "",
      // ST returns the line items inline as `items[]` — but on some tenants
      // the items only come back when explicitly expanded. We map whatever
      // shape we get and let the UI render gracefully when the array is empty.
      items: Array.isArray(inv.items) ? inv.items.map(it => ({
        sku:          it.skuName || it.sku || "",
        description:  it.description || it.skuName || "",
        quantity:     num(it.quantity),
        unitPrice:    num(it.price) || num(it.unitPrice),
        total:        num(it.total) || (num(it.quantity) * (num(it.price) || num(it.unitPrice))),
        type:         it.type || it.skuType || "",
        cost:         num(it.cost) || num(it.totalCost),
      })) : [],
    }));
  } catch (e) {
    warnings.push(`invoice lookup failed: ${e.message}`);
  }

  // Aggregate invoice totals across all invoices on the job.
  const invTotals = invoices.reduce((acc, i) => {
    acc.billed   += num(i.total);
    acc.subtotal += num(i.subtotal);
    acc.tax      += num(i.tax);
    acc.balance  += num(i.balance);
    acc.items    += (i.items || []).length;
    acc.materialCost += (i.items || [])
      .filter(it => /material/i.test(it.type) || /equipment/i.test(it.type))
      .reduce((s, it) => s + num(it.cost), 0);
    acc.serviceRevenue += (i.items || [])
      .filter(it => /service/i.test(it.type) || !it.type)
      .reduce((s, it) => s + num(it.total), 0);
    return acc;
  }, { billed: 0, subtotal: 0, tax: 0, balance: 0, items: 0, materialCost: 0, serviceRevenue: 0 });

  // ── 5. Tech hours — merged from three sources, LIVE FIRST ───────────────
  //
  //   a) ServiceTitan Payroll API (live)         ← preferred — real-time truth
  //   b) Cached xlsx timesheet imports            ← fallback for older jobs
  //   c) Scheduled-appointment estimate           ← last resort
  //
  // We try LIVE first because "real timesheet info" is the user's expectation
  // when they search a job. Cache is only used when live yields nothing.
  // We track which sources contributed so the UI can be honest about it.
  const techHours = {};            // tech → { working, driving, idle, jobPrep, total }
  const dayList   = new Set();
  let entries     = [];            // chronological timeline rows for the UI
  const sources   = [];            // names of sources that contributed data
  let cacheRowsFound = 0;          // declared up-front so the live block can read it

  // ── (b/cache scan helper, runs only if live came up empty) ──
  function scanCachedTimesheets() {
    try {
      if (!fs.existsSync(loader.CACHE_ROOT)) return;
      for (const dir of fs.readdirSync(loader.CACHE_ROOT)) {
        const tsPath = path.join(loader.CACHE_ROOT, dir, "timesheets.json");
        if (!fs.existsSync(tsPath)) continue;
        const ts = JSON.parse(fs.readFileSync(tsPath, "utf8"));
        for (const e of ts) {
          if (!e || !e.jobNumber) continue;
          if (String(e.jobNumber).trim() !== jn) continue;
          if (!JOB_ACTIVITIES.has(e.activity)) continue;

          const dur = num(e.durationHours);
          const t = techHours[e.tech] = techHours[e.tech] || {
            tech: e.tech, working: 0, driving: 0, idle: 0, jobPrep: 0, total: 0,
          };
          switch (e.activity) {
            case "Working":  t.working  += dur; break;
            case "Driving":  t.driving  += dur; break;
            case "Idle":     t.idle     += dur; break;
            case "Job Prep": t.jobPrep  += dur; break;
          }
          t.total += dur;

          const dateKey = typeof e.date === "string" ? e.date.slice(0, 10) : null;
          if (dateKey) dayList.add(dateKey);

          entries.push({
            tech: e.tech,
            date: dateKey,
            activity: e.activity,
            startTime: e.startTime,
            endTime: e.endTime,
            durationHours: dur,
            source: "cache",
          });
          cacheRowsFound++;
        }
      }
    } catch (e) {
      warnings.push(`cache timesheet scan failed: ${e.message}`);
    }
  }

  // ── (a) Live ServiceTitan Payroll feeds — primary source ──
  // Try two endpoints in parallel, each fails-soft:
  //   • /payroll/v2/.../jobs/splits         — per-tech labor on the job
  //   • /payroll/v2/.../gross-pay-items     — per-tech paid-time line items,
  //     usually richer (includes pay type / activity bucketing)
  // We use whichever returned rows, prefering the more detailed gross-pay
  // items when both came back.
  let liveRowsFound = 0;
  const debug = {
    timesheets: { tried: false, count: 0, filteredCount: 0, error: null, sampleKeys: null, sampleJobId: null },
    splits:     { tried: false, count: 0, filteredCount: 0, error: null, sampleKeys: null, sampleJobId: null },
    grossPay:   { tried: false, count: 0, filteredCount: 0, error: null, sampleKeys: null, sampleJobId: null },
    jobIdLookups: { jobId: job.id, jobNumber: job.jobNumber || jn },
  };
  if (job.id) {
    const techMap = await st.getTechniciansMap().catch(() => new Map());

    // Three Payroll endpoints, in order of preference:
    //   1. /payroll/v2/jobs/timesheets   — actual time entries (paidDurationHours per appt)
    //   2. /payroll/v2/jobs/splits       — labor allocation per tech (split fraction or hours)
    //   3. /payroll/v2/gross-pay-items   — payroll-batched line items (often 0 for new jobs)
    const [timesheetsResult, splitsResult, grossPayResult] = await Promise.allSettled([
      st.getJobTimesheets(job.id),
      st.getJobLaborSplits(job.id),
      st.getJobGrossPayItems(job.id),
    ]);

    // Lenient match: ST tenants vary in how they shape these payloads —
    // jobId may live at the top level, nested under .job.id, or be returned
    // as a string. Job number sometimes substitutes for job ID. Try them all.
    const wantedId  = String(job.id);
    const wantedNum = String(job.jobNumber || jn);
    const matchesThisJob = row => {
      const candidates = [
        row.jobId, row.JobId, row.parentJobId,
        row.job?.id, row.job?.jobId,
        row.jobNumber, row.JobNumber, row.job?.number, row.job?.jobNumber,
      ];
      return candidates.some(c => c != null && (String(c) === wantedId || String(c) === wantedNum));
    };

    const recordDebug = (key, result) => {
      debug[key].tried = true;
      if (result.status === "fulfilled") {
        debug[key].count = result.value.length;
        if (result.value[0]) {
          debug[key].sampleKeys  = Object.keys(result.value[0]).slice(0, 24);
          debug[key].sampleJobId = result.value[0].jobId ?? result.value[0].job?.id ?? null;
        }
      } else {
        debug[key].error = liveErrLabel(result.reason);
      }
    };
    recordDebug("timesheets", timesheetsResult);
    recordDebug("splits",     splitsResult);
    recordDebug("grossPay",   grossPayResult);

    // Try endpoints in order — first that returns matching rows wins.
    let liveRows = [];
    let liveSource = null;

    if (timesheetsResult.status === "fulfilled") {
      const filtered = timesheetsResult.value.filter(matchesThisJob);
      debug.timesheets.filteredCount = filtered.length;
      if (filtered.length > 0) {
        liveRows = filtered;
        liveSource = "timesheets";
      }
    }

    if (liveRows.length === 0 && splitsResult.status === "fulfilled") {
      const filtered = splitsResult.value.filter(matchesThisJob);
      debug.splits.filteredCount = filtered.length;
      if (filtered.length > 0) {
        // Splits return a `split` field (a labor-allocation fraction or raw
        // hours depending on tenant config). When we only have splits to work
        // with, we have to derive hours from appointment durations: each
        // tech's hours = (their split fraction) * (sum of appointment hours).
        const totalApptHours = appointments.reduce(
          (s, a) => s + hoursBetween(a.start, a.end), 0
        );
        liveRows = filtered.map(s => {
          // If `split` ≤ 1 it's a fraction; if > 1 it's raw hours.
          const splitVal = num(s.split);
          const hours = splitVal <= 1 ? splitVal * totalApptHours : splitVal;
          return {
            ...s,
            _derivedHours: hours,
            _derivedAppointmentTotal: totalApptHours,
          };
        });
        liveSource = "splits";
      }
    }

    if (liveRows.length === 0 && grossPayResult.status === "fulfilled") {
      const filtered = grossPayResult.value.filter(matchesThisJob);
      debug.grossPay.filteredCount = filtered.length;
      if (filtered.length > 0) {
        liveRows = filtered;
        liveSource = "gross-pay";
      }
    }

    // Normalize each raw row into 0..2 timeline entries. The `jobs/timesheets`
    // endpoint gives us dispatchedOn/arrivedOn/doneOn — split that into a
    // Driving leg and a Working leg so the bucketing matches the cached
    // xlsx imports. Other endpoints get a single entry.
    const normalized = [];
    for (const row of liveRows) {
      const techId = row.technicianId || row.employeeId || row.payrollId;
      const techName = techMap.get(String(techId)) || `Tech ${techId || "?"}`;

      if (liveSource === "timesheets") {
        // For an in-progress job the doneOn is null — substitute "now" so we
        // still surface live hours instead of zeroing the row out.
        const nowIso = new Date().toISOString();
        const dispatched = row.dispatchedOn || null;
        const arrived    = row.arrivedOn    || null;
        const done       = row.doneOn       || (row.canceledOn ? null : nowIso);

        // Driving leg: dispatched → arrived
        const driveDur = arrived ? hoursBetween(dispatched, arrived) : 0;
        if (driveDur > 0) {
          normalized.push({
            techName, activity: "Driving",
            start: new Date(dispatched), end: new Date(arrived),
            dur: driveDur, source: "payroll-timesheet",
          });
        }
        // Working leg: arrived → done (wrench time). If still en-route (no
        // arrival yet), skip — we don't have wrench time yet.
        const workDur = arrived && done ? hoursBetween(arrived, done) : 0;
        if (workDur > 0) {
          normalized.push({
            techName, activity: "Working",
            start: new Date(arrived), end: new Date(done),
            dur: workDur, source: "payroll-timesheet",
          });
        }
        // Final fallback: dispatched but no arrival yet (en-route or just-
        // dispatched). Count it as Driving until arrival is logged. Without
        // this we'd lose all "currently on the way" jobs.
        if (driveDur === 0 && workDur === 0 && dispatched && done) {
          const totalDur = hoursBetween(dispatched, done);
          if (totalDur > 0) {
            normalized.push({
              techName,
              activity: arrived ? "Working" : "Driving",   // en-route → Driving
              start: new Date(dispatched), end: new Date(done),
              dur: totalDur, source: "payroll-timesheet",
            });
          }
        }
      } else {
        // splits or gross-pay-items
        const dur = num(row._derivedHours)
                  || num(row.paidDurationHours)
                  || num(row.hoursWorked)
                  || num(row.regularHours)
                  || hoursBetween(row.startedOn || row.startsAt || row.date,
                                  row.endedOn   || row.endsAt);
        if (dur <= 0) continue;

        const activity = row.activity || row.payoutType || row.paidTimeType || "Working";
        const start = (row.startedOn || row.startsAt) ? new Date(row.startedOn || row.startsAt) : null;
        const end   = (row.endedOn   || row.endsAt)   ? new Date(row.endedOn   || row.endsAt)   : null;
        normalized.push({
          techName, activity, start, end, dur,
          source: liveSource === "gross-pay" ? "payroll-gp" : "payroll-split (derived)",
        });
      }
    }

    // Bucket each normalized entry into the per-tech aggregate + timeline.
    for (const n of normalized) {
      const t = techHours[n.techName] = techHours[n.techName] || {
        tech: n.techName, working: 0, driving: 0, idle: 0, jobPrep: 0, total: 0,
      };
      const a = String(n.activity || "Working").toLowerCase();
      const bucket = a.includes("driv")  ? "driving"
                   : a.includes("idle")  ? "idle"
                   : a.includes("prep")  ? "jobPrep"
                   : "working";
      t[bucket] += n.dur;
      t.total   += n.dur;

      const dateKey = n.start ? n.start.toISOString().slice(0, 10) : null;
      if (dateKey) dayList.add(dateKey);
      entries.push({
        tech: n.techName,
        date: dateKey,
        activity: n.activity,
        startTime: n.start ? toLocalTime(n.start) : "",
        endTime:   n.end   ? toLocalTime(n.end)   : "",
        durationHours: n.dur,
        source: n.source,
      });
      liveRowsFound++;
    }
    if (liveRowsFound > 0) sources.push("payroll-api");

    // Surface auth failures as actionable warnings
    for (const r of [timesheetsResult, splitsResult, grossPayResult]) {
      if (r.status !== "rejected") continue;
      const status = r.reason?.response?.status;
      if (status === 401 || status === 403) {
        warnings.push(`Payroll API: scope not granted (${status}) — request the Payroll v2 scope on the ST app.`);
      } else if (status === 404) {
        // 404 on one endpoint is fine if the other returned data; only warn
        // when nothing came back at all.
        if (liveRowsFound === 0) warnings.push(`Payroll API endpoint returned 404 — verify the tenant has Payroll v2 enabled.`);
      } else if (liveRowsFound === 0) {
        warnings.push(`Payroll API fetch failed: ${r.reason?.message || r.reason}`);
      }
    }
  }

  function liveErrLabel(err) {
    const status = err?.response?.status;
    return status ? `${status} ${err.response?.statusText || ""}`.trim() : (err?.message || "error");
  }

  // ── (b) Cache scan — runs only if live API returned no matching rows ──
  // Cache is the secondary source for jobs whose live data isn't available
  // (older months, or any job ST didn't return rows for).
  if (liveRowsFound === 0) {
    scanCachedTimesheets();
    if (cacheRowsFound > 0) sources.push("cache");
  }

  // ── (c) Appointment-duration fallback (only if both above came up empty) ──
  // Use scheduled appointment windows multiplied by the number of techs on
  // each appointment. This is rough but gives the user *something* when both
  // the cache and Payroll API are unavailable.
  let appointmentEstUsed = false;
  if (cacheRowsFound === 0 && liveRowsFound === 0 && appointments.length > 0) {
    try {
      const techMap = await st.getTechniciansMap().catch(() => new Map());
      for (const a of appointments) {
        const dur = hoursBetween(a.start, a.end);
        if (dur <= 0) continue;
        const dateKey = a.start ? new Date(a.start).toISOString().slice(0, 10) : null;
        if (dateKey) dayList.add(dateKey);
        const techIds = (a.technicianIds && a.technicianIds.length) ? a.technicianIds : [null];
        for (const tid of techIds) {
          const techName = techMap.get(String(tid)) || `Tech ${tid || "(unassigned)"}`;
          const t = techHours[techName] = techHours[techName] || {
            tech: techName, working: 0, driving: 0, idle: 0, jobPrep: 0, total: 0,
          };
          t.working += dur;
          t.total   += dur;
          entries.push({
            tech: techName,
            date: dateKey,
            activity: "Scheduled",
            startTime: a.start ? toLocalTime(new Date(a.start)) : "",
            endTime:   a.end   ? toLocalTime(new Date(a.end))   : "",
            durationHours: dur,
            source: "appointment",
          });
        }
      }
      appointmentEstUsed = true;
      sources.push("appointment-estimate");
      // Build a precise reason so the user can see why we're estimating.
      const reasons = [];
      if (debug.timesheets.tried && debug.timesheets.error) reasons.push(`jobs/timesheets: ${debug.timesheets.error}`);
      else if (debug.timesheets.tried)                       reasons.push(`jobs/timesheets returned ${debug.timesheets.count} row(s), 0 matched this job`);
      if (cacheRowsFound === 0) reasons.push("no cached timesheet entries for this job");
      warnings.push(`Tech hours are SCHEDULED ESTIMATES (not real timesheet data) — ${reasons.join("; ") || "no live or cached data available"}. Likely the techs haven't logged time on this job yet.`);
    } catch (e) {
      warnings.push(`appointment-based estimate failed: ${e.message}`);
    }
  }

  const techArr = Object.values(techHours)
    .map(t => ({
      tech: t.tech,
      working:  round1(t.working),
      driving:  round1(t.driving),
      idle:     round1(t.idle),
      jobPrep:  round1(t.jobPrep),
      total:    round1(t.total),
    }))
    .sort((a, b) => b.total - a.total);

  const fleetHours = techArr.reduce((acc, t) => {
    acc.working += t.working;
    acc.driving += t.driving;
    acc.idle    += t.idle;
    acc.jobPrep += t.jobPrep;
    acc.total   += t.total;
    return acc;
  }, { working: 0, driving: 0, idle: 0, jobPrep: 0, total: 0 });
  for (const k of Object.keys(fleetHours)) fleetHours[k] = round1(fleetHours[k]);

  entries.sort((a, b) =>
    (a.date || "").localeCompare(b.date || "") ||
    (a.startTime || "").localeCompare(b.startTime || "")
  );

  // ── 6. Labor cost — three priority sources ─────────────────────────────
  //
  //   1. Explicit override (query ?laborRate=N or LABOR_RATE env)
  //      → flat rate × paid hours
  //
  //   2. Cached job from monthly-cache (the WIP xlsx import has actual
  //      laborCost from "Total Labor Costs")
  //      → use it directly
  //
  //   3. Per-tech rates derived from cached history (median of single-tech
  //      jobs the tech appeared on)
  //      → Σ tech.hours × rate(tech.name), with fleet median as the fallback
  //        for techs we have no rate data for
  //
  // Total paid hours we charge labor against = wrench + drive.
  const paidLaborHours = fleetHours.working + fleetHours.driving;
  const overrideRate = num(req.query.laborRate) || num(process.env.LABOR_RATE);

  // Look for this job in the cached jobs.json files so we can use its actual
  // laborCost when present.
  let cachedJob = null;
  try {
    if (fs.existsSync(loader.CACHE_ROOT)) {
      for (const dir of fs.readdirSync(loader.CACHE_ROOT)) {
        const jp = path.join(loader.CACHE_ROOT, dir, "jobs.json");
        if (!fs.existsSync(jp)) continue;
        const arr = JSON.parse(fs.readFileSync(jp, "utf8"));
        const found = arr.find(j => String(j.jobNumber).trim() === jn);
        if (found) { cachedJob = found; break; }
      }
    }
  } catch (e) {
    warnings.push(`cached jobs scan failed: ${e.message}`);
  }

  let laborCost;
  let laborRate;       // effective rate ($/hr) — for display
  let laborSource;     // where the number came from
  let laborBreakdown = null;   // optional per-tech detail
  if (overrideRate) {
    laborRate   = overrideRate;
    laborCost   = round0(paidLaborHours * laborRate);
    laborSource = `manual override · $${overrideRate}/hr × ${round1(paidLaborHours)} hrs`;
  } else if (cachedJob && Number(cachedJob.laborCost) > 0) {
    laborCost   = round0(cachedJob.laborCost);
    laborRate   = paidLaborHours > 0 ? Math.round(laborCost / paidLaborHours) : 0;
    laborSource = `cached WIP xlsx (Total Labor Costs)`;
  } else {
    // Build per-tech labor cost from the rate map
    const rateMap = getLaborRateMap();
    let total = 0;
    let weightedSum = 0;
    let weight      = 0;
    const breakdownByTech = [];
    for (const t of techArr) {
      const techPaidHrs = (t.working || 0) + (t.driving || 0);
      if (techPaidHrs <= 0) continue;
      const rate = rateMap.perTech.get(t.tech) || rateMap.fleetMedian;
      const cost = techPaidHrs * rate;
      total       += cost;
      weightedSum += rate * techPaidHrs;
      weight      += techPaidHrs;
      breakdownByTech.push({
        tech: t.tech, hours: round1(techPaidHrs), rate: round0(rate),
        cost: round0(cost), source: rateMap.perTech.has(t.tech) ? "tech-history" : "fleet-median",
      });
    }
    laborCost      = round0(total);
    laborRate      = weight > 0 ? Math.round(weightedSum / weight) : rateMap.fleetMedian;
    laborSource    = `per-tech rates (median across ${rateMap.sampleSize} cached jobs)`;
    laborBreakdown = breakdownByTech;
  }

  // Two views of profit so the user can pick:
  //   • preLaborGP   — billed − materials       (a.k.a. contribution margin)
  //   • netGP        — billed − materials − labor (true gross profit)
  const preLaborGP    = invTotals.billed - invTotals.materialCost;
  const preLaborGPpct = invTotals.billed > 0
    ? round1((preLaborGP / invTotals.billed) * 100) : 0;
  const grossProfit   = preLaborGP - laborCost;
  const grossMarginPct = invTotals.billed > 0
    ? round1((grossProfit / invTotals.billed) * 100) : 0;

  // Two productivity rates:
  //   • $/wrench hour — billed / hours actively working on the job
  //   • $/paid hour   — billed / (wrench + drive) — accounts for windshield time
  const dollarsPerWrenchHr = fleetHours.working > 0
    ? Math.round(invTotals.billed / fleetHours.working) : 0;
  const dollarsPerPaidHr   = paidLaborHours > 0
    ? Math.round(invTotals.billed / paidLaborHours) : 0;

  // ── 7. On-time verdict (first appointment vs. earliest "Working" arrival)
  const onTime = computeOnTime(appointments, entries);

  res.json({
    job: {
      jobNumber:   job.jobNumber || jn,
      jobId:       job.id,
      type:        job.jobTypeName || job.jobType || "—",
      status:      job.jobStatus || job.status || "—",
      priority:    job.priority || "",
      summary:     job.summary || "",
      noCharge:    !!job.noCharge,
      createdOn:   job.createdOn,
      completedOn: job.completedOn,
      modifiedOn:  job.modifiedOn,
      customerId:  job.customerId,
      locationId:  job.locationId,
      businessUnit: job.businessUnitName || (job.businessUnit && job.businessUnit.name) || "",
      campaign:    job.campaignName || (job.campaign && job.campaign.name) || "",
      technicians: Array.isArray(job.technicians) ? job.technicians : [],
    },
    customer: customer ? {
      id:    customer.id,
      name:  customer.name,
      type:  customer.type,
      email: customer.email,
      phoneSettings: customer.phoneSettings || null,
    } : null,
    location: location ? {
      id:      location.id,
      name:    location.name,
      address: location.address || null,
    } : null,
    appointments: appointments.map(a => ({
      appointmentId:        a.id,
      appointmentNumber:    a.appointmentNumber,
      scheduledStart:       a.start,
      scheduledEnd:         a.end,
      arrivalWindowStart:   a.arrivalWindowStart,
      arrivalWindowEnd:     a.arrivalWindowEnd,
      status:               a.status,
      technicianIds:        a.technicianIds || [],
      specialInstructions:  a.specialInstructions || "",
    })),
    invoices,
    invoiceTotals: {
      billed:         round0(invTotals.billed),
      subtotal:       round0(invTotals.subtotal),
      tax:            round0(invTotals.tax),
      balance:        round0(invTotals.balance),
      itemCount:      invTotals.items,
      materialCost:   round0(invTotals.materialCost),
      serviceRevenue: round0(invTotals.serviceRevenue),
    },
    techHours: {
      perTech: techArr,
      fleet:   fleetHours,
      uniqueDays: dayList.size,
      entries,                  // chronological raw entries for the timeline view
      sources,                  // which data feeds contributed (cache | payroll-api | appointment-estimate)
      estimated: appointmentEstUsed,  // true when only the appointment fallback was used
    },
    headline: {
      billed:            round0(invTotals.billed),
      materialCost:      round0(invTotals.materialCost),
      laborCost,                       // dollars
      laborRate,                       // effective $/hr for this job
      laborSource,                     // where the labor cost came from
      laborBreakdown,                  // [{tech, hours, rate, cost, source}] (null when override or cached)
      paidLaborHours:    round1(paidLaborHours),
      preLaborGP:        round0(preLaborGP),
      preLaborGPpct,
      grossProfit:       round0(grossProfit),  // net of materials AND labor
      grossMarginPct,                  // net margin
      wrenchHours:       fleetHours.working,
      drivingHours:      fleetHours.driving,
      totalLaborHours:   fleetHours.total,
      dollarsPerWrenchHr,
      dollarsPerPaidHr,
      techCount:         techArr.length,
      uniqueDays:        dayList.size,
      appointmentCount:  appointments.length,
      invoiceCount:      invoices.length,
    },
    onTime,
    warnings,
    debug: {
      payroll: debug,
      cacheRows: cacheRowsFound,
      liveRows:  liveRowsFound,
    },
  });
});

// ── helpers ────────────────────────────────────────────────────────────────
function num(x) { return typeof x === "number" && !isNaN(x) ? x : (parseFloat(x) || 0); }
function round0(x) { return Math.round(num(x)); }
function round1(x) { return Math.round(num(x) * 10) / 10; }

/**
 * Pair the first scheduled appointment with the earliest matching "Working"
 * timesheet entry on the same date, and produce a verdict that the UI can
 * render as a single colored badge.
 */
function computeOnTime(appointments, entries) {
  if (!appointments.length || !entries.length) return null;
  const first = appointments[0];
  if (!first || !first.start) return null;

  const sched = new Date(first.arrivalWindowStart || first.start);
  if (isNaN(sched.getTime())) return null;
  const schedDateKey = isoDateKey(sched);

  // Find the earliest "Working" entry on the same date, in Central Time.
  const sameDayWorking = entries.filter(
    e => e.date === schedDateKey && e.activity === "Working" && e.startTime
  );
  if (!sameDayWorking.length) return null;

  let earliest = null;
  for (const e of sameDayWorking) {
    // Build a Central-time anchored timestamp: the timesheet times are local
    // to the shop's timezone (America/Chicago). Honor DST roughly using -05
    // for Mar–Nov and -06 for Dec–Feb. Same heuristic the monthly review uses.
    const offset = isCentralDST(sched) ? "-05:00" : "-06:00";
    const dt = new Date(`${e.date}T${e.startTime}:00${offset}`);
    if (!earliest || dt < earliest) earliest = dt;
  }
  if (!earliest) return null;

  const diffMin = Math.round((earliest - sched) / 60000);
  let verdict;
  if (diffMin <= 0)       verdict = "EARLY";
  else if (diffMin <= 10) verdict = "ON TIME";
  else if (diffMin <= 30) verdict = "WITHIN +30 min";
  else                    verdict = "LATE";

  return {
    scheduledStart: first.arrivalWindowStart || first.start,
    actualArrival:  earliest.toISOString(),
    diffMinutes:    diffMin,
    verdict,
  };
}

function isoDateKey(d) {
  // Use America/Chicago calendar date — close enough; a second-level
  // resolution isn't necessary here.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}
function isCentralDST(d) {
  const m = d.getUTCMonth() + 1;
  return m >= 3 && m <= 11;
}

// Difference in hours between two ISO timestamps. Returns 0 for invalid input.
function hoursBetween(startISO, endISO) {
  if (!startISO || !endISO) return 0;
  const s = new Date(startISO).getTime();
  const e = new Date(endISO).getTime();
  if (isNaN(s) || isNaN(e) || e <= s) return 0;
  return (e - s) / 3600000;
}

// "HH:MM" in America/Chicago for an ISO timestamp.
function toLocalTime(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return "";
  try {
    return d.toLocaleTimeString("en-US", {
      timeZone: "America/Chicago",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  } catch { return ""; }
}

module.exports = router;
