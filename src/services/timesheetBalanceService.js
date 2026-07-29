/**
 * src/services/timesheetBalanceService.js
 * ───────────────────────────────────────────────────────────────────────
 * Pure balance math for the employee timesheet.
 *
 * Everything in this module is a plain function with no I/O — no DB, no
 * network — so it can be unit-tested in isolation and reasoned about
 * cleanly. The timesheetRepository is the only thing that persists the
 * numbers these functions produce.
 *
 * Two leave balances are tracked per employee:
 *
 *   • Comp Time — bidirectional, tracked 1:1 (no overtime multiplier).
 *       earned this week = hours over 40 rolled into the bank (`otBanked`)
 *       used   this week = positive hours on the Comp Time row (comp leave)
 *       running delta     = earned − used
 *     Comp is "swapped" straight across, so a week that rolls in 4 and burns
 *     1 nets +3 to the running balance.
 *
 *     Earning: when a week's total exceeds 40, the employee may roll the extra
 *     into comp. That amount (`otBanked`) is added to the bank AND applied as a
 *     NEGATIVE against the comp-time total, which pulls the payable week back
 *     to 40. Rolling is optional — leave it and the week pays overtime instead.
 *
 *     Using: a positive number on the Comp Time row for a day means comp taken
 *     as leave that day. Those hours count toward the week's paid total (like
 *     PTO) and are subtracted from the bank.
 *
 *     So the Comp row's displayed total = comp used − comp rolled in. It reads
 *     negative on a week that banked more than it burned.
 *
 *   • P-Law — frontloaded once, then only counts DOWN as it's used.
 *       used this week = the P-Law row total
 *       running delta   = −used
 *     There is no accrual math; the starting balance is set on the very
 *     first processed timesheet (per employee) and drains from there.
 *
 * The "applied delta" pattern:
 *   When a timesheet is processed we record the EXACT change it caused to
 *   each balance (both the running delta and any one-time initialization).
 *   Reopening a processed sheet reverses precisely that recorded change —
 *   reverse-then-reapply — so editing an approved week can never double
 *   count. See applyProcess / reverseProcess below.
 * ───────────────────────────────────────────────────────────────────────
 */

// Row + day keys must stay in lock-step with the front-end (timesheet.html)
// and the paper sheet. Wednesday → Tuesday, six hour types.
const ROW_KEYS = ["regular", "overtime", "pto", "plaw", "holiday", "comp"];
const DAY_KEYS = ["wed", "thu", "fri", "sat", "sun", "mon", "tue"];

/** Coerce any cell value to a finite number; blanks / junk become 0. */
function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/** Round to 2dp to keep floating-point noise (0.1+0.2) out of stored balances. */
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Total a single hour-type row across the week.
 * Tolerates a missing row (returns 0) so partially-formed grids are safe.
 */
function rowTotal(grid, rowKey) {
  const row = (grid && grid[rowKey]) || {};
  return DAY_KEYS.reduce((sum, d) => sum + num(row[d]), 0);
}

/**
 * Summarize a grid into row totals, per-day column totals, and grand total.
 * This mirrors what the UI shows live; the server recomputes it from the
 * stored grid so the numbers can never be spoofed by the client.
 */
function summarizeGrid(grid) {
  const rowTotals = {};
  for (const r of ROW_KEYS) rowTotals[r] = round2(rowTotal(grid, r));

  const colTotals = {};
  for (const d of DAY_KEYS) {
    colTotals[d] = round2(
      ROW_KEYS.reduce((sum, r) => sum + num(grid?.[r]?.[d]), 0)
    );
  }

  const grandTotal = round2(
    Object.values(rowTotals).reduce((a, b) => a + b, 0)
  );

  return { rowTotals, colTotals, grandTotal };
}

/** The standard full-time week. */
const WEEK_HOURS = 40;

/** Daily regular-hours cap. Worked hours beyond this on a single day are overtime. */
const DAY_REGULAR_CAP = 8;

/**
 * Daily overtime split: for each day, treat Regular + Overtime as the hours
 * worked that day, cap Regular at 8, and push the remainder into Overtime.
 *
 * Total-preserving (Regular+Overtime for a day is unchanged) and idempotent
 * (running it again is a no-op), so it's safe to apply on every save and on
 * top of clock-fills that keep adding to the Regular cell. Leave categories
 * (PTO, P-Law, Holiday, Comp) are untouched — only worked hours become OT.
 *
 * Returns a NEW grid; the input isn't mutated.
 */
function normalizeDailyOvertime(grid) {
  const out = {};
  for (const r of ROW_KEYS) {
    out[r] = {};
    for (const d of DAY_KEYS) out[r][d] = (grid && grid[r] && grid[r][d] != null) ? grid[r][d] : "";
  }
  for (const d of DAY_KEYS) {
    const worked = round2(num(out.regular[d]) + num(out.overtime[d]));
    const reg = Math.min(worked, DAY_REGULAR_CAP);
    const ot = round2(Math.max(0, worked - DAY_REGULAR_CAP));
    out.regular[d] = reg === 0 ? "" : String(round2(reg));
    out.overtime[d] = ot === 0 ? "" : String(ot);
  }
  return out;
}

/**
 * Payable hours for a week = every hour on the sheet minus whatever was
 * banked to comp. When overtime is banked to cap the week at 40, this returns
 * 40. When "pay overtime" is on (otBanked = 0) it returns the raw total,
 * which may exceed 40.
 */
function payableHours(grid, otBanked) {
  const { grandTotal } = summarizeGrid(grid);
  return round2(grandTotal - Math.max(0, num(otBanked)));
}

/**
 * Suggested overtime-to-comp banking for a week when overtime is NOT paid:
 * the hours over 40. Returns 0 when the week is at or under 40. Used by the
 * UI to offer a one-click "bank the overage" and by the server guard.
 */
function suggestedOtBanked(grid) {
  const { grandTotal } = summarizeGrid(grid);
  return round2(Math.max(0, grandTotal - WEEK_HOURS));
}

/**
 * Compute the effect processing a timesheet will have on the balances,
 * given the CURRENT initialization state of the employee.
 *
 * Inputs:
 *   grid            — the 6×7 hour grid
 *   compUsed        — comp hours taken as leave this period (number|string)
 *   bankedCompInput — starting comp balance, only meaningful on the first
 *                     sheet (when compInitialized is false)
 *   plawStartInput  — starting P-Law balance, only meaningful on the first
 *                     sheet (when plawInitialized is false)
 *   compInitialized — has this employee's comp balance been seeded yet?
 *   plawInitialized — has this employee's P-Law balance been seeded yet?
 *
 * Returns a fully-explicit effect object. `initComp` / `initPlaw` are the
 * one-time seed amounts this sheet applies (null if the balance was already
 * initialized), and `compDelta` / `plawDelta` are the ongoing running
 * changes. Storing them separately lets reverseProcess undo both parts.
 */
function computeProcessEffect({
  grid,
  compUsed,
  otBanked,
  bankedCompInput,
  plawStartInput,
  compInitialized,
  plawInitialized,
}) {
  const { rowTotals } = summarizeGrid(grid);

  // Comp is EARNED by rolling the week's hours over 40 into the bank.
  const otBankedNum = Math.max(0, round2(num(otBanked)));
  const earned = otBankedNum;

  // Comp is USED by entering positive hours on the Comp Time row — that's comp
  // taken as leave that day. It counts toward the week's paid hours (like PTO)
  // and comes straight out of the bank. `compUsed` is a legacy field kept in
  // the sum so any older stored value still applies; new saves send 0.
  const compUsedNum = round2(rowTotals.comp + num(compUsed));
  const plawUsed = rowTotals.plaw; // P-Law hours used this week

  const compDelta = round2(earned - compUsedNum);
  const plawDelta = round2(-plawUsed);

  // One-time seeds — only on the first processed sheet per balance.
  const initComp = compInitialized ? null : round2(num(bankedCompInput));
  const initPlaw = plawInitialized ? null : round2(num(plawStartInput));

  return { earned, otBanked: otBankedNum, compUsedNum, plawUsed, compDelta, plawDelta, initComp, initPlaw };
}

/**
 * Apply an effect to a balances object, returning the NEW balances plus the
 * exact record to persist on the timesheet ("applied delta").
 *
 * balances: { comp, plaw, compInitialized, plawInitialized }
 *
 * The initialization seed lands BEFORE the running delta so the first week's
 * own earned/used hours stack on top of the carried-in starting balance.
 */
function applyProcess(balances, effect) {
  let comp = num(balances.comp);
  let plaw = num(balances.plaw);
  let compInitialized = !!balances.compInitialized;
  let plawInitialized = !!balances.plawInitialized;

  if (effect.initComp != null && !compInitialized) {
    comp = round2(comp + effect.initComp);
    compInitialized = true;
  }
  if (effect.initPlaw != null && !plawInitialized) {
    plaw = round2(plaw + effect.initPlaw);
    plawInitialized = true;
  }

  comp = round2(comp + effect.compDelta);
  plaw = round2(plaw + effect.plawDelta);

  const newBalances = { comp, plaw, compInitialized, plawInitialized };

  // The exact, self-contained record needed to reverse this later.
  const applied = {
    appliedCompDelta: effect.compDelta,
    appliedPlawDelta: effect.plawDelta,
    initComp: effect.initComp, // null when this sheet didn't seed comp
    initPlaw: effect.initPlaw, // null when this sheet didn't seed P-Law
  };

  return { balances: newBalances, applied };
}

/**
 * Reverse a previously-applied effect (reopen for corrections). Takes the
 * `applied` record stored when the sheet was processed and undoes exactly
 * that — running delta first, then any one-time seed (flipping the
 * initialization flag back off so a re-process re-seeds correctly).
 */
function reverseProcess(balances, applied) {
  let comp = round2(num(balances.comp) - num(applied.appliedCompDelta));
  let plaw = round2(num(balances.plaw) - num(applied.appliedPlawDelta));
  let compInitialized = !!balances.compInitialized;
  let plawInitialized = !!balances.plawInitialized;

  if (applied.initComp != null) {
    comp = round2(comp - applied.initComp);
    compInitialized = false;
  }
  if (applied.initPlaw != null) {
    plaw = round2(plaw - applied.initPlaw);
    plawInitialized = false;
  }

  return { comp, plaw, compInitialized, plawInitialized };
}

module.exports = {
  ROW_KEYS,
  DAY_KEYS,
  WEEK_HOURS,
  DAY_REGULAR_CAP,
  num,
  round2,
  rowTotal,
  summarizeGrid,
  normalizeDailyOvertime,
  payableHours,
  suggestedOtBanked,
  computeProcessEffect,
  applyProcess,
  reverseProcess,
};
