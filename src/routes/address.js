/**
 * routes/address.js
 * ────────────────────────────────────────────────────────────────────────────
 * HTTP layer for the Address Audit page.
 *
 *   GET  /api/address/audit?page=1&pageSize=50&modifiedOnOrAfter=...
 *        → { ok, rows, summary, page, pageSize, hasMore, totalCount, elapsedMs }
 *        Pulls one page of ST locations and geocodes each. The page knob is
 *        deliberate — auditing the whole tenant in one shot would hammer
 *        Google's quota and ST's rate limit. The UI walks pages on demand.
 *
 *   POST /api/address/verify
 *        body: { street, unit, city, state, zip }
 *        → { ok, result }  — one-off geocode without touching ST
 *
 *   POST /api/address/apply
 *        body: { locationId, address: { street, unit, city, state, zip, country } }
 *        → { ok, method, status }  — PATCHes ST location with the verified address
 *
 *   GET  /api/address/health
 *        → { ok, providerConfigured }  — sanity check the page calls on load
 *        so we can show a helpful banner if GOOGLE_MAPS_API_KEY isn't set.
 * ────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router = express.Router();
const {
  auditLocations,
  findIssues,
  geocode,
  classify,
  applyCorrection,
} = require("../services/addressAuditService");
const {
  getCacheStats,
  reclassifyAll,
  clearCache,
  markDismissed,
} = require("../db/addressCacheRepository");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z?)?$/;

// GET /api/address/health
router.get("/health", (req, res) => {
  res.json({
    ok: true,
    providerConfigured: !!process.env.GOOGLE_MAPS_API_KEY,
    provider: "google-geocoding",
  });
});

// POST /api/address/reclassify — re-run the in-process classifier against
// every cached row without calling Google. Use this after the classifier
// logic itself improves (e.g. smarter street-suffix normalization) so the
// cache stops surfacing false positives.
router.post("/reclassify", (req, res) => {
  try {
    const result = reclassifyAll(classify);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/address/clear-cache — nuke the cache so the next audit re-pays
// Google on every location. Reserved for "the verified data is wrong somehow"
// scenarios. The reclassify endpoint above is cheaper for classifier changes.
router.post("/clear-cache", (req, res) => {
  try {
    const result = clearCache();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/address/cache-stats — total verified, last-checked timestamp, applied count.
// The page uses this to render "X locations cached · last touched Y" so the
// user can see the cache filling in over time.
router.get("/cache-stats", (req, res) => {
  try {
    res.json({ ok: true, ...getCacheStats() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/address/audit
router.get("/audit", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const modifiedOnOrAfter = req.query.modifiedOnOrAfter || undefined;

    if (modifiedOnOrAfter && !ISO_DATE.test(modifiedOnOrAfter)) {
      return res.status(400).json({
        ok: false,
        error: "modifiedOnOrAfter must be ISO date (YYYY-MM-DD or full ISO timestamp)",
      });
    }

    if (!process.env.GOOGLE_MAPS_API_KEY) {
      return res.status(503).json({
        ok: false,
        error: "GOOGLE_MAPS_API_KEY is not set on the server. Add it as a Railway env var to enable verification.",
      });
    }

    const result = await auditLocations({ page, pageSize, modifiedOnOrAfter });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[Address] /audit error:", err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/address/find-issues
// Walks ST until `count` problem addresses are found (or `maxScan` is hit).
// Use `startPage` to resume after the previous batch — pass the prior
// response's `nextStartPage` and you won't re-scan the same locations.
router.get("/find-issues", async (req, res) => {
  try {
    const count    = Math.min(100, Math.max(1, parseInt(req.query.count, 10) || 10));
    const maxScan  = Math.min(10000, Math.max(count, parseInt(req.query.maxScan, 10) || 500));
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const startPage = Math.max(1, parseInt(req.query.startPage, 10) || 1);
    const modifiedOnOrAfter = req.query.modifiedOnOrAfter || undefined;

    if (modifiedOnOrAfter && !ISO_DATE.test(modifiedOnOrAfter)) {
      return res.status(400).json({
        ok: false,
        error: "modifiedOnOrAfter must be ISO date (YYYY-MM-DD or full ISO timestamp)",
      });
    }
    if (!process.env.GOOGLE_MAPS_API_KEY) {
      return res.status(503).json({
        ok: false,
        error: "GOOGLE_MAPS_API_KEY is not set on the server.",
      });
    }

    const result = await findIssues({
      targetCount: count, maxScan, pageSize, startPage, modifiedOnOrAfter,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[Address] /find-issues error:", err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/address/verify
router.post("/verify", async (req, res) => {
  try {
    const { street, unit, city, state, zip } = req.body || {};
    if (!process.env.GOOGLE_MAPS_API_KEY) {
      return res.status(503).json({ ok: false, error: "GOOGLE_MAPS_API_KEY is not set on the server." });
    }
    const original = { street: street || "", unit: unit || "", city: city || "", state: state || "", zip: zip || "" };
    const geoResult = await geocode(original);
    const status = classify(original, geoResult);
    res.json({
      ok: true,
      result: {
        original,
        verified: geoResult?.verified || null,
        verifiedFormatted: geoResult?.formatted || null,
        partialMatch: !!geoResult?.partialMatch,
        locationType: geoResult?.locationType || null,
        lat: geoResult?.lat ?? null,
        lng: geoResult?.lng ?? null,
        placeId: geoResult?.placeId || null,
        status,
      },
    });
  } catch (err) {
    console.error("[Address] /verify error:", err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/address/dismiss — mark a location as "ignore" so it stops
// surfacing in findIssues. Reversible by clearing dismissed_at directly in
// SQLite (or by hitting clear-cache to nuke everything).
router.post("/dismiss", (req, res) => {
  try {
    const { locationId } = req.body || {};
    if (!locationId) return res.status(400).json({ ok: false, error: "locationId required" });
    markDismissed(locationId);
    res.json({ ok: true });
  } catch (err) {
    console.error("[Address] /dismiss error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/address/apply
// Body: { locationId, address, name?, customerType?, customerId? }
//   - name is optional. When provided + non-empty, the Location Name is
//     updated in the same ST PATCH.
//   - customerType is optional. When provided ("Residential" or "Commercial")
//     along with customerId, the customer record is also PATCHed.
router.post("/apply", async (req, res) => {
  try {
    const { locationId, address, name, customerType, customerId } = req.body || {};
    if (!locationId) return res.status(400).json({ ok: false, error: "locationId required" });
    if (!address)    return res.status(400).json({ ok: false, error: "address object required" });
    const result = await applyCorrection({ locationId, address, name, customerType, customerId });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[Address] /apply error:", err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
