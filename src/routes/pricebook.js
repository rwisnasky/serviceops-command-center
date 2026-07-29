/**
 * src/routes/pricebook.js
 *
 * Pricebook Lookup — backs the /pricebook page in the Command Center.
 *
 * Each of the four item-type endpoints is a live pass-through to ServiceTitan's
 * pricebook v2 API. No local caching — the user chose live-on-every-search so
 * prices are always current (at the cost of a round trip per keystroke/submit).
 *
 *   GET  /api/pricebook/services?searchTerm=...&page=1&pageSize=25
 *   GET  /api/pricebook/materials?...
 *   GET  /api/pricebook/equipment?...
 *   GET  /api/pricebook/discounts-and-fees?...
 *
 *   POST /api/pricebook/estimate
 *     Body: { jobNumber, name?, summary?, items: [{ skuId, skuType, quantity, unitPrice?, description? }] }
 *     Looks up the job by number (ST internal id), then creates an estimate
 *     with the cart's line items. Returns { ok, estimateId, ... } or an error
 *     payload with ST's 400 message if the schema needs tweaking for your tenant.
 */

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const {
  searchPricebookServices,
  searchPricebookMaterials,
  searchPricebookEquipment,
  searchPricebookDiscountsAndFees,
  createEstimate,
  findJobByNumber,
} = require("../api/servicetitan");
const {
  syncAll,
  getStats,
  searchIndex,
  getDuplicates,
  getDuplicatesCount,
  suggestCanonical,
  mergeDuplicates,
  undoMerge,
  getMergeLog,
} = require("../services/pricebookIndexService");
const {
  parseAndPreview: parseScopeAndPreview,
  createEstimateFromPreview,
  listRecentScopeEstimates,
} = require("../services/scopeImportService");
const { matchLineItem } = require("../services/pricebookMatcher");
const {
  listCandidates: listRenameCandidates,
  countCandidates: countRenameCandidates,
  suggestName: suggestRenameName,
  applyRename: applyMaterialRename,
  skipRename: skipMaterialRename,
  listRecent: listRecentRenames,
} = require("../services/materialRenameService");

const router = express.Router();

// ── Multer config — scope PDFs/images into /tmp/scope-uploads ────────────────
const SCOPE_UPLOAD_DIR = process.env.SCOPE_UPLOAD_TMP || "/tmp/scope-uploads";
try { fs.mkdirSync(SCOPE_UPLOAD_DIR, { recursive: true }); } catch (_) {}

const scopeStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, SCOPE_UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".pdf";
    cb(null, `scope-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`);
  },
});

const uploadScope = multer({
  storage: scopeStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype === "application/pdf" ||
      file.mimetype.startsWith("image/") ||
      /\.(pdf|png|jpg|jpeg|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error("Only PDF or image files are allowed"), ok);
  },
});

// ── In-memory preview cache (same pattern as invoice parser) ─────────────────
const SCOPE_PREVIEWS = new Map();
const SCOPE_PREVIEW_TTL_MS = 30 * 60 * 1000;

function stashScopePreview(preview, meta) {
  const id = crypto.randomBytes(12).toString("hex");
  SCOPE_PREVIEWS.set(id, { preview, meta, expires: Date.now() + SCOPE_PREVIEW_TTL_MS });
  return id;
}
function popScopePreview(id) {
  const row = SCOPE_PREVIEWS.get(id);
  if (!row) return null;
  if (row.expires < Date.now()) {
    SCOPE_PREVIEWS.delete(id);
    return null;
  }
  return row;
}
// Sweep expired previews every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [id, row] of SCOPE_PREVIEWS) {
    if (row.expires < now) {
      SCOPE_PREVIEWS.delete(id);
      try { fs.unlinkSync(row.meta.filePath); } catch (_) {}
    }
  }
}, 5 * 60 * 1000).unref?.();

// ── Small helper: normalize query → search opts ──────────────────────────────
function parseSearchOpts(q) {
  const searchTerm = (q.searchTerm || q.q || "").toString().trim();
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 25));
  // Default to active-only for CSR lookups; allow override via ?active=Any
  const active = ["True", "False", "Any"].includes(q.active) ? q.active : "True";
  return { searchTerm, page, pageSize, active };
}

// ── Generic handler factory ──────────────────────────────────────────────────
function makeSearchHandler(searchFn, label) {
  return async (req, res) => {
    const opts = parseSearchOpts(req.query);
    try {
      const data = await searchFn(opts);
      return res.json({
        ok: true,
        type: label,
        searchTerm: opts.searchTerm,
        page: data.page ?? opts.page,
        pageSize: data.pageSize ?? opts.pageSize,
        hasMore: !!data.hasMore,
        totalCount: data.totalCount ?? null,
        items: Array.isArray(data.data) ? data.data : [],
      });
    } catch (err) {
      const status = err.response?.status || 500;
      const stMsg = err.response?.data?.title || err.response?.data?.message || err.message;
      console.error(`[Pricebook] ${label} search failed (${status}): ${stMsg}`);
      return res.status(status).json({ ok: false, error: stMsg, type: label });
    }
  };
}

// ── Search endpoints ─────────────────────────────────────────────────────────
router.get("/services",            makeSearchHandler(searchPricebookServices,        "Service"));
router.get("/materials",           makeSearchHandler(searchPricebookMaterials,       "Material"));
router.get("/equipment",           makeSearchHandler(searchPricebookEquipment,       "Equipment"));
router.get("/discounts-and-fees",  makeSearchHandler(searchPricebookDiscountsAndFees, "DiscountOrFee"));

// ── POST /estimate ───────────────────────────────────────────────────────────
router.post("/estimate", express.json(), async (req, res) => {
  const { jobNumber, jobId: explicitJobId, name, summary, items } = req.body || {};

  if (!jobNumber && !explicitJobId) {
    return res.status(400).json({ ok: false, error: "jobNumber (or jobId) is required" });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ ok: false, error: "cart has no items" });
  }

  try {
    // Resolve job number → internal id (unless an id was passed through directly).
    // findJobByNumber returns { jobId, jobNumber } — both strings (or null).
    let jobId = explicitJobId ? Number(explicitJobId) : null;
    if (!jobId) {
      const lookup = await findJobByNumber(String(jobNumber).trim());
      jobId = lookup?.jobId ? Number(lookup.jobId) : null;
    }
    if (!jobId) {
      return res.status(404).json({
        ok: false,
        error: `Job "${jobNumber}" not found in ServiceTitan`,
      });
    }

    const result = await createEstimate({
      jobId,
      name: name || `Phone Quote – ${new Date().toLocaleDateString()}`,
      summary: summary || "",
      items,
    });

    console.log(
      `[Pricebook] ✅ Estimate created for job ${jobNumber || jobId} — ` +
        `${items.length} line item(s), estimateId=${result?.id || "(n/a)"}`
    );
    return res.json({ ok: true, jobId, estimate: result });
  } catch (err) {
    const status = err.response?.status || 500;
    const stErr = err.response?.data;
    const stMsg = stErr?.title || stErr?.message || err.message;
    console.error(`[Pricebook] Estimate create failed (${status}): ${stMsg}`);
    return res.status(status).json({
      ok: false,
      error: stMsg,
      details: stErr || null,
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//   Scope-of-Work / Competitor-Quote → Estimate flow
// ══════════════════════════════════════════════════════════════════════════════

// ── POST /parse-scope ────────────────────────────────────────────────────────
// Multipart: scopeFile (PDF/image), optional jobNumber override in body
// Returns { ok, previewId, parsed, jobMatch, stats, ready }
router.post("/parse-scope", uploadScope.single("scopeFile"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "scopeFile is required" });
  }
  const jobNumberOverride = (req.body?.jobNumber || "").toString().trim() || null;
  const fileName = req.file.originalname;
  const filePath = req.file.path;

  console.log(
    `[Scope] Parse request — file=${fileName} size=${(req.file.size / 1024).toFixed(0)}KB ` +
    `override=${jobNumberOverride || "(none)"}`
  );

  try {
    const preview = await parseScopeAndPreview(filePath, { jobNumberOverride });
    const previewId = stashScopePreview(preview, { filePath, fileName });

    console.log(
      `[Scope]   lines=${preview.stats.totalLines} matched=${preview.stats.matched} ` +
      `unmatched=${preview.stats.unmatched} llm=${preview.stats.llmUsed} ` +
      `job=${preview.parsed.usedJobNumber || "(none)"} ready=${preview.ready}`
    );

    return res.json({ ok: true, previewId, ...preview });
  } catch (err) {
    try { fs.unlinkSync(filePath); } catch (_) {}
    console.error(`[Scope] Parse failed for ${fileName}:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /parse-scope/resolve-job ───────────────────────────────────────────
// Re-resolve the ServiceTitan job for an existing preview after the user types
// a different job # in the override input. Updates the stashed preview in place
// so a subsequent /create-estimate call picks up the new jobId.
// Body: { previewId, jobNumber }
router.post("/parse-scope/resolve-job", express.json(), async (req, res) => {
  const previewId = (req.body?.previewId || "").toString();
  const jobNumber = (req.body?.jobNumber || "").toString().trim();

  if (!previewId) return res.status(400).json({ ok: false, error: "previewId required" });
  if (!jobNumber) return res.status(400).json({ ok: false, error: "jobNumber required" });

  const stashed = SCOPE_PREVIEWS.get(previewId);
  if (!stashed || stashed.expires < Date.now()) {
    return res.status(410).json({ ok: false, error: "Preview expired — please re-upload." });
  }

  try {
    const { jobId, jobNumber: confirmed } = await findJobByNumber(jobNumber);
    const jobMatch = { jobId: jobId || null, jobNumber: confirmed || jobNumber, error: jobId ? null : "Job not found" };

    // Update the stashed preview in place so /create-estimate sees the new job
    stashed.preview.jobMatch = jobMatch;
    stashed.preview.parsed = stashed.preview.parsed || {};
    stashed.preview.parsed.usedJobNumber = jobNumber;

    return res.json({ ok: true, jobMatch });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
      jobMatch: { jobId: null, jobNumber, error: err.message },
    });
  }
});

// ── POST /create-estimate ───────────────────────────────────────────────────
// Body: { previewId, preview } — preview may contain user edits to matches,
// quantities, and the resolved job. We trust the client's preview for the push.
router.post("/create-estimate", express.json(), async (req, res) => {
  const { previewId, preview: clientPreview } = req.body || {};
  if (!previewId) {
    return res.status(400).json({ ok: false, error: "previewId is required" });
  }
  const stashed = popScopePreview(previewId);
  if (!stashed) {
    return res.status(410).json({
      ok: false,
      error: "Preview expired — please re-upload the scope document.",
    });
  }

  const preview = clientPreview || stashed.preview;

  try {
    const result = await createEstimateFromPreview(preview, {
      fileName: stashed.meta.fileName,
    });
    console.log(
      `[Scope] ✅ Estimate created — estimateId=${result.estimateId || "(n/a)"} ` +
      `on job ${result.jobNumber || result.jobId} (${result.lineItemCount} lines, $${result.total.toFixed(2)})`
    );
    SCOPE_PREVIEWS.delete(previewId);
    try { fs.unlinkSync(stashed.meta.filePath); } catch (_) {}
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[Scope] Estimate create failed:", err.message);
    SCOPE_PREVIEWS.set(previewId, stashed); // keep alive so user can fix + retry
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /recent-scope-estimates ──────────────────────────────────────────────
router.get("/recent-scope-estimates", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  try {
    return res.json({ ok: true, imports: listRecentScopeEstimates(limit) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Pricebook index admin: refresh + stats + manual rematch ──────────────────

// POST /index/refresh — kicks off a full sync (services, materials, equipment)
router.post("/index/refresh", async (req, res) => {
  try {
    const result = await syncAll();
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /index/stats
router.get("/index/stats", (req, res) => {
  try {
    return res.json({ ok: true, ...getStats() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /index/search?q=...&limit=10
// Used by the "swap SKU" dropdown on the preview so the user can pick an
// alternative when the auto-match is wrong. Fast: reads from local SQLite.
router.get("/index/search", (req, res) => {
  const q = (req.query.q || "").toString().trim();
  const limit = Math.min(25, Math.max(1, Number(req.query.limit) || 10));
  if (!q) return res.json({ ok: true, results: [] });
  try {
    const results = searchIndex(q, { limit });
    return res.json({ ok: true, results });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /index/rematch  — re-run the hybrid matcher for a single description
// Body: { description }
router.post("/index/rematch", express.json(), async (req, res) => {
  const description = (req.body?.description || "").toString().trim();
  if (!description) return res.status(400).json({ ok: false, error: "description required" });
  try {
    const match = await matchLineItem(description);
    return res.json({ ok: true, match });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /duplicates
//   ?type=all|Service|Material|Equipment  (default: all)
//   ?rule=code|name                       (default: code)
//   ?activeOnly=true|false                (default: true)
//   ?count=true                           → returns only totals, not the groups
//
// Uses the local pricebook_index (synced nightly at 3 AM). Groups records that
// share a normalized code (trim+upper) or display name (trim+lower). Mixed-type
// groups can appear when type=all and the same code is used across a Service
// and an Equipment record.
router.get("/duplicates", (req, res) => {
  const type = (req.query.type || "all").toString();
  const rule = (req.query.rule || "code").toString();
  const activeOnly = req.query.activeOnly !== "false";
  const countOnly = req.query.count === "true";

  try {
    if (countOnly) {
      const counts = getDuplicatesCount({ type, rule, activeOnly });
      return res.json({ ok: true, type, rule, activeOnly, ...counts });
    }
    const groups = getDuplicates({ type, rule, activeOnly });
    const totalRecords = groups.reduce((acc, g) => acc + g.count, 0);
    return res.json({
      ok: true,
      type,
      rule,
      activeOnly,
      groups,
      stats: { groups: groups.length, records: totalRecords },
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// GET /duplicates/suggest-canonical
//   ?type=Service|Material|Equipment
//   ?stIds=123,456,789
// Returns the recommended canonical ST id for a group of duplicates.
router.get("/duplicates/suggest-canonical", (req, res) => {
  const skuType = (req.query.type || "").toString();
  const stIds = (req.query.stIds || "")
    .toString()
    .split(",")
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0);

  try {
    const result = suggestCanonical({ stIds, skuType });
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /merge
//   body: {
//     canonicalStId:  number,
//     duplicateStIds: number[],
//     skuType:        "Service" | "Material" | "Equipment",
//     copyFields?:    { displayName?, description?, price?, ... }  (optional, opt-in)
//     userNote?:      string,
//     dryRun?:        boolean
//   }
// Deactivates duplicates in ST, optionally copies fields onto canonical,
// writes pricebook_merge_log row. Returns { ok, logId, deactivated, failed }.
router.post("/merge", async (req, res) => {
  const {
    canonicalStId,
    duplicateStIds,
    skuType,
    copyFields = null,
    userNote = null,
    dryRun = false,
    generateImage = false,
    imageSource = "hybrid",
  } = req.body || {};

  try {
    const result = await mergeDuplicates({
      canonicalStId,
      duplicateStIds,
      skuType,
      copyFields,
      userNote,
      dryRun: !!dryRun,
      generateImage: !!generateImage,
      imageSource,
    });
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /merge/:logId/undo
// Reactivates duplicates and restores canonical snapshot. Marks the log undone.
router.post("/merge/:logId/undo", async (req, res) => {
  const logId = Number(req.params.logId);
  try {
    const result = await undoMerge(logId);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// GET /merge/log
//   ?limit=50     (default 50)
//   ?type=Service|Material|Equipment  (optional filter)
// Returns recent merge actions, newest first, for the audit panel.
router.get("/merge/log", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const skuType = req.query.type ? req.query.type.toString() : null;
  try {
    const log = getMergeLog({ limit, skuType });
    return res.json({ ok: true, count: log.length, log });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//   Material Rename tool
//   GET  /rename/candidates    — list cryptic Material names worth reviewing
//   POST /rename/suggest       — LLM suggests a friendlier displayName
//   POST /rename/apply         — push approved name to ST + log
//   POST /rename/skip          — mark reviewed so it stops resurfacing
//   GET  /rename/recent        — recent activity for the audit panel
// ══════════════════════════════════════════════════════════════════════════════

// GET /rename/candidates ?limit=50&includeReviewed=false
router.get("/rename/candidates", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const includeReviewed = String(req.query.includeReviewed || "").toLowerCase() === "true";
  try {
    const candidates = listRenameCandidates({ limit, includeReviewed });
    const total = countRenameCandidates({ includeReviewed });
    return res.json({ ok: true, total, candidates });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /rename/suggest  body: { stId }
router.post("/rename/suggest", express.json(), async (req, res) => {
  const stId = Number(req.body?.stId);
  if (!stId) return res.status(400).json({ ok: false, error: "stId required" });
  try {
    const out = await suggestRenameName(stId);
    return res.json({ ok: true, ...out });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /rename/apply  body: { stId, newName }
//
// Image creation is intentionally NOT triggered from the rename flow — the
// PATCH-shape we tried for image attachment never made the upload appear on
// the SKU, so we removed the option rather than ship a confusing "renamed but
// image failed" warning every time. Image generation is still available as a
// standalone tool via /api/pricebook/ensure-image and /image-test for when
// we want to revisit it.
router.post("/rename/apply", express.json(), async (req, res) => {
  const stId = Number(req.body?.stId);
  const newName = (req.body?.newName || "").toString().trim();
  if (!stId || !newName) {
    return res.status(400).json({ ok: false, error: "stId and newName required" });
  }
  try {
    const out = await applyMaterialRename({ stId, newName });
    return res.json(out);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /rename/skip   body: { stId, reason? }
router.post("/rename/skip", express.json(), (req, res) => {
  const stId = Number(req.body?.stId);
  const reason = (req.body?.reason || "").toString().trim() || null;
  if (!stId) return res.status(400).json({ ok: false, error: "stId required" });
  try {
    const out = skipMaterialRename(stId, reason);
    return res.json(out);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /rename/recent ?limit=50
router.get("/rename/recent", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  try {
    return res.json({ ok: true, log: listRecentRenames(limit) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Image routes ─────────────────────────────────────────────────────────────
const {
  hasImage: hasPricebookImage,
  ensureImage: ensurePricebookImage,
  listRecent: listRecentImageLog,
} = require("../services/pricebookImageService");

// GET /image-check ?stId=123&skuType=Material
// Quick "does this SKU have an image?" check. Cache-first; only hits ST on miss.
router.get("/image-check", async (req, res) => {
  const stId = Number(req.query.stId);
  const skuType = (req.query.skuType || "Material").toString();
  if (!stId) return res.status(400).json({ ok: false, error: "stId required" });
  try {
    const result = await hasPricebookImage({ stId, skuType });
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /ensure-image  body: { stId, skuType, source?, force?, dryRun?, promptOverride? }
// Hybrid by default (manufacturer → AI fallback). Writes to pricebook_image_log.
router.post("/ensure-image", express.json(), async (req, res) => {
  const stId = Number(req.body?.stId);
  const skuType = (req.body?.skuType || "Material").toString();
  const source = (req.body?.source || "hybrid").toString();
  const force = !!req.body?.force;
  const dryRun = !!req.body?.dryRun;
  const promptOverride = req.body?.promptOverride ? String(req.body.promptOverride) : null;
  if (!stId) return res.status(400).json({ ok: false, error: "stId required" });
  try {
    const result = await ensurePricebookImage({ stId, skuType, source, force, dryRun, promptOverride });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /image-log ?limit=50&stId=123
router.get("/image-log", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const stId = req.query.stId ? Number(req.query.stId) : null;
  try {
    return res.json({ ok: true, log: listRecentImageLog(limit, stId) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /image-proxy ?stId=&skuType=  (preferred — always returns current)
// GET /image-proxy ?path=Images/abc.png
//
// Streams a pricebook image back to the browser through our auth. Lets the
// Recent Renames accordion show a live thumbnail of the SKU's current image
// without juggling ST tokens on the client.
router.get("/image-proxy", async (req, res) => {
  try {
    const {
      getPricebookItem,
      fetchPricebookImageBytes,
    } = require("../api/servicetitan");
    const { _extractImagePath } = require("../services/pricebookImageService");

    let pathOrUrl = (req.query.path || "").toString().trim();
    if (!pathOrUrl && req.query.stId) {
      const item = await getPricebookItem(
        (req.query.skuType || "Material").toString(),
        Number(req.query.stId)
      );
      pathOrUrl = _extractImagePath(item);
    }
    if (!pathOrUrl) {
      return res.status(404).send("No image path for SKU");
    }
    const { bytes, contentType } = await fetchPricebookImageBytes(pathOrUrl);
    res.setHeader("Content-Type", contentType || "image/png");
    // Short cache — image might be regenerated and we want fresh thumbs on refresh.
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.send(bytes);
  } catch (err) {
    // Return a 1x1 transparent PNG on failure so the <img> doesn't show
    // a broken-image icon. Callers can detect failure via Cache-Control:no-store
    // header we emit instead.
    console.warn(`[Image proxy] ${err.message}`);
    const blank = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64"
    );
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Image-Proxy-Error", String(err.message).slice(0, 200));
    return res.status(200).send(blank);
  }
});

// POST /image-test
//   body: { prompt?, stId?, skuType? }
//
// Diagnostic tool. Runs in two modes:
//
//   Mode A (no stId): OpenAI generate → ST upload. No SKU PATCH. Safe.
//     Use this to confirm the API keys + upload format work at all.
//
//   Mode B (stId + skuType supplied): full end-to-end against a real SKU.
//     1. Reads current image on the SKU (before)
//     2. Generates bytes via OpenAI
//     3. Uploads to ST
//     4. Tries up to 25 body shapes (21 PATCH + 4 sub-endpoint attach),
//        verifying each via re-GET and capturing ST's response body
//     5. Returns the complete attempt trace + before/after image path
//
//   Intended for debugging "PATCH returned 200 but no image appeared"
//   silently-ignored-field bugs. Only PATCHes in Mode B, and only the SKU
//   you specified — so pick a low-stakes test SKU.
router.post("/image-test", express.json(), async (req, res) => {
  const customPrompt = (req.body?.prompt || "").toString().trim();
  const stId = req.body?.stId ? Number(req.body.stId) : null;
  const skuType = (req.body?.skuType || "Material").toString();
  const out = { ok: false, mode: stId ? "end-to-end" : "upload-only", stages: {} };

  // Mode B: capture the starting image state on the SKU.
  if (stId) {
    try {
      const { getPricebookItem } = require("../api/servicetitan");
      const { _extractImagePath } = require("../services/pricebookImageService");
      const item = await getPricebookItem(skuType, stId);
      out.stages.before = {
        ok: true,
        imagePath: _extractImagePath(item),
        displayName: item?.displayName || item?.name || null,
      };
    } catch (err) {
      out.stages.before = { ok: false, error: err.message };
      return res.json(out);
    }
  }

  // Stage 1: OpenAI image generation.
  let bytes = null;
  try {
    const { generateAIImage } = require("../services/pricebookImageService");
    const gen = await generateAIImage({
      title: customPrompt || "air filter, pleated, 16x25x1",
      skuType,
    });
    bytes = gen.bytes;
    out.stages.openai = {
      ok: true,
      bytes: bytes.length,
      prompt: gen.prompt,
      contentType: gen.contentType,
    };
  } catch (err) {
    out.stages.openai = { ok: false, error: err.message };
    return res.json(out);
  }

  // Stage 2: ST upload.
  let uploaded = null;
  try {
    const { uploadPricebookImage } = require("../api/servicetitan");
    uploaded = await uploadPricebookImage(bytes, { contentType: "image/png" });
    out.stages.st_upload = {
      ok: true,
      path: uploaded.path,
      rawType: typeof uploaded.raw,
      rawSample:
        typeof uploaded.raw === "string"
          ? uploaded.raw.slice(0, 400)
          : JSON.stringify(uploaded.raw).slice(0, 400),
    };
  } catch (err) {
    out.stages.st_upload = { ok: false, error: err.message };
    return res.json(out);
  }

  // Mode A stops here.
  if (!stId) {
    out.ok = true;
    return res.json(out);
  }

  // Mode B Stage 3: try each PATCH/attach shape, verify after each via re-GET,
  // capture ST's response body on every attempt (silent-ignore detection).
  const {
    updateMaterial,
    updateEquipment,
    updateService,
    getPricebookItem,
    attachPricebookImage,
  } = require("../api/servicetitan");
  const { _extractImagePath } = require("../services/pricebookImageService");
  const t = skuType.toLowerCase();
  const updateFn =
    t === "material" || t === "materials" ? updateMaterial :
    t === "equipment" ? updateEquipment :
    t === "service" || t === "services" ? updateService :
    null;
  if (!updateFn) {
    out.stages.patch = { ok: false, error: `unsupported skuType "${skuType}"` };
    return res.json(out);
  }

  const uploadedPath = uploaded.path;
  const basename = uploadedPath.split("/").pop() || uploadedPath;      // "uuid.png"
  const uuid = basename.replace(/\.[^.]+$/, "");                       // "uuid"
  const fullUrl = /^https?:\/\//i.test(uploadedPath)
    ? uploadedPath
    : `https://api.servicetitan.io/${uploadedPath.replace(/^\/+/, "")}`;

  // Mirror the 25-shape attempts list from pricebookImageService.ensureImage so
  // the /image-test trace reflects exactly what happens during a real rename.
  const shapes = [
    // PATCH shapes on the SKU itself
    { kind: "patch", label: "image-scalar",                 body: { image: uploadedPath } },
    { kind: "patch", label: "image-basename",               body: { image: basename } },
    { kind: "patch", label: "image-uuid",                   body: { image: uuid } },
    { kind: "patch", label: "image-fullurl",                body: { image: fullUrl } },
    { kind: "patch", label: "imageUrl-path",                body: { imageUrl: uploadedPath } },
    { kind: "patch", label: "imageUrl-fullurl",             body: { imageUrl: fullUrl } },
    { kind: "patch", label: "imageName-basename",           body: { imageName: basename } },
    { kind: "patch", label: "imageFileId-uuid",             body: { imageFileId: uuid } },
    { kind: "patch", label: "iconFileId-uuid",              body: { iconFileId: uuid } },
    { kind: "patch", label: "picture-path",                 body: { picture: uploadedPath } },
    { kind: "patch", label: "thumbnail-path",               body: { thumbnail: uploadedPath } },
    { kind: "patch", label: "primaryImage-path",            body: { primaryImage: uploadedPath } },
    { kind: "patch", label: "images-array-string",          body: { images: [uploadedPath] } },
    { kind: "patch", label: "images-array-basename",        body: { images: [basename] } },
    { kind: "patch", label: "images-array-object-url",      body: { images: [{ url: uploadedPath }] } },
    { kind: "patch", label: "images-array-object-path",     body: { images: [{ path: uploadedPath }] } },
    { kind: "patch", label: "images-array-object-fileName", body: { images: [{ fileName: basename, path: uploadedPath }] } },
    { kind: "patch", label: "image-obj-fileName",           body: { image: { fileName: basename, path: uploadedPath } } },
    { kind: "patch", label: "assets-type-image-url",        body: { assets: [{ type: "Image", url: uploadedPath }] } },
    { kind: "patch", label: "assets-type-image-path",       body: { assets: [{ type: "Image", path: uploadedPath }] } },
    { kind: "patch", label: "attachments-path",             body: { attachments: [{ path: uploadedPath }] } },
    // Sub-endpoint attach: POST /{materials|equipment|services}/{id}/image
    { kind: "attach", label: "attach-path",                 body: { path: uploadedPath } },
    { kind: "attach", label: "attach-image",                body: { image: uploadedPath } },
    { kind: "attach", label: "attach-fileName",             body: { fileName: basename } },
    { kind: "attach", label: "attach-string",               body: uploadedPath }, // raw string body
  ];

  const summarize = (v) =>
    v == null ? "(empty)" :
    typeof v === "string" ? v.slice(0, 300) :
    JSON.stringify(v).slice(0, 300);

  out.stages.patch_attempts = [];
  let winner = null;
  for (const shape of shapes) {
    const attempt = { kind: shape.kind, label: shape.label, body: shape.body };
    let callResponse = null;
    try {
      if (shape.kind === "attach") {
        const r = await attachPricebookImage(skuType, stId, shape.body);
        callResponse = r && r.data !== undefined ? r.data : r;
      } else {
        callResponse = await updateFn(Number(stId), shape.body);
      }
      attempt.callOk = true;
      attempt.respSummary = summarize(callResponse);
    } catch (err) {
      attempt.callOk = false;
      attempt.callError = err.message;
      attempt.respSummary = summarize(err.response?.data);
      out.stages.patch_attempts.push(attempt);
      continue;
    }

    try {
      const verify = await getPricebookItem(skuType, stId);
      attempt.foundAfter = _extractImagePath(verify);
      attempt.verified = !!attempt.foundAfter;
    } catch (err) {
      attempt.verified = false;
      attempt.verifyError = err.message;
    }
    out.stages.patch_attempts.push(attempt);
    if (attempt.verified) {
      winner = attempt;
      break;
    }
  }

  out.stages.after = {
    winner: winner ? { kind: winner.kind, label: winner.label, imagePath: winner.foundAfter } : null,
    totalAttempts: out.stages.patch_attempts.length,
  };
  out.ok = !!winner;
  return res.json(out);
});

// GET /image-upload-inspect
//
// Zero-risk diagnostic. Uploads a tiny 1x1 PNG to ST's pricebook image store
// and returns the FULL raw response body with every key ST returned. No SKU
// is touched. Use this when "PATCH succeeds but image never appears" to
// discover whether ST is returning an id/token/hash alongside the Temp/ path
// that we should be PATCHing with instead.
router.get("/image-upload-inspect", async (_req, res) => {
  try {
    const { uploadPricebookImage } = require("../api/servicetitan");
    // 1x1 transparent PNG
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64"
    );
    const uploaded = await uploadPricebookImage(pngBytes, {
      contentType: "image/png",
      filename: `inspect-${Date.now()}.png`,
    });

    // Show raw type + stringified in case ST returned a string, object,
    // or something weirder like a nested object with hidden id/token keys.
    const rawType = typeof uploaded.raw;
    const rawKeys = uploaded.raw && typeof uploaded.raw === "object"
      ? Object.keys(uploaded.raw)
      : null;
    const rawString =
      rawType === "string"
        ? uploaded.raw
        : JSON.stringify(uploaded.raw, null, 2);

    return res.json({
      ok: true,
      extractedPath: uploaded.path,
      contentType: uploaded.contentType,
      filename: uploaded.filename,
      raw: {
        type: rawType,
        keys: rawKeys,
        stringified: rawString,
      },
    });
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    return res.status(200).json({
      ok: false,
      error: err.message,
      responseStatus: status || null,
      responseBody: data
        ? typeof data === "string"
          ? data.slice(0, 2000)
          : JSON.stringify(data).slice(0, 2000)
        : null,
    });
  }
});

module.exports = router;
