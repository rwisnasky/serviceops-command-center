/**
 * fiscalAggregator.js
 * ────────────────────────────────────────────────────────────────────────────
 * Aggregates multiple cached months into FY-to-Date or full-FY rollups.
 *
 * Each input month has already been processed by buildReview(). This module
 * sums the headline metrics across months and returns a combined rollup
 * suitable for the FY review page.
 * ────────────────────────────────────────────────────────────────────────────
 */

const fs = require("fs");
const path = require("path");
const fy   = require("./fiscalYear");
const loader = require("./monthlyDataLoader");
const { buildReview } = require("./monthlyReviewService");

function num(x) { return typeof x === "number" && !isNaN(x) ? x : 0; }

/**
 * Load and build a review for every cached month in the given list.
 * Returns array of { year, month, label, review } — review is null for
 * months that have no cached data.
 */
async function loadMonthsForFY(months) {
  const out = [];
  for (const { year, month } of months) {
    const data = loader.readCache(year, month);
    if (!data) {
      out.push({ year, month, label: fy.monthLabel(month), review: null });
      continue;
    }
    const review = buildReview({
      year, month,
      jobs: data.jobs,
      timesheets: data.timesheets,
      appointments: data.appointments || [],
    });
    out.push({ year, month, label: fy.monthLabel(month), review });
  }
  return out;
}

/**
 * Build an FY-to-Date rollup as of the given (year, month).
 * Returns aggregated KPIs across every cached month from FY start through
 * the given month.
 */
async function buildFYToDate(year, month) {
  const months = fy.fyToDateMonths(year, month);
  const data = await loadMonthsForFY(months);
  return rollUp(fy.fyForMonth(year, month), data, /* includeMonths= */ true);
}

/**
 * Build a full-FY rollup for the given FY label (e.g., "FY26").
 */
async function buildFullFY(fyLabel) {
  const months = fy.monthsInFY(fyLabel);
  const data = await loadMonthsForFY(months);
  return rollUp(fyLabel, data, /* includeMonths= */ true);
}

function rollUp(fyLabel, monthData, includeMonths = false) {
  const totals = {
    // Revenue
    reportedBilling: 0,
    operationalBilling: 0,
    carryoverRevenue: 0,
    // GM
    reportedGrossProfit: 0,
    operationalGrossProfit: 0,
    // Costs
    materials: 0,
    labor: 0,
    // Counts
    completedJobs: 0,
    operationalJobCount: 0,
    canceledJobs: 0,
    inProgressJobs: 0,
    // Hours
    paidServiceHours: 0,
    serviceWrenchHours: 0,
    constructionHours: 0,
    paidAllHours: 0,
  };
  let monthsWithData = 0;

  for (const m of monthData) {
    if (!m.review) continue;
    monthsWithData++;
    const h = m.review.headline;
    const c = m.review.jobs.byStatus.Completed || { materials: 0, labor: 0 };

    totals.reportedBilling        += num(h.reportedBilling);
    totals.operationalBilling     += num(h.operationalBilling);
    totals.carryoverRevenue       += num(h.carryoverRevenue);
    totals.reportedGrossProfit    += num(h.reportedGrossProfit);
    totals.operationalGrossProfit += num(h.operationalGrossProfit);
    totals.materials              += num(c.materials);
    totals.labor                  += num(c.labor);
    totals.completedJobs          += num(h.completedJobs);
    totals.operationalJobCount    += num(h.operationalJobCount);
    totals.canceledJobs           += num(h.canceledJobs);
    totals.inProgressJobs         += num(h.inProgressJobs);
    totals.paidServiceHours       += num(h.paidServiceHours);
    totals.serviceWrenchHours     += num(h.serviceWrenchHours);
    totals.constructionHours      += num(h.constructionHours);
    totals.paidAllHours           += num(h.paidAllHours);
  }

  // Derived
  totals.reportedGrossMarginPct    = totals.reportedBilling    > 0 ? Math.round(totals.reportedGrossProfit    / totals.reportedBilling    * 1000) / 10 : 0;
  totals.operationalGrossMarginPct = totals.operationalBilling > 0 ? Math.round(totals.operationalGrossProfit / totals.operationalBilling * 1000) / 10 : 0;
  totals.serviceUtilization        = totals.paidServiceHours   > 0 ? Math.round(totals.serviceWrenchHours    / totals.paidServiceHours   * 1000) / 10 : 0;
  totals.dollarsPerPaidHour        = totals.paidServiceHours   > 0 ? Math.round(totals.reportedBilling      / totals.paidServiceHours)              : 0;
  totals.laborCostPerWrenchHour    = totals.serviceWrenchHours > 0 ? Math.round(totals.labor                / totals.serviceWrenchHours * 100) / 100 : 0;

  const result = {
    fyLabel,
    monthsWithData,
    monthsRequested: monthData.length,
    totals,
  };
  if (includeMonths) {
    result.months = monthData.map(m => ({
      year: m.year, month: m.month, label: m.label,
      hasData: !!m.review,
      headline: m.review ? m.review.headline : null,
    }));
  }
  return result;
}

module.exports = {
  buildFYToDate,
  buildFullFY,
  loadMonthsForFY,
};
