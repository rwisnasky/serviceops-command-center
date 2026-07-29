const express = require("express");
const router = express.Router();
const { getRecentHappyReviewSubmissions, processHappyReviews, previewLatestSubmission, processLastPreviewed } = require("../services/happyReviewService");
const { getDb } = require("../db/index");

// ── Pause state (persisted in kv_store so it survives deploys AND is
// ── honored by the forms poll service, not just the HTTP routes) ──────────────
function ensureKvTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);
}

function getPaused() {
  ensureKvTable();
  const db = getDb();
  const row = db.prepare("SELECT value FROM kv_store WHERE key = 'happy_review_paused'").get();
  return row?.value === "true";
}

function setPaused(paused) {
  ensureKvTable();
  const db = getDb();
  db.prepare(`
    INSERT INTO kv_store (key, value) VALUES ('happy_review_paused', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(paused ? "true" : "false");
}

router.get("/status", (req, res) => res.json({ paused: getPaused() }));
router.post("/pause",  (req, res) => { setPaused(true);  res.json({ paused: true }); });
router.post("/resume", (req, res) => { setPaused(false); res.json({ paused: false }); });

// GET /api/forms/recent?hours=1
// Preview how many Happy Review submissions exist in the last N hours
router.get("/recent", async (req, res) => {
  try {
    const hours = parseFloat(req.query.hours) || 1;
    const submissions = await getRecentHappyReviewSubmissions(hours);
    res.json({
      count: submissions.length,
      hours,
      submissions: submissions.map((s) => ({
        id: s.id,
        submittedOn: s.submittedOn || s.createdOn,
        customer: s.customerName || s.customer?.name || null,
      })),
    });
  } catch (err) {
    console.error("[API] /forms/recent error:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/forms/preview-happy-review?hours=2
// Dry-run: shows what the most recent submission contains and what would go to GHL — no writes
router.get("/preview-happy-review", async (req, res) => {
  try {
    const hours = parseFloat(req.query.hours) || 2;
    const result = await previewLatestSubmission(hours);
    res.json(result);
  } catch (err) {
    console.error("[API] /forms/preview-happy-review error:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/forms/process-happy-reviews
// Body: { hours: 1 }
// Pull last N hours of Happy Review form submissions and push each to GHL
router.post("/process-happy-reviews", async (req, res) => {
  try {
    if (getPaused()) {
      return res.status(423).json({ paused: true, message: "Happy Review processing is currently paused. Resume it from the dashboard first." });
    }

    const hours = parseFloat(req.body?.hours) || 1;

    // Run synchronously so the dashboard can report the real outcome.
    // (Manual button click — fine to wait a few seconds for ST lookups.)
    const results = await processHappyReviews(hours);

    const sent    = results.filter((r) => r.created).length;
    const skipped = results.filter((r) => r.skipped).length;
    const errors  = results.filter((r) => r.error).length;

    console.log(`[HappyReview] Done — ${results.length} found, ${sent} sent, ${skipped} already done, ${errors} errors`);

    res.json({
      found:   results.length,
      sent,
      skipped,
      errors,
      hours,
      results,
    });
  } catch (err) {
    console.error("[API] /forms/process-happy-reviews error:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/forms/process-last-preview
// Processes exactly the submission that was last returned by preview — no re-fetch needed
router.post("/process-last-preview", async (req, res) => {
  try {
    if (getPaused()) {
      return res.status(423).json({ paused: true, message: "Processing is paused. Resume it from the dashboard first." });
    }
    const result = await processLastPreviewed();
    res.json({ success: true, result });
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error("[API] /forms/process-last-preview error:", detail);
    res.status(400).json({ error: err.message, detail: err.response?.data || null });
  }
});

module.exports = router;
