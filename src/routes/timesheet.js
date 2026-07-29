/**
 * src/routes/timesheet.js
 *
 * Employee timesheet API. Mounted at /api/timesheet.
 *
 * Auth: the global requireAuth middleware in src/index.js already guarantees
 * a logged-in session on every route here. The timesheet is self-service —
 * the EMPLOYEE is always the logged-in user, so no route accepts a user id
 * from the client. We read it from req.session and look up the display name
 * so the sheet auto-fills the employee without them typing it.
 *
 * Endpoints:
 *   GET    /api/timesheet/summary          → { employee, balances }
 *   GET    /api/timesheet/periods          → { periods: [...] } (newest first)
 *   POST   /api/timesheet/draft            → save/update the current week's draft
 *   POST   /api/timesheet/:id/process      → lock + apply balances (oldest-first)
 *   POST   /api/timesheet/:id/reopen       → reverse + unlock (newest-first)
 *   DELETE /api/timesheet/:id              → delete a draft
 */

const express = require("express");
const router = express.Router();
const repo = require("../db/timesheetRepository");
const clockRepo = require("../db/timeClockRepository");
const clockSvc = require("../services/timeClockService");
const userRepo = require("../db/userRepository");

function jsonError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

/** The logged-in employee, resolved from the session. */
function currentEmployee(req) {
  const id = req.session?.userId;
  if (!id) return null;
  const u = userRepo.findById(id);
  if (!u || !u.active) return null;
  // The timesheet wants the whole name (First + Last). userRepo.fullName
  // handles the fallbacks (display name, then email) when name parts aren't set.
  const name = userRepo.fullName(u);
  const hasFullName = !!((u.first_name && u.first_name.trim()) || (u.last_name && u.last_name.trim()));
  return { id: u.id, email: u.email, name, hasFullName };
}

// ── GET /summary — employee identity + current balances ──────────────────────
router.get("/summary", (req, res) => {
  const emp = currentEmployee(req);
  if (!emp) return jsonError(res, 401, "not logged in");
  try {
    const balances = repo.getBalances(emp.id);
    res.json({ ok: true, employee: emp, balances });
  } catch (err) {
    console.error("[Timesheet] summary error:", err.message);
    return jsonError(res, 500, "failed to load summary");
  }
});

// ── GET /periods — full history for the accordion ────────────────────────────
router.get("/periods", (req, res) => {
  const emp = currentEmployee(req);
  if (!emp) return jsonError(res, 401, "not logged in");
  try {
    const periods = repo.listForUser(emp.id);
    res.json({ ok: true, periods });
  } catch (err) {
    console.error("[Timesheet] periods error:", err.message);
    return jsonError(res, 500, "failed to load periods");
  }
});

// ── POST /draft — save/update the current week ───────────────────────────────
router.post("/draft", express.json(), (req, res) => {
  const emp = currentEmployee(req);
  if (!emp) return jsonError(res, 401, "not logged in");

  const { periodStart, periodEnd, grid, notes, compUsed, payOvertime, otBanked, bankedCompInput, plawStartInput } =
    req.body || {};
  if (!periodStart) return jsonError(res, 400, "periodStart is required");

  try {
    const saved = repo.saveDraft({
      userId: emp.id,
      employeeName: emp.name,
      periodStart,
      periodEnd,
      grid,
      notes,
      compUsed,
      payOvertime,
      otBanked,
      bankedCompInput,
      plawStartInput,
    });
    res.json({ ok: true, timesheet: saved });
  } catch (err) {
    console.error("[Timesheet] saveDraft error:", err.message);
    return jsonError(res, 400, err.message || "failed to save draft");
  }
});

// ── POST /:id/process — lock + apply balances ────────────────────────────────
router.post("/:id/process", (req, res) => {
  const emp = currentEmployee(req);
  if (!emp) return jsonError(res, 401, "not logged in");
  try {
    const result = repo.processTimesheet(Number(req.params.id), emp.id);
    console.log(`[Timesheet] ${emp.email} processed period ${result.timesheet.periodStart}`);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[Timesheet] process error:", err.message);
    return jsonError(res, 400, err.message || "failed to process timesheet");
  }
});

// ── POST /:id/reopen — reverse + unlock for corrections ──────────────────────
router.post("/:id/reopen", (req, res) => {
  const emp = currentEmployee(req);
  if (!emp) return jsonError(res, 401, "not logged in");
  try {
    const result = repo.reopenTimesheet(Number(req.params.id), emp.id);
    console.log(`[Timesheet] ${emp.email} reopened period ${result.timesheet.periodStart}`);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[Timesheet] reopen error:", err.message);
    return jsonError(res, 400, err.message || "failed to reopen timesheet");
  }
});

// ── DELETE /:id — delete a draft ─────────────────────────────────────────────
router.delete("/:id", (req, res) => {
  const emp = currentEmployee(req);
  if (!emp) return jsonError(res, 401, "not logged in");
  try {
    repo.deleteDraft(Number(req.params.id), emp.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[Timesheet] delete error:", err.message);
    return jsonError(res, 400, err.message || "failed to delete draft");
  }
});

// ── Time clock ───────────────────────────────────────────────────────────────
// Live punch in/out with break tracking + manual entries. Clock-out drops the
// worked hours onto the day's Regular cell. The browser sends ISO timestamps
// (its local zone) and the local workDate so day/period mapping is correct.

// GET /clock — active punch + this pay period's punches
router.get("/clock", (req, res) => {
  const emp = currentEmployee(req);
  if (!emp) return jsonError(res, 401, "not logged in");
  try {
    const active = clockRepo.getActive(emp.id);
    const today = clockSvc.isoDate(new Date());
    const periodStart = req.query.periodStart || clockSvc.periodStartFor(today);
    const periodEnd = clockSvc.periodEndFor(periodStart);
    const punches = clockRepo.listForPeriod(emp.id, periodStart, periodEnd);
    res.json({ ok: true, active, punches, periodStart, periodEnd, serverNow: new Date().toISOString() });
  } catch (err) {
    console.error("[Timesheet] clock status error:", err.message);
    return jsonError(res, 500, "failed to load clock");
  }
});

router.post("/clock/in", express.json(), (req, res) => {
  const emp = currentEmployee(req);
  if (!emp) return jsonError(res, 401, "not logged in");
  try {
    const { at, workDate, note } = req.body || {};
    const punch = clockRepo.clockIn({ userId: emp.id, at, workDate, note });
    console.log(`[Timesheet] ${emp.email} clocked in`);
    res.json({ ok: true, active: punch });
  } catch (err) {
    return jsonError(res, 400, err.message || "failed to clock in");
  }
});

router.post("/clock/out", express.json(), (req, res) => {
  const emp = currentEmployee(req);
  if (!emp) return jsonError(res, 401, "not logged in");
  try {
    const { at } = req.body || {};
    const result = clockRepo.clockOut({ userId: emp.id, at, employeeName: emp.name });
    console.log(`[Timesheet] ${emp.email} clocked out — ${result.hours}h`);
    res.json({ ok: true, ...result });
  } catch (err) {
    return jsonError(res, 400, err.message || "failed to clock out");
  }
});

router.post("/clock/break/start", express.json(), (req, res) => {
  const emp = currentEmployee(req);
  if (!emp) return jsonError(res, 401, "not logged in");
  try {
    const active = clockRepo.startBreak({ userId: emp.id, at: (req.body || {}).at });
    res.json({ ok: true, active });
  } catch (err) {
    return jsonError(res, 400, err.message || "failed to start break");
  }
});

router.post("/clock/break/end", express.json(), (req, res) => {
  const emp = currentEmployee(req);
  if (!emp) return jsonError(res, 401, "not logged in");
  try {
    const active = clockRepo.endBreak({ userId: emp.id, at: (req.body || {}).at });
    res.json({ ok: true, active });
  } catch (err) {
    return jsonError(res, 400, err.message || "failed to end break");
  }
});

router.post("/clock/adjust", express.json(), (req, res) => {
  const emp = currentEmployee(req);
  if (!emp) return jsonError(res, 401, "not logged in");
  try {
    const { clockIn, note } = req.body || {};
    const active = clockRepo.adjustActive({ userId: emp.id, clockIn, note });
    res.json({ ok: true, active });
  } catch (err) {
    return jsonError(res, 400, err.message || "failed to adjust clock-in");
  }
});

router.post("/clock/manual", express.json(), (req, res) => {
  const emp = currentEmployee(req);
  if (!emp) return jsonError(res, 401, "not logged in");
  try {
    const { workDate, clockIn, clockOut, breakSeconds, note } = req.body || {};
    const result = clockRepo.manualEntry({
      userId: emp.id, workDate, clockIn, clockOut, breakSeconds, note, employeeName: emp.name,
    });
    console.log(`[Timesheet] ${emp.email} added manual entry — ${result.hours}h`);
    res.json({ ok: true, ...result });
  } catch (err) {
    return jsonError(res, 400, err.message || "failed to add manual entry");
  }
});

module.exports = router;
