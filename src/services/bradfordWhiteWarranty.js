/**
 * src/services/bradfordWhiteWarranty.js
 *
 * Parse a Bradford White water-heater registration/warranty SCREENSHOT (image,
 * or a PDF) into a ServiceTitan-ready unit, using the OpenAI Vision API — the
 * same OCR toolchain the invoice parser uses (services/invoiceParserService.js).
 *
 * A Bradford White registration page looks like:
 *   Serial: BL56188983   Model: RG2PV75H6N19   Type: RES GAS
 *   Mfg. Date: November 25, 2025
 *   Warranty Length: Tank 6 years, Parts 6 years
 *   Warranty Expires: Tank - July 14, 2032, Parts - July 14, 2032
 *   Registration Status: Registered    Registration Date: July 15, 2026
 *
 * DESIGN NOTES
 * - One screenshot = one water heater (a single unit), but we return a units[]
 *   array so it flows through the same multi-unit UI as American Standard.
 * - The manufacture date is printed explicitly (no serial decode needed).
 * - Install date is derived: warranty coverage begins at installation, so
 *   install = (warranty expires) − (warranty years). Here Tank expires 2032-07-14
 *   over 6 years → installed ~2026-07-14.
 * - ServiceTitan's single warranty-end field gets the TANK term (the primary
 *   water-heater coverage); Tank + Parts are both spelled out in the memo.
 * - Date helpers are shared with the American Standard module.
 */

const asw = require("./americanStandardWarranty");

// ── OpenAI Vision client (lazy — never break require-time if the key is unset) ─
// api/openaiClient decides between the real SDK and the canned demo shim.
const { getClient, aiAvailable } = require("../api/openaiClient");

const SYSTEM_PROMPT = `You read Bradford White water-heater registration / warranty screenshots for a
plumbing & HVAC contractor. You will receive an image. Extract the fields and
return STRICT JSON only — no prose, no markdown fences.

Return exactly this shape:
{
  "serial": string,                 // e.g. "BL56188983"
  "model": string,                  // e.g. "RG2PV75H6N19"
  "type": string | null,            // e.g. "RES GAS"
  "mfgDate": string | null,         // ISO YYYY-MM-DD (from "Mfg. Date")
  "originalMfgDate": string | null, // ISO YYYY-MM-DD (from "Original Mfg. Date")
  "tankWarrantyYears": number | null,   // integer years from "Warranty Length"
  "partsWarrantyYears": number | null,
  "tankWarrantyExpires": string | null, // ISO YYYY-MM-DD from "Warranty Expires"
  "partsWarrantyExpires": string | null,
  "registrationStatus": string | null,  // e.g. "Registered"
  "registrationDate": string | null      // ISO YYYY-MM-DD
}

Rules:
- ALL dates must be ISO YYYY-MM-DD. Convert "November 25, 2025" -> "2025-11-25".
- Years are plain integers (e.g. "Tank 6 years" -> 6).
- If a field is not visible, use null. Do not invent values.
- The serial and model must be copied EXACTLY, character for character.`;

/**
 * Convert an uploaded file to an image path if needed (PDF -> PNG page 1).
 * Images pass through unchanged. Mirrors invoiceParserService.ensureImage.
 */
function ensureImage(filePath) {
  const path = require("path");
  const fs = require("fs");
  const ext = path.extname(filePath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return filePath;
  if (ext !== ".pdf") throw new Error(`Unsupported file type: ${ext || "unknown"}`);
  const { execSync } = require("child_process");
  const outBase = path.join(path.dirname(filePath), `.${path.basename(filePath, ".pdf")}-page`);
  execSync(`pdftoppm -png -r 200 -f 1 -l 1 "${filePath}" "${outBase}"`, { stdio: "ignore" });
  const pngPath = `${outBase}-1.png`;
  if (!fs.existsSync(pngPath)) throw new Error("Could not render the PDF to an image (poppler-utils missing?).");
  return pngPath;
}

/** Detect the data-URL mime type from a file extension. */
function mimeFor(filePath) {
  const p = filePath.toLowerCase();
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".webp")) return "image/webp";
  if (p.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

/**
 * OCR + parse a Bradford White screenshot file into structured JSON, then
 * normalize into { units:[unit] }.
 * @param {string} filePath  path to the uploaded image (or PDF)
 */
async function parseWarrantyImage(filePath) {
  if (!aiAvailable()) throw new Error("OPENAI_API_KEY is not set");
  const fs = require("fs");

  const imagePath = ensureImage(filePath);
  const b64 = fs.readFileSync(imagePath).toString("base64");
  const mime = mimeFor(imagePath);

  const openai = getClient();
  let response;
  try {
    response = await openai.chat.completions.create({
      model: process.env.BRADFORD_WHITE_PARSER_MODEL || process.env.INVOICE_PARSER_MODEL || "gpt-4o",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract this Bradford White registration as JSON." },
            { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        },
      ],
    });
  } catch (err) {
    const status = err.status || err.response?.status;
    const detail = err.error?.message || err.response?.data?.error?.message || err.message;
    throw new Error(`OpenAI parse failed (${status || "?"}): ${detail}`);
  } finally {
    if (imagePath !== filePath) { try { fs.unlinkSync(imagePath); } catch (_) {} }
  }

  const rawText = response.choices?.[0]?.message?.content || "{}";
  let parsed;
  try { parsed = JSON.parse(rawText); }
  catch (_) { throw new Error(`Parser returned non-JSON: ${rawText.slice(0, 200)}`); }

  const unit = normalizeUnit(unitFromParsed(parsed));
  return { units: unit.serialNumber || unit.model ? [unit] : [], parsed };
}

/** Shape the raw vision JSON into the common unit form (pre-normalize). */
function unitFromParsed(p = {}) {
  const coverages = [];
  if (p.tankWarrantyExpires || p.tankWarrantyYears != null) {
    coverages.push({ name: "Tank", endDate: p.tankWarrantyExpires || null, years: p.tankWarrantyYears });
  }
  if (p.partsWarrantyExpires || p.partsWarrantyYears != null) {
    coverages.push({ name: "Parts", endDate: p.partsWarrantyExpires || null, years: p.partsWarrantyYears });
  }
  return {
    equipmentName: "Water Heater",
    model: p.model || "",
    serialNumber: p.serial || "",
    waterHeaterType: p.type || "",
    coverages,
    manufactureDate: p.mfgDate || p.originalMfgDate || null,
    registrationStatus: p.registrationStatus || null,
    registrationDate: p.registrationDate || null,
  };
}

// ── headline / memo / normalize ───────────────────────────────────────────────

/** Bradford White headline coverage = Tank (primary), else the longest. */
function pickHeadlineCoverage(coverages = []) {
  if (!coverages.length) return null;
  const tank = coverages.find((c) => /tank/i.test(c.name || ""));
  if (tank) return tank;
  return coverages.slice().sort((a, b) => (b.years || 0) - (a.years || 0))[0];
}

/** ISO date -> "November 25, 2025". */
function prettyDate(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

function buildUnitMemo(unit) {
  const parts = [];
  const t = unit.waterHeaterType ? ` (${unit.waterHeaterType})` : "";
  parts.push(`Bradford White water heater${t}.`);
  for (const c of unit.coverages || []) {
    const end = c.endDateUS || asw.isoToUS(c.endDate) || c.endDate || "?";
    const yrs = c.years ? `${c.years} yr ` : "";
    parts.push(`${c.name}: ${yrs}through ${end}.`);
  }
  if (unit.manufacture && unit.manufacture.label) parts.push(`Manufactured ${unit.manufacture.label}.`);
  if (unit.registrationDate) parts.push(`Registered ${asw.isoToUS(unit.registrationDate) || unit.registrationDate}.`);
  return parts.join(" ");
}

/**
 * Normalize a Bradford White unit (from the parser OR the manual/edited UI).
 */
function normalizeUnit(u = {}) {
  const coverages = (u.coverages || [])
    .map((c) => {
      const endDate = c.endDate && /^\d{4}-\d{2}-\d{2}$/.test(c.endDate) ? c.endDate : asw.usToISO(c.endDate || c.endDateUS);
      let years = c.years != null && c.years !== "" ? Number(c.years) : null;
      if (years != null && Number.isNaN(years)) years = null;
      return { name: String(c.name || "Tank").trim(), endDate, endDateUS: endDate ? asw.isoToUS(endDate) : (c.endDateUS || null), years };
    })
    .filter((c) => c.endDate);

  const installedOn = u.installedOn && /^\d{4}-\d{2}-\d{2}$/.test(u.installedOn) ? u.installedOn : null;
  for (const c of coverages) {
    if (c.years == null && installedOn && c.endDate) c.years = asw.diffYears(installedOn, c.endDate);
  }

  const unit = {
    equipmentName: String(u.equipmentName || "Water Heater").trim() || "Water Heater",
    model: String(u.model || "").trim(),
    serialNumber: String(u.serialNumber || "").trim(),
    waterHeaterType: String(u.waterHeaterType || "").trim(),
    coverages,
    registrationStatus: u.registrationStatus || null,
    registrationDate: u.registrationDate && /^\d{4}-\d{2}-\d{2}$/.test(u.registrationDate) ? u.registrationDate : null,
  };

  const head = pickHeadlineCoverage(coverages);
  unit.installedOn = installedOn || (head ? asw.subtractYears(head.endDate, head.years) : null);
  unit.warrantyStart = unit.installedOn;
  unit.warrantyEnd = head ? head.endDate : null;
  unit.warrantyEndUS = head ? head.endDateUS : null;
  unit.headlineCoverage = head ? head.name : null;

  // Manufacture date comes printed on the page (no serial decode).
  const mfgISO = u.manufactureDate && /^\d{4}-\d{2}-\d{2}$/.test(u.manufactureDate)
    ? u.manufactureDate
    : (u.manufacture && u.manufacture.date) || null;
  unit.manufacture = mfgISO ? { date: mfgISO, label: prettyDate(mfgISO) } : (u.manufacture || null);

  unit.memo = buildUnitMemo(unit);
  unit.__normalized = true;
  return unit;
}

/**
 * Build the ServiceTitan Installed Equipment POST body for one water heater.
 * Tank term = manufacturerWarrantyEnd; all coverages in the memo.
 */
function buildStPayloadForUnit({ locationId, unit }) {
  const u = unit && unit.__normalized ? unit : normalizeUnit(unit || {});
  return {
    locationId: Number(locationId),
    name: u.equipmentName || "Water Heater",
    manufacturer: "Bradford White",
    model: u.model || null,
    serialNumber: u.serialNumber || null,
    installedOn: asw.toStDateTime(u.installedOn),
    // ST "manufacturedOn" is a plain date (YYYY-MM-DD), not a datetime.
    manufacturedOn: u.manufacture ? u.manufacture.date : null,
    manufacturerWarrantyStart: asw.toStDateTime(u.warrantyStart),
    manufacturerWarrantyEnd: asw.toStDateTime(u.warrantyEnd),
    memo: u.memo,
  };
}

module.exports = {
  parseWarrantyImage,
  unitFromParsed,
  normalizeUnit,
  buildStPayloadForUnit,
  buildUnitMemo,
  pickHeadlineCoverage,
  prettyDate,
  ensureImage,
};
