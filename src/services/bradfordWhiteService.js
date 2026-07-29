/**
 * src/services/bradfordWhiteService.js
 *
 * Orchestrates the Bradford White tab on the Equipment page:
 *   1. OCR/parse an uploaded registration SCREENSHOT (image or PDF) → one unit
 *   2. build a preview (ST payload + duplicate warnings)
 *   3. submit: write the Installed Equipment record to ServiceTitan + persist.
 *
 * Bradford White is a single water heater per screenshot (no whole-system labor
 * warranty / membership extras — those are HVAC-system only). Mirrors the
 * American Standard service otherwise.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const st = require("../api/servicetitan");
const repo = require("../db/installedEquipmentRepository");
const bww = require("./bradfordWhiteWarranty");

const TYPE_ID = "bradford-white-water-heater";

/**
 * Parse an uploaded screenshot buffer. Writes it to a temp file (the vision
 * parser + pdftoppm work on paths), parses, then cleans up.
 * @param {Buffer} buffer
 * @param {string} originalName  used only to preserve the file extension
 */
async function parseUploadedImage(buffer, originalName = "upload.png") {
  if (!buffer || !buffer.length) throw new Error("Empty upload.");
  let ext = (path.extname(originalName || "") || ".png").toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf"].includes(ext)) ext = ".png";
  const tmp = path.join(os.tmpdir(), `bw-${process.pid}-${Date.now()}${ext}`);
  fs.writeFileSync(tmp, buffer);
  try {
    const out = await bww.parseWarrantyImage(tmp);
    return { units: out.units || [], parsed: out.parsed || null };
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

/**
 * @param {{ locationId:number, units:object[] }} args
 * @returns {Promise<Array<{unit:object, stPayload:object, warnings:string[]}>>}
 */
async function buildBatchPreview({ locationId, units }) {
  if (!locationId) throw new Error("locationId required");
  const list = Array.isArray(units) ? units : [];
  const normalized = list.map((u) => bww.normalizeUnit(u));

  let existingSerials = new Set();
  try {
    const existing = await st.getInstalledEquipmentByLocation(locationId);
    existingSerials = new Set((existing || []).map((e) => String(e.serialNumber || "").trim().toUpperCase()).filter(Boolean));
  } catch (_) { /* non-fatal */ }

  return normalized.map((u) => {
    const stPayload = bww.buildStPayloadForUnit({ locationId, unit: u });
    const serial = String(u.serialNumber || "").trim().toUpperCase();
    const warnings = [];
    if (!u.model) warnings.push("Missing model number.");
    if (!u.serialNumber) warnings.push("Missing serial number.");
    if (!u.warrantyEnd) warnings.push("No warranty end date — the ST warranty field will be blank.");
    if (!u.installedOn) warnings.push("No install date — set one so the warranty start is recorded.");
    if (serial && existingSerials.has(serial)) warnings.push("A unit with this serial already exists on this ServiceTitan location.");
    if (u.serialNumber) {
      const localDupes = repo.findBySerial(u.serialNumber);
      if (localDupes.length) warnings.push(`This serial was already entered here ${localDupes.length} time(s).`);
    }
    return { unit: u, stPayload, warnings };
  });
}

/**
 * @param {{ customerId, locationId, customerName, locationAddress, units, createdBy }} args
 */
async function submitBatch({ customerId, locationId, customerName, locationAddress, units, createdBy }) {
  if (!locationId) throw new Error("locationId required");
  const preview = await buildBatchPreview({ locationId, units });
  if (!preview.length) return { ok: false, created: 0, failed: 0, results: [], error: "No units to register." };

  const results = [];
  for (const { unit, stPayload } of preview) {
    let stId = null;
    let status = "created";
    let error = null;
    try {
      const created = await st.createInstalledEquipment(stPayload);
      stId = created?.id ?? null;
    } catch (err) {
      status = "failed";
      error = err.message;
    }

    const { id } = repo.recordRegistration({
      equipment_type_id: TYPE_ID,
      st_installed_equipment_id: stId,
      st_customer_id: customerId ? Number(customerId) : null,
      st_customer_name: customerName || null,
      st_location_id: Number(locationId),
      location_address: locationAddress || null,
      model: unit.model || null,
      serial_number: unit.serialNumber || null,
      installed_on: unit.installedOn || null,
      manufacture_date: unit.manufacture ? unit.manufacture.date : null,
      warranty_start: unit.warrantyStart || null,
      warranty_end: unit.warrantyEnd || null,
      form_data: unit,
      proportal_row: null,
      st_write_status: status,
      st_error: error,
      created_by: createdBy || null,
    });

    results.push({
      id,
      equipmentName: unit.equipmentName,
      model: unit.model,
      serialNumber: unit.serialNumber,
      warrantyEnd: unit.warrantyEnd,
      stInstalledEquipmentId: stId,
      stWriteStatus: status,
      stError: error,
    });
  }

  const created = results.filter((r) => r.stWriteStatus === "created").length;
  const failed = results.length - created;
  return { ok: failed === 0, created, failed, results };
}

module.exports = { TYPE_ID, parseUploadedImage, buildBatchPreview, submitBatch };
