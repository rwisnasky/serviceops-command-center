/**
 * src/db/timesheetRepository.js
 * ───────────────────────────────────────────────────────────────────────
 * CRUD + balance orchestration for the employee timesheet.
 *
 * Backs the /api/timesheet routes. Every row belongs to a single employee
 * (users.id). Balance math itself lives in ../services/timesheetBalanceService
 * (pure, unit-tested); this module just persists what those functions produce
 * and enforces the ordering rules:
 *
 *   • Process oldest-first — you can't process a period while an OLDER draft
 *     for the same employee is still unprocessed. This keeps the running comp
 *     balance correct when two weeks are turned in together.
 *   • Reopen newest-first (LIFO) — you can only reopen the most-recently
 *     processed period, because reversing a middle period would corrupt the
 *     running balance of the periods stacked on top of it.
 *
 * All balance-changing operations (process / reopen) run inside a single
 * better-sqlite3 transaction so the timesheet row and the balances row can
 * never drift out of sync.
 * ───────────────────────────────────────────────────────────────────────
 */

const { getDb } = require("./index");
const bal = require("../services/timesheetBalanceService");

// ── Balances ───────────────────────────────────────────────────────────

/** Fetch (or lazily create) the balances row for an employee. */
function getBalances(userId) {
  const db = getDb();
  let row = db
    .prepare(`SELECT * FROM timesheet_balances WHERE user_id = ?`)
    .get(userId);
  if (!row) {
    db.prepare(
      `INSERT INTO timesheet_balances (user_id) VALUES (?)`
    ).run(userId);
    row = db
      .prepare(`SELECT * FROM timesheet_balances WHERE user_id = ?`)
      .get(userId);
  }
  return normalizeBalances(row);
}

function normalizeBalances(row) {
  return {
    userId: row.user_id,
    comp: row.comp_balance,
    plaw: row.plaw_balance,
    compInitialized: !!row.comp_initialized,
    plawInitialized: !!row.plaw_initialized,
    updatedAt: row.updated_at,
  };
}

function writeBalances(userId, b) {
  getDb()
    .prepare(
      `UPDATE timesheet_balances
         SET comp_balance = ?, plaw_balance = ?,
             comp_initialized = ?, plaw_initialized = ?,
             updated_at = datetime('now')
       WHERE user_id = ?`
    )
    .run(
      bal.round2(b.comp),
      bal.round2(b.plaw),
      b.compInitialized ? 1 : 0,
      b.plawInitialized ? 1 : 0,
      userId
    );
}

// ── Timesheet rows ───────────────────────────────────────────────────────

/** Shape a raw DB row into the object the API/UI consumes (grid parsed, totals computed). */
function decorate(row) {
  if (!row) return null;
  let grid = {};
  try {
    grid = row.grid_json ? JSON.parse(row.grid_json) : {};
  } catch (_) {
    grid = {};
  }
  const totals = bal.summarizeGrid(grid);
  const otBanked = Math.max(0, bal.num(row.ot_banked));
  return {
    id: row.id,
    userId: row.user_id,
    employeeName: row.employee_name,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    grid,
    notes: row.notes || "",
    compUsed: row.comp_used || 0,
    payOvertime: !!row.pay_overtime,
    otBanked,
    payableHours: bal.payableHours(grid, otBanked),   // hours the week actually pays (≤40 unless OT paid)
    suggestedOtBanked: bal.suggestedOtBanked(grid),    // hours over 40 (for the UI suggestion)
    bankedCompInput: row.banked_comp_input,
    plawStartInput: row.plaw_start_input,
    appliedCompDelta: row.applied_comp_delta,
    appliedPlawDelta: row.applied_plaw_delta,
    appliedInitComp: row.applied_init_comp,
    appliedInitPlaw: row.applied_init_plaw,
    processedAt: row.processed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    totals,
  };
}

function getById(id) {
  const row = getDb().prepare(`SELECT * FROM timesheets WHERE id = ?`).get(Number(id));
  return decorate(row);
}

/** All of an employee's periods, newest first, for the history accordion. */
function listForUser(userId) {
  const rows = getDb()
    .prepare(
      `SELECT * FROM timesheets WHERE user_id = ? ORDER BY period_start DESC, id DESC`
    )
    .all(userId);
  return rows.map(decorate);
}

/**
 * Save (insert or update) a DRAFT. Keyed on (user_id, period_start) so
 * re-saving the same week updates it rather than duplicating. Refuses to
 * touch a period that's already processed — the caller must reopen first.
 *
 * Returns the decorated row.
 */
function saveDraft({
  userId,
  employeeName,
  periodStart,
  periodEnd,
  grid,
  notes,
  compUsed,
  payOvertime,
  otBanked,
  bankedCompInput,
  plawStartInput,
}) {
  const db = getDb();
  if (!userId) throw new Error("userId required");
  if (!periodStart) throw new Error("periodStart required");

  const existing = db
    .prepare(`SELECT * FROM timesheets WHERE user_id = ? AND period_start = ?`)
    .get(userId, periodStart);

  if (existing && existing.status === "processed") {
    throw new Error("This period is processed. Reopen it before editing.");
  }

  // Enforce the daily overtime rule on every save: Regular caps at 8/day and
  // the remainder spills into Overtime. This also normalizes clock-fills
  // (which accumulate into Regular) since they route through here.
  const normGrid = bal.normalizeDailyOvertime(grid || {});
  const gridJson = JSON.stringify(normGrid);
  const compUsedNum = bal.round2(bal.num(compUsed));
  const payOt = payOvertime ? 1 : 0;
  // If overtime is paid, nothing is banked. Otherwise clamp the banked amount
  // to the actual overage so a stale value can't over-bank a now-smaller week.
  // Clamp against the NORMALIZED grid so a stale banked amount can't exceed the
  // week's actual overage after the daily split is applied.
  const otBankedNum = payOt ? 0 : Math.min(Math.max(0, bal.round2(bal.num(otBanked))), bal.suggestedOtBanked(normGrid));
  const banked = bankedCompInput === "" || bankedCompInput == null ? null : bal.round2(bal.num(bankedCompInput));
  const plawStart = plawStartInput === "" || plawStartInput == null ? null : bal.round2(bal.num(plawStartInput));

  if (existing) {
    db.prepare(
      `UPDATE timesheets
         SET employee_name = ?, period_end = ?, grid_json = ?, notes = ?,
             comp_used = ?, pay_overtime = ?, ot_banked = ?,
             banked_comp_input = ?, plaw_start_input = ?,
             updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      employeeName || existing.employee_name,
      periodEnd || null,
      gridJson,
      notes || null,
      compUsedNum,
      payOt,
      otBankedNum,
      banked,
      plawStart,
      existing.id
    );
    return getById(existing.id);
  }

  const info = db
    .prepare(
      `INSERT INTO timesheets
         (user_id, employee_name, period_start, period_end, status,
          grid_json, notes, comp_used, pay_overtime, ot_banked,
          banked_comp_input, plaw_start_input)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      employeeName || null,
      periodStart,
      periodEnd || null,
      gridJson,
      notes || null,
      compUsedNum,
      payOt,
      otBankedNum,
      banked,
      plawStart
    );
  return getById(info.lastInsertRowid);
}

/**
 * Add worked hours onto a single day/row cell of a period, creating the draft
 * if needed and merging with whatever's already there. Used by the time clock
 * to drop clocked hours onto the Regular row. Refuses (without throwing) if
 * the target period is already processed — the caller surfaces that.
 *
 * Returns { added, timesheet?, periodStart, reason? }.
 */
function addHoursToDay({ userId, employeeName, periodStart, periodEnd, dayKey, rowKey = "regular", hours }) {
  const db = getDb();
  if (!userId) throw new Error("userId required");
  if (!periodStart || !dayKey) throw new Error("periodStart and dayKey required");

  const existing = db
    .prepare(`SELECT * FROM timesheets WHERE user_id = ? AND period_start = ?`)
    .get(userId, periodStart);

  if (existing && existing.status === "processed") {
    return { added: false, reason: "processed", periodStart };
  }

  let grid = {};
  if (existing) { try { grid = JSON.parse(existing.grid_json || "{}"); } catch (_) {} }
  if (!grid[rowKey]) grid[rowKey] = {};
  const next = bal.round2(bal.num(grid[rowKey][dayKey]) + bal.num(hours));
  grid[rowKey][dayKey] = next === 0 ? "" : String(next);

  const saved = saveDraft({
    userId,
    employeeName: employeeName || (existing && existing.employee_name),
    periodStart,
    periodEnd: periodEnd || (existing && existing.period_end),
    grid,
    notes: existing ? existing.notes : undefined,
    compUsed: existing ? existing.comp_used : undefined,
    payOvertime: existing ? !!existing.pay_overtime : undefined,
    otBanked: existing ? existing.ot_banked : undefined,
    bankedCompInput: existing ? existing.banked_comp_input : undefined,
    plawStartInput: existing ? existing.plaw_start_input : undefined,
  });
  return { added: true, timesheet: saved, periodStart };
}

/** Delete a draft. Processed sheets can't be deleted (reopen first). */
function deleteDraft(id, userId) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM timesheets WHERE id = ?`).get(Number(id));
  if (!row) throw new Error("timesheet not found");
  if (row.user_id !== userId) throw new Error("not your timesheet");
  if (row.status === "processed") throw new Error("Reopen before deleting a processed period.");
  db.prepare(`DELETE FROM timesheets WHERE id = ?`).run(Number(id));
  return { ok: true };
}

// ── Process / Reopen (balance-changing, transactional) ───────────────────

/**
 * Process a draft: lock the period and apply its effect to the running
 * balances. Enforces oldest-first — refuses if any earlier draft is still
 * unprocessed. Returns { timesheet, balances }.
 */
function processTimesheet(id, userId) {
  const db = getDb();

  const tx = db.transaction(() => {
    const row = db.prepare(`SELECT * FROM timesheets WHERE id = ?`).get(Number(id));
    if (!row) throw new Error("timesheet not found");
    if (row.user_id !== userId) throw new Error("not your timesheet");
    if (row.status === "processed") throw new Error("This period is already processed.");

    // Oldest-first guard: no earlier DRAFT may remain unprocessed.
    const olderDraft = db
      .prepare(
        `SELECT period_start FROM timesheets
          WHERE user_id = ? AND status = 'draft' AND period_start < ?
          ORDER BY period_start ASC LIMIT 1`
      )
      .get(userId, row.period_start);
    if (olderDraft) {
      throw new Error(
        `Process the earlier period (${olderDraft.period_start}) first — ` +
        `weeks must be processed oldest-first so the comp balance stays correct.`
      );
    }

    const current = getBalances(userId);
    let grid = {};
    try { grid = row.grid_json ? JSON.parse(row.grid_json) : {}; } catch (_) {}

    // Hours are categorized per-day (Regular caps at 8, remainder → Overtime).
    // Separately, any hours the employee chose to bank (the week's total over
    // 40) roll into comp — that amount rides on the row. Banking is optional,
    // so a week over 40 with nothing banked simply processes as paid overtime.
    const otBanked = Math.max(0, bal.num(row.ot_banked));

    const effect = bal.computeProcessEffect({
      grid,
      compUsed: row.comp_used,
      otBanked,
      bankedCompInput: row.banked_comp_input,
      plawStartInput: row.plaw_start_input,
      compInitialized: current.compInitialized,
      plawInitialized: current.plawInitialized,
    });

    const { balances: newBal, applied } = bal.applyProcess(current, effect);
    writeBalances(userId, newBal);

    db.prepare(
      `UPDATE timesheets
         SET status = 'processed',
             applied_comp_delta = ?, applied_plaw_delta = ?,
             applied_init_comp = ?, applied_init_plaw = ?,
             processed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      applied.appliedCompDelta,
      applied.appliedPlawDelta,
      applied.initComp,
      applied.initPlaw,
      Number(id)
    );

    return { timesheet: getById(id), balances: getBalances(userId) };
  });

  return tx();
}

/**
 * Reopen a processed period for corrections: reverse its exact applied
 * effect and flip it back to draft. Enforces newest-first (LIFO) — you can
 * only reopen the latest processed period so the running balance can't be
 * corrupted underneath a later week.
 */
function reopenTimesheet(id, userId) {
  const db = getDb();

  const tx = db.transaction(() => {
    const row = db.prepare(`SELECT * FROM timesheets WHERE id = ?`).get(Number(id));
    if (!row) throw new Error("timesheet not found");
    if (row.user_id !== userId) throw new Error("not your timesheet");
    if (row.status !== "processed") throw new Error("This period isn't processed.");

    // Newest-first guard: no LATER processed period may exist.
    const laterProcessed = db
      .prepare(
        `SELECT period_start FROM timesheets
          WHERE user_id = ? AND status = 'processed' AND period_start > ?
          ORDER BY period_start DESC LIMIT 1`
      )
      .get(userId, row.period_start);
    if (laterProcessed) {
      throw new Error(
        `Reopen the later period (${laterProcessed.period_start}) first — ` +
        `periods must be reopened newest-first so balances unwind cleanly.`
      );
    }

    const current = getBalances(userId);
    const reverted = bal.reverseProcess(current, {
      appliedCompDelta: row.applied_comp_delta,
      appliedPlawDelta: row.applied_plaw_delta,
      initComp: row.applied_init_comp,
      initPlaw: row.applied_init_plaw,
    });
    writeBalances(userId, reverted);

    db.prepare(
      `UPDATE timesheets
         SET status = 'draft',
             applied_comp_delta = NULL, applied_plaw_delta = NULL,
             applied_init_comp = NULL, applied_init_plaw = NULL,
             processed_at = NULL, updated_at = datetime('now')
       WHERE id = ?`
    ).run(Number(id));

    return { timesheet: getById(id), balances: getBalances(userId) };
  });

  return tx();
}

module.exports = {
  getBalances,
  listForUser,
  getById,
  saveDraft,
  addHoursToDay,
  deleteDraft,
  processTimesheet,
  reopenTimesheet,
};
