/**
 * src/db/timeClockRepository.js
 * ───────────────────────────────────────────────────────────────────────
 * Live time clock persistence (punch in/out, breaks, manual entries).
 *
 * One employee has at most one ACTIVE punch at a time. Clocking out computes
 * rounded worked hours (via timeClockService) and drops them onto that day's
 * Regular cell of the matching pay period (via timesheetRepository), so the
 * grid fills itself. Times are ISO strings the browser sends; work_date is
 * the employee's LOCAL calendar day.
 * ───────────────────────────────────────────────────────────────────────
 */

const { getDb } = require("./index");
const clock = require("../services/timeClockService");
const timesheetRepo = require("./timesheetRepository");

function decorate(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    workDate: row.work_date,
    clockIn: row.clock_in,
    clockOut: row.clock_out,
    breakSeconds: row.break_seconds || 0,
    breakStartedAt: row.break_started_at,
    onBreak: !!row.break_started_at,
    hours: row.hours,
    status: row.status,
    appliedPeriodStart: row.applied_period_start,
    appliedDay: row.applied_day,
    note: row.note || "",
    source: row.source || "clock",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The employee's currently-open punch, or null. */
function getActive(userId) {
  const row = getDb()
    .prepare(`SELECT * FROM time_punches WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`)
    .get(userId);
  return decorate(row);
}

function getById(id) {
  return decorate(getDb().prepare(`SELECT * FROM time_punches WHERE id = ?`).get(Number(id)));
}

/** Recent closed punches for a pay period (for the panel's "today/this period" list). */
function listForPeriod(userId, periodStart, periodEnd) {
  const rows = getDb()
    .prepare(
      `SELECT * FROM time_punches
        WHERE user_id = ? AND work_date >= ? AND work_date <= ?
        ORDER BY clock_in DESC`
    )
    .all(userId, periodStart, periodEnd);
  return rows.map(decorate);
}

/**
 * Clock in. Refuses if an active punch already exists. `at` is the clock-in
 * ISO (defaults to now on the caller side); `workDate` is the local day.
 */
function clockIn({ userId, at, workDate, note }) {
  const db = getDb();
  if (getActive(userId)) throw new Error("You're already clocked in.");
  const clockInIso = at || new Date().toISOString();
  const wd = workDate || clock.isoDate(new Date(clockInIso));
  const info = db
    .prepare(
      `INSERT INTO time_punches (user_id, work_date, clock_in, status, note, source)
       VALUES (?, ?, ?, 'active', ?, 'clock')`
    )
    .run(userId, wd, clockInIso, note || null);
  return getById(info.lastInsertRowid);
}

/** Adjust the active punch's clock-in time (the "Adjust Clock-In" affordance). */
function adjustActive({ userId, clockIn: newIn, note }) {
  const db = getDb();
  const active = getActive(userId);
  if (!active) throw new Error("You're not clocked in.");
  if (newIn && !Number.isFinite(Date.parse(newIn))) throw new Error("Invalid clock-in time.");
  db.prepare(
    `UPDATE time_punches
       SET clock_in = COALESCE(?, clock_in),
           work_date = COALESCE(?, work_date),
           note = COALESCE(?, note),
           updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    newIn || null,
    newIn ? clock.isoDate(new Date(newIn)) : null,
    note != null ? note : null,
    active.id
  );
  return getActive(userId);
}

function startBreak({ userId, at }) {
  const db = getDb();
  const active = getActive(userId);
  if (!active) throw new Error("You're not clocked in.");
  if (active.onBreak) throw new Error("You're already on break.");
  db.prepare(`UPDATE time_punches SET break_started_at = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(at || new Date().toISOString(), active.id);
  return getActive(userId);
}

function endBreak({ userId, at }) {
  const db = getDb();
  const active = getActive(userId);
  if (!active) throw new Error("You're not clocked in.");
  if (!active.onBreak) throw new Error("You're not on a break.");
  const add = clock.secondsBetween(active.breakStartedAt, at || new Date().toISOString());
  db.prepare(
    `UPDATE time_punches
       SET break_seconds = break_seconds + ?, break_started_at = NULL, updated_at = datetime('now')
     WHERE id = ?`
  ).run(add, active.id);
  return getActive(userId);
}

/**
 * Clock out the active punch: close any open break, compute rounded worked
 * hours, record them, and add them to the Regular cell of the day's period.
 * Returns { punch, fill } where fill describes the grid update.
 */
function clockOut({ userId, at, employeeName }) {
  const db = getDb();
  const active = getActive(userId);
  if (!active) throw new Error("You're not clocked in.");

  const outIso = at || new Date().toISOString();
  if (Date.parse(outIso) <= Date.parse(active.clockIn)) {
    throw new Error("Clock-out time must be after clock-in.");
  }

  // Fold any in-progress break into the accrued break seconds.
  let breakSeconds = active.breakSeconds;
  if (active.onBreak) breakSeconds += clock.secondsBetween(active.breakStartedAt, outIso);

  const hours = clock.workedHours(active.clockIn, outIso, breakSeconds);
  const periodStart = clock.periodStartFor(active.workDate);
  const periodEnd = clock.periodEndFor(periodStart);
  const dayKey = clock.dayKeyFor(active.workDate);

  const tx = db.transaction(() => {
    const fill = timesheetRepo.addHoursToDay({
      userId,
      employeeName,
      periodStart,
      periodEnd,
      dayKey,
      rowKey: "regular",
      hours,
    });

    db.prepare(
      `UPDATE time_punches
         SET clock_out = ?, break_seconds = ?, break_started_at = NULL,
             hours = ?, status = 'closed',
             applied_period_start = ?, applied_day = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(outIso, breakSeconds, hours, periodStart, dayKey, active.id);

    return { punch: getById(active.id), fill, hours, periodStart, dayKey };
  });

  return tx();
}

/**
 * Add a completed entry by hand (forgot to clock in, or fixing a day). Same
 * grid fill as a real clock-out. Times are ISO; workDate the local day.
 */
function manualEntry({ userId, workDate, clockIn: inIso, clockOut: outIso, breakSeconds = 0, note, employeeName }) {
  const db = getDb();
  if (!inIso || !outIso) throw new Error("Both start and end times are required.");
  if (Date.parse(outIso) <= Date.parse(inIso)) throw new Error("End time must be after start time.");
  const wd = workDate || clock.isoDate(new Date(inIso));
  const brk = Math.max(0, Number(breakSeconds) || 0);
  const hours = clock.workedHours(inIso, outIso, brk);
  const periodStart = clock.periodStartFor(wd);
  const periodEnd = clock.periodEndFor(periodStart);
  const dayKey = clock.dayKeyFor(wd);

  const tx = db.transaction(() => {
    const fill = timesheetRepo.addHoursToDay({
      userId, employeeName, periodStart, periodEnd, dayKey, rowKey: "regular", hours,
    });
    const info = db
      .prepare(
        `INSERT INTO time_punches
           (user_id, work_date, clock_in, clock_out, break_seconds, hours,
            status, applied_period_start, applied_day, note, source)
         VALUES (?, ?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'manual')`
      )
      .run(userId, wd, inIso, outIso, brk, hours, periodStart, dayKey, note || null);
    return { punch: getById(info.lastInsertRowid), fill, hours, periodStart, dayKey };
  });

  return tx();
}

module.exports = {
  getActive,
  getById,
  listForPeriod,
  clockIn,
  adjustActive,
  startBreak,
  endBreak,
  clockOut,
  manualEntry,
};
