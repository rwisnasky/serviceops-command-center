/**
 * openJobsService.js
 * ────────────────────────────────────────────────────────────────────────────
 * Aggregates "open" jobs across every cached month — jobs that are aging,
 * have unbilled cost, or appear to be missed invoice opportunities.
 *
 * Strategy:
 *   1. Walk every cached month and collect every job's most recent state
 *      (deduped by Job #, keeping the row from the most recent cache).
 *   2. Flag jobs as "open" when their latest state is:
 *        • In Progress / Scheduled / Hold / Dispatched (still in flight)
 *        • Completed but $0 billed AND has cost incurred (missed invoice)
 *   3. Compute aging (days since created) and total cost-at-risk per job.
 *   4. Bucket by category so the page can group: Aging WIP, Missed Invoices,
 *      Estimates Pending, etc.
 * ────────────────────────────────────────────────────────────────────────────
 */

const fs   = require("fs");
const path = require("path");
const { CACHE_ROOT } = require("./monthlyDataLoader");

function num(x) { return typeof x === "number" && !isNaN(x) ? x : 0; }

function listCachedMonths() {
  if (!fs.existsSync(CACHE_ROOT)) return [];
  return fs.readdirSync(CACHE_ROOT)
    .filter(d => /^\d{4}-\d{2}$/.test(d))
    .sort()
    .map(d => {
      const [y, m] = d.split("-").map(Number);
      return { year: y, month: m, key: d };
    });
}

function readJobs(year, month) {
  const file = path.join(CACHE_ROOT, `${year}-${String(month).padStart(2, "0")}`, "jobs.json");
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function daysBetween(a, b) {
  if (!a || !b) return 0;
  const da = new Date(a), db = new Date(b);
  if (isNaN(da) || isNaN(db)) return 0;
  return Math.round((db - da) / 86400000);
}

const OPEN_STATUSES = new Set(["In Progress", "Scheduled", "Hold", "Dispatched"]);

// ── Likely-maintenance filter ──────────────────────────────────────────────
// Short Misc HVAC visits by the maintenance techs are nearly always
// PSM/Ground-Club checkups that got booked under the wrong job type. They
// rarely have a real invoicing problem — dues paid the bill — so
// surfacing them as "missed invoice" candidates drowns out the actual
// issues. We filter them out at the source and report the count so it's
// not invisible (the summary shows how many got hidden).
const MAINT_HVAC_TECHS = new Set([
  "reid",           // matches any "Reid …" tech name
  "nolan vasquez",
  "trevor nakamura",
]);
const MAINT_HVAC_MAX_HOURS = 1.5;

function isLikelyMaintenanceMisc(job) {
  const type = (job.jobType || "").toLowerCase();
  if (!type.includes("misc")) return false;
  if (!type.includes("hvac")) return false;
  const hrs = num(job.hours);
  if (hrs > MAINT_HVAC_MAX_HOURS) return false;
  // Match against the assigned tech(s). The field is usually a single name
  // but can be a comma-joined list — accept the row if *any* tech on it is
  // one of the maintenance regulars.
  const techs = String(job.technicians || job.primaryTech || "").toLowerCase();
  if (!techs) return false;
  for (const m of MAINT_HVAC_TECHS) {
    if (techs.includes(m)) return true;
  }
  return false;
}

// ── Membership-visit job types ─────────────────────────────────────────────
// Some job types are pure membership/PSM visits — the dues covered the bill,
// so they will always be $0 billed by design. They should never surface as
// "missed invoice" candidates. Match is case-insensitive and exact on the
// trimmed job type string.
const MEMBERSHIP_JOB_TYPES = new Set([
  "psm - heating maintenance",
  "bi-annual hvac maintenance",
]);

function isMembershipVisit(job) {
  const type = String(job.jobType || "").trim().toLowerCase();
  if (!type) return false;
  return MEMBERSHIP_JOB_TYPES.has(type);
}

/**
 * Build the open-jobs report from cached data.
 * Returns:
 *   {
 *     summary: { totals by bucket }
 *     buckets: {
 *       agingWIP: [{...job}],
 *       missedInvoices: [{...job}],          // truly unbilled, no same-customer follow-up
 *       missedInvoicesLikelyExplained: [...], // same-customer billed job found nearby
 *       missedInvoicesNoCost: [{...job}],
 *       scheduled: [{...job}],
 *     },
 *     allOpen: [...]   // flat list of every open job, sorted by exposure
 *     generatedAt
 *   }
 */
function buildOpenJobsReport({ asOfDate = null, linkDayWindow = 60 } = {}) {
  const today = asOfDate ? new Date(asOfDate) : new Date();
  const months = listCachedMonths();

  // Walk months in chronological order; later writes overwrite earlier ones,
  // so each Job # ends up holding its most-recent observed state.
  const latest = new Map(); // jobNumber → { ...jobRow, sourceMonth }
  for (const m of months) {
    const jobs = readJobs(m.year, m.month);
    for (const j of jobs) {
      if (!j.jobNumber) continue;
      latest.set(j.jobNumber, { ...j, _sourceMonth: m.key });
    }
  }

  const all = [...latest.values()];

  // Build customer index — { customerId: [job, job, ...] } for fast lookups
  const byCustomer = new Map();
  for (const j of all) {
    const cid = j.customerId && String(j.customerId).trim();
    if (!cid) continue;
    if (!byCustomer.has(cid)) byCustomer.set(cid, []);
    byCustomer.get(cid).push(j);
  }
  const buckets = {
    agingWIP:                      [], // In-progress, status open
    missedInvoices:                [], // Completed, $0 billed, has cost — NO same-customer billed follow-up nearby
    missedInvoicesLikelyExplained: [], // Completed, $0 billed, has cost — likely linked to a billed job for same customer
    missedZeroCost:                [], // Completed, $0 billed, no cost (likely free quote / rescheduled)
    scheduled:                     [], // Scheduled / Dispatched
  };

  // Helper: for a candidate missed-invoice job, find the most likely linked
  // same-customer job. Returns null if no strong link.
  function findLinkedJob(candidate) {
    const cid = candidate.customerId && String(candidate.customerId).trim();
    if (!cid) return null;
    const peers = byCustomer.get(cid) || [];
    if (peers.length <= 1) return null;

    const candDate = candidate.completionDate || candidate.createdDate;
    if (!candDate) return null;
    const candTime = new Date(candDate).getTime();

    // Look for peer jobs that are: a different job, have non-zero billing,
    // and were created/completed within the link window of this candidate.
    let best = null;
    for (const p of peers) {
      if (p.jobNumber === candidate.jobNumber) continue;
      const billed = num(p.billed);
      if (billed <= 0) continue;
      const peerDate = p.completionDate || p.createdDate;
      if (!peerDate) continue;
      const peerTime = new Date(peerDate).getTime();
      const days = Math.abs(peerTime - candTime) / 86400000;
      if (days > linkDayWindow) continue;
      // Score = billed amount, weighted higher if the peer has LOW material
      // cost (suggests the materials may have come from the candidate).
      const matRatio = num(p.materialCost) / Math.max(billed, 1);
      const score = billed * (matRatio < 0.1 ? 1.3 : 1.0) / Math.max(days, 1);
      if (!best || score > best.score) {
        best = {
          score,
          jobNumber: p.jobNumber,
          jobType: p.jobType || "",
          completionDate: p.completionDate || null,
          createdDate: p.createdDate || null,
          daysApart: Math.round(days),
          billed: round(billed),
          materialCost: round(num(p.materialCost)),
          laborCost: round(num(p.laborCost)),
          status: p.status,
        };
      }
    }
    return best;
  }
  function round(n) { return Math.round((n || 0) * 100) / 100; }

  let filteredMaintenance = 0;       // # jobs hidden by the Misc-HVAC maintenance rule
  let filteredMaintenanceCost = 0;   // their combined exposure (so we can show what we're suppressing)
  let filteredMembership = 0;        // # jobs hidden by the membership-visit job-type rule
  let filteredMembershipCost = 0;    // their combined exposure

  for (const j of all) {
    const status   = (j.status || "").trim();
    const billed   = num(j.billed);
    const labor    = num(j.laborCost);
    const material = num(j.materialCost);
    const hours    = num(j.hours);
    const cost     = labor + material;
    const exposure = cost; // dollars at risk if never invoiced

    // Drop PSM / membership job types — these are covered by membership dues
    // and will always be $0 billed by design. Not actual missed invoices.
    if (isMembershipVisit(j)) {
      filteredMembership += 1;
      filteredMembershipCost += exposure;
      continue;
    }

    // Drop short Misc-HVAC visits by maintenance techs before bucketing — these
    // are almost always PSM/Fan-Club checkups that got booked under the wrong
    // job type, not actual missed invoices.
    if (isLikelyMaintenanceMisc(j)) {
      filteredMaintenance += 1;
      filteredMaintenanceCost += exposure;
      continue;
    }

    const created = j.createdDate ? new Date(j.createdDate) : null;
    const daysOpen = created ? daysBetween(created, today) : null;

    const enriched = {
      jobNumber:     j.jobNumber,
      jobType:       j.jobType || "",
      status:        status,
      customerId:    j.customerId,
      customerName:  j.customerName || "",
      technicians:   j.technicians || j.primaryTech || "",
      createdDate:   j.createdDate,
      completionDate:j.completionDate,
      daysOpen,
      hours,
      billed,
      labor:    labor,
      material: material,
      cost,
      exposure,
      summary:  (j.summary || "").slice(0, 300),
      sourceMonth: j._sourceMonth,
    };

    if (status === "In Progress" || status === "Hold") {
      buckets.agingWIP.push(enriched);
    } else if (status === "Scheduled" || status === "Dispatched") {
      buckets.scheduled.push(enriched);
    } else if (status === "Completed" && billed === 0) {
      if (cost > 0 || hours > 0) {
        // Cross-reference with same-customer billed jobs nearby
        const linked = findLinkedJob(j);
        if (linked) {
          enriched.linkedJob = linked;
          buckets.missedInvoicesLikelyExplained.push(enriched);
        } else {
          buckets.missedInvoices.push(enriched);
        }
      } else {
        buckets.missedZeroCost.push(enriched);
      }
    }
  }

  // Sort each bucket by exposure descending (then aging)
  const sortByExposure = (a, b) => (b.exposure - a.exposure) || ((b.daysOpen || 0) - (a.daysOpen || 0));
  for (const k of Object.keys(buckets)) buckets[k].sort(sortByExposure);

  // Flat list of every open job for one-table view
  const allOpen = [
    ...buckets.agingWIP,
    ...buckets.missedInvoices,
    ...buckets.missedInvoicesLikelyExplained,
    ...buckets.scheduled,
    ...buckets.missedZeroCost,
  ].sort(sortByExposure);

  // Summary
  const sum = arr => arr.reduce((s, j) => s + j.exposure, 0);
  const summary = {
    cachedMonths: months.length,
    asOf: today.toISOString().slice(0, 10),
    linkDayWindow,
    counts: {
      agingWIP:                      buckets.agingWIP.length,
      missedInvoices:                buckets.missedInvoices.length,
      missedInvoicesLikelyExplained: buckets.missedInvoicesLikelyExplained.length,
      scheduled:                     buckets.scheduled.length,
      missedZeroCost:                buckets.missedZeroCost.length,
      total:                         allOpen.length,
    },
    exposure: {
      agingWIP:                      Math.round(sum(buckets.agingWIP)),
      missedInvoices:                Math.round(sum(buckets.missedInvoices)),
      missedInvoicesLikelyExplained: Math.round(sum(buckets.missedInvoicesLikelyExplained)),
      scheduled:                     Math.round(sum(buckets.scheduled)),
      total:                         Math.round(sum(allOpen)),
    },
    suppressed: {
      maintenanceMisc:     filteredMaintenance,
      maintenanceMiscCost: Math.round(filteredMaintenanceCost),
      maintenanceRule:
        `Misc HVAC jobs <= ${MAINT_HVAC_MAX_HOURS}hr by ${[...MAINT_HVAC_TECHS].join(", ")} — treated as PSM/Ground Club checkups booked under the wrong job type.`,
      membership:          filteredMembership,
      membershipCost:      Math.round(filteredMembershipCost),
      membershipRule:
        `Job types treated as membership visits (covered by dues, never expected to bill): ${[...MEMBERSHIP_JOB_TYPES].join(", ")}.`,
    },
  };

  return {
    summary,
    buckets,
    allOpen,
    generatedAt: today.toISOString(),
  };
}

module.exports = { buildOpenJobsReport };
