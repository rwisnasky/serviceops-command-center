const express = require("express");
const router = express.Router();
const st = require("../api/servicetitan");

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function today() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

// NOTE: /overview, /technician/:name, and /today were removed in the Jul 2026
// tune-up. They backed an analytics dashboard page that no longer exists and
// had no remaining callers. The sync-return-visits endpoint below is still used
// by the home dashboard (public/index.html).

// POST /api/analytics/sync-return-visits
// Body: { startDate, endDate } — manually backfill return visits to GHL
router.post("/sync-return-visits", async (req, res) => {
  try {
    const { syncReturnVisitsForDateRange } = require("../services/returnVisitService");
    const days = parseInt(req.body.days) || 30;
    const startDate = req.body.startDate || daysAgo(days);
    const endDate = req.body.endDate || today();

    // Run async
    res.json({ started: true, message: `Syncing return visits from ${startDate} to ${endDate}` });
    syncReturnVisitsForDateRange(startDate, endDate)
      .then((results) => console.log(`[Sync] Complete: ${results.length} jobs processed`))
      .catch((err) => console.error("[Sync] Error:", err.message));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
