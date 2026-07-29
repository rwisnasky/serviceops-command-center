/**
 * src/services/americanStandardWarranty.js
 *
 * Parse an American Standard / Ameristar "Limited Warranty" registration PDF
 * (the printable confirmation shown after registering on the American Standard
 * site) into structured, ServiceTitan-ready equipment records.
 *
 * A single PDF describes a whole SYSTEM — e.g. Air Conditioner + Coil + Furnace —
 * each with its own model, serial, and one or more coverage terms:
 *
 *   AIR CONDITIONER (Model# A5AC3036B1000AA) (Serial# 26175T95FF) (Residential Extended)
 *   Functional Parts : Term End Date is 05/01/2036 (10 Years )
 *   FURNACE (Model# A951X060BU4SACA) (Serial# 26101X8GJG) (Residential Extended)
 *   Heat Exchanger : Term End Date is 05/01/2046 (20 Years )
 *   Functional Parts : Term End Date is 05/01/2036 (10 Years )
 *
 * DESIGN NOTES
 * ────────────
 * 1. pdf-parse's DEFAULT text extraction returns items in PDF-object order, which
 *    for these warranty PDFs is jumbled (labels detach from values, a coverage
 *    line can be flung to the end). We supply a custom pagerender that rebuilds
 *    reading order from each text item's x/y position — the result matches the
 *    on-screen layout, so a simple sequential parse (each coverage line belongs
 *    to the most recent unit header above it) is reliable.
 * 2. The PDF never states an install date. We derive it from a coverage term:
 *    install = (term end date) − (term years). All coverages agree in practice.
 * 3. ServiceTitan's Installed Equipment record has a SINGLE warranty-end field.
 *    Per the owner's decision, the FUNCTIONAL PARTS term-end is the headline warranty
 *    end; every coverage (incl. Heat Exchanger) is spelled out in the memo.
 * 4. There is NO manufacturer upload/CSV step — the PDF *is* the registration
 *    confirmation. We only write to ServiceTitan.
 */

// ── date helpers ──────────────────────────────────────────────────────────────

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "05/01/2036" (US M/D/Y) → "2036-05-01" (ISO). Returns null on bad input. */
function usToISO(us) {
  const m = String(us || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/** "2036-05-01" → "05/01/2036". Returns null on bad input. */
function isoToUS(iso) {
  const m = String(iso || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, yyyy, mm, dd] = m;
  return `${mm}/${dd}/${yyyy}`;
}

/** ISO date − N calendar years → ISO date. Used to derive the install date. */
function subtractYears(iso, years) {
  if (!iso || years == null || Number.isNaN(Number(years))) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCFullYear(d.getUTCFullYear() - Number(years));
  return d.toISOString().slice(0, 10);
}

/** ISO date + N calendar years → ISO date. Used for the Grounded labor warranty end. */
function addYearsISO(iso, years) {
  if (!iso || years == null || Number.isNaN(Number(years))) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCFullYear(d.getUTCFullYear() + Number(years));
  return d.toISOString().slice(0, 10);
}

/** Whole-year span between two ISO dates (end − start), rounded to nearest year. */
function diffYears(startISO, endISO) {
  const s = new Date(`${startISO}T00:00:00Z`);
  const e = new Date(`${endISO}T00:00:00Z`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
  const years = (e.getTime() - s.getTime()) / (365.25 * 24 * 3600 * 1000);
  const rounded = Math.round(years);
  return rounded > 0 ? rounded : null;
}

/** ServiceTitan date fields want a full ISO-8601 datetime. */
function toStDateTime(isoDate) {
  return isoDate ? `${isoDate}T00:00:00Z` : null;
}

/**
 * Decode the manufacture date from an American Standard / Trane serial number.
 *
 * Modern (2010+) Trane/American Standard format:
 *   positions 1-2 = year (2 digits, e.g. "26" = 2026)
 *   positions 3-4 = week of the year (01-53)
 *   e.g. "26175T95FF" → 2026, week 17.
 *
 * Returns an approximate ISO date (the given week of that year) plus a
 * human label. Date-only; the serial does not encode the model.
 */
function decodeAmericanStandardSerial(serial) {
  const raw = String(serial == null ? "" : serial);
  const cleaned = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (cleaned.length < 4 || !/^\d{4}/.test(cleaned)) {
    return { ok: false, raw, cleaned, error: "Serial doesn't start with 4 digits — can't decode a date." };
  }
  const year = 2000 + Number(cleaned.slice(0, 2));
  const week = Number(cleaned.slice(2, 4));
  if (week < 1 || week > 53) {
    return { ok: false, raw, cleaned, manufactureYear: year, manufactureWeek: week,
      error: `Unusual week code "${cleaned.slice(2, 4)}" — double-check the serial.` };
  }
  // Approximate a date inside that week: Jan 1 + (week-1)*7 days.
  const approx = new Date(Date.UTC(year, 0, 1) + (week - 1) * 7 * 86400000);
  const iso = approx.toISOString().slice(0, 10);
  const monthName = MONTHS[approx.getUTCMonth()];
  return {
    ok: true, raw, cleaned,
    manufactureYear: year,
    manufactureWeek: week,
    manufactureDate: iso,
    manufactureMonthName: monthName,
    label: `Week ${week}, ${year} (~${monthName} ${year})`,
  };
}

/** "AIR CONDITIONER" → "Air Conditioner"; leaves mixed/short tokens sensible. */
function titleCase(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

// Equipment types American Standard registers (also the manual-add dropdown).
const EQUIPMENT_NAME_OPTIONS = [
  "Air Conditioner", "Coil", "Furnace", "Heat Pump", "Air Handler",
  "Package Unit", "Evaporator Coil", "Fan Coil", "Thermostat", "Other",
];

// ── layout-preserving PDF text extraction ─────────────────────────────────────

/**
 * pdf-parse pagerender that reconstructs reading order from text-item positions.
 * Groups items into rows by Y (within a small tolerance), orders rows top→bottom
 * and items left→right. Returns plain text with one logical line per row.
 */
function layoutPageRender(pageData) {
  return pageData
    .getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false })
    .then((tc) => {
      const items = (tc.items || []).filter((i) => i.str && i.str.trim() !== "");
      const rows = [];
      const Y_TOL = 3; // points
      for (const it of items) {
        const x = it.transform[4];
        const y = it.transform[5];
        let row = rows.find((r) => Math.abs(r.y - y) <= Y_TOL);
        if (!row) { row = { y, cells: [] }; rows.push(row); }
        row.cells.push({ x, str: it.str });
      }
      rows.sort((a, b) => b.y - a.y);
      return rows
        .map((r) =>
          r.cells
            .sort((a, b) => a.x - b.x)
            .map((c) => c.str)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()
        )
        .join("\n");
    });
}

/**
 * Read a warranty PDF buffer → { warrantyNumber, customer, dealer, units }.
 * Units are normalized (coverages, derived install date, headline warranty, memo).
 */
async function extractWarrantyPdf(buffer) {
  // Lazy require so unit tests of parseWarrantyText don't need pdf-parse.
  const pdf = require("pdf-parse");
  const data = await pdf(buffer, { pagerender: layoutPageRender });
  return parseWarrantyText(data.text || "");
}

// ── contact-block parsing ─────────────────────────────────────────────────────

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_RE = /\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}/;
// A line that ends one contact block / starts the next section.
const BLOCK_STOP_RE = /(Installation Information:|Dealer Information:|Main system|^System\b|\(Model#)/i;

/**
 * Pull the name / address / phone / email that follow a labelled block such as
 * "Installation Information:" or "Dealer Information:".
 */
function parseInfoBlock(lines, label) {
  const start = lines.findIndex((l) => l.toLowerCase() === label.toLowerCase());
  if (start < 0) return null;

  const block = [];
  for (let j = start + 1; j < lines.length; j++) {
    const l = lines[j];
    if (!l) { if (block.length) break; else continue; }
    if (BLOCK_STOP_RE.test(l)) break;
    block.push(l);
  }
  if (!block.length) return null;

  const name = block[0];
  let email = null;
  let phone = null;
  const addressLines = [];
  for (const l of block.slice(1)) {
    const em = l.match(EMAIL_RE);
    if (em && !email) { email = em[0]; continue; }
    if (PHONE_RE.test(l) && !phone) { phone = l.trim(); continue; }
    addressLines.push(l);
  }
  return { name, addressLines, address: addressLines.join(", "), phone, email };
}

// ── unit + coverage parsing ───────────────────────────────────────────────────

// "AIR CONDITIONER (Model# X) (Serial# Y) (Residential Extended)"
const UNIT_HEADER_RE =
  /^(.*?)\(Model#\s*([^)]+?)\)\s*\(Serial#\s*([^)]+?)\)\s*(?:\(([^)]*)\))?\s*$/i;
// "Functional Parts : Term End Date is 05/01/2036 (10 Years )"
const COVERAGE_RE =
  /^(.+?)\s*:\s*Term End Date is\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*\(\s*(\d+)\s*Years?\s*\)/i;

/** Prefer the Functional Parts coverage (the owner's headline choice); else longest. */
function pickHeadlineCoverage(coverages = []) {
  if (!coverages.length) return null;
  const fp = coverages.find((c) => /functional\s*parts/i.test(c.name || ""));
  if (fp) return fp;
  return coverages.slice().sort((a, b) => (b.years || 0) - (a.years || 0))[0];
}

/** Build the ServiceTitan memo listing every coverage for a unit. */
function buildUnitMemo(unit) {
  const parts = [];
  const wn = unit.warrantyNumber ? ` #${unit.warrantyNumber}` : "";
  const tier = unit.tier ? ` (${unit.tier})` : "";
  parts.push(`American Standard Limited Warranty${wn}${tier}.`);
  for (const c of unit.coverages || []) {
    const end = c.endDateUS || isoToUS(c.endDate) || c.endDate || "?";
    const yrs = c.years ? `${c.years} yr ` : "";
    parts.push(`${c.name}: ${yrs}through ${end}.`);
  }
  if (unit.manufacture && unit.manufacture.label) {
    parts.push(`Manufactured ${unit.manufacture.label}.`);
  }
  return parts.join(" ");
}

/**
 * Normalize a unit (from the parser OR edited/added in the UI) into a consistent
 * shape: cleaned coverages, derived install date, headline warranty end, memo.
 */
function normalizeUnit(u = {}, warrantyNumber = null) {
  const coverages = (u.coverages || [])
    .map((c) => {
      const endDate =
        c.endDate && /^\d{4}-\d{2}-\d{2}$/.test(c.endDate)
          ? c.endDate
          : usToISO(c.endDate || c.endDateUS);
      let years = c.years != null && c.years !== "" ? Number(c.years) : null;
      if (years != null && Number.isNaN(years)) years = null;
      return {
        name: String(c.name || "Functional Parts").trim(),
        endDate,
        endDateUS: endDate ? isoToUS(endDate) : (c.endDateUS || null),
        years,
      };
    })
    .filter((c) => c.endDate);

  const installedOn =
    u.installedOn && /^\d{4}-\d{2}-\d{2}$/.test(u.installedOn) ? u.installedOn : null;

  // Fill missing coverage year spans from the install date when we have it.
  for (const c of coverages) {
    if (c.years == null && installedOn && c.endDate) c.years = diffYears(installedOn, c.endDate);
  }

  const unit = {
    equipmentName: String(u.equipmentName || u.rawEquipmentName || "Unit").trim() || "Unit",
    model: String(u.model || "").trim(),
    serialNumber: String(u.serialNumber || "").trim(),
    tier: u.tier || null,
    coverages,
    warrantyNumber: u.warrantyNumber || warrantyNumber || null,
  };

  const head = pickHeadlineCoverage(coverages);
  unit.installedOn =
    installedOn || (head ? subtractYears(head.endDate, head.years) : null);
  unit.warrantyStart = unit.installedOn;
  unit.warrantyEnd = head ? head.endDate : null;
  unit.warrantyEndUS = head ? head.endDateUS : null;
  unit.headlineCoverage = head ? head.name : null;

  // Manufacture date decoded from the serial (year + week).
  const dec = decodeAmericanStandardSerial(unit.serialNumber);
  unit.manufacture = dec.ok
    ? { date: dec.manufactureDate, label: dec.label, year: dec.manufactureYear, week: dec.manufactureWeek }
    : null;

  unit.memo = buildUnitMemo(unit);
  unit.__normalized = true;
  return unit;
}

/** Parse the "Main system" body into normalized units. */
function parseUnits(lines, warrantyNumber) {
  const units = [];
  let cur = null;
  let currentSystem = null;

  for (const line of lines) {
    if (/^(Main system|System\b.*)$/i.test(line) && !UNIT_HEADER_RE.test(line)) {
      currentSystem = line.trim();
      continue;
    }
    const h = line.match(UNIT_HEADER_RE);
    if (h) {
      if (cur) units.push(cur);
      const rawName = (h[1] || "").replace(/[\s\-–]+$/, "").trim();
      cur = {
        system: currentSystem,
        equipmentName: rawName ? titleCase(rawName) : "Unit",
        rawEquipmentName: rawName,
        model: (h[2] || "").trim(),
        serialNumber: (h[3] || "").trim(),
        tier: (h[4] || "").trim() || null,
        coverages: [],
      };
      continue;
    }
    const c = line.match(COVERAGE_RE);
    if (c && cur) {
      const endDate = usToISO(c[2]);
      cur.coverages.push({
        name: c[1].trim(),
        endDate,
        endDateUS: c[2],
        years: Number(c[3]),
      });
    }
  }
  if (cur) units.push(cur);

  return units.map((u) => {
    const norm = normalizeUnit(u, warrantyNumber);
    norm.system = u.system || null;
    return norm;
  });
}

/**
 * Parse the layout-reconstructed text of a warranty PDF.
 * @param {string} text
 * @returns {{ warrantyNumber:string|null, customer:object|null, dealer:object|null, units:object[] }}
 */
function parseWarrantyText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim());

  const wn = lines.join("\n").match(/Limited Warranty\s*#\s*([A-Za-z0-9-]+)/i);
  const warrantyNumber = wn ? wn[1] : null;

  const customer = parseInfoBlock(lines, "Installation Information:");
  const dealer = parseInfoBlock(lines, "Dealer Information:");
  const units = parseUnits(lines, warrantyNumber);

  return { warrantyNumber, customer, dealer, units };
}

// ── ServiceTitan payload ──────────────────────────────────────────────────────

/**
 * Build the ServiceTitan Installed Equipment POST body for ONE unit.
 * Functional Parts term-end is the headline (manufacturer) warranty end; all
 * coverages → memo. When laborWarrantyYears > 0 (our dealer labor warranty),
 * the service-provider warranty dates are set (install → install + N yr) and a
 * labor line is appended to the memo — belt-and-suspenders in case a tenant
 * doesn't surface the service-provider warranty field.
 * @param {{ locationId:number, unit:object, warrantyNumber?:string, laborWarrantyYears?:number }} ctx
 */
function buildStPayloadForUnit({ locationId, unit, warrantyNumber = null, laborWarrantyYears = 0 }) {
  const u = unit && unit.__normalized ? unit : normalizeUnit(unit || {}, warrantyNumber);
  const payload = {
    locationId: Number(locationId),
    name: u.equipmentName || "American Standard Unit",
    manufacturer: "American Standard",
    model: u.model || null,
    serialNumber: u.serialNumber || null,
    installedOn: toStDateTime(u.installedOn),
    // ST "manufacturedOn" is a plain date (YYYY-MM-DD), not a datetime.
    manufacturedOn: u.manufacture ? u.manufacture.date : null,
    manufacturerWarrantyStart: toStDateTime(u.warrantyStart),
    manufacturerWarrantyEnd: toStDateTime(u.warrantyEnd),
    memo: u.memo,
  };

  const yrs = Number(laborWarrantyYears) || 0;
  if (yrs > 0 && u.installedOn) {
    const laborEnd = addYearsISO(u.installedOn, yrs);
    payload.serviceProviderWarrantyStart = toStDateTime(u.installedOn);
    payload.serviceProviderWarrantyEnd = toStDateTime(laborEnd);
    payload.memo = `${u.memo} Grounded labor warranty: ${yrs} yr through ${isoToUS(laborEnd) || laborEnd}.`;
  }
  return payload;
}

module.exports = {
  extractWarrantyPdf,
  parseWarrantyText,
  parseInfoBlock,
  parseUnits,
  normalizeUnit,
  buildStPayloadForUnit,
  buildUnitMemo,
  decodeAmericanStandardSerial,
  pickHeadlineCoverage,
  layoutPageRender,
  // helpers (exported for tests / config reuse)
  usToISO,
  isoToUS,
  subtractYears,
  addYearsISO,
  diffYears,
  toStDateTime,
  titleCase,
  EQUIPMENT_NAME_OPTIONS,
};
