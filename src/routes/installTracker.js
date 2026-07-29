/**
 * routes/installTracker.js
 * ────────────────────────────────────────────────────────────────────────────
 * HTTP layer for the Install Tracker — completed HVAC + Water Heater installs
 * and whether the office has (1) listed the equipment in ServiceTitan and
 * (2) registered the manufacturer warranty. Both statuses are manual toggles.
 *
 *   GET  /api/install-tracker/list?from=YYYY-MM-DD&to=YYYY-MM-DD&status=all
 *        → { rows, summary, meta }
 *   GET  /api/install-tracker/list.csv?from=&to=&status=
 *        → CSV download of the current view
 *   POST /api/install-tracker/status
 *        body: { jobId, field, value, snapshot:{...display fields} }
 *        field ∈ 'equipmentListed' | 'warrantyRegistered'
 *        → { ok, row }
 *   POST /api/install-tracker/notes
 *        body: { jobId, notes, snapshot:{...} }  → { ok, row }
 *   GET  /api/install-tracker/job-types   → diagnostic: watched types
 *
 * Date range is capped at 366 days to keep the ST fan-out reasonable. The heavy
 * lifting lives in services/installTrackerService.js.
 * ────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router = express.Router();
const svc = require("../services/installTrackerService");
const { INSTALL_JOB_TYPES } = require("../config/installTrackerJobTypes");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function parseRange(req) {
  const { from, to } = req.query;
  if (!from || !to) throw httpError(400, "Both `from` and `to` (YYYY-MM-DD) are required.");
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    throw httpError(400, "`from` and `to` must be in YYYY-MM-DD format.");
  }
  const fromD = new Date(`${from}T00:00:00Z`);
  const toD = new Date(`${to}T00:00:00Z`);
  if (isNaN(fromD) || isNaN(toD)) throw httpError(400, "Invalid date(s) — couldn't parse.");
  if (fromD > toD) throw httpError(400, "`from` must be on or before `to`.");
  const days = Math.round((toD - fromD) / 86400000) + 1;
  if (days > 366) throw httpError(400, `Date range too large (${days} days). Keep it ≤ 366 days.`);
  return { from, to, days };
}

// Best-effort human label for who confirmed a status (mirrors equipment route).
function createdByFrom(req) {
  const uid = req.session?.userId;
  if (!uid) return null;
  try {
    const { findById } = require("../db/userRepository");
    const u = findById(uid);
    return u?.email || u?.name || String(uid);
  } catch (_) {
    return String(uid);
  }
}

// GET /api/install-tracker/list
router.get("/list", async (req, res) => {
  try {
    const { from, to } = parseRange(req);
    const report = await svc.buildTrackerReport({ from, to, status: req.query.status });
    res.json({ ok: true, ...report });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("[InstallTracker] /list error:", err.response?.data || err.message);
    res.status(status).json({ ok: false, error: err.message });
  }
});

// GET /api/install-tracker/list.csv
router.get("/list.csv", async (req, res) => {
  try {
    const { from, to } = parseRange(req);
    const report = await svc.buildTrackerReport({ from, to, status: req.query.status });

    const headers = [
      "Completed", "Customer", "Job #", "Category", "Job Type",
      "In ServiceTitan", "Warranty Registered", "Confirmed By", "Notes",
    ];
    const cell = (v) => {
      if (v == null) return "";
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const yn = (b) => (b ? "Yes" : "No");

    const lines = [headers.map(cell).join(",")];
    for (const r of report.rows) {
      const by = [r.equipmentListedBy, r.warrantyRegisteredBy].filter(Boolean).join(" / ");
      lines.push([
        r.completedOn, r.customerName, r.jobNumber, r.category, r.jobType,
        yn(r.equipmentListed), yn(r.warrantyRegistered), by, r.notes,
      ].map(cell).join(","));
    }

    const fname = `install_tracker_${from}_to_${to}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    res.send(lines.join("\r\n"));
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("[InstallTracker] /list.csv error:", err.response?.data || err.message);
    res.status(status).json({ ok: false, error: err.message });
  }
});

// POST /api/install-tracker/status
router.post("/status", (req, res) => {
  try {
    const { jobId, field, value, snapshot } = req.body || {};
    if (!jobId || !/^\d+$/.test(String(jobId))) {
      return res.status(400).json({ ok: false, error: "numeric jobId required" });
    }
    if (field !== "equipmentListed" && field !== "warrantyRegistered") {
      return res.status(400).json({ ok: false, error: "field must be equipmentListed or warrantyRegistered" });
    }
    const row = svc.setStatus({
      jobId, field, value: !!value, actor: createdByFrom(req), snapshot,
    });
    res.json({ ok: true, row });
  } catch (err) {
    console.error("[InstallTracker] /status error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/install-tracker/notes
router.post("/notes", (req, res) => {
  try {
    const { jobId, notes, snapshot } = req.body || {};
    if (!jobId || !/^\d+$/.test(String(jobId))) {
      return res.status(400).json({ ok: false, error: "numeric jobId required" });
    }
    const row = svc.setNotes({ jobId, notes, snapshot });
    res.json({ ok: true, row });
  } catch (err) {
    console.error("[InstallTracker] /notes error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/install-tracker/job-types — diagnostic
router.get("/job-types", (_req, res) => {
  res.json({ ok: true, types: INSTALL_JOB_TYPES });
});

module.exports = router;
