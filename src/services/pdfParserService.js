/**
 * src/services/pdfParserService.js
 *
 * Turns a scanned job-ticket PDF (the kind a big client emails us) into:
 *   1. One JPG per page  — every page (the ticket form AND each job photo) as an
 *      image the CSR can upload straight to the ServiceTitan job.
 *   2. OCR'd text of the whole ticket  — copyable, so the CSR doesn't retype.
 *   3. A single .zip bundling all of the above.
 *
 * Goal: replace the "print it, then re-scan through ScanSnap" loop. Nothing here
 * touches ServiceTitan — it only produces files for the CSR to upload.
 *
 * A scanned PDF is one raster image per page, so "split every page to a JPG"
 * gives the CSR every photo and the ticket itself, with zero guesswork about
 * which page is which. Rendering with poppler (pdftoppm) guarantees a real JPG
 * regardless of how the scanner encoded the source. OCR is local via Tesseract
 * (printed text) — same no-new-deps toolchain the invoice parser already uses.
 *
 * Everything for one upload lives under  <WORK_ROOT>/<jobId>/  so the route can
 * serve files by name and stream the zip. A TTL sweep (run by the route) deletes
 * old job folders.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { getSpecialInstructions } = require("./specialInstructionsService");

const execFileP = promisify(execFile);

// Where per-upload working folders live. Overridable via env; defaults to the
// OS temp dir (ephemeral on Railway, which is fine — these are throwaway).
const WORK_ROOT = process.env.PDF_PARSER_TMP || path.join(os.tmpdir(), "pdf-parser");
try { fs.mkdirSync(WORK_ROOT, { recursive: true }); } catch (_) {}

// Render DPI for page → JPG. 200 is plenty for a scanned ticket and keeps file
// sizes reasonable for upload into ST.
const RENDER_DPI = Number(process.env.PDF_PARSER_DPI) || 200;

const EXEC_OPTS = { maxBuffer: 96 * 1024 * 1024 }; // OCR of a busy page can be big

// ── helpers ──────────────────────────────────────────────────────────────────

// Numeric-aware sort so page-2 comes before page-10.
function natSort(a, b) {
  const na = parseInt((a.match(/(\d+)/) || [])[1] || "0", 10);
  const nb = parseInt((b.match(/(\d+)/) || [])[1] || "0", 10);
  return na - nb || a.localeCompare(b);
}

function listMatching(dir, re) {
  return fs.readdirSync(dir).filter((f) => re.test(f)).sort(natSort);
}

async function run(cmd, args, opts = {}) {
  return execFileP(cmd, args, { ...EXEC_OPTS, ...opts });
}

/**
 * Render every page of the PDF to <dir>/render-N.jpg.
 * Returns the absolute paths in page order.
 */
async function renderPages(pdfPath, dir) {
  await run("pdftoppm", [
    "-jpeg",
    "-jpegopt", "quality=85",
    "-r", String(RENDER_DPI),
    pdfPath,
    path.join(dir, "render"),
  ]);
  return listMatching(dir, /^render-\d+\.jpg$/i).map((f) => path.join(dir, f));
}

/**
 * OCR a single image with Tesseract. Tuned for printed forms (--psm 6 = assume
 * a uniform block of text). Returns trimmed text, or "" if OCR fails for a page
 * (a bad page shouldn't sink the whole upload).
 */
async function ocrImage(imgPath) {
  try {
    const { stdout } = await run("tesseract", [imgPath, "stdout", "-l", "eng", "--psm", "6"]);
    return (stdout || "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();
  } catch (_) {
    return "";
  }
}

// ── main entry ───────────────────────────────────────────────────────────────

/**
 * Parse an uploaded job-ticket PDF.
 *
 * @param {string} pdfPath  absolute path to the uploaded PDF
 * @param {object} [opts]
 * @param {string} [opts.originalName]  original filename (for labels / zip name)
 * @returns {Promise<{
 *   id: string,
 *   dir: string,
 *   originalName: string,
 *   pageCount: number,
 *   text: string,
 *   files: Array<{ name, label, kind: 'page', bytes }>,
 *   zipName: string
 * }>}
 */
async function parsePdf(pdfPath, opts = {}) {
  const originalName = (opts.originalName || path.basename(pdfPath) || "document.pdf").trim();
  const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const dir = path.join(WORK_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });

  // 1. Render every page to a JPG (guaranteed JPGs, and the OCR source).
  const renderPaths = await renderPages(pdfPath, dir);
  if (renderPaths.length === 0) {
    throw new Error("Could not read any pages from that PDF — is it a valid PDF?");
  }

  // 2. OCR every page (sequential — Tesseract is CPU-heavy; parallel would just
  //    thrash a small Railway box).
  const pageTexts = [];
  for (const p of renderPaths) pageTexts.push(await ocrImage(p));

  // 3. Normalize each render to page-NN.jpg (clean, predictable filenames).
  const files = [];
  renderPaths.forEach((src, i) => {
    const name = `page-${String(i + 1).padStart(2, "0")}.jpg`;
    const dest = path.join(dir, name);
    if (src !== dest) fs.renameSync(src, dest);
    files.push({ name, label: `Page ${i + 1}`, kind: "page", bytes: statBytes(dir, name) });
  });
  const pageCount = files.length;

  // 4. Assemble OCR text with per-page headers.
  const text = pageTexts
    .map((t, i) => `── Page ${i + 1} ─────────────────────────────\n${t || "(no text detected on this page)"}`)
    .join("\n\n")
    .trim();
  fs.writeFileSync(path.join(dir, "ocr-text.txt"), text + "\n", "utf8");

  // 5. Pull out the "Special Installation Instructions" block (if present) and
  //    turn it into clean bullets. Best-effort — never let this sink a parse.
  let specialInstructions = { found: false, raw: null, bullets: [], engine: "none" };
  try {
    specialInstructions = await getSpecialInstructions(text);
  } catch (err) {
    console.warn(`[PDFParser] special-instructions step failed (non-fatal): ${err.message}`);
  }

  // 6. Bundle a zip (page JPGs + ocr-text.txt) for one-click "download all".
  const baseName = sanitizeBase(originalName).replace(/\.pdf$/i, "") || "document";
  const zipName = `${baseName}-extracted.zip`;
  await buildZip(dir, zipName, [...files.map((f) => f.name), "ocr-text.txt"]);

  return { id, dir, originalName, pageCount, text, files, zipName, specialInstructions };
}

// ── small fs/zip utilities ───────────────────────────────────────────────────

function statBytes(dir, name) {
  try { return fs.statSync(path.join(dir, name)).size; } catch (_) { return 0; }
}

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch (_) {}
}

function sanitizeBase(name) {
  return String(name).replace(/[^\w.\-]+/g, "_").slice(0, 80);
}

async function buildZip(dir, zipName, members) {
  const zipPath = path.join(dir, zipName);
  safeUnlink(zipPath);
  // `zip -j` = junk paths (flat archive). Run with cwd=dir so members are relative.
  await run("zip", ["-j", "-q", zipName, ...members], { cwd: dir });
  return zipPath;
}

/**
 * Delete job folders older than maxAgeMs. Called periodically by the route.
 * Returns the number of folders removed.
 */
function sweepOldJobs(maxAgeMs) {
  let removed = 0;
  let entries = [];
  try { entries = fs.readdirSync(WORK_ROOT); } catch (_) { return 0; }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of entries) {
    const full = path.join(WORK_ROOT, name);
    try {
      const st = fs.statSync(full);
      if (st.isDirectory() && st.mtimeMs < cutoff) {
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
      }
    } catch (_) {}
  }
  return removed;
}

module.exports = {
  parsePdf,
  sweepOldJobs,
  WORK_ROOT,
};
