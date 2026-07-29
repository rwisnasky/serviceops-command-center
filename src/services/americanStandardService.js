/**
 * src/services/americanStandardService.js
 *
 * Orchestrates the American Standard tab on the Equipment page:
 *   1. parse an uploaded warranty PDF → structured units (+ customer/dealer)
 *   2. build a batch preview (one ST payload per unit + duplicate warnings)
 *   3. submit the batch: write EACH unit to ServiceTitan as its own Installed
 *      Equipment record, persisting a row per unit.
 *
 * Unlike the Rinnai tab there is NO manufacturer-registration CSV — the PDF is
 * the registration confirmation, so every row is stored with proportal_row=null
 * (it never queues for a ProPortal export). Customer/location resolution reuses
 * the shared ST customer/location endpoints; ServiceTitan is the source of truth
 * for the address and we only ever write to the location the office confirmed.
 *
 * Works for a SINGLE piece of equipment or a full multi-unit system — a batch is
 * simply an array of 1..N units.
 */

const st = require("../api/servicetitan");
const repo = require("../db/installedEquipmentRepository");
const asw = require("./americanStandardWarranty");

const TYPE_ID = "american-standard-hvac";

// Grounded whole-system install offer. These only apply to a WHOLE SYSTEM
// (2+ units in one registration) — not single-piece swaps.
const LABOR_WARRANTY_YEARS = 5;

// Free-membership plan for a whole-system install. Our membership program is
// the "Ground Club" (tiered by system count); a single whole HVAC system →
// "Ground Club - Annual" (ST membershipTypeId 7001). Overridable via env.
const FREE_MEMBERSHIP_TYPE_ID = Number(process.env.ST_FREE_MEMBERSHIP_TYPE_ID) || 7001;
const FREE_MEMBERSHIP_PLAN_NAME = process.env.ST_FREE_MEMBERSHIP_PLAN || "Ground Club - Annual";
// Real membership-record creation is OFF until verified live; when off (default)
// the toggle drops a clearly-labeled customer note naming the plan instead.
const MEMBERSHIP_CREATE_ENABLED = String(process.env.ST_ENABLE_MEMBERSHIP_CREATE || "").toLowerCase() === "true";
const FREE_MEMBERSHIP_BUSINESS_UNIT_ID = Number(process.env.ST_FREE_MEMBERSHIP_BU_ID) || null;

/** A registration counts as a "whole system" when it has 2+ units. */
function isWholeSystem(units) {
  return Array.isArray(units) && units.length >= 2;
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Parse an uploaded warranty PDF buffer.
 * @param {Buffer} buffer
 * @returns {Promise<{warrantyNumber:string|null, customer:object|null, dealer:object|null, units:object[]}>}
 */
async function parseUploadedPdf(buffer) {
  if (!buffer || !buffer.length) throw new Error("Empty PDF upload.");
  const parsed = await asw.extractWarrantyPdf(buffer);
  return {
    warrantyNumber: parsed.warrantyNumber || null,
    customer: parsed.customer || null,
    dealer: parsed.dealer || null,
    units: parsed.units || [],
  };
}

/**
 * Build a no-write preview for a batch of units against a chosen ST location.
 * Adds per-unit validation + duplicate warnings (local DB + live ST location).
 * @param {{ locationId:number, units:object[], warrantyNumber?:string }} args
 * @returns {Promise<Array<{unit:object, stPayload:object, warnings:string[]}>>}
 */
async function buildBatchPreview({ locationId, units, warrantyNumber = null, applyLaborWarranty = false }) {
  if (!locationId) throw new Error("locationId required");
  const list = Array.isArray(units) ? units : [];
  const normalized = list.map((u) => asw.normalizeUnit(u, warrantyNumber));
  // Labor warranty only rides along on a whole system.
  const laborYears = applyLaborWarranty && isWholeSystem(list) ? LABOR_WARRANTY_YEARS : 0;

  // One live lookup of what's already on this location, shared across units.
  let existingSerials = new Set();
  try {
    const existing = await st.getInstalledEquipmentByLocation(locationId);
    existingSerials = new Set(
      (existing || [])
        .map((e) => String(e.serialNumber || "").trim().toUpperCase())
        .filter(Boolean)
    );
  } catch (_) { /* non-fatal */ }

  return normalized.map((u) => {
    const stPayload = asw.buildStPayloadForUnit({ locationId, unit: u, laborWarrantyYears: laborYears });
    const serial = String(u.serialNumber || "").trim().toUpperCase();
    const warnings = [];
    if (!u.model) warnings.push("Missing model number.");
    if (!u.serialNumber) warnings.push("Missing serial number.");
    if (!u.warrantyEnd) warnings.push("No warranty end date — the ST warranty field will be blank.");
    if (!u.installedOn) warnings.push("No install date — set one so the warranty start is recorded.");
    if (u.manufacture && u.installedOn && u.manufacture.date > u.installedOn) {
      warnings.push("Serial decodes to a manufacture date after the install date — double-check the serial or install date.");
    }
    if (serial && existingSerials.has(serial)) {
      warnings.push("A unit with this serial already exists on this ServiceTitan location.");
    }
    if (u.serialNumber) {
      const localDupes = repo.findBySerial(u.serialNumber);
      if (localDupes.length) warnings.push(`This serial was already entered here ${localDupes.length} time(s).`);
    }
    return { unit: u, stPayload, warnings };
  });
}

/**
 * Write a batch of units to ServiceTitan and persist a row per unit.
 * A failed ST write on one unit does not abort the rest — each result carries
 * its own status so the UI can show exactly what happened.
 * @param {{ customerId?:number, locationId:number, customerName?:string,
 *           locationAddress?:string, units:object[], warrantyNumber?:string,
 *           createdBy?:string }} args
 */
async function submitBatch({
  customerId, locationId, customerName, locationAddress, units, warrantyNumber,
  applyLaborWarranty = false, createMembership = false, createdBy,
}) {
  if (!locationId) throw new Error("locationId required");

  // Whole-system extras only apply to a whole system (2+ units).
  const wholeSystem = isWholeSystem(units);
  const laborApplied = !!applyLaborWarranty && wholeSystem;
  const membershipRequested = !!createMembership && wholeSystem;

  const preview = await buildBatchPreview({
    locationId, units, warrantyNumber, applyLaborWarranty: laborApplied,
  });
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
      manufacture_date: unit.manufacture ? unit.manufacture.date : null, // decoded from serial (year+week)
      warranty_start: unit.warrantyStart || null,
      warranty_end: unit.warrantyEnd || null,
      form_data: { ...unit, warrantyNumber: warrantyNumber || unit.warrantyNumber || null },
      proportal_row: null, // no ProPortal/CSV for American Standard
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

  // Free 1-year membership (whole system only). Runs once per registration, after
  // the equipment writes. See applyFreeMembership for how it's recorded.
  let membership = null;
  if (membershipRequested) {
    membership = await applyFreeMembership({
      customerId, customerName, locationId, locationAddress,
      units: preview.map((p) => p.unit), warrantyNumber,
      laborYears: laborApplied ? LABOR_WARRANTY_YEARS : 0, createdBy,
    });
  }

  return {
    ok: failed === 0,
    created, failed, results,
    wholeSystem,
    laborWarrantyApplied: laborApplied,
    laborWarrantyYears: laborApplied ? LABOR_WARRANTY_YEARS : 0,
    membership,
  };
}

/**
 * Record the complimentary 1-year "Ground Club - Annual" membership for a
 * whole-system install.
 *
 * When ST_ENABLE_MEMBERSHIP_CREATE=true, this creates a real ServiceTitan
 * membership record (12-month term, plan FREE_MEMBERSHIP_TYPE_ID). Otherwise —
 * and as a guaranteed fallback if the create call fails — it drops a clearly
 * labeled customer NOTE naming the plan so the membership team sets up the free
 * year. Never throws: a membership hiccup must not fail the equipment writes.
 */
async function applyFreeMembership({
  customerId, locationId, units = [], warrantyNumber, laborYears,
}) {
  if (!customerId) {
    return { ok: false, method: "none", error: "No customerId to attach the membership to." };
  }
  const sys = units.map((u) => u.equipmentName).filter(Boolean).join(", ") || "system";
  const from = todayISO();
  const to = asw.addYearsISO(from, 1);

  // Preferred path: create the real membership record (opt-in until verified).
  if (MEMBERSHIP_CREATE_ENABLED) {
    try {
      const body = {
        customerId: Number(customerId),
        membershipTypeId: FREE_MEMBERSHIP_TYPE_ID,
        from: `${from}T00:00:00Z`,
        to: `${to}T00:00:00Z`,
        status: "Active",
      };
      if (locationId) body.locationIds = [Number(locationId)];
      if (FREE_MEMBERSHIP_BUSINESS_UNIT_ID) body.businessUnitId = FREE_MEMBERSHIP_BUSINESS_UNIT_ID;
      const created = await st.createMembership(body);
      return { ok: true, method: "membership", plan: FREE_MEMBERSHIP_PLAN_NAME, membershipId: created?.id ?? null };
    } catch (err) {
      // fall through to the note so the free year is never silently lost
      const note = membershipNoteText({ sys, warrantyNumber, laborYears, failed: err.message });
      try { await st.addCustomerNote(Number(customerId), note); } catch (_) {}
      return { ok: false, method: "note", plan: FREE_MEMBERSHIP_PLAN_NAME, error: err.message, note };
    }
  }

  // Default path: flag it with a customer note naming the plan.
  const note = membershipNoteText({ sys, warrantyNumber, laborYears });
  try {
    await st.addCustomerNote(Number(customerId), note);
    return { ok: true, method: "note", plan: FREE_MEMBERSHIP_PLAN_NAME, note };
  } catch (err) {
    return { ok: false, method: "note", plan: FREE_MEMBERSHIP_PLAN_NAME, error: err.message };
  }
}

function membershipNoteText({ sys, warrantyNumber, laborYears, failed }) {
  return (
    `FREE 1-YEAR MEMBERSHIP (${FREE_MEMBERSHIP_PLAN_NAME}) — new American Standard system installed ${todayISO()}` +
    (warrantyNumber ? ` (warranty #${warrantyNumber})` : "") +
    `. System: ${sys}.` +
    (laborYears ? ` Includes Grounded ${laborYears}-yr labor warranty.` : "") +
    ` Set up the complimentary 12-month membership for this customer.` +
    (failed ? ` [auto-create attempted but failed: ${failed}]` : "")
  );
}

module.exports = {
  TYPE_ID,
  LABOR_WARRANTY_YEARS,
  parseUploadedPdf,
  buildBatchPreview,
  submitBatch,
  applyFreeMembership,
  isWholeSystem,
};
