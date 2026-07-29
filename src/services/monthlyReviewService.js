/**
 * monthlyReviewService.js
 * ────────────────────────────────────────────────────────────────────────────
 * All calculation logic for the monthly operational review.
 *
 * Inputs are two arrays of plain objects:
 *
 *   jobs[]       — completed/in-progress/canceled jobs for the period:
 *     {
 *       jobNumber, jobType, status,            // 'Completed' | 'In Progress' | 'Canceled' | 'Scheduled'
 *       billed,    materialCost,  laborCost,   // numbers
 *       hours,     gm,                         // numbers (hours = ST "Total Hours Worked"; gm = jobs gross margin)
 *       customerId, technicians,  createdDate, // strings
 *       summary
 *     }
 *
 *   timesheets[] — per-tech activity entries for the period:
 *     {
 *       tech, businessUnit, date, activity,    // activity ∈ {Working, WORKING CONSTRUCTION JOB, Driving, Idle,
 *                                              //              OFF / UNPAID, Training, Meeting, Meal, Job Prep, ...}
 *       startTime, endTime, durationHours,     // numbers
 *       jobNumber                              // optional
 *     }
 *
 * Returns a fully aggregated review object suitable for the dashboard UI.
 *
 * Key calculation rules (matched to the March 2026 written review):
 *   • Idle entries longer than 8 hrs are treated as timesheet artifacts and
 *     dropped (missed clock-out events that auto-fill end-of-shift / weekend
 *     days as "Idle").
 *   • Construction time (activity = "WORKING CONSTRUCTION JOB") is counted
 *     separately. Drive/Idle/Other time is allocated to service vs construction
 *     pro rata to each tech's wrench-time mix, so a tech who is 60% on
 *     construction has 60% of their drive/idle attributed to construction.
 *   • "Adjusted utilization" excludes Training and OFF/UNPAID time from the
 *     denominator so techs aren't penalized for scheduled training or PTO.
 *     Both the raw and adjusted util numbers are returned so the UI can show
 *     both.
 * ────────────────────────────────────────────────────────────────────────────
 */

const PRODUCTIVE_ACTIVITIES = new Set(["Working", "WORKING CONSTRUCTION JOB"]);
const NON_BILLABLE_ACTIVITIES = new Set([
  "Training", "Meeting", "Meal", "Job Prep", "DR", "Stand By", "Home By Tech Choice",
]);
const IDLE_ARTIFACT_THRESHOLD_HOURS = 8;
const FULL_OFF_DAY_THRESHOLD_HOURS = 4;   // OFF/UNPAID block ≥4 hrs counts as a full PTO day

// Techs to exclude from on-time analysis. The install crew works scheduled
// all-day jobs rather than customer arrival windows, so their "arrival" times
// are meaningless here and would drag the whole metric down.
const ONTIME_EXCLUDE_TECHS = new Set(["Jonah Whitfield", "Andre Sokoloff", "Bryce Hallowell"]);

// Grace window for "on time" classification. A tech who arrives within this
// many minutes of the scheduled start counts as on time. Tighten or loosen
// here as company standards change.
const ON_TIME_GRACE_MINUTES = 10;

// Job summaries contain dispatch windows in the form "M/D/YY - X-Y ...":
//   "3/9/2026 - 7-9 NO HEAT"            → 7am-9am
//   "3/24/2026 - 11-1 - CHILLER UNIT"   → 11am-1pm
//   "03/09/26 - 1-3 NO HEAT"             → 1pm-3pm
const SCHEDULE_WINDOW_REGEX = /(\d{1,2})\/(\d{1,2})\/((?:20)?\d{2})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})\b/g;

function num(x) { return typeof x === "number" && !isNaN(x) ? x : 0; }
function safeDiv(a, b) { return b > 0 ? a / b : 0; }

// ── 1. JOBS aggregation ─────────────────────────────────────────────────────
function aggregateJobs(jobs) {
  const byStatus = {};
  const byType   = {};
  let zeroBilled = [];   // completed jobs that closed without an invoice
  let zeroBilledWithMaterials = []; // subset: had materials installed but $0 billed

  // Operational view = jobs with full cost data ("matched" — both revenue
  // AND cost from this period's WIP). Excludes jc-only carry-overs whose
  // costs were absorbed in prior fiscal periods and would inflate GM.
  const operational = { count: 0, hours: 0, billed: 0, materials: 0, labor: 0, gm: 0 };

  for (const j of jobs) {
    const status = j.status || "Unknown";
    const s = byStatus[status] = byStatus[status] || {
      count: 0, hours: 0, billed: 0, materials: 0, labor: 0, gm: 0,
    };
    s.count++;
    s.hours     += num(j.hours);
    s.billed    += num(j.billed);
    s.materials += num(j.materialCost);
    s.labor     += num(j.laborCost);
    s.gm        += num(j.gm);

    // Track operational subset (Completed jobs with cost data attached)
    if (status === "Completed" && j._hasCostData !== false && j._source !== "jc-only") {
      operational.count++;
      operational.hours     += num(j.hours);
      operational.billed    += num(j.billed);
      operational.materials += num(j.materialCost);
      operational.labor     += num(j.laborCost);
      operational.gm        += num(j.gm);
    }

    if (status === "Completed") {
      const t = byType[j.jobType] = byType[j.jobType] || {
        jobs: 0, hours: 0, billed: 0, materials: 0, labor: 0, gm: 0,
      };
      t.jobs++;
      t.hours     += num(j.hours);
      t.billed    += num(j.billed);
      t.materials += num(j.materialCost);
      t.labor     += num(j.laborCost);
      t.gm        += num(j.gm);

      if (num(j.billed) === 0 && (num(j.hours) > 0 || num(j.laborCost) > 0)) {
        const entry = {
          jobNumber: j.jobNumber, jobType: j.jobType, createdDate: j.createdDate,
          hours: num(j.hours), labor: num(j.laborCost), materials: num(j.materialCost),
          technicians: j.technicians || "", customerId: j.customerId || null,
        };
        zeroBilled.push(entry);
        if (entry.materials > 0) zeroBilledWithMaterials.push(entry);
      }
    }
  }

  // Decorate per-type with derived metrics
  const types = Object.entries(byType).map(([name, t]) => ({
    name,
    jobs: t.jobs, hours: round1(t.hours), billed: round0(t.billed),
    materials: round0(t.materials), labor: round0(t.labor), gm: round0(t.gm),
    dollarsPerHour: round0(safeDiv(t.billed, t.hours)),
    laborMultiplier: round1(safeDiv(t.billed, t.labor)),
    gmPct: round1(safeDiv(t.gm, t.billed) * 100),
  })).sort((a, b) => b.billed - a.billed);

  // Same-customer pairing for $0-billed-with-materials → potential follow-up bills
  const customerMap = {};
  for (const j of jobs) {
    if (!j.customerId) continue;
    (customerMap[j.customerId] = customerMap[j.customerId] || []).push(j);
  }
  zeroBilledWithMaterials = zeroBilledWithMaterials.map(z => {
    const sameCust = (customerMap[z.customerId] || [])
      .filter(o => o.jobNumber !== z.jobNumber)
      .filter(o => new Date(o.createdDate) >= new Date(z.createdDate))
      .filter(o => num(o.billed) > 0)
      .sort((a, b) => new Date(a.createdDate) - new Date(b.createdDate));
    z.followUp = sameCust[0]
      ? {
          jobNumber: sameCust[0].jobNumber,
          jobType: sameCust[0].jobType,
          createdDate: sameCust[0].createdDate,
          billed: num(sameCust[0].billed),
          materials: num(sameCust[0].materialCost),
        }
      : null;
    return z;
  });

  return {
    byStatus,
    byType: types,
    zeroBilled,
    zeroBilledWithMaterials,
    operational,
  };
}

// ── 2. TIMESHEETS aggregation ───────────────────────────────────────────────
function aggregateTimesheets(timesheets, options = {}) {
  const { idleArtifactThreshold = IDLE_ARTIFACT_THRESHOLD_HOURS } = options;

  // Strip timesheet artifacts (long idle blocks)
  let removedArtifactHours = 0;
  let removedArtifactCount = 0;
  const cleaned = [];
  for (const e of timesheets) {
    const dur = num(e.durationHours);
    if (!e.tech || dur <= 0 || dur > 50) continue;
    if (e.activity === "Idle" && dur > idleArtifactThreshold) {
      removedArtifactHours += dur;
      removedArtifactCount++;
      continue;
    }
    cleaned.push(e);
  }

  // Per-tech activity buckets
  const perTech = {};
  for (const e of cleaned) {
    const t = perTech[e.tech] = perTech[e.tech] || {
      tech: e.tech,
      working: 0, construction: 0, driving: 0, idle: 0, off: 0,
      training: 0, meal: 0, meeting: 0, jobPrep: 0, other: 0,
      offDays: 0, trainingDays: 0,
    };
    const dur = num(e.durationHours);
    switch (e.activity) {
      case "Working":                      t.working += dur; break;
      case "WORKING CONSTRUCTION JOB":     t.construction += dur; break;
      case "Driving":                      t.driving += dur; break;
      case "Idle":                         t.idle += dur; break;
      case "OFF / UNPAID":                 t.off += dur; if (dur >= FULL_OFF_DAY_THRESHOLD_HOURS) t.offDays += 1; break;
      case "Training":                     t.training += dur; if (dur >= FULL_OFF_DAY_THRESHOLD_HOURS) t.trainingDays += 1; break;
      case "Meal":                         t.meal += dur; break;
      case "Meeting":                      t.meeting += dur; break;
      case "Job Prep":                     t.jobPrep += dur; break;
      default:                             t.other += dur; break;
    }
  }

  // Compute derived per-tech metrics (raw + service-only + adjusted)
  const techs = Object.values(perTech).map(t => {
    const wrenchAll  = t.working + t.construction;
    const otherMisc  = t.training + t.meal + t.meeting + t.jobPrep + t.other;
    const paidAll    = wrenchAll + t.driving + t.idle + otherMisc;

    // Service-only allocation: split drive/idle/other proportionally to
    // service share of wrench time. Construction-only techs (Brad) get most
    // of their drive/idle attributed to construction; mixed techs split.
    const serviceShare = wrenchAll > 0 ? t.working / wrenchAll : 1.0;
    const svcDrive  = t.driving * serviceShare;
    const svcIdle   = t.idle    * serviceShare;
    const svcOther  = otherMisc * serviceShare;
    const svcPaid   = t.working + svcDrive + svcIdle + svcOther;

    // Adjusted utilization: exclude Training + OFF from the denominator
    const trainingShareSvc = t.training * serviceShare;
    const adjustedSvcPaid  = svcPaid - trainingShareSvc;
    const utilSvc          = safeDiv(t.working, svcPaid) * 100;
    const utilSvcAdjusted  = safeDiv(t.working, adjustedSvcPaid) * 100;
    const utilAll          = safeDiv(wrenchAll, paidAll) * 100;

    return {
      tech: t.tech,
      paidAll: round1(paidAll),
      paidService: round1(svcPaid),
      wrenchAll: round1(wrenchAll),
      working: round1(t.working),
      construction: round1(t.construction),
      driving: round1(t.driving),
      svcDriving: round1(svcDrive),
      idle: round1(t.idle),
      svcIdle: round1(svcIdle),
      training: round1(t.training),
      trainingDays: t.trainingDays,
      off: round1(t.off),
      offDays: t.offDays,
      otherMisc: round1(otherMisc),
      svcOtherMisc: round1(svcOther),
      utilAll: round1(utilAll),
      utilService: round1(utilSvc),
      utilServiceAdjusted: round1(utilSvcAdjusted),
    };
  }).sort((a, b) => b.paidService - a.paidService);

  // Fleet-level totals
  const fleet = {
    paidAll: 0, paidService: 0, working: 0, construction: 0,
    driving: 0, svcDriving: 0, idle: 0, svcIdle: 0,
    training: 0, off: 0, otherMisc: 0, svcOtherMisc: 0,
    trainingDays: 0, offDays: 0,
  };
  for (const t of techs) {
    for (const k of Object.keys(fleet)) fleet[k] += num(t[k]);
  }
  fleet.utilAll = round1(safeDiv(fleet.working + fleet.construction, fleet.paidAll) * 100);
  fleet.utilService = round1(safeDiv(fleet.working, fleet.paidService) * 100);
  fleet.utilServiceAdjusted = round1(
    safeDiv(fleet.working, fleet.paidService - fleet.training * safeDiv(fleet.working, fleet.working + fleet.construction)) * 100
  );
  for (const k of Object.keys(fleet)) {
    if (typeof fleet[k] === "number") fleet[k] = round1(fleet[k]);
  }

  return {
    techs,
    fleet,
    artifacts: {
      removedIdleHours: round1(removedArtifactHours),
      removedIdleCount: removedArtifactCount,
    },
  };
}

// ── 3. ON-TIME PERFORMANCE ──────────────────────────────────────────────────
// Parse all "M/D/YY - X-Y" dispatch windows from a job summary. Returns array
// of { date: 'YYYY-MM-DD', startMin, endMin } in 24-hour minutes since midnight.
function parseScheduledWindows(summary) {
  if (!summary || typeof summary !== "string") return [];
  const out = [];
  const seen = new Set();
  SCHEDULE_WINDOW_REGEX.lastIndex = 0;
  let m;
  while ((m = SCHEDULE_WINDOW_REGEX.exec(summary)) !== null) {
    const month = parseInt(m[1], 10);
    const day   = parseInt(m[2], 10);
    let yr      = parseInt(m[3], 10);
    if (yr < 100) yr += 2000;
    const sh    = parseInt(m[4], 10);
    const eh    = parseInt(m[5], 10);
    const win   = parseWindowHours(sh, eh);
    if (!win) continue;
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const dateStr = `${yr}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const key = `${dateStr}|${win[0]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date: dateStr, startMin: win[0], endMin: win[1] });
  }
  return out;
}

function parseWindowHours(s, e) {
  // "7-9" = 7am-9am; "11-1" = 11am-1pm; "1-3" = 1pm-3pm; "12-2" = 12pm-2pm.
  let startH;
  if (s === 12) startH = 12;
  else if (s >= 6 && s <= 11) startH = s;
  else if (s >= 1 && s <= 5)  startH = s + 12;
  else return null;
  let endH;
  if (e === 12) endH = 12;
  else if (e <= 5) endH = e + 12;
  else if (e <= 11 && e > s) endH = e;
  else if (e <= 11 && e < s) endH = e + 12;
  else endH = e;
  return [startH * 60, endH * 60];
}

// Convert a "HH:MM" time string to minutes since midnight.
function parseStartTimeMin(s) {
  if (!s || typeof s !== "string" || !s.includes(":")) return null;
  const [h, m] = s.split(":");
  const hi = parseInt(h, 10);
  const mi = parseInt(m, 10);
  if (isNaN(hi) || isNaN(mi)) return null;
  return hi * 60 + mi;
}

function dateKey(d) {
  if (!d) return null;
  if (typeof d === "string") {
    // Already ISO-ish — strip time
    return d.length >= 10 ? d.slice(0, 10) : null;
  }
  if (d instanceof Date) {
    return d.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Compute on-time performance for the period.
 *
 * Source of truth (in priority order):
 *   1. ServiceTitan appointment data (`appointments[]`) — has real scheduled
 *      `start` time and `arrivalWindowStart`/`arrivalWindowEnd` per appointment.
 *      Far more accurate than parsing dispatch notes.
 *   2. Fallback: parse "M/D/YY - X-Y" patterns from each job's summary.
 *      Used only when no appointments[] are provided.
 *
 * For each scheduled appointment, finds the earliest non-excluded tech's
 * "Working" timesheet entry on that date for that job, then aggregates
 * by scheduled hour and by tech (for the 7am slot).
 */
function computeOnTimePerformance(jobs, timesheets, options = {}) {
  const excludeTechs = new Set(options.excludeTechs || ONTIME_EXCLUDE_TECHS);
  const appointments = options.appointments || [];

  // Build (jobNumber, dateKey) → list of { arrivalMin, tech } from timesheets.
  const arrivals = new Map();
  for (const e of timesheets) {
    if (!e.tech || e.activity !== "Working") continue;
    if (!e.jobNumber) continue;
    const sm = parseStartTimeMin(e.startTime);
    if (sm === null) continue;
    const k = dateKey(e.date);
    if (!k) continue;
    const key = `${String(e.jobNumber).trim()}|${k}`;
    const arr = arrivals.get(key) || [];
    arr.push({ arrivalMin: sm, tech: e.tech });
    arrivals.set(key, arr);
  }

  // Build the list of scheduled windows we'll evaluate against arrivals.
  // Prefer real appointment data when present, fall back to summary parsing.
  let scheduledWindows;
  let dataSource;
  if (appointments.length > 0) {
    dataSource = "servicetitan-appointments";
    // Build jobId → jobNumber lookup from jobs list
    const jobIdToNumber = new Map();
    const jobNumberToJob = new Map();
    for (const j of jobs) {
      if (j.jobId) jobIdToNumber.set(String(j.jobId), j.jobNumber);
      if (j.jobNumber) jobNumberToJob.set(j.jobNumber, j);
    }
    scheduledWindows = appointments
      .map(a => {
        const jobNumber = a.jobNumber || jobIdToNumber.get(String(a.jobId));
        if (!jobNumber) return null;
        // PRIMARY: scheduledStart — the dispatch-board time. Auto-updates
        // when CSRs reschedule, so our on-time metric stays accurate
        // without depending on whether the customer window was kept in sync.
        const sched = parseISOToLocal(a.scheduledStart);
        const end   = parseISOToLocal(a.scheduledEnd) || sched;
        if (!sched) return null;
        return {
          jobNumber,
          date: sched.date,
          startMin: sched.minutes,
          endMin: end ? end.minutes : sched.minutes + 120,
        };
      })
      .filter(Boolean);
  } else {
    dataSource = "summary-parsed";
    scheduledWindows = [];
    for (const j of jobs) {
      const wins = parseScheduledWindows(j.summary);
      for (const w of wins) {
        scheduledWindows.push({ jobNumber: j.jobNumber, ...w });
      }
    }
  }

  const slotBuckets = new Map();
  const tech7am   = new Map();
  const details7am = [];
  let jobsScheduled = 0;
  let jobsMatched = 0;

  for (const w of scheduledWindows) {
    jobsScheduled++;
    const list = arrivals.get(`${w.jobNumber}|${w.date}`);
    if (!list || !list.length) continue;
    const filtered = list.filter(a => !excludeTechs.has(a.tech));
    if (!filtered.length) continue;
    filtered.sort((a, b) => a.arrivalMin - b.arrivalMin);
    const first = filtered[0];
    jobsMatched++;

      const slot = slotBuckets.get(w.startMin) || {
        jobs: 0, strictOnTime: 0, withinGrace: 0, within30: 0, withinWindow: 0, sumArrival: 0,
      };
      slot.jobs++;
      slot.sumArrival += first.arrivalMin;
      if (first.arrivalMin <= w.startMin)                          slot.strictOnTime++;
      if (first.arrivalMin <= w.startMin + ON_TIME_GRACE_MINUTES)  slot.withinGrace++;
      if (first.arrivalMin <= w.startMin + 30)                     slot.within30++;
      if (first.arrivalMin <= w.endMin)                            slot.withinWindow++;
      slotBuckets.set(w.startMin, slot);

      if (w.startMin === 7 * 60) {
        const tt = tech7am.get(first.tech) || { jobs: 0, onTime: 0, withinWindow: 0, sumArrival: 0 };
        tt.jobs++;
        tt.sumArrival += first.arrivalMin;
        if (first.arrivalMin <= w.startMin + ON_TIME_GRACE_MINUTES) tt.onTime++;
        if (first.arrivalMin <= w.endMin)                           tt.withinWindow++;
        tech7am.set(first.tech, tt);

        const status = first.arrivalMin <= w.startMin + ON_TIME_GRACE_MINUTES ? "on-time"
                     : first.arrivalMin <= w.endMin                            ? "in-window"
                     : "late";
        details7am.push({
          jobNumber: w.jobNumber, tech: first.tech, date: w.date,
          arrivalMin: first.arrivalMin, scheduledStart: w.startMin,
          scheduledEnd: w.endMin, status,
        });
      }
  }

  const bySlot = [...slotBuckets.entries()]
    .map(([hour, s]) => ({
      scheduledStart: hour,
      label: minutesToTimeLabel(hour),
      jobs: s.jobs,
      strictOnTime: s.strictOnTime,
      withinGrace: s.withinGrace,
      within30: s.within30,
      withinWindow: s.withinWindow,
      strictOnTimePct: round1(safeDiv(s.strictOnTime, s.jobs) * 100),
      withinGracePct: round1(safeDiv(s.withinGrace, s.jobs) * 100),
      within30Pct: round1(safeDiv(s.within30, s.jobs) * 100),
      withinWindowPct: round1(safeDiv(s.withinWindow, s.jobs) * 100),
      avgArrivalMin: Math.round(safeDiv(s.sumArrival, s.jobs)),
      avgArrivalLabel: minutesToTimeLabel(Math.round(safeDiv(s.sumArrival, s.jobs))),
      // Back-compat aliases (legacy field names — treat the +15 fields as the
      // current grace threshold, even though the underlying value is now 10 min)
      onTime: s.strictOnTime,
      within15: s.withinGrace,
      onTimePct: round1(safeDiv(s.strictOnTime, s.jobs) * 100),
      within15Pct: round1(safeDiv(s.withinGrace, s.jobs) * 100),
    }))
    .sort((a, b) => a.scheduledStart - b.scheduledStart);

  const byTech7am = [...tech7am.entries()]
    .map(([tech, s]) => ({
      tech,
      jobs: s.jobs,
      onTime: s.onTime,
      withinWindow: s.withinWindow,
      onTimePct: round1(safeDiv(s.onTime, s.jobs) * 100),
      avgArrivalMin: Math.round(safeDiv(s.sumArrival, s.jobs)),
      avgArrivalLabel: minutesToTimeLabel(Math.round(safeDiv(s.sumArrival, s.jobs))),
    }))
    .sort((a, b) => b.onTimePct - a.onTimePct || b.jobs - a.jobs);

  return {
    bySlot,
    byTech7am,
    details7am: details7am.sort((a, b) => a.date.localeCompare(b.date) || a.arrivalMin - b.arrivalMin),
    totals: { jobsScheduled, jobsMatched },
    excludedTechs: [...excludeTechs],
    onTimeGraceMinutes: ON_TIME_GRACE_MINUTES,
    dataSource,
  };
}

/**
 * Parse an ISO timestamp into { date: 'YYYY-MM-DD', minutes: <minutes since midnight LOCAL> }.
 * ServiceTitan returns appointment timestamps in UTC. We want the *local* hour
 * the appointment was scheduled (a 7am appointment at the customer's site),
 * so we honor the offset baked into the timestamp string when present.
 */
function parseISOToLocal(iso) {
  if (!iso) return null;
  const s = String(iso);
  // Pattern: YYYY-MM-DDTHH:MM:SS[.fff][Z|±HH:MM]
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?/);
  if (!m) return null;
  const [, yr, mo, da, hh, mm, tz] = m;
  // If timestamp is bare-Z (UTC), assume the user's tenant is in Central Time
  // (this shop's timezone). For unambiguous offsets (e.g. -05:00) honor them.
  if (!tz || tz === "Z") {
    // Convert UTC → America/Chicago. CST = UTC-6, CDT = UTC-5. March in Chicago
    // is in CDT (DST starts 2nd Sunday of March), so use -5. April–Oct same.
    // For Nov–Feb use -6. This is a pragmatic shortcut; the full Intl.DateTimeFormat
    // approach would be more rigorous but adds complexity for marginal correctness.
    const moNum = parseInt(mo, 10);
    const offsetHours = isCentralDST(parseInt(yr, 10), moNum, parseInt(da, 10)) ? -5 : -6;
    let h = parseInt(hh, 10) + offsetHours;
    let dayShift = 0;
    if (h < 0) { h += 24; dayShift = -1; }
    else if (h >= 24) { h -= 24; dayShift = 1; }
    let date = `${yr}-${mo}-${da}`;
    if (dayShift !== 0) {
      const d = new Date(`${yr}-${mo}-${da}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + dayShift);
      date = d.toISOString().slice(0, 10);
    }
    return { date, minutes: h * 60 + parseInt(mm, 10) };
  }
  // Explicit offset — strip it; the HH:MM is already in the customer's local zone
  return { date: `${yr}-${mo}-${da}`, minutes: parseInt(hh, 10) * 60 + parseInt(mm, 10) };
}

// Return true if the given date is in US Central Daylight Time (rough rule).
function isCentralDST(year, month, day) {
  // DST: 2nd Sunday in March → 1st Sunday in November
  if (month < 3 || month > 11) return false;
  if (month > 3 && month < 11) return true;
  // March: DST starts 2nd Sunday. Find that date.
  if (month === 3) {
    const secondSunday = nthSundayOfMonth(year, 3, 2);
    return day >= secondSunday;
  }
  // November: DST ends 1st Sunday.
  if (month === 11) {
    const firstSunday = nthSundayOfMonth(year, 11, 1);
    return day < firstSunday;
  }
  return false;
}
function nthSundayOfMonth(year, month, n) {
  const d = new Date(Date.UTC(year, month - 1, 1));
  const dayOfWeek = d.getUTCDay(); // 0=Sun
  const firstSunday = 1 + ((7 - dayOfWeek) % 7);
  return firstSunday + (n - 1) * 7;
}

function minutesToTimeLabel(min) {
  if (min == null || isNaN(min)) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h < 12 ? "am" : "pm";
  const dispH = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${dispH}:${String(m).padStart(2, "0")}${ampm}`;
}

// ── 3.5. PER-TECH IMPLIED LABOR RATE ───────────────────────────────────────
// ServiceTitan stores a burdened labor rate per technician and uses it to
// compute "Total Labor Costs" on each job. We can back-solve that rate by
// dividing labor cost by hours on solo-tech jobs only (multi-tech jobs blend
// rates and aren't usable for per-tech rate detection).
function computeLaborRates(jobs) {
  const perTech = {}; // tech -> { laborCost, hours, jobs }
  let fleetCost = 0, fleetHours = 0;

  for (const j of jobs) {
    if (j.status !== "Completed") continue;
    const labor = num(j.laborCost);
    const hours = num(j.hours);
    if (labor <= 0 || hours <= 0) continue;
    fleetCost += labor; fleetHours += hours;

    const techStr = (j.technicians || "").trim();
    if (!techStr) continue;
    const techs = techStr.split(",").map(t => t.trim()).filter(Boolean);
    // Only use solo-tech jobs for per-tech rate inference
    if (techs.length !== 1) continue;
    const t = techs[0];
    const rec = perTech[t] = perTech[t] || { laborCost: 0, hours: 0, jobs: 0 };
    rec.laborCost += labor;
    rec.hours += hours;
    rec.jobs += 1;
  }

  const fleetImpliedRate = fleetHours > 0 ? fleetCost / fleetHours : 0;
  const techRates = Object.entries(perTech)
    .map(([tech, r]) => ({
      tech, jobs: r.jobs, hours: round1(r.hours), laborCost: Math.round(r.laborCost),
      impliedRate: r.hours > 0 ? Math.round((r.laborCost / r.hours) * 100) / 100 : 0,
    }))
    .filter(r => r.hours >= 1) // need at least 1 hr of solo work to have a meaningful rate
    .sort((a, b) => b.impliedRate - a.impliedRate);

  return {
    fleet: {
      totalLaborCost:   Math.round(fleetCost),
      totalWrenchHours: round1(fleetHours),
      impliedRate:      round1(fleetImpliedRate),
    },
    perTech: techRates,
  };
}

// ── 4. Combined review ──────────────────────────────────────────────────────
function buildReview({ year, month, jobs, timesheets, appointments = [], options = {} }) {
  const jobAgg = aggregateJobs(jobs);
  const tsAgg  = aggregateTimesheets(timesheets, options);
  const onTime = computeOnTimePerformance(jobs, timesheets, { ...options, appointments });
  const laborRates = computeLaborRates(jobs);

  const completed = jobAgg.byStatus.Completed || { count: 0, hours: 0, billed: 0, materials: 0, labor: 0, gm: 0 };
  const inProgress = jobAgg.byStatus["In Progress"] || { count: 0, hours: 0, billed: 0, materials: 0, labor: 0, gm: 0 };
  const canceled  = jobAgg.byStatus.Canceled || { count: 0 };
  const scheduled = jobAgg.byStatus.Scheduled || { count: 0 };

  // Headline KPIs (service-only basis)
  const op = jobAgg.operational || { count: 0, billed: 0, gm: 0 };
  const carryoverRevenue = (completed.billed || 0) - (op.billed || 0);
  // Has any cost actually landed for this period? The current month is served
  // live from ServiceTitan, which carries revenue but no material or labor
  // cost — those only arrive when the month-end job-costing workbook is
  // imported. With zero cost, gross margin computes to a triumphant 100%,
  // which is worse than showing nothing: it's a number a reader will believe.
  // Consumers use this flag to render "—" until real cost exists.
  const hasCostData =
    (completed.materials || 0) > 0 || (completed.labor || 0) > 0;

  const headline = {
    billing:        round0(completed.billed),
    grossProfit:    round0(completed.gm),
    grossMarginPct: round1(safeDiv(completed.gm, completed.billed) * 100),
    hasCostData,
    // ── Two-track GM split ─────────────────────────────────────────────
    // Operational: matched-cost jobs only (true profitability of work done
    // this period). Reported: all completed jobs incl. carry-overs (what
    // hits the FY P&L).
    reportedBilling:        round0(completed.billed),
    reportedGrossProfit:    round0(completed.gm),
    reportedGrossMarginPct: round1(safeDiv(completed.gm, completed.billed) * 100),
    operationalBilling:        round0(op.billed),
    operationalGrossProfit:    round0(op.gm),
    operationalGrossMarginPct: round1(safeDiv(op.gm, op.billed) * 100),
    operationalJobCount:       op.count,
    carryoverRevenue:          round0(carryoverRevenue),
    carryoverJobCount:         (completed.count || 0) - (op.count || 0),
    completedJobs:  completed.count,
    canceledJobs:   canceled.count,
    inProgressJobs: inProgress.count,
    scheduledJobs:  scheduled.count,
    serviceUtilization:         tsAgg.fleet.utilService,
    serviceUtilizationAdjusted: tsAgg.fleet.utilServiceAdjusted,
    fleetUtilization:           tsAgg.fleet.utilAll,
    paidServiceHours:    tsAgg.fleet.paidService,
    paidAllHours:        tsAgg.fleet.paidAll,
    constructionHours:   tsAgg.fleet.construction,
    serviceWrenchHours:  tsAgg.fleet.working,
    dollarsPerPaidHour:  round0(safeDiv(completed.billed, tsAgg.fleet.paidService)),
    dollarsPerWrenchHour:round0(safeDiv(completed.billed, tsAgg.fleet.working)),
    // Implied labor cost per wrench hour (from ST job-level data)
    laborCostPerWrenchHour: laborRates.fleet.impliedRate,
    // Margin per wrench hour = revenue/hr − cost/hr
    marginPerWrenchHour: round0(safeDiv(completed.billed, tsAgg.fleet.working) - laborRates.fleet.impliedRate),
  };

  // Top-level on-time KPI for the headline (7am slot — the worst performer
  // and the most operationally meaningful)
  const sevenAm = onTime.bySlot.find(s => s.scheduledStart === 7 * 60);
  if (sevenAm) {
    headline.sevenAmOnTimePct = sevenAm.withinGracePct;
    headline.sevenAmWithinWindowPct = sevenAm.withinWindowPct;
    headline.sevenAmJobs = sevenAm.jobs;
    headline.sevenAmAvgArrival = sevenAm.avgArrivalLabel;
    headline.onTimeGraceMinutes  = onTime.onTimeGraceMinutes;
  }

  return {
    period: { year, month, monthName: monthName(month), label: `${monthName(month)} ${year}` },
    headline,
    jobs: jobAgg,
    timesheets: tsAgg,
    onTime,
    laborRates,
    counts: {
      jobsTotal: jobs.length,
      timesheetEntries: timesheets.length,
      timesheetEntriesCleaned: timesheets.length - tsAgg.artifacts.removedIdleCount,
    },
  };
}

// ── helpers ────────────────────────────────────────────────────────────────
function round0(x) { return Math.round(num(x)); }
function round1(x) { return Math.round(num(x) * 10) / 10; }
function monthName(m) {
  return ["January","February","March","April","May","June","July","August","September","October","November","December"][m - 1] || String(m);
}

module.exports = {
  buildReview,
  aggregateJobs,
  aggregateTimesheets,
  computeOnTimePerformance,
  parseScheduledWindows,
};
