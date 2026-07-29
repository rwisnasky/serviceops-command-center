/**
 * src/services/scopeParserService.js
 *
 * Scope-of-work / competitor-quote parser.
 *
 * Takes a PDF (or image) describing work to be done — a customer scope, a
 * competitor's quote, a commercial bid spec — and uses OpenAI vision to
 * extract a normalized list of line items we can then match against our
 * pricebook.
 *
 * Why a separate parser from invoiceParserService?
 *  - Invoices have a strict grammar (vendor, invoice#, line total). Scope
 *    docs are much freer — often prose ("Replace the 50-gal water heater
 *    and re-route the gas line"), bulleted lists, or table rows without
 *    prices. We tell the LLM to ignore pricing in the source document and
 *    just extract *what work is being asked for*.
 *  - Scope docs are commonly multi-page. We send up to 5 pages.
 *
 * Output:
 *   {
 *     jobNumber:    string | null,    // if the doc references one of our ST job #s
 *     customerName: string | null,    // who the scope is for, if printed
 *     projectTitle: string | null,    // short description of the whole job
 *     lineItems: [
 *       { description: string, quantity: number, notes: string | null }
 *     ],
 *     raw: <full LLM response>        // for debugging
 *   }
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Lazy OpenAI client — constructing eagerly at module load throws when
// OPENAI_API_KEY isn't set, which would bring down the whole pricebook
// router (and anything else that requires this module transitively).
// api/openaiClient returns the canned shim under DEMO_MODE.
const { getClient } = require("../api/openaiClient");

const MAX_PAGES = 5;

const SYSTEM_PROMPT = `You are a dispatcher at a home-services contracting company
(plumbing / HVAC / electrical). You will receive one or more page images of a
document describing work a customer wants done — it might be a scope-of-work
write-up, a quote from a competitor, or a project spec.

Extract the data and return STRICT JSON only — no prose, no markdown fences.

Required JSON shape:
{
  "jobNumber":    string | null,  // only if the doc references OUR ServiceTitan
                                  // job number (e.g. "Job #123456", "PO# 123456")
  "customerName": string | null,  // e.g. "Smith Residence" or company name
  "projectTitle": string | null,  // one short line summarizing the job
  "lineItems": [
    {
      "description": string,      // plain-English description of the task or part
      "quantity":    number,      // default 1 if not specified
      "notes":       string | null // any specifics: size, brand, location, condition
    }
  ]
}

Rules for lineItems:
- BREAK THE SCOPE INTO DISCRETE TASKS OR PARTS. A paragraph like
  "Replace the 50-gal gas water heater, install new shutoff valve, and
  re-route the supply line" should become THREE items, not one.
- IGNORE any prices, dollar amounts, or totals in the source document. We
  will look up our own pricing. Do NOT include unitPrice or lineTotal.
- KEEP descriptions short and generic enough to match a pricebook SKU
  (e.g. "Replace 50 gallon gas water heater" not "Replace the existing
  leaky old water heater that Mr. Smith complained about").
- Move specifics (sizes, brands, locations, existing-condition notes) into
  the "notes" field, not the description.
- If quantity is not clearly stated, default to 1.
- If the document is a competitor quote with line items in a table, use
  the line descriptions but STILL ignore competitor prices.
- If NO line items can be extracted (e.g. blank page, unrelated doc),
  return lineItems: [].

Other rules:
- If unsure about jobNumber, return null. Do NOT invent one.
- Numbers must be plain numbers (no $, no commas).`;

/**
 * Convert a PDF into PNG images of each page (up to MAX_PAGES) using pdftoppm.
 * Returns an array of image paths. Caller owns cleanup.
 * If the input is already an image, returns [filePath].
 */
function pdfToImages(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return [filePath];
  if (ext !== ".pdf") {
    throw new Error(`Unsupported scope file type: ${ext}`);
  }

  const outBase = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath, ".pdf")}-scope-page`
  );
  execSync(`pdftoppm -png -r 180 -f 1 -l ${MAX_PAGES} "${filePath}" "${outBase}"`, {
    stdio: "ignore",
  });

  const pages = [];
  for (let i = 1; i <= MAX_PAGES; i++) {
    const p = `${outBase}-${i}.png`;
    if (fs.existsSync(p)) pages.push(p);
    else break; // PDF had fewer than i pages
  }
  if (pages.length === 0) {
    throw new Error(`pdftoppm produced no pages for ${filePath}. Is poppler-utils installed?`);
  }
  return pages;
}

function buildImageMessage(paths) {
  return paths.map(p => {
    const b64 = fs.readFileSync(p).toString("base64");
    const mime = p.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    return { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } };
  });
}

/**
 * Parse a scope/quote file into structured data.
 */
async function parseScope(filePath) {
  const openai = getClient(); // throws if OPENAI_API_KEY is missing

  const images = pdfToImages(filePath);
  const imageContent = buildImageMessage(images);

  let response;
  try {
    response = await openai.chat.completions.create({
      model: process.env.SCOPE_PARSER_MODEL || process.env.INVOICE_PARSER_MODEL || "gpt-4o",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: `Extract this scope-of-work as JSON. ${images.length > 1 ? `(${images.length} pages included)` : ""}` },
            ...imageContent,
          ],
        },
      ],
    });
  } catch (err) {
    const status = err.status || err.response?.status;
    const detail = err.error?.message || err.response?.data?.error?.message || err.message;
    // Clean up generated PNGs before surfacing the error
    for (const p of images) {
      if (p !== filePath) { try { fs.unlinkSync(p); } catch (_) {} }
    }
    throw new Error(`OpenAI scope-parse failed (${status || "?"}): ${detail}`);
  }

  // Clean up generated images
  for (const p of images) {
    if (p !== filePath) { try { fs.unlinkSync(p); } catch (_) {} }
  }

  const rawText = response.choices?.[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Scope parser returned non-JSON: ${rawText.slice(0, 200)}`);
  }

  const num = v => (v == null || v === "" ? 0 : Number(v));

  parsed.jobNumber    = parsed.jobNumber    || null;
  parsed.customerName = parsed.customerName || null;
  parsed.projectTitle = parsed.projectTitle || null;

  parsed.lineItems = Array.isArray(parsed.lineItems)
    ? parsed.lineItems.map(li => ({
        description: String(li.description || "").trim(),
        quantity:    num(li.quantity) || 1,
        notes:       li.notes ? String(li.notes) : null,
      })).filter(li => li.description)
    : [];

  parsed.raw = rawText;
  return parsed;
}

module.exports = { parseScope };
