/**
 * src/config/equipmentTypes.js
 *
 * Config-driven registry of equipment types for the Equipment page. Each entry
 * fully describes one tab: its form fields, warranty rule, how to build the
 * ServiceTitan Installed Equipment payload, and (optionally) how to build a
 * manufacturer-registration CSV row.
 *
 * Adding a new equipment type later (furnace, AC, backflow…) = add another
 * object here. No route/UI rewrite required — the page renders from `fields`
 * and the service reads `computeWarranty` / `buildStPayload` / `proPortal`.
 *
 * CURRENT SCOPE: Rinnai Sensei tankless, residential installs only.
 */

// ── date helpers ──────────────────────────────────────────────────────────────
function addYears(iso, years) {
  // iso: "YYYY-MM-DD". Returns "YYYY-MM-DD" `years` later (calendar-accurate).
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}
// ServiceTitan date fields want full ISO-8601 datetimes.
function toStDateTime(isoDate) {
  return isoDate ? `${isoDate}T00:00:00Z` : null;
}

// ── Rinnai ProPortal allowed dropdown values (from RinnaiBulkUpload.xlsx) ──────
const RINNAI_APPLICATION_TYPES_RESIDENTIAL = [
  "Residential Hot Water Only",
  "Residential Hot Water / Home Heating",
  "Residential Home Heating Only",
];
const RINNAI_RECIRCULATION_TYPES = [
  "No Recirculation System",
  "Recirculation System with Motion Sensor Or Activation Switch (On Demand)",
  "Recirculation System with Aquastat/Thermostat (Timer or Other Activation Device)",
  "Recirculation System with No Activation Device (Continuously Running Pump)",
  "I Don't Know",
];
const RINNAI_FUEL_TYPES = ["Natural Gas", "Propane", "Electric"];
const RINNAI_REGISTRATION_TYPES = ["Residential", "Commercial"];

// Common Sensei model numbers — datalist suggestions only; free text is allowed
// so a new/uncommon model can still be entered.
const SENSEI_MODELS = [
  "RU130iN", "RU160iN", "RU180iN", "RU199iN",
  "RU160eN", "RU180eN", "RU199eN",
  "RU160iP", "RU199iP", "RU199eP",
  "RUR160iN", "RUR199iN", "RUR199iP",
  "RSC160iN", "RSC199iN",
  "RX160iN", "RX199iN", "RX199eN",
];

const rinnaiSenseiTankless = {
  id: "rinnai-sensei-tankless",
  label: "Rinnai Tankless",
  tabTitle: "Rinnai Sensei Tankless",
  manufacturer: "Rinnai",
  active: true,
  serialDecoder: "rinnai",
  models: SENSEI_MODELS,

  // ── Form fields (drives dynamic rendering + server-side validation) ─────────
  // The customer/location picker is handled by the page shell, not listed here.
  fields: [
    { key: "model", label: "Model", type: "model", required: true,
      help: "Sensei model (pick or type)." },
    { key: "serialNumber", label: "Serial Number", type: "text", required: true,
      help: "Rinnai serial — the first two letters decode the manufacture date." },
    { key: "installedOn", label: "Installation Date", type: "date", required: true },
    { key: "applicationType", label: "Application Type", type: "select", required: true,
      options: RINNAI_APPLICATION_TYPES_RESIDENTIAL,
      default: "Residential Hot Water Only" },
    { key: "recirculationType", label: "Recirculation", type: "select", required: true,
      options: RINNAI_RECIRCULATION_TYPES, default: "No Recirculation System" },
    { key: "fuelType", label: "Fuel Type", type: "select", required: true,
      options: RINNAI_FUEL_TYPES, default: "Natural Gas" },
    { key: "registrationType", label: "Registration Type", type: "select", required: true,
      options: RINNAI_REGISTRATION_TYPES, default: "Residential" },
  ],

  /**
   * Warranty rule — Rinnai Sensei, residential.
   *   Heat exchanger: 15 years
   *   Parts:          5 years
   *   Labor:          1 year → 5 years when registered within 90 days of install
   * The ST manufacturer-warranty DATE reflects the 15-year heat-exchanger term
   * (the headline coverage most relevant at service time); parts/labor are noted
   * in the memo.
   */
  computeWarranty(installDateISO /*, formData */) {
    const heatExchangerYears = 15;
    const partsYears = 5;
    const laborYearsRegistered = 5;
    const start = installDateISO;
    const end = addYears(installDateISO, heatExchangerYears);
    return {
      heatExchangerYears,
      partsYears,
      laborYearsRegistered,
      manufacturerWarrantyStart: start,
      manufacturerWarrantyEnd: end, // heat exchanger, 15 yr
      memo:
        `Warranty (Rinnai Sensei, residential): Heat exchanger ${heatExchangerYears} yr ` +
        `(through ${end}); Parts ${partsYears} yr (through ${addYears(installDateISO, partsYears)}); ` +
        `Labor 1 yr → ${laborYearsRegistered} yr with ProPortal registration within 90 days of install.`,
    };
  },

  /**
   * Build the ServiceTitan Installed Equipment POST body.
   * @param {{ locationId:number, formData:object, decoded:object, warranty:object }} ctx
   */
  buildStPayload({ locationId, formData, decoded, warranty }) {
    return {
      locationId: Number(locationId),
      name: "Rinnai Tankless Water Heater",
      manufacturer: "Rinnai",
      model: formData.model || null,
      serialNumber: formData.serialNumber || null,
      installedOn: toStDateTime(formData.installedOn),
      // ST "manufacturedOn" is a plain date (YYYY-MM-DD) — from the serial decode.
      manufacturedOn: decoded && decoded.ok ? decoded.manufactureDate : null,
      manufacturerWarrantyStart: toStDateTime(warranty.manufacturerWarrantyStart),
      manufacturerWarrantyEnd: toStDateTime(warranty.manufacturerWarrantyEnd),
      memo: warranty.memo,
    };
  },

  /**
   * Rinnai ProPortal bulk-upload CSV mapping. Column order matches the
   * "Template" sheet of RinnaiBulkUpload.xlsx exactly so ProPortal accepts it.
   * Most columns are sourced from the ST contact/location; only serial, dates,
   * and the four dropdowns come from the form.
   */
  proPortal: {
    columns: [
      "First Name", "Last Name", "Email", "Company Name", "Phone",
      "Unit Address (Street)", "Unit Address (City)",
      "Unit Address (State/Province)", "Unit Address (ZIP/Postal Code)",
      "Unit Address (Country/Territory)", "Serial Number", "Application Type",
      "Recirculation Type", "Registration Type", "Fuel Type",
      "Registration Date", "Installation Date",
    ],
    /**
     * @param {{ contact:object, location:object, formData:object, registrationDate:string }} ctx
     * contact: { firstName, lastName, email, phone, companyName }
     * location: { street, city, state, zip, country }
     */
    buildRow({ contact = {}, location = {}, formData = {}, registrationDate }) {
      return {
        "First Name": contact.firstName || "",
        "Last Name": contact.lastName || "",
        "Email": contact.email || "",
        "Company Name": contact.companyName || "",
        "Phone": contact.phone || "",
        "Unit Address (Street)": location.street || "",
        "Unit Address (City)": location.city || "",
        "Unit Address (State/Province)": location.state || "",
        "Unit Address (ZIP/Postal Code)": location.zip || "",
        "Unit Address (Country/Territory)": location.country || "US",
        "Serial Number": formData.serialNumber || "",
        "Application Type": formData.applicationType || "",
        "Recirculation Type": formData.recirculationType || "",
        "Registration Type": formData.registrationType || "Residential",
        "Fuel Type": formData.fuelType || "",
        "Registration Date": registrationDate || "",
        "Installation Date": formData.installedOn || "",
      };
    },
  },
};

// ── American Standard / Ameristar HVAC (PDF-driven, whole-system) ─────────────
// The office registers on the American Standard site, then uploads the printable
// "Limited Warranty" confirmation PDF here. One PDF can describe a whole system
// (AC + Coil + Furnace) OR a single piece — the tab handles 1..N units.
// There is NO manufacturer CSV/upload afterward; the PDF IS the registration, so
// we only write Installed Equipment to ServiceTitan. Per the owner's decision, the
// Functional Parts term-end is the ST warranty date; every coverage (incl. Heat
// Exchanger) is spelled out in the memo. Parsing + ST payloads live in
// services/americanStandardWarranty.js; this object registers the tab and drives
// the PDF-upload UI + the manual-add fallback.
const AS_EQUIPMENT_NAMES = [
  "Air Conditioner", "Coil", "Furnace", "Heat Pump", "Air Handler",
  "Package Unit", "Evaporator Coil", "Fan Coil", "Thermostat", "Other",
];

const americanStandardHvac = {
  id: "american-standard-hvac",
  label: "American Standard",
  tabTitle: "American Standard HVAC",
  manufacturer: "American Standard",
  active: true,

  // UI modality: upload + parse a warranty PDF into a multi-unit batch, rather
  // than the single-unit form the other tabs use.
  inputMode: "pdf",
  allowManual: true,          // also allow typing a unit by hand (no-PDF case)
  serialDecoder: null,        // American Standard serials are not date-decoded
  proPortal: null,            // no bulk-registration CSV — PDF is the registration
  headlineCoverage: "Functional Parts",
  equipmentNameOptions: AS_EQUIPMENT_NAMES,

  // ── Shared upload-flow config (read by the config-driven UI) ────────────────
  apiBase: "american-standard",          // /api/equipment/american-standard/*
  uploadAccept: "application/pdf",       // file input accept
  serialFormat: "trane",                 // client live-decodes manufacture date
  uploadTitle: "Import the warranty",
  uploadHint: 'Upload the American Standard "Limited Warranty" PDF (the printable confirmation). It reads every unit — a full system or a single piece. You can do this before or after picking the customer. No PDF? Add a unit by hand.',
  parseLabel: "Parse PDF",
  registrationUrl: "https://www.americanstandardair.com/resources/warranty-and-registration/register/",
  registrationLabel: "Register on the American Standard site →",
  // Per-unit coverage date inputs shown in the editor (name + label + matcher).
  coverageFields: [
    { name: "Functional Parts", label: "Functional Parts End", match: "functional\\s*parts", help: "Goes in the ST warranty field." },
    { name: "Heat Exchanger", label: "Heat Exchanger End", match: "heat\\s*exchanger", help: "Furnaces only — noted in the memo." },
  ],
  extraUnitFields: [],

  // Fields for the manual add-a-unit editor (PDF-parsed units reuse the same
  // shape; the server normalizes either into coverages + derived install date).
  unitFields: [
    { key: "equipmentName", label: "Equipment", type: "select", required: true,
      options: AS_EQUIPMENT_NAMES, default: "Air Conditioner" },
    { key: "model", label: "Model #", type: "text", required: true },
    { key: "serialNumber", label: "Serial #", type: "text", required: true },
    { key: "installedOn", label: "Install Date", type: "date", required: false,
      help: "If blank, derived from the warranty end date." },
    { key: "functionalPartsEnd", label: "Functional Parts End", type: "date", required: false,
      help: "This date goes in the ServiceTitan warranty field." },
    { key: "heatExchangerEnd", label: "Heat Exchanger End", type: "date", required: false,
      help: "Furnaces only — recorded in the memo." },
  ],

  // The generic single-unit form is unused for this type (UI reads inputMode).
  fields: [],
};

// ── Bradford White water heaters (image/OCR-driven, single unit) ─────────────
// The office registers on Bradford White's site, then uploads a SCREENSHOT of
// the registration/warranty page here. It's OCR'd via OpenAI Vision (same engine
// as the invoice parser) into one water-heater unit. Manufacture date is printed
// (no serial decode). ST warranty date = the Tank term; Tank + Parts in the memo.
// Parsing + ST payloads live in services/bradfordWhiteWarranty.js.
const BW_EQUIPMENT_NAMES = [
  "Water Heater", "Tankless Water Heater", "Power Vent Water Heater",
  "Electric Water Heater", "Other",
];

const bradfordWhiteWaterHeater = {
  id: "bradford-white-water-heater",
  label: "Bradford White",
  tabTitle: "Bradford White Water Heater",
  manufacturer: "Bradford White",
  active: true,

  inputMode: "image",          // upload + OCR a registration screenshot
  allowManual: true,
  serialDecoder: null,
  serialFormat: null,          // manufacture date is printed, not decoded
  proPortal: null,
  headlineCoverage: "Tank",
  equipmentNameOptions: BW_EQUIPMENT_NAMES,

  apiBase: "bradford-white",   // /api/equipment/bradford-white/*
  uploadAccept: "image/*,application/pdf",
  uploadTitle: "Import the registration",
  uploadHint: "Upload a screenshot (PNG/JPG) — or PDF — of the Bradford White registration/warranty page. It reads the serial, model, type, manufacture date, and Tank/Parts warranty. No screenshot? Add a unit by hand.",
  parseLabel: "Read screenshot",
  registrationUrl: "https://warranty.bradfordwhite.com/",
  registrationLabel: "Register on the Bradford White site →",
  coverageFields: [
    { name: "Tank", label: "Tank Warranty End", match: "tank", help: "Primary — goes in the ST warranty field." },
    { name: "Parts", label: "Parts Warranty End", match: "parts", help: "Noted in the memo." },
  ],
  extraUnitFields: [
    { key: "waterHeaterType", label: "Type (e.g. RES GAS)" },
  ],

  fields: [],
};

// Registry keyed by id. Order here = tab order on the page (first = default tab).
// American Standard is the most common install, so it leads; Bradford White next.
const EQUIPMENT_TYPES = [americanStandardHvac, bradfordWhiteWaterHeater, rinnaiSenseiTankless];

function listEquipmentTypes() {
  return EQUIPMENT_TYPES.filter((t) => t.active);
}
function getEquipmentType(id) {
  return EQUIPMENT_TYPES.find((t) => t.id === id) || null;
}

// A JSON-safe view of a type for the browser (functions stripped).
function publicView(t) {
  return {
    id: t.id,
    label: t.label,
    tabTitle: t.tabTitle,
    manufacturer: t.manufacturer,
    models: t.models || [],
    fields: t.fields || [],
    hasProPortal: !!t.proPortal,
    inputMode: t.inputMode || "form",
    allowManual: !!t.allowManual,
    unitFields: t.unitFields || [],
    equipmentNameOptions: t.equipmentNameOptions || [],
    headlineCoverage: t.headlineCoverage || null,
    apiBase: t.apiBase || null,
    uploadAccept: t.uploadAccept || "application/pdf",
    serialFormat: t.serialFormat || null,
    uploadTitle: t.uploadTitle || "Import the warranty",
    uploadHint: t.uploadHint || "",
    parseLabel: t.parseLabel || "Parse file",
    registrationUrl: t.registrationUrl || null,
    registrationLabel: t.registrationLabel || "Register on the manufacturer site →",
    coverageFields: t.coverageFields || [],
    extraUnitFields: t.extraUnitFields || [],
  };
}

module.exports = {
  EQUIPMENT_TYPES,
  listEquipmentTypes,
  getEquipmentType,
  publicView,
  addYears,
  toStDateTime,
};
