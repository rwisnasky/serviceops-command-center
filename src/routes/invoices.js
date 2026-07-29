/**
 * src/routes/invoices.js
 *
 * HTTP surface for the dashboard Invoice → PO feature.
 *
 *   POST /api/invoices/parse      (multipart: invoiceFile + optional jobNumber)
 *     → saves PDF/image to tmp, runs the parser + ST lookups, returns a
 *       preview (does NOT create a PO)
 *     → response includes parsed fields, jobMatch, vendorMatch, and a
 *       `previewId` we stash server-side so the client can confirm-create
 *       without having to re-upload the file.
 *
 *   POST /api/invoices/create-po  (JSON: { previewId, preview })
 *     → takes the preview (optionally edited by the user) and creates the PO
 *
 *   GET  /api/invoices/recent     ?limit=25
 *     → recent invoice_uploads rows (most recent first)
 */

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const {
  parseAndPreview,
  createPoFromPreview,
  listRecentImports,
  clearRecentImports,
} = require("../services/invoiceImportService");
const {
  invalidateVendorCache,
  createMaterial,
} = require("../api/servicetitan");
const { getDb } = require("../db/index");
const { invalidateCodeCache } = require("../services/poPricebookMatchService");

const router = express.Router();

// ── Multer config — PDFs / images into /tmp/invoice-uploads ──────────────────
const UPLOAD_DIR = process.env.INVOICE_UPLOAD_TMP || "/tmp/invoice-uploads";
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) {}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".pdf";
    cb(null, `invoice-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB (invoices are small)
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype === "application/pdf" ||
      file.mimetype.startsWith("image/") ||
      /\.(pdf|png|jpg|jpeg|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error("Only PDF or image files are allowed"), ok);
  },
});

// ── In-memory preview cache ──────────────────────────────────────────────────
// Small, short-lived. Cleared on restart. 30 min TTL.
const PREVIEWS = new Map();
const PREVIEW_TTL_MS = 30 * 60 * 1000;

function stashPreview(preview, meta) {
  const id = crypto.randomBytes(12).toString("hex");
  PREVIEWS.set(id, { preview, meta, expires: Date.now() + PREVIEW_TTL_MS });
  return id;
}

function popPreview(id) {
  const row = PREVIEWS.get(id);
  if (!row) return null;
  if (row.expires < Date.now()) {
    PREVIEWS.delete(id);
    return null;
  }
  return row;
}

// Sweep expired previews every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [id, row] of PREVIEWS) {
    if (row.expires < now) {
      PREVIEWS.delete(id);
      try { fs.unlinkSync(row.meta.filePath); } catch (_) {}
    }
  }
}, 5 * 60 * 1000).unref?.();

// ── POST /parse ──────────────────────────────────────────────────────────────
router.post("/parse", upload.single("invoiceFile"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "Invoice file is required" });
  }

  const jobNumberOverride = (req.body?.jobNumber || "").toString().trim() || null;
  const refreshVendors = /^(1|true|yes)$/i.test(String(req.body?.refreshVendors || ""));
  const fileName = req.file.originalname;
  const filePath = req.file.path;

  console.log(
    `[Invoices] Parse request — file=${fileName} size=${(req.file.size / 1024).toFixed(0)}KB ` +
      `override=${jobNumberOverride || "(none)"}${refreshVendors ? " refreshVendors=true" : ""}`
  );

  if (refreshVendors) invalidateVendorCache();

  try {
    const preview = await parseAndPreview(filePath, { jobNumberOverride });
    const previewId = stashPreview(preview, { filePath, fileName });

    console.log(
      `[Invoices]   vendor="${preview.parsed.vendor}" invoice#=${preview.parsed.invoiceNumber} ` +
        `job=${preview.parsed.usedJobNumber || "(none)"} jobId=${preview.jobMatch.jobId || "—"} ` +
        `vendorId=${preview.vendorMatch.id || "—"} ready=${preview.ready}`
    );

    return res.json({ ok: true, previewId, ...preview });
  } catch (err) {
    try { fs.unlinkSync(filePath); } catch (_) {}
    console.error(`[Invoices] Parse failed for ${fileName}:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /create-po ──────────────────────────────────────────────────────────
router.post("/create-po", express.json(), async (req, res) => {
  const { previewId, preview: clientPreview } = req.body || {};
  if (!previewId) {
    return res.status(400).json({ ok: false, error: "previewId is required" });
  }
  const stashed = popPreview(previewId);
  if (!stashed) {
    return res.status(410).json({
      ok: false,
      error: "Preview expired — please re-upload the invoice.",
    });
  }

  // Use the client's preview if provided (so user edits to job#/vendor are
  // respected). Fall back to the server-stashed version.
  const preview = clientPreview || stashed.preview;

  try {
    const result = await createPoFromPreview(preview, {
      fileName: stashed.meta.fileName,
    });
    console.log(
      `[Invoices] ✅ PO created id=${result.poId} number=${result.poNumber || "(n/a)"} ` +
        `on job ${result.jobNumber} for vendor "${result.vendor}"`
    );

    // Success → drop the tmp file (service has already used it for attachment) and the preview
    PREVIEWS.delete(previewId);
    try { fs.unlinkSync(stashed.meta.filePath); } catch (_) {}

    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error(`[Invoices] PO create failed:`, err.message);
    // Keep preview alive so the user can fix vendor/job and retry
    PREVIEWS.set(previewId, stashed);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /recent ──────────────────────────────────────────────────────────────
router.get("/recent", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  try {
    const rows = listRecentImports(limit);
    return res.json({ imports: rows });
  } catch (err) {
    console.error("[Invoices] listRecent failed:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── DELETE /recent ───────────────────────────────────────────────────────────
// scope=failed  → delete only failed rows (default — safe, no confirm needed)
// scope=all     → delete every invoice_uploads row (UI requires confirm)
router.delete("/recent", (req, res) => {
  const scope = (req.query.scope || "failed").toString();
  if (!["failed", "all"].includes(scope)) {
    return res.status(400).json({ ok: false, error: "scope must be 'failed' or 'all'" });
  }
  try {
    const deleted = clearRecentImports(scope);
    console.log(`[Invoices] Cleared ${deleted} ${scope === "all" ? "" : "failed "}import row(s)`);
    return res.json({ ok: true, deleted, scope });
  } catch (err) {
    console.error("[Invoices] clearRecent failed:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /add-to-pricebook ───────────────────────────────────────────────────
// Body: { items: [{ code, displayName, description?, cost }] }
//
// For each item: POST to ST /pricebook/v2/.../materials, then upsert the
// result into our local pricebook_index so subsequent PO parses match on
// it without waiting for the nightly sync.
//
// Per policy decision: retail `price` is NOT sent to ST — only `cost`. A
// tech/manager sets retail inside ST afterward. This matches what the user
// asked for: "cost only — set retail later in ST."
//
// Response is per-item so the UI can show which additions succeeded and
// which failed (e.g. duplicate code, missing business-unit default, etc.)
// without rolling back the successful ones.
router.post("/add-to-pricebook", express.json(), async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (items.length === 0) {
    return res.status(400).json({ ok: false, error: "items array is required and non-empty" });
  }

  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO pricebook_index
      (st_id, sku_type, name, code, description, price, active, tokens, synced_at)
    VALUES
      (@st_id, 'Material', @name, @code, @description, @price, 1, @tokens, datetime('now'))
    ON CONFLICT(st_id, sku_type) DO UPDATE SET
      name = excluded.name, code = excluded.code,
      description = excluded.description, price = excluded.price,
      active = 1, tokens = excluded.tokens, synced_at = excluded.synced_at
  `);

  // Tiny tokenizer for the local index (same rules as pricebookIndexService
  // — lowercase, strip punctuation, drop 1-char tokens). Duplicated here
  // on purpose to avoid a cross-require; very short code.
  const tokenString = (...parts) => {
    const seen = new Set();
    for (const p of parts) {
      if (!p) continue;
      for (const t of String(p).toLowerCase().replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/).filter(t => t.length >= 2)) {
        seen.add(t);
      }
    }
    return [...seen].join(" ");
  };

  const results = [];
  for (const it of items) {
    const code = (it.code || "").toString().trim();
    const displayName = (it.displayName || "").toString().trim();
    const description = (it.description || "").toString().trim();
    const costRaw = it.cost;
    const cost =
      typeof costRaw === "number" ? costRaw : Number(costRaw) || 0;

    if (!code) {
      results.push({ ok: false, code: "", displayName, error: "code required" });
      continue;
    }
    if (!displayName) {
      results.push({ ok: false, code, displayName: "", error: "displayName required" });
      continue;
    }

    // Build the ST payload. ST requires `code` + `description`. We send
    // displayName (what techs see), code (sku), description (optional long
    // text), and cost. Price is intentionally omitted — 0 is an acceptable
    // default and a manager can fill it in ST.
    const payload = {
      code,
      description: description || displayName,
      displayName,
      cost,
      active: true,
    };

    try {
      const created = await createMaterial(payload);
      const stId = Number(created?.id);

      // Upsert into local index so the next PO recognizes this code.
      if (stId) {
        upsert.run({
          st_id: stId,
          name: displayName,
          code,
          description: description || "",
          price: 0,
          tokens: tokenString(displayName, code, description),
        });
      }

      results.push({
        ok: true,
        code,
        displayName,
        stId: stId || null,
      });
      console.log(`[Invoice→Pricebook] ✅ Created material "${displayName}" (${code}) → id ${stId}`);
    } catch (err) {
      const msg = err.message || String(err);
      console.error(`[Invoice→Pricebook] ❌ Create failed for ${code}: ${msg}`);
      results.push({ ok: false, code, displayName, error: msg });
    }
  }

  // Invalidate the exact-code cache in the match service so the next parse
  // picks up these new materials immediately instead of waiting 5 min.
  invalidateCodeCache();

  const okCount = results.filter(r => r.ok).length;
  return res.json({
    ok: okCount > 0,
    created: okCount,
    failed: results.length - okCount,
    results,
  });
});

module.exports = router;
