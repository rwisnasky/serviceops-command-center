/**
 * src/demo/monthlyCache.js
 *
 * Generates `data/monthly-cache/YYYY-MM/{jobs,timesheets,appointments,imported-at}.json`
 * from the demo world.
 *
 * Why this exists as its own thing rather than falling out of the ServiceTitan
 * mock: in production these files aren't an API cache at all. They're the
 * output of importing the month-end "job costing" and "WIP" spreadsheets that
 * the accountant produces — the only place actual material cost and ServiceTitan's
 * own gross-margin figure are available. Several pages (fiscal-year review, the
 * Customer Review margins, past months on Monthly Review) read the
 * files directly and have no API path at all. With no files they render an
 * honest but very boring "no data yet — import the monthly report".
 *
 * So the demo has to produce them. The numbers are derived from the same jobs,
 * invoices and payroll rows the rest of the world is built from, so the
 * spreadsheet-sourced figures agree with the API-sourced ones. That agreement
 * matters: Customer Review shows both side by side.
 *
 * Field shapes are fussy and load-bearing:
 *   - every file is a BARE ARRAY at the top level
 *   - `status` is case-sensitive; only "Completed" gates revenue
 *   - `technicians` is a COMMA-JOINED STRING, not an array
 *   - `_hasCostData: false` or `_source: "jc-only"` excludes a job from every
 *     operational margin number
 *   - timesheet `tech` must match the spelling used in `jobs.json`
 */

const fs = require("fs");
const path = require("path");
const { Rng, ROOT_SEED } = require("./rng");
const { getWorld } = require("./world");

const pad2 = (n) => String(n).padStart(2, "0");
const round2 = (n) => Math.round(n * 100) / 100;

/** ST writes these with a case and spacing of their own. */
const STATUS_MAP = {
  Completed: "Completed",
  InProgress: "In Progress",
  Canceled: "Canceled",
  Scheduled: "Scheduled",
  Hold: "Hold",
  Dispatched: "Dispatched",
};

const ACTIVITIES = [
  ["Working", 58],
  ["Driving", 18],
  ["Idle", 7],
  ["Job Prep", 5],
  ["Meal", 5],
  ["Meeting", 3],
  ["Training", 2],
  ["OFF / UNPAID", 2],
];

function hhmm(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * Build the per-month arrays. Returns a Map keyed "YYYY-MM".
 */
function buildMonths(world) {
  const rng = new Rng(ROOT_SEED).fork("monthly-cache");
  const months = new Map();

  const ensure = (key) => {
    if (!months.has(key)) months.set(key, { jobs: [], timesheets: [], appointments: [] });
    return months.get(key);
  };

  for (const job of world.jobs) {
    // The month-end workbooks are built from completion date, falling back to
    // creation date for work that never finished.
    const anchor = job.completedOn || job.createdOn;
    if (!anchor) continue;
    const d = new Date(anchor);
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;

    const jt = job._jobType;
    const invoice = job._invoiceId ? world.index.invoiceById.get(String(job._invoiceId)) : null;
    const appts = world.index.appointmentsByJob.get(String(job.id)) || [];
    const payroll = world.index.grossPayByJob.get(String(job.id)) || [];
    const pos = world.index.posByJob.get(String(job.id)) || [];

    const billed = invoice ? invoice.subtotal : 0;

    // Material cost comes from the invoice's own line costs, which are the
    // pricebook cost fields — the same basis the accountant's job-costing
    // workbook uses. Purchase orders are deliberately NOT summed in here: a PO
    // is raised against the job for the material, so counting both would
    // double-book every install.
    const materialCost = invoice
      ? invoice.items.reduce((s, i) => s + (i.totalCost || 0), 0)
      : 0;

    const hours = payroll.reduce((s, r) => s + (r.paidDurationHours || 0), 0);

    // Payroll returns the technician's gross wage. The job-costing workbook
    // costs labor at the *burdened* rate — payroll taxes, workers' comp,
    // health, vehicle and tool allocation — which for this trade runs about
    // 1.35x wage. Costing at bare wage is a common way for a shop to think it
    // is 8 points more profitable than it is.
    const LABOR_BURDEN = 1.35;
    const laborCost = payroll.reduce((s, r) => s + (r.amount || 0), 0) * LABOR_BURDEN;

    // ServiceTitan reports its own gross margin figure rather than deriving it,
    // and it does not always equal billed - material - labor (burden, overhead
    // allocations, adjustments). Nudge it slightly so the demo reflects that
    // the two never quite tie — a report that reconciles perfectly would be
    // the unrealistic version.
    const derived = billed - materialCost - laborCost;
    const gm = round2(derived * (1 + rng.money(-0.04, 0.03)));

    const techNames = Array.from(
      new Set(
        appts
          .map((a) => (a.technician && a.technician.name) || null)
          .filter(Boolean)
      )
    );
    const primaryTech =
      (world.index.technicianById.get(String(job.leadTechnicianId)) || {}).name || techNames[0] || "";

    // A slice of rows come from the job-costing workbook only, with no WIP
    // counterpart, so they carry no usable cost data. Downstream those are
    // excluded from operational margin — a real and load-bearing distinction.
    const jcOnly = rng.chance(0.05);
    const hasCostData = !jcOnly && (billed > 0 || materialCost > 0 || laborCost > 0);

    ensure(key).jobs.push({
      jobNumber: String(job.jobNumber),
      jobId: String(job.id),
      jobType: jt.name,
      jobClass: jt.category,
      status: STATUS_MAP[job.jobStatus] || job.jobStatus,
      billed: round2(billed),
      materialCost: round2(materialCost),
      laborCost: round2(laborCost),
      hours: round2(hours),
      gm,
      customerId: String(job.customerId),
      customerName: job.customerName,
      technicians: techNames.join(", "),
      primaryTech,
      createdDate: job.createdOn || null,
      completionDate: job.completedOn || null,
      summary: job.summary || "",
      soldHours: round2(jt.hours),
      _source: jcOnly ? "jc-only" : rng.weighted([["jc+wip", 8], ["wip", 2], ["live-overlay", 1]]),
      _hasCostData: hasCostData,
    });

    // ---- timesheet rows -----------------------------------------------------
    for (const ap of appts) {
      const techName = (ap.technician && ap.technician.name) || null;
      if (!techName) continue;
      const start = new Date(ap.start);
      const tsKey = `${start.getFullYear()}-${pad2(start.getMonth() + 1)}`;

      // The tech drives, preps, works, then drives to the next call. Only
      // "Working" counts as an arrival for the on-time calculation.
      const driveMins = rng.int(8, 34);
      const prepMins = rng.chance(0.4) ? rng.int(4, 12) : 0;
      const workHours = Math.max(0.4, round2(ap._hours * (1 + rng.money(-0.1, 0.25))));

      const driveStart = new Date(start.getTime() - (driveMins + prepMins) * 60000);
      const prepStart = new Date(start.getTime() - prepMins * 60000);
      const workEnd = new Date(start.getTime() + workHours * 3600000);

      const bu = (world.index.businessUnitById.get(String(job.businessUnitId)) || {}).name || "";
      const rows = [];
      rows.push({
        tech: techName,
        businessUnit: bu,
        date: start.toISOString(),
        activity: "Driving",
        startTime: hhmm(driveStart),
        endTime: hhmm(prepMins ? prepStart : start),
        durationHours: round2(driveMins / 60),
        jobNumber: String(job.jobNumber),
        laborType: "Regular",
      });
      if (prepMins) {
        rows.push({
          tech: techName,
          businessUnit: bu,
          date: start.toISOString(),
          activity: "Job Prep",
          startTime: hhmm(prepStart),
          endTime: hhmm(start),
          durationHours: round2(prepMins / 60),
          jobNumber: String(job.jobNumber),
          laborType: "Regular",
        });
      }
      rows.push({
        tech: techName,
        businessUnit: bu,
        date: start.toISOString(),
        activity: "Working",
        startTime: hhmm(start),
        endTime: hhmm(workEnd),
        durationHours: workHours,
        jobNumber: String(job.jobNumber),
        laborType: "Regular",
      });
      // Occasional non-job activity so the utilisation breakdown isn't 100% billable.
      if (rng.chance(0.18)) {
        const act = rng.weighted(ACTIVITIES.filter(([a]) => a !== "Working"));
        const mins = rng.int(15, 55);
        rows.push({
          tech: techName,
          businessUnit: bu,
          date: start.toISOString(),
          activity: act,
          startTime: hhmm(workEnd),
          endTime: hhmm(new Date(workEnd.getTime() + mins * 60000)),
          durationHours: round2(mins / 60),
          jobNumber: "",
          laborType: "Regular",
        });
      }
      ensure(tsKey).timesheets.push(...rows);

      // ---- appointment rows -------------------------------------------------
      ensure(tsKey).appointments.push({
        jobNumber: String(job.jobNumber),
        jobId: String(job.id),
        appointmentId: String(ap.id),
        tech: techName,
        start: ap.start,
        end: ap.end,
        arrivalWindowStart: ap.arrivalWindowStart,
        arrivalWindowEnd: ap.arrivalWindowEnd,
        status: ap.status,
      });
    }
  }

  return months;
}

/**
 * Write the cache to disk. Idempotent: skips a month whose imported-at.json
 * already carries this world's seed, so a restart doesn't rewrite ~40 files.
 */
function writeMonthlyCache({ dir, force = false, quiet = false } = {}) {
  const world = getWorld();
  const baseDir = dir || path.join(__dirname, "..", "..", "data", "monthly-cache");
  const months = buildMonths(world);

  fs.mkdirSync(baseDir, { recursive: true });

  let written = 0;
  let skipped = 0;

  for (const [key, payload] of months) {
    const monthDir = path.join(baseDir, key);
    const stampPath = path.join(monthDir, "imported-at.json");

    if (!force && fs.existsSync(stampPath)) {
      try {
        const stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
        if (stamp && stamp.demoSeed === world.seed) {
          skipped++;
          continue;
        }
      } catch {
        // unreadable stamp — fall through and rewrite
      }
    }

    fs.mkdirSync(monthDir, { recursive: true });
    fs.writeFileSync(path.join(monthDir, "jobs.json"), JSON.stringify(payload.jobs));
    fs.writeFileSync(path.join(monthDir, "timesheets.json"), JSON.stringify(payload.timesheets));
    fs.writeFileSync(path.join(monthDir, "appointments.json"), JSON.stringify(payload.appointments));
    fs.writeFileSync(
      stampPath,
      JSON.stringify({
        importedAt: new Date().toISOString(),
        source: "demo-generator",
        demoSeed: world.seed,
        jobs: payload.jobs.length,
        timesheets: payload.timesheets.length,
        appointments: payload.appointments.length,
      })
    );
    written++;
  }

  if (!quiet) {
    console.log(
      `[demo] monthly cache: ${written} month(s) written, ${skipped} up to date ` +
        `(${months.size} total, ${baseDir.replace(process.cwd(), ".")})`
    );
  }

  return { written, skipped, months: months.size, dir: baseDir };
}

module.exports = { writeMonthlyCache, buildMonths };

// CLI: node src/demo/monthlyCache.js [--force]
if (require.main === module) {
  writeMonthlyCache({ force: process.argv.includes("--force") });
}
