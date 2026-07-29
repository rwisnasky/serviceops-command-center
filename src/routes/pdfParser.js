/**
 * src/routes/pdfParser.js
 *
 * HTTP surface for the dashboard "PDF Parser" feature.
 *
 *   POST /api/pdf-parser/parse   (multipart: pdfFile)
 *     → saves the PDF to tmp, extracts page JPGs + embedded photos + OCR text,
 *       returns JSON the page renders (text + file list with download URLs).
 *
 *   GET  /api/pdf-parser/file/:id/:name
 *     → serves one generated JPG (or ocr-text.txt) for download/preview.
 *
 *   GET  /api/pdf-parser/zip/:id
 *     → streams the bundled .zip (all images + ocr-text.txt).
 *
 *   POST /api/pdf-parser/attach   (JSON: { id, jobNumber, files? })
 *     → resolves the typed job number to an ST job id and uploads the selected
 *       page JPGs to that job as attachments. Returns per-file results.
 *
 * Output lives in a per-upload tmp folder swept on a TTL (see below).
 */

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const {
  parsePdf,
  sweepOldJobs,
  WORK_ROOT,
} = require("../services/pdfParserService");
const { findJobByNumber, createJobAttachment, appendJobSummary } = require("../api/servicetitan");
const { findById } = require("../db/userRepository");

const router = express.Router();

// ── Multer — PDF (or single image) into /tmp/pdf-parser-uploads ──────────────
const UPLOAD_DIR = process.env.PDF_PARSER_UPLOAD_TMP || "/tmp/pdf-parser-uploads";
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) {}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".pdf";
    cb(null, `ticket-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 60 * 1024 * 1024 }, // scanned multi-page tickets get large
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype === "application/pdf" ||
      /\.pdf$/i.test(file.originalname);
    cb(ok ? null : new Error("Please upload a PDF job ticket."), ok);
  },
});

// Wrap multer so a rejected upload (wrong type / too big) returns a clean 400
// JSON the page can show, instead of Express's default 500 HTML.
function uploadTicket(req, res, next) {
  upload.single("pdfFile")(req, res, (err) => {
    if (!err) return next();
    const msg =
      err instanceof multer.MulterError
        ? (err.code === "LIMIT_FILE_SIZE" ? "That PDF is too large (max 60 MB)." : err.message)
        : (err.message || "Upload failed.");
    return res.status(400).json({ ok: false, error: msg });
  });
}

// ── Result metadata cache (so /file and /zip can validate ids) ───────────────
// The actual files live on disk under WORK_ROOT/<id>/. We keep light metadata
// in memory with a TTL; the on-disk folders are swept to match.
const RESULTS = new Map();
const RESULT_TTL_MS = 60 * 60 * 1000; // 1 hour — CSR downloads then moves on

function stashResult(result) {
  RESULTS.set(result.id, { ...result, expires: Date.now() + RESULT_TTL_MS });
}

// Sweep expired in-memory entries + on-disk folders every 10 min.
setInterval(() => {
  const now = Date.now();
  for (const [id, row] of RESULTS) {
    if (row.expires < now) RESULTS.delete(id);
  }
  try { sweepOldJobs(RESULT_TTL_MS); } catch (_) {}
}, 10 * 60 * 1000).unref?.();

// Reject path-traversal / unexpected names. We only ever generate
// page-NN.jpg, photo-NN.jpg, ocr-text.txt, and *-extracted.zip.
function safeName(name) {
  return /^[\w.\-]+$/.test(name) && !name.includes("..");
}

// ── POST /parse ──────────────────────────────────────────────────────────────
router.post("/parse", uploadTicket, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "A PDF job ticket is required." });
  }

  const fileName = req.file.originalname;
  const filePath = req.file.path;
  console.log(
    `[PDFParser] Parse request — file=${fileName} size=${(req.file.size / 1024).toFixed(0)}KB`
  );

  try {
    const result = await parsePdf(filePath, { originalName: fileName });
    stashResult(result);

    console.log(
      `[PDFParser]   id=${result.id} pages=${result.pageCount} textChars=${result.text.length}`
    );

    return res.json({
      ok: true,
      id: result.id,
      originalName: result.originalName,
      pageCount: result.pageCount,
      text: result.text,
      files: result.files.map((f) => ({
        ...f,
        url: `/api/pdf-parser/file/${result.id}/${f.name}`,
      })),
      zipUrl: `/api/pdf-parser/zip/${result.id}`,
      zipName: result.zipName,
      specialInstructions: result.specialInstructions || { found: false, bullets: [] },
    });
  } catch (err) {
    console.error(`[PDFParser] Parse failed for ${fileName}:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    // The uploaded source PDF isn't needed once extraction is done.
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
});

// ── GET /file/:id/:name ──────────────────────────────────────────────────────
router.get("/file/:id/:name", (req, res) => {
  const { id, name } = req.params;
  if (!safeName(id) || !safeName(name)) {
    return res.status(400).json({ ok: false, error: "Bad request." });
  }
  const row = RESULTS.get(id);
  if (!row || row.expires < Date.now()) {
    return res.status(410).json({ ok: false, error: "These files have expired — please re-upload the ticket." });
  }
  const full = path.join(WORK_ROOT, id, name);
  if (!full.startsWith(path.join(WORK_ROOT, id) + path.sep) || !fs.existsSync(full)) {
    return res.status(404).json({ ok: false, error: "File not found." });
  }
  // ?dl=1 forces a download; otherwise allow inline preview (thumbnails).
  if (/^(1|true|yes)$/i.test(String(req.query.dl || ""))) {
    return res.download(full, name);
  }
  return res.sendFile(full);
});

// ── GET /zip/:id ─────────────────────────────────────────────────────────────
router.get("/zip/:id", (req, res) => {
  const { id } = req.params;
  if (!safeName(id)) return res.status(400).json({ ok: false, error: "Bad request." });
  const row = RESULTS.get(id);
  if (!row || row.expires < Date.now()) {
    return res.status(410).json({ ok: false, error: "These files have expired — please re-upload the ticket." });
  }
  const full = path.join(WORK_ROOT, id, row.zipName);
  if (!fs.existsSync(full)) {
    return res.status(404).json({ ok: false, error: "Zip not found." });
  }
  return res.download(full, row.zipName);
});

// ── POST /attach ─────────────────────────────────────────────────────────────
// Body: { id, jobNumber, files?: string[] }
//   id        — the parse-result id whose JPGs live under WORK_ROOT/<id>/
//   jobNumber — what the office types (job number OR internal id; resolved below)
//   files     — optional subset of file names to attach; defaults to all pages
router.post("/attach", express.json(), async (req, res) => {
  const { id, jobNumber, files: requested } = req.body || {};

  if (!id || !safeName(String(id))) {
    return res.status(400).json({ ok: false, error: "Missing or invalid upload id." });
  }
  if (!jobNumber || !String(jobNumber).trim()) {
    return res.status(400).json({ ok: false, error: "Enter a ServiceTitan job number." });
  }

  const row = RESULTS.get(id);
  if (!row || row.expires < Date.now()) {
    return res.status(410).json({ ok: false, error: "These files have expired — please re-upload the PDF." });
  }

  // Which images to attach? Default to every page for this upload; otherwise the
  // caller-selected subset (validated against what we actually have on disk).
  const allNames = (row.files || []).map((f) => f.name);
  const names =
    Array.isArray(requested) && requested.length
      ? requested.filter((n) => allNames.includes(n))
      : allNames;
  if (names.length === 0) {
    return res.status(400).json({ ok: false, error: "No images selected to attach." });
  }

  // Resolve the typed job number → internal ST job id.
  let jobId = null;
  let resolvedNumber = null;
  try {
    const match = await findJobByNumber(String(jobNumber).trim());
    jobId = match.jobId;
    resolvedNumber = match.jobNumber;
  } catch (err) {
    console.error(`[PDFParser] job lookup failed for "${jobNumber}":`, err.message);
    return res.status(502).json({ ok: false, error: `Could not look up that job: ${err.message}` });
  }
  if (!jobId) {
    return res.status(404).json({ ok: false, error: `No ServiceTitan job found for "${jobNumber}".` });
  }

  // Upload each selected JPG. One bad file shouldn't sink the rest — collect
  // per-file results so the page can show exactly what landed.
  const dir = path.join(WORK_ROOT, id);
  const results = [];
  for (const name of names) {
    const full = path.join(dir, name);
    if (!full.startsWith(path.join(dir) + path.sep) || !fs.existsSync(full)) {
      results.push({ name, ok: false, error: "file missing" });
      continue;
    }
    try {
      const bytes = fs.readFileSync(full);
      const stName = `${resolvedNumber || String(jobNumber).trim()}-${name}`;
      const r = await createJobAttachment(jobId, bytes, { filename: stName, contentType: "image/jpeg" });
      results.push({ name, ok: true, fileName: r.fileName });
      console.log(`[PDFParser] attached ${name} → ST job ${jobId} (#${resolvedNumber})`);
    } catch (err) {
      results.push({ name, ok: false, error: err.message });
      console.error(`[PDFParser] attach failed ${name} → job ${jobId}: ${err.message}`);
    }
  }

  const attached = results.filter((r) => r.ok).length;
  return res.json({
    ok: attached > 0,
    jobId,
    jobNumber: resolvedNumber || String(jobNumber).trim(),
    attached,
    failed: results.length - attached,
    results,
  });
});

// ── POST /add-summary ────────────────────────────────────────────────────────
// Body: { jobNumber, instructions }
//   jobNumber    — job number OR internal id (resolved below)
//   instructions — the (possibly user-edited) bullet text from the page; one
//                  bullet per line, with or without a leading "•".
//
// Appends a dated, attributed block of the Special Installation Instructions to
// the ServiceTitan job Summary (never overwrites existing summary text).
router.post("/add-summary", express.json(), async (req, res) => {
  const { jobNumber, instructions } = req.body || {};

  if (!jobNumber || !String(jobNumber).trim()) {
    return res.status(400).json({ ok: false, error: "Enter a ServiceTitan job number." });
  }

  // Normalize the bullet text: strip any existing bullet glyph, drop blanks.
  const bullets = String(instructions || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[•\-*•]\s*/, "").trim())
    .filter(Boolean);
  if (bullets.length === 0) {
    return res.status(400).json({ ok: false, error: "There are no instructions to add." });
  }

  // Resolve the typed job number → internal ST job id.
  let jobId = null;
  let resolvedNumber = null;
  try {
    const match = await findJobByNumber(String(jobNumber).trim());
    jobId = match.jobId;
    resolvedNumber = match.jobNumber;
  } catch (err) {
    console.error(`[PDFParser] job lookup failed for "${jobNumber}":`, err.message);
    return res.status(502).json({ ok: false, error: `Could not look up that job: ${err.message}` });
  }
  if (!jobId) {
    return res.status(404).json({ ok: false, error: `No ServiceTitan job found for "${jobNumber}".` });
  }

  // Who's adding this (dashboard user) + when (in the office timezone).
  const userName = currentUserName(req);
  const tz = process.env.PDF_PARSER_TZ || "America/Chicago";
  let dateStr;
  try {
    dateStr = new Date().toLocaleDateString("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch (_) {
    dateStr = new Date().toISOString().slice(0, 10);
  }

  const header = `── Special Installation Instructions (added ${dateStr} by ${userName}) ──`;
  const block = `${header}\n` + bullets.map((b) => `• ${b}`).join("\n");

  const result = await appendJobSummary(jobId, block);
  if (!result.ok) {
    console.error(`[PDFParser] add-summary failed for job ${jobId}: ${result.error}`);
    return res.status(502).json({ ok: false, error: `ServiceTitan rejected the update: ${result.error}` });
  }

  console.log(`[PDFParser] summary updated on ST job ${jobId} (#${resolvedNumber}) by ${userName} — ${bullets.length} bullet(s)`);
  return res.json({
    ok: true,
    jobId,
    jobNumber: resolvedNumber || String(jobNumber).trim(),
    bulletCount: bullets.length,
    addedBy: userName,
    date: dateStr,
  });
});

// Resolve a friendly display name for the logged-in dashboard user. Falls back
// gracefully when there's no session (e.g. in tests).
function currentUserName(req) {
  try {
    const uid = req.session?.userId;
    if (uid) {
      const u = findById(uid);
      if (u) return u.display_name || (u.email ? u.email.split("@")[0] : null) || "the dashboard";
    }
  } catch (_) {}
  return "the dashboard";
}

module.exports = router;
