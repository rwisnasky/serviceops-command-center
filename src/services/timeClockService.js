/**
 * src/services/timeClockService.js
 * ───────────────────────────────────────────────────────────────────────
 * Pure helpers for the live time clock (HoursTracker-style punch in/out).
 *
 * No I/O — just the math and calendar mapping — so it's unit-testable and
 * the repository can lean on it without duplicating logic.
 *
 * Worked hours = (clock_out − clock_in − break) rounded to the nearest
 * quarter hour, which is how the shop already reads time (6.5, 7.75, 8.0…).
 *
 * A punch counts toward a calendar work date (the employee's LOCAL day, sent
 * by the browser). From that date we derive which pay period (Wed→Tue) and
 * which day-of-week column the hours land in, so clock-out can drop them onto
 * the right grid cell.
 * ───────────────────────────────────────────────────────────────────────
 */

// day-of-week (Date.getDay: 0=Sun … 6=Sat) → grid day key
const DOW_TO_KEY = { 3: "wed", 4: "thu", 5: "fri", 6: "sat", 0: "sun", 1: "mon", 2: "tue" };

/** Round hours to the nearest quarter (0.25). */
function roundQuarter(h) {
  return Math.round(h * 4) / 4;
}

/**
 * Worked hours between two ISO timestamps, minus break seconds, rounded to
 * the nearest quarter hour. Returns 0 for missing/inverted times.
 */
function workedHours(clockInIso, clockOutIso, breakSeconds = 0) {
  const inMs = Date.parse(clockInIso);
  const outMs = Date.parse(clockOutIso);
  if (!Number.isFinite(inMs) || !Number.isFinite(outMs) || outMs <= inMs) return 0;
  const grossSec = (outMs - inMs) / 1000;
  const netSec = Math.max(0, grossSec - Math.max(0, Number(breakSeconds) || 0));
  return Math.max(0, roundQuarter(netSec / 3600));
}

/** Seconds elapsed between two ISO timestamps (>= 0). Used for break accrual. */
function secondsBetween(startIso, endIso) {
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return Math.round((b - a) / 1000);
}

/** Local YYYY-MM-DD for a Date object. */
function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse a 'YYYY-MM-DD' as a local calendar date (midnight, no tz surprises). */
function parseDate(dateIso) {
  return new Date(String(dateIso) + "T00:00:00");
}

/** The pay period start (most recent Wednesday on/before the date). */
function periodStartFor(dateIso) {
  const d = parseDate(dateIso);
  const diff = (d.getDay() - 3 + 7) % 7; // 3 = Wednesday
  d.setDate(d.getDate() - diff);
  return isoDate(d);
}

/** The pay period end (start + 6 days = Tuesday). */
function periodEndFor(startIso) {
  const d = parseDate(startIso);
  d.setDate(d.getDate() + 6);
  return isoDate(d);
}

/** The grid day-key (wed…tue) for a calendar date. */
function dayKeyFor(dateIso) {
  return DOW_TO_KEY[parseDate(dateIso).getDay()];
}

module.exports = {
  DOW_TO_KEY,
  roundQuarter,
  workedHours,
  secondsBetween,
  isoDate,
  periodStartFor,
  periodEndFor,
  dayKeyFor,
};
