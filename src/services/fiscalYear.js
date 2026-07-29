/**
 * fiscalYear.js
 * ────────────────────────────────────────────────────────────────────────────
 * Fiscal-year aware helpers for the dashboard.
 *
 * Grounded Home Services' fiscal year starts October 1.
 *   FY26 = October 1, 2025 → September 30, 2026
 *   FY27 = October 1, 2026 → September 30, 2027
 *
 * The FY label uses the fiscal year's END calendar year (so an FY ending in
 * Sept 2026 is "FY26"). This matches accounting convention.
 * ────────────────────────────────────────────────────────────────────────────
 */

const FY_START_MONTH = 10;   // October
const FY_END_MONTH   = 9;    // September

/**
 * Given a (year, month), return the fiscal year label.
 * Example: (2025, 10) → "FY26", (2026, 9) → "FY26", (2026, 10) → "FY27"
 */
function fyForMonth(year, month) {
  // If month >= FY_START_MONTH, the FY ends in (year + 1)
  // If month < FY_START_MONTH,  the FY ends in (year)
  const fyEndYear = month >= FY_START_MONTH ? year + 1 : year;
  return `FY${String(fyEndYear).slice(-2)}`;
}

/**
 * Given an FY label like "FY26", return its start (year, month) and end (year, month).
 *   "FY26" → start: (2025, 10), end: (2026, 9)
 */
function fyBounds(fyLabel) {
  const m = String(fyLabel).match(/^FY(\d{2})$/);
  if (!m) return null;
  const fyEndYear = 2000 + parseInt(m[1], 10);
  return {
    start: { year: fyEndYear - 1, month: FY_START_MONTH },
    end:   { year: fyEndYear,     month: FY_END_MONTH },
  };
}

/**
 * Return all (year, month) pairs in an FY, in calendar order.
 * "FY26" → [(2025,10), (2025,11), (2025,12), (2026,1), ..., (2026,9)]
 */
function monthsInFY(fyLabel) {
  const b = fyBounds(fyLabel);
  if (!b) return [];
  const out = [];
  let y = b.start.year, m = b.start.month;
  for (let i = 0; i < 12; i++) {
    out.push({ year: y, month: m });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * Return all (year, month) pairs from FY start through the given (year, month) inclusive.
 * Used for "FY-to-Date" rollups.
 */
function fyToDateMonths(year, month) {
  const fy = fyForMonth(year, month);
  const all = monthsInFY(fy);
  return all.filter(m => (m.year < year) || (m.year === year && m.month <= month));
}

function monthLabel(month) {
  return ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][month - 1] || "";
}

function fullMonthLabel(month) {
  return ["January","February","March","April","May","June","July","August","September","October","November","December"][month - 1] || "";
}

module.exports = {
  FY_START_MONTH,
  fyForMonth,
  fyBounds,
  monthsInFY,
  fyToDateMonths,
  monthLabel,
  fullMonthLabel,
};
