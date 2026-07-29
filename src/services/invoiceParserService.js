/**
 * Invoice parser service.
 *
 * Takes a supplier-invoice PDF (or image) and uses the OpenAI vision API to
 * extract structured data we can use to create a ServiceTitan Purchase Order.
 *
 * Returns:
 *   {
 *     vendor:         "Ferguson Plumbing Supply",
 *     invoiceNumber:  "INV-12345",
 *     invoiceDate:    "2026-04-05",
 *     jobNumber:      "JOB-9876"  | null,   // job/PO ref printed on invoice
 *     subtotal:       123.45,
 *     tax:            9.88,
 *     total:          133.33,
 *     lineItems: [
 *       { description, sku, quantity, unitCost, lineTotal }
 *     ],
 *     raw: <full LLM response> // for debugging
 *   }
 */

const fs = require("fs");
const path = require("path");
// Lazy OpenAI client — same reason as scopeParserService/materialRenameService:
// constructing eagerly throws when OPENAI_API_KEY is missing and takes the
// whole router down at require-time. Requires that touch this module should
// still load; only actually calling the parser needs the key. Returns the
// canned demo shim under DEMO_MODE.
const { getClient, aiAvailable } = require("../api/openaiClient");

const SYSTEM_PROMPT = `You are an expert at reading supplier invoices for a home-services
contracting business. You will receive an image of a single invoice page.
Extract the data and return STRICT JSON only — no prose, no markdown fences.

Required JSON shape:
{
  "vendor": string,                // supplier company name (top of invoice)
  "invoiceNumber": string,         // the supplier's invoice / document number
  "invoiceDate": string,           // ISO date YYYY-MM-DD
  "jobNumber": string | null,      // see IMPORTANT rules below
  "jobNumberLabel": string | null, // the label text from the invoice next to the
                                   // jobNumber you returned (e.g. "Customer PO",
                                   // "Your PO #", "Job No."). null if not found.
  "subtotal": number,
  "tax": number,
  "total": number,
  "lineItems": [
    {
      "description": string,
      "sku": string | null,
      "quantity": number,
      "unitCost": number,
      "lineTotal": number
    }
  ]
}

IMPORTANT — jobNumber rules:
The invoice will have MANY numbers on it. We only want the reference the
CUSTOMER (us) gave the supplier when ordering — that number maps to our
internal job in ServiceTitan.

PREFER these labels (in order):
  1. "Customer PO", "Customer P.O.", "Cust PO", "Customer PO #"
  2. "Your PO", "Your P.O.", "Your Reference", "Your Ref"
  3. "Customer Job", "Customer Job #", "Customer Reference"
  4. "Job #", "Job No.", "Job Number"  (only if no customer-labeled field exists)
  5. "PO #" or "P.O. #"  (only if no more specific label exists AND no Order #
     is also present — otherwise this is likely the supplier's own PO)
  6. "Project", "Project #"

DO NOT use these — they are the SUPPLIER's internal tracking, not ours:
  - "Order #", "Order No.", "Sales Order", "SO #"
  - "Invoice #" (that's the invoiceNumber field, not jobNumber)
  - "Delivery #", "Delivery Ticket", "Ticket #"
  - "Quote #", "Estimate #"
  - "Account #", "Account Number"
  - "Ship To" codes, "Bill To" codes

If the invoice has both an "Order #" and a "Customer PO" field, ALWAYS choose
the Customer PO. If only an Order # exists and no customer-side reference,
return null for jobNumber — do NOT fall back to Order #.

If unsure, return null. Do NOT invent a jobNumber.

Other rules:
- Numbers must be plain numbers (no $, no commas).
- If a value is missing on the invoice, use null (or 0 for required numbers).`;

/**
 * Convert a PDF to a PNG of page 1 using pdftoppm (poppler-utils).
 * Returns the PNG path. Caller is responsible for cleaning up.
 *
 * If the input is already an image (.png/.jpg/.jpeg), it is returned as-is.
 */
async function ensureImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return filePath;
  if (ext !== ".pdf") {
    throw new Error(`Unsupported invoice file type: ${ext}`);
  }

  const { execSync } = require("child_process");
  const outBase = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath, ".pdf")}-page`
  );
  // pdftoppm appends "-1.png" for the first page
  execSync(`pdftoppm -png -r 200 -f 1 -l 1 "${filePath}" "${outBase}"`, {
    stdio: "ignore",
  });
  const pngPath = `${outBase}-1.png`;
  if (!fs.existsSync(pngPath)) {
    throw new Error(
      `pdftoppm did not produce ${pngPath}. Is poppler-utils installed?`
    );
  }
  return pngPath;
}

/**
 * Parse an invoice file into structured data.
 */
async function parseInvoice(filePath) {
  if (!aiAvailable()) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const imagePath = await ensureImage(filePath);
  const b64 = fs.readFileSync(imagePath).toString("base64");
  const mimeType = imagePath.toLowerCase().endsWith(".png")
    ? "image/png"
    : "image/jpeg";

  const openai = getClient();
  let response;
  try {
    response = await openai.chat.completions.create({
      model: process.env.INVOICE_PARSER_MODEL || "gpt-4o",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract this invoice as JSON." },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${b64}` },
            },
          ],
        },
      ],
    });
  } catch (err) {
    // Surface the real OpenAI error — their SDK's default message is opaque
    const status = err.status || err.response?.status;
    const detail =
      err.error?.message ||
      err.response?.data?.error?.message ||
      err.message;
    throw new Error(`OpenAI parse failed (${status || "?"}): ${detail}`);
  }

  // Clean up generated PNG (only if we created it)
  if (imagePath !== filePath) {
    try {
      fs.unlinkSync(imagePath);
    } catch (_) {}
  }

  const rawText = response.choices?.[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Invoice parser returned non-JSON: ${rawText.slice(0, 200)}`);
  }

  // Normalize numbers
  const num = (v) => (v == null || v === "" ? 0 : Number(v));
  parsed.subtotal = num(parsed.subtotal);
  parsed.tax = num(parsed.tax);
  parsed.total = num(parsed.total);
  parsed.lineItems = (parsed.lineItems || []).map((it) => ({
    description: it.description || "",
    sku: it.sku || null,
    quantity: num(it.quantity) || 1,
    unitCost: num(it.unitCost),
    lineTotal: num(it.lineTotal),
  }));

  parsed.raw = rawText;
  return parsed;
}

module.exports = { parseInvoice };
