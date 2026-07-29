/**
 * routes/backflow.js
 * ────────────────────────────────────────────────────────────────────────────
 * HTTP layer for the Backflow Details report.
 *
 *   GET  /api/backflow/list?from=YYYY-MM-DD&to=YYYY-MM-DD
 *        → { rows, summary, meta }
 *
 *   GET  /api/backflow/list.csv?from=YYYY-MM-DD&to=YYYY-MM-DD
 *        → CSV download with the same columns as the on-page table.
 *
 *   GET  /api/backflow/job-type
 *        → quick sanity check: which ST job type(s) are we matching?
 *
 * Date range is capped at 366 days to keep the per-job fan-out reasonable.
 * The actual heavy lifting lives in services/backflowReportService.js.
 * ────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router = express.Router();
const {
  buildBackflowReport,
  getBackflowJobTypeIds,
} = require("../services/backflowReportService");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseRange(req) {
  const { from, to } = req.query;
  if (!from || !to) {
    throw httpError(400, "Both `from` and `to` (YYYY-MM-DD) are required.");
  }
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    throw httpError(400, "`from` and `to` must be in YYYY-MM-DD format.");
  }
  const fromD = new Date(`${from}T00:00:00Z`);
  const toD = new Date(`${to}T00:00:00Z`);
  if (isNaN(fromD) || isNaN(toD)) {
    throw httpError(400, "Invalid date(s) — couldn't parse.");
  }
  if (fromD > toD) {
    throw httpError(400, "`from` must be on or before `to`.");
  }
  const days = Math.round((toD - fromD) / 86400000) + 1;
  if (days > 366) {
    throw httpError(400, `Date range too large (${days} days). Keep it ≤ 366 days.`);
  }
  return { from, to, days };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// GET /api/backflow/list
router.get("/list", async (req, res) => {
  try {
    const { from, to } = parseRange(req);
    const report = await buildBackflowReport({ from, to });
    res.json({ ok: true, ...report });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) {
      console.error("[Backflow] /list error:", err.response?.data || err.message);
    }
    res.status(status).json({ ok: false, error: err.message });
  }
});

// GET /api/backflow/list.csv
router.get("/list.csv", async (req, res) => {
  try {
    const { from, to } = parseRange(req);
    const report = await buildBackflowReport({ from, to });

    const headers = [
      "Comp Date",
      "Customer",
      "Total HR",
      "Price Charged",
      "Price/Tech Time",
      "Technician",
      "Dispatched Min",
      "Working Min",
      "Job #",
      "# of Backflows",
      "Job Type",
      "Notes",
    ];

    const cell = (v) => {
      if (v == null) return "";
      const s = String(v);
      // Quote if it contains a comma, quote, or newline.
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const lines = [headers.map(cell).join(",")];
    for (const r of report.rows) {
      lines.push([
        r.compDate,
        r.customer,
        r.totalHr,
        r.priceCharged,
        r.pricePerTechTime,
        r.technician,
        r.dispatchedMin,
        r.workingMin,
        r.jobNumber,
        r.numBackflows,
        r.jobType,
        r.notes,
      ].map(cell).join(","));
    }

    const fname = `backflow_${from}_to_${to}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    res.send(lines.join("\r\n"));
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) {
      console.error("[Backflow] /list.csv error:", err.response?.data || err.message);
    }
    res.status(status).json({ ok: false, error: err.message });
  }
});

// GET /api/backflow/job-type — diagnostic
router.get("/job-type", async (req, res) => {
  try {
    const { ids, names } = await getBackflowJobTypeIds();
    res.json({
      ok: true,
      matched: Array.from(names.entries()).map(([id, name]) => ({ id, name })),
      count: ids.length,
    });
  } catch (err) {
    console.error("[Backflow] /job-type error:", err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
