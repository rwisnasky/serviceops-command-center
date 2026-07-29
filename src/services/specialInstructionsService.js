/**
 * src/services/specialInstructionsService.js
 *
 * Most of the scanned PDFs the office processes carry a labeled box titled
 * "Special Installation Instructions" — a dense run-on paragraph that's painful
 * for an installer to read on the job. This service:
 *
 *   1. extractSpecialInstructions(ocrText)  — pulls that block out of the OCR
 *      text (null if the label isn't present).
 *   2. bulletizeInstructions(rawText)       — turns the paragraph into a clean,
 *      scannable bullet list using the OpenAI model already wired into the app
 *      (same pattern as invoiceParserService). Falls back to a deterministic
 *      sentence split when no API key is set or the call fails, so a parse
 *      never hard-fails over this.
 *
 * The bullets are shown on the PDF Parser page (editable) and can be pushed
 * into the ServiceTitan job Summary by the route layer.
 */

// Lazy client — constructing eagerly throws when OPENAI_API_KEY is missing and
// would take the whole router down at require-time (same reasoning as the
// invoice/scope parsers). api/openaiClient owns the caching and returns the
// canned demo shim when DEMO_MODE=true.
const { getClient } = require("../api/openaiClient");

const MODEL =
  process.env.JOB_SUMMARY_MODEL ||
  process.env.INVOICE_PARSER_MODEL ||
  "gpt-4o";

// ── Extraction ───────────────────────────────────────────────────────────────

/**
 * Find the "Special Installation Instructions" block in OCR text and return it
 * as a single cleaned paragraph (newlines collapsed to spaces). Returns null if
 * the label isn't found.
 *
 * We capture from the label up to the next injected page header
 * ("── Page N ──", written by pdfParserService) since the box lives within one
 * page. Any over-capture of unrelated form text is tolerated — the bulletizer
 * is instructed to ignore boilerplate.
 */
function extractSpecialInstructions(ocrText) {
  if (!ocrText || typeof ocrText !== "string") return null;

  // Tolerate OCR wobble: "Special Installation Instructions",
  // "Special Instalation Instruction", optional trailing colon.
  const labelRe = /special\s+in?stall?(?:ation|ion)?\s+instructions?\s*:?/i;
  const m = labelRe.exec(ocrText);
  if (!m) return null;

  let after = ocrText.slice(m.index + m[0].length);

  // Stop at the next page boundary we injected during OCR assembly.
  after = after.split(/\n?─+\s*Page\s+\d+[^\n]*/i)[0];

  const text = after
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .trim();

  return text.length >= 10 ? text : null;
}

// ── Bulletizing ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You reformat the "Special Installation Instructions" from a
home-services (plumbing / water-treatment) install ticket so a technician can read
them at a glance.

Convert the run-on text into a clean, scannable bullet list. Rules:
- PRESERVE every concrete detail: sizes ("9\\""), model/brand names, device names,
  locations ("under sink, on the right"), quantities ("8 bags of salt"), and
  directions.
- Fix obvious OCR / shorthand artifacts: "h.e." -> "HE", "R.o." or "r.o." -> "RO".
- Group tightly-related clauses into a single bullet; split distinct points apart.
- Keep each bullet short and factual. Do NOT invent or infer anything not stated.
- Ignore unrelated form boilerplate, page numbers, or headers if any slipped in.
- Keep "(see pictures)" style notes attached to the relevant bullet.

Return STRICT JSON only, no markdown fences:
{ "bullets": string[] }`;

/**
 * Turn a raw instructions paragraph into an array of bullet strings.
 * Uses OpenAI; falls back to a deterministic sentence split on any failure.
 *
 * @param {string} rawText
 * @returns {Promise<{ bullets: string[], engine: "ai" | "fallback" }>}
 */
async function bulletizeInstructions(rawText) {
  const text = (rawText || "").trim();
  if (!text) return { bullets: [], engine: "fallback" };

  try {
    const client = getClient();
    const res = await client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    });
    const raw = res.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    const bullets = Array.isArray(parsed.bullets)
      ? parsed.bullets.map((b) => String(b).trim()).filter(Boolean)
      : [];
    if (bullets.length) return { bullets, engine: "ai" };
    // Empty AI result — fall through to deterministic split.
  } catch (err) {
    console.warn(`[SpecialInstructions] AI bulletize failed (${err.message}); using fallback split`);
  }

  return { bullets: fallbackBullets(text), engine: "fallback" };
}

/**
 * Deterministic, offline fallback: split into sentences without breaking on
 * common abbreviations (h.e., R.o., etc.).
 */
function fallbackBullets(text) {
  // Temporarily neutralize 2-letter dotted abbreviations so the sentence
  // splitter doesn't break on them (h.e. / R.o. / r.o.).
  const protectedText = text.replace(
    /\b([A-Za-z])\.([A-Za-z])\.(?=\s|$)/g,
    (_m, a, b) => `${a}${b}·ABBR·`
  );
  return protectedText
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"(])/)
    .map((s) => s.replace(/·ABBR·/g, ".").replace(/\s+/g, " ").trim())
    .map((s) => s.replace(/\s*\.\s*$/, "")) // drop trailing period for tidiness
    .filter((s) => s.length > 2);
}

/**
 * Convenience: extract + bulletize in one call.
 * @returns {Promise<{ found: boolean, raw: string|null, bullets: string[], engine: string }>}
 */
async function getSpecialInstructions(ocrText) {
  const raw = extractSpecialInstructions(ocrText);
  if (!raw) return { found: false, raw: null, bullets: [], engine: "none" };
  const { bullets, engine } = await bulletizeInstructions(raw);
  return { found: true, raw, bullets, engine };
}

module.exports = {
  extractSpecialInstructions,
  bulletizeInstructions,
  getSpecialInstructions,
  fallbackBullets,
};
