/**
 * src/services/contractDiffService.js
 *
 * Compare two contracts (PDF, DOCX, or plain text) and return a structured
 * change list suitable for accordion-style review.
 *
 * Pipeline:
 *   1. extractText(buffer, mime, filename) → normalized plain-text string
 *   2. splitParagraphs(text)               → ordered array of paragraph blocks
 *   3. tagSections(paragraphs)             → annotates each block with the
 *                                            nearest preceding heading so the
 *                                            UI can group changes by section
 *   4. diffParagraphs(oldBlocks, newBlocks) → array of {type, section, oldText, newText}
 *
 * The output is intentionally compact — no full-document side-by-side render,
 * just a flat list of changes the user can expand one by one.
 */

const pdfParse  = require("pdf-parse");
const mammoth   = require("mammoth");
const { diffArrays, diffWordsWithSpace } = require("diff");
const crypto    = require("crypto");

// ── 1. Text extraction ──────────────────────────────────────────────────────

/**
 * Extract clean plain text from any supported file buffer or pasted string.
 * Returns the extracted text + the detected source type.
 *
 *   { text: "…", kind: "pdf" | "docx" | "text" }
 */
async function extractText({ buffer, mime, filename, pastedText }) {
  // Pasted text wins if both supplied.
  if (pastedText && pastedText.trim().length > 0) {
    return { text: normalize(pastedText), kind: "text" };
  }
  if (!buffer || buffer.length === 0) {
    throw httpError(400, "No file or pasted text provided");
  }

  const name = (filename || "").toLowerCase();
  const isPdf  = mime === "application/pdf" || name.endsWith(".pdf");
  const isDocx =
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx");
  const isText = mime?.startsWith("text/") || name.endsWith(".txt") || name.endsWith(".md");

  if (isPdf) {
    const parsed = await pdfParse(buffer);
    return { text: normalize(parsed.text || ""), kind: "pdf" };
  }
  if (isDocx) {
    const { value } = await mammoth.extractRawText({ buffer });
    return { text: normalize(value || ""), kind: "docx" };
  }
  if (isText) {
    return { text: normalize(buffer.toString("utf8")), kind: "text" };
  }

  throw httpError(
    415,
    `Unsupported file type: ${mime || "(unknown)"}. ` +
    `Upload a PDF, DOCX, or plain-text file, or paste the text directly.`
  );
}

/**
 * Normalize whitespace without destroying paragraph breaks.
 *   - convert CRLF → LF
 *   - trim trailing space on each line
 *   - collapse 3+ blank lines to a single blank line (paragraph separator)
 *   - drop leading/trailing whitespace on the whole doc
 */
function normalize(s) {
  return String(s || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── 2. Paragraph segmentation + section tagging ─────────────────────────────

/**
 * Split a normalized document into paragraph blocks. A paragraph is text
 * separated from its neighbors by one or more blank lines. Within a paragraph
 * single newlines are flattened to spaces so the diff treats a wrapped line
 * the same as an unwrapped one.
 */
function splitParagraphs(text) {
  if (!text) return [];
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n+/g, " ").replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
}

/**
 * Heading heuristic — a paragraph is treated as a section heading if any of:
 *   • starts with a section number pattern (e.g. "1.", "1.1", "1.1.2", "Article IV")
 *   • is short (≤ 80 chars) AND entirely uppercase letters/digits/punct
 *   • is short (≤ 80 chars) AND does not end with a sentence terminator
 *
 * This is intentionally generous — false positives are cheap (a slightly
 * weirder section label in the UI) but false negatives lose context.
 */
const SECTION_PATTERNS = [
  /^\d+(\.\d+)*\.?\s+\S/,                            // "1.", "2.3", "1.1.2 Foo"
  /^(article|section|clause|exhibit|schedule|appendix)\s+(\d+|[ivxlc]+)/i,
  /^(ARTICLE|SECTION|CLAUSE|EXHIBIT|SCHEDULE|APPENDIX)\s+[\dIVXLC]+/,
];
function looksLikeHeading(p) {
  if (p.length > 120) return false;
  for (const re of SECTION_PATTERNS) {
    if (re.test(p)) return true;
  }
  if (p.length <= 80) {
    const letters = p.replace(/[^A-Za-z]/g, "");
    if (letters.length > 0 && letters === letters.toUpperCase()) return true;
    if (!/[.!?]$/.test(p) && /^[A-Z]/.test(p)) return true;
  }
  return false;
}

/**
 * Walk the paragraph list and annotate each block with the nearest preceding
 * heading text. The heading block itself carries its own text as the section.
 *
 *   [{ text: "1. Scope of Work", section: "1. Scope of Work", isHeading: true },
 *    { text: "Contractor shall …", section: "1. Scope of Work", isHeading: false }]
 */
function tagSections(paragraphs) {
  let current = "";
  return paragraphs.map((text) => {
    const isHeading = looksLikeHeading(text);
    if (isHeading) current = text;
    return { text, section: current, isHeading };
  });
}

// ── 3. Diff ─────────────────────────────────────────────────────────────────

/**
 * Produce an inline word-level diff between two strings. Used only for
 * "modified" changes so the UI can highlight what flipped.
 *
 *   [{ value: "Customer shall pay ", kind: "same" },
 *    { value: "thirty",              kind: "removed" },
 *    { value: "forty-five",          kind: "added" },
 *    { value: " days after invoice", kind: "same" }]
 */
function inlineWordDiff(oldText, newText) {
  const parts = diffWordsWithSpace(oldText || "", newText || "");
  return parts.map((p) => ({
    value: p.value,
    kind: p.added ? "added" : p.removed ? "removed" : "same",
  }));
}

/**
 * Diff two paragraph arrays. Returns an ordered list of change records:
 *
 *   { id, type: "added"|"removed"|"modified", section, oldText, newText, inline? }
 *
 * Adjacent removed/added pairs are collapsed into a single "modified" entry so
 * the reviewer sees the before+after together rather than scrolling between
 * two separate accordion cards.
 */
function diffParagraphs(oldBlocks, newBlocks) {
  const oldTexts = oldBlocks.map((b) => b.text);
  const newTexts = newBlocks.map((b) => b.text);

  const parts = diffArrays(oldTexts, newTexts);

  // Flatten into a per-paragraph change list with section context, then
  // collapse removed↔added adjacencies into "modified".
  const raw = [];
  let oi = 0; // running index into oldBlocks
  let ni = 0; // running index into newBlocks

  for (const part of parts) {
    if (!part.added && !part.removed) {
      // unchanged — advance both
      for (const _ of part.value) {
        oi++;
        ni++;
      }
      continue;
    }
    if (part.removed) {
      for (const text of part.value) {
        raw.push({
          type: "removed",
          section: oldBlocks[oi]?.section || "",
          oldText: text,
          newText: null,
          _ni: ni, // capture position for adjacency collapse
        });
        oi++;
      }
    } else if (part.added) {
      for (const text of part.value) {
        raw.push({
          type: "added",
          section: newBlocks[ni]?.section || "",
          oldText: null,
          newText: text,
          _ni: ni,
        });
        ni++;
      }
    }
  }

  // Collapse runs of removed followed by added at the same insertion point
  // into "modified" entries (pair them by order within the run).
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const cur = raw[i];
    if (cur.type === "removed") {
      // Look ahead for the next consecutive block of "added" right after this run.
      let j = i;
      const removedRun = [];
      while (j < raw.length && raw[j].type === "removed") {
        removedRun.push(raw[j]);
        j++;
      }
      const addedRun = [];
      while (j < raw.length && raw[j].type === "added") {
        addedRun.push(raw[j]);
        j++;
      }
      const pairs = Math.min(removedRun.length, addedRun.length);
      for (let k = 0; k < pairs; k++) {
        const r = removedRun[k];
        const a = addedRun[k];
        out.push({
          id: makeId(),
          type: "modified",
          section: a.section || r.section,
          oldText: r.oldText,
          newText: a.newText,
          inline: inlineWordDiff(r.oldText, a.newText),
        });
      }
      // Any leftover removes / adds become their own entries.
      for (let k = pairs; k < removedRun.length; k++) {
        const r = removedRun[k];
        out.push({
          id: makeId(),
          type: "removed",
          section: r.section,
          oldText: r.oldText,
          newText: null,
        });
      }
      for (let k = pairs; k < addedRun.length; k++) {
        const a = addedRun[k];
        out.push({
          id: makeId(),
          type: "added",
          section: a.section,
          oldText: null,
          newText: a.newText,
        });
      }
      i = j - 1;
    } else if (cur.type === "added") {
      out.push({
        id: makeId(),
        type: "added",
        section: cur.section,
        oldText: null,
        newText: cur.newText,
      });
    }
  }

  return out;
}

// ── 4. Top-level orchestrator ───────────────────────────────────────────────

/**
 * Compare two inputs end to end. Inputs can be uploaded files or pasted text.
 *
 *   await compareContracts(
 *     { buffer, mime, filename },              // or { pastedText: "…" }
 *     { buffer, mime, filename }
 *   )
 *
 * Returns:
 *   {
 *     summary: { totalChanges, added, removed, modified, oldParagraphs, newParagraphs, oldKind, newKind },
 *     changes: [ {id, type, section, oldText, newText, inline?}, … ],
 *     bySection: [ { section, items: [...] }, … ]   // pre-grouped for the UI
 *   }
 */
async function compareContracts(oldInput, newInput) {
  const [oldExtract, newExtract] = await Promise.all([
    extractText(oldInput),
    extractText(newInput),
  ]);

  const oldBlocks = tagSections(splitParagraphs(oldExtract.text));
  const newBlocks = tagSections(splitParagraphs(newExtract.text));

  const changes = diffParagraphs(oldBlocks, newBlocks);

  const summary = {
    totalChanges: changes.length,
    added:    changes.filter((c) => c.type === "added").length,
    removed:  changes.filter((c) => c.type === "removed").length,
    modified: changes.filter((c) => c.type === "modified").length,
    oldParagraphs: oldBlocks.length,
    newParagraphs: newBlocks.length,
    oldKind: oldExtract.kind,
    newKind: newExtract.kind,
  };

  // Group by section in stable order.
  const bySection = [];
  const seen = new Map();
  for (const c of changes) {
    const key = c.section || "(unsectioned)";
    if (!seen.has(key)) {
      seen.set(key, { section: key, items: [] });
      bySection.push(seen.get(key));
    }
    seen.get(key).items.push(c);
  }

  return { summary, changes, bySection };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function makeId() {
  return "c_" + crypto.randomBytes(5).toString("hex");
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = {
  compareContracts,
  // exported for unit testing
  extractText,
  splitParagraphs,
  tagSections,
  diffParagraphs,
  looksLikeHeading,
};
