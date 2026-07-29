#!/usr/bin/env node
/**
 * import-monthly-xlsx.js
 * ────────────────────────────────────────────────────────────────────────────
 * Imports a month's WIP-report, Job-Completed-report, and Timesheet xlsx
 * into the monthly-cache so the dashboard's monthly-review page can read past
 * months instantly.
 *
 * The Job Completed (JC) report is optional but RECOMMENDED — it filters by
 * Completion Date (true completion-based revenue recognition) rather than the
 * WIP report's Creation Date (which misses jobs created in prior months but
 * completed this month). Including the JC report typically captures 5–15%
 * more revenue than WIP alone.
 *
 * Usage:
 *   node scripts/import-monthly-xlsx.js \
 *     --year 2025 --month 10 \
 *     --wip "/path/to/102025_WIP.xlsx" \
 *     --jobcompleted "/path/to/102025JC.xlsx" \
 *     --timesheets "/path/to/102025Timesheet.xlsx"
 *
 * Writes:
 *   data/monthly-cache/{year}-{month}/jobs.json           (merged WIP + JC)
 *   data/monthly-cache/{year}-{month}/timesheets.json
 *   data/monthly-cache/{year}-{month}/imported-at.json
 * ────────────────────────────────────────────────────────────────────────────
 */

const path = require("path");
const xlsx = require("xlsx");
const { writeCache } = require(path.join(__dirname, "..", "src", "services", "monthlyDataLoader"));

function parseArgs() {
  const out = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const k = process.argv[i].replace(/^--/, "");
    out[k] = process.argv[i + 1];
  }
  return out;
}

function n(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return v;
  const f = parseFloat(String(v).replace(/[$,]/g, ""));
  return isNaN(f) ? 0 : f;
}
function s(v) { return v === null || v === undefined ? "" : String(v); }

function importWIP(filePath) {
  const wb = xlsx.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: null, raw: true });
  const jobs = [];
  for (const r of rows) {
    const jobNumber = s(r["Job #"] || r["Job Number"] || r.jobNumber);
    if (!jobNumber || jobNumber.length < 5) continue;
    jobs.push({
      jobNumber,
      jobType:      s(r["Job Type"]),
      status:       s(r["Status"]),
      billed:       n(r["Jobs Total"]),
      materialCost: n(r["Materials + Equip. + PO/Bill Costs"]),
      laborCost:    n(r["Total Labor Costs"]),
      hours:        n(r["Total Hours Worked"]),
      gm:           n(r["Jobs Gross Margin"]),
      customerId:   s(r["Customer ID"] || r["customerId"] || ""),
      technicians:  s(r["Assigned Technicians"]),
      createdDate:  parseDate(r["Created Date"]),
      summary:      s(r["Summary"]),
      _source:      "wip",
    });
  }
  return jobs;
}

function importJobCompleted(filePath) {
  const wb = xlsx.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: null, raw: true });
  const jobs = [];
  for (const r of rows) {
    const jobNumber = s(r["Job #"] || r["Job Number"]);
    if (!jobNumber || jobNumber.length < 5) continue;
    jobs.push({
      jobNumber,
      jobId:           s(r["Job ID"]),
      jobType:         s(r["Job Type"]),
      completionDate:  parseDate(r["Completion Date"]),
      customerId:      s(r["Customer ID"] || ""),
      customerName:    s(r["Customer Name"]),
      revenue:         n(r["Jobs Total Revenue"]),
      jobClass:        s(r["Job Class"]),
      soldHours:       n(r["Sold Hours"]),
      hoursWorked:     n(r["Total Hours Worked"]),
      primaryTech:     s(r["Primary Technician"]),
      estimates:       s(r["Estimates"]),
      _source:         "jc",
    });
  }
  return jobs;
}

/**
 * Merge WIP and JC reports into a single canonical "jobs" array.
 *
 * Strategy:
 *   - JC is the source of truth for which jobs count as "completed in this
 *     period" — and what their revenue was. (Revenue recognition follows
 *     completion date, not creation date.)
 *   - WIP supplies cost data (materials, labor) per job, since JC doesn't
 *     have those columns. Jobs in JC but not WIP get their cost data only
 *     if we can find them in a prior month's cache (not done here yet).
 *   - WIP-only jobs (created in period but not yet completed) are kept
 *     with status "In Progress" / "Canceled" / "Scheduled" so aging-WIP
 *     metrics still work.
 *   - WIP jobs marked "Completed" but NOT in JC are usually sub-period
 *     completions where the JC report cut-off doesn't perfectly align.
 *     We trust JC here — if JC didn't include a job, it wasn't completed
 *     in the report's date range.
 */
function mergeJobs(wipJobs, jcJobs) {
  const wipByNum = new Map();
  for (const w of wipJobs) wipByNum.set(w.jobNumber, w);

  const merged = [];
  const usedWipKeys = new Set();

  // Start with every JC job (these are the period's true completions)
  for (const j of jcJobs) {
    const w = wipByNum.get(j.jobNumber);
    if (w) usedWipKeys.add(j.jobNumber);
    merged.push({
      jobNumber:    j.jobNumber,
      jobType:      j.jobType || (w ? w.jobType : ""),
      status:       "Completed",                     // JC = completed
      billed:       j.revenue,                       // ← JC revenue is authoritative
      materialCost: w ? w.materialCost : 0,          // ← cost from WIP if matched
      laborCost:    w ? w.laborCost    : 0,
      hours:        j.hoursWorked || (w ? w.hours : 0),
      gm:           w ? w.gm : (j.revenue),          // GM = revenue if no cost data
      customerId:   j.customerId || (w ? w.customerId : ""),
      customerName: j.customerName,
      technicians:  w ? w.technicians : j.primaryTech,
      primaryTech:  j.primaryTech,
      createdDate:  w ? w.createdDate : null,
      completionDate: j.completionDate,
      summary:      w ? w.summary : "",
      soldHours:    j.soldHours,
      jobClass:     j.jobClass,
      _source:      w ? "jc+wip" : "jc-only",
      _hasCostData: !!w,
    });
  }

  // Then append WIP-only jobs that weren't in JC. These fall into two camps:
  //   1. Genuinely in-progress / canceled / scheduled — keep as-is
  //   2. WIP says "Completed" but JC didn't include them — these completed
  //      AFTER the JC report's cutoff (i.e., next month). Reclassify them
  //      as "In Progress" so they don't inflate this period's revenue.
  for (const w of wipJobs) {
    if (usedWipKeys.has(w.jobNumber)) continue;
    if (w.status === "Completed") {
      // Completed per WIP but not in JC's date range — push to next period
      merged.push({
        ...w,
        status: "In Progress",
        _source: "wip-only-completed-after-cutoff",
        _originalStatus: "Completed",
      });
    } else {
      merged.push({ ...w, _source: "wip-only" });
    }
  }

  return merged;
}

function importTimesheets(filePath) {
  const wb = xlsx.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: null, raw: true });
  const ts = [];
  for (const r of rows) {
    const tech = s(r["Name"]);
    if (!tech) continue;
    ts.push({
      tech,
      businessUnit:  s(r["Business Unit"]),
      date:          parseDate(r["Timesheet Activity Date"]),
      activity:      s(r["Timesheet Activity"]),
      startTime:     s(r["Start Time"]),
      endTime:       s(r["End Time"]),
      durationHours: n(r["Duration (Decimal)"]),
      jobNumber:     s(r["Job Number"]),
      laborType:     s(r["Labor Type"]),
    });
  }
  return ts;
}

function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") {
    // Excel serial date
    const ms = (v - 25569) * 86400 * 1000;
    return new Date(ms).toISOString();
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toISOString();
}

(function main() {
  const args = parseArgs();
  const year  = parseInt(args.year, 10);
  const month = parseInt(args.month, 10);
  if (!year || !month || !args.wip || !args.timesheets) {
    console.error("Usage: node scripts/import-monthly-xlsx.js --year YYYY --month M --wip PATH --timesheets PATH [--jobcompleted PATH]");
    process.exit(1);
  }
  console.log(`Importing ${year}-${String(month).padStart(2, "0")}…`);

  const wipJobs = importWIP(args.wip);
  console.log(`  WIP jobs:           ${wipJobs.length}`);

  let jobs;
  if (args.jobcompleted) {
    const jcJobs = importJobCompleted(args.jobcompleted);
    console.log(`  Job Completed jobs: ${jcJobs.length}`);
    jobs = mergeJobs(wipJobs, jcJobs);
    const stats = jobs.reduce((s, j) => {
      s[j._source] = (s[j._source] || 0) + 1;
      return s;
    }, {});
    console.log(`  Merged total:       ${jobs.length}`);
    console.log(`    └ jc+wip (matched):  ${stats["jc+wip"] || 0}   (revenue from JC, cost from WIP)`);
    console.log(`    └ jc-only:           ${stats["jc-only"] || 0}   (completed Oct, created earlier — no cost data)`);
    console.log(`    └ wip-only:          ${stats["wip-only"] || 0}   (in-progress / canceled / scheduled)`);
  } else {
    console.log(`  ⚠ No --jobcompleted file provided. Using WIP only (less accurate revenue recognition).`);
    jobs = wipJobs;
  }

  const timesheets = importTimesheets(args.timesheets);
  console.log(`  Timesheet entries:  ${timesheets.length}`);

  writeCache(year, month, jobs, timesheets);
  console.log(`  ✓ written to data/monthly-cache/${year}-${String(month).padStart(2, "0")}/`);
})();
