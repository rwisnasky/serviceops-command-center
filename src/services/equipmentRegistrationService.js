/**
 * src/services/equipmentRegistrationService.js
 *
 * Orchestrates the Equipment page flow:
 *   1. resolve a customer (by name or ID) and their location(s)
 *   2. decode the serial → manufacture date, validate
 *   3. compute warranty from the install date (per equipment-type rule)
 *   4. build a preview (ST payload + ProPortal CSV row + duplicate warnings)
 *   5. on submit: write Installed Equipment to ServiceTitan, persist the row
 *   6. generate the Rinnai ProPortal CSV on demand (dedup by serial)
 *
 * ServiceTitan is the source of truth for customer/location; we never guess an
 * address — the office picks the location and every CSV address field comes
 * from that ST location record.
 */

const st = require("../api/servicetitan");
const { getEquipmentType } = require("../config/equipmentTypes");
const { decodeRinnaiSerial, warnIfInstallBeforeManufacture } = require("./rinnaiSerial");
const repo = require("../db/installedEquipmentRepository");

// ── small helpers ─────────────────────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function splitName(fullName = "", customerType = "") {
  const name = String(fullName || "").trim();
  if (!name) return { firstName: "", lastName: "", companyName: "" };
  // Commercial customers: treat the whole name as the company.
  const isCommercial = String(customerType).toLowerCase() === "commercial";
  if (isCommercial) return { firstName: "", lastName: "", companyName: name };
  if (name.includes(",")) {
    // "Last, First"
    const [last, first] = name.split(",").map((s) => s.trim());
    return { firstName: first || "", lastName: last || "", companyName: "" };
  }
  const parts = name.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: "", companyName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" "), companyName: "" };
}

function formatAddress(addr = {}) {
  const line1 = [addr.street, addr.unit].filter(Boolean).join(" ");
  const cityStateZip = [addr.city, [addr.state, addr.zip].filter(Boolean).join(" ")]
    .filter(Boolean).join(", ");
  return [line1, cityStateZip].filter(Boolean).join(", ");
}

function pickContact(contacts = []) {
  let email = "";
  let phone = "";
  for (const c of contacts) {
    const type = String(c.type || "").toLowerCase();
    const value = c.value || "";
    if (!email && type.includes("email")) email = value;
    if (!phone && (type.includes("phone") || type.includes("mobile"))) phone = value;
  }
  return { email, phone };
}

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── customer / location resolution ────────────────────────────────────────────

/**
 * Search customers by name, customer ID, OR street address.
 * Address search hits ServiceTitan LOCATIONS by street (each carries a
 * customerId), which are then resolved to their owning customers and merged
 * with the name/ID matches.
 * @returns {Promise<Array<{id:number,name:string,type:string,address:string,active:boolean}>>}
 */
async function searchCustomers(query) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];

  const results = [];
  const seen = new Set();
  // `matched` (optional) = { address, locationId } from an address search, so the
  // UI can auto-confirm that specific location instead of listing them all.
  const add = (c, matched) => {
    if (!c || !c.id || seen.has(c.id)) return;
    seen.add(c.id);
    results.push({
      id: c.id,
      name: c.name || `Customer ${c.id}`,
      type: c.type || "",
      address: (matched && matched.address) || formatAddress(c.address || {}),
      locationId: matched ? matched.locationId : null,
      active: c.active !== false,
    });
  };

  // Numeric → exact customer ID lookup first (takes the top slot when found).
  if (/^\d+$/.test(q)) {
    try {
      const c = await st.getCustomer(Number(q));
      if (c && c.id) add(c);
    } catch (_) { /* fall through */ }
  }

  // Name + address searches in parallel.
  const [byName, byAddr] = await Promise.all([
    st.searchCustomersByName(q, { pageSize: 15 }).catch(() => []),
    q.length >= 3 ? st.searchLocationsByAddress(q, { pageSize: 20 }).catch(() => []) : Promise.resolve([]),
  ]);

  byName.forEach((c) => add(c));

  // Resolve unique address-matched customers (capped to limit API calls). Keep
  // the first matching location per customer so the UI can auto-confirm it.
  const addrMatchById = new Map(); // customerId → { address, locationId }
  const toResolve = [];
  for (const loc of byAddr) {
    const cid = loc.customerId;
    if (!cid || seen.has(cid) || addrMatchById.has(cid)) continue;
    addrMatchById.set(cid, { address: formatAddress(loc.address || {}), locationId: loc.id });
    toResolve.push(cid);
    if (toResolve.length >= 10) break;
  }
  if (toResolve.length) {
    const customers = await Promise.all(
      toResolve.map((id) => st.getCustomer(Number(id)).catch(() => null))
    );
    customers.forEach((c) => { if (c) add(c, addrMatchById.get(c.id)); });
  }

  return results;
}

/**
 * List a customer's locations.
 * @returns {Promise<Array<{id:number,name:string,address:string,raw:object}>>}
 */
async function getLocationsForCustomer(customerId) {
  const locs = await st.getLocationsByCustomer(Number(customerId), { pageSize: 100 });
  return locs.map((l) => ({
    id: l.id,
    name: l.name || "",
    address: formatAddress(l.address || {}),
    raw: l,
  }));
}

/** Decode a serial + optional install-date sanity check (for live preview). */
function previewSerial(serial, installedOn) {
  const decoded = decodeRinnaiSerial(serial);
  const warning = decoded.ok
    ? warnIfInstallBeforeManufacture(decoded.manufactureDate, installedOn)
    : null;
  return { decoded, warning };
}

// ── gather full ST context for CSV + payload ──────────────────────────────────

async function gatherContext(customerId, locationId) {
  const [customer, contacts, location] = await Promise.all([
    st.getCustomer(Number(customerId)).catch(() => null),
    st.getCustomerContacts(Number(customerId)).catch(() => []),
    st.getLocationById(Number(locationId)).catch(() => null),
  ]);

  const nameParts = splitName(customer?.name, customer?.type);
  const { email, phone } = pickContact(contacts);
  const addr = location?.address || {};

  return {
    customer,
    location,
    contact: {
      firstName: nameParts.firstName,
      lastName: nameParts.lastName,
      companyName: nameParts.companyName,
      email,
      phone,
    },
    csvLocation: {
      street: [addr.street, addr.unit].filter(Boolean).join(" "),
      city: addr.city || "",
      state: addr.state || "",
      zip: addr.zip || "",
      country: addr.country || "US",
    },
    formattedAddress: formatAddress(addr),
    customerName: customer?.name || "",
  };
}

// ── build preview (no writes) ─────────────────────────────────────────────────

/**
 * @param {{equipmentTypeId:string, customerId:number, locationId:number, formData:object}} args
 */
async function buildPreview({ equipmentTypeId, customerId, locationId, formData }) {
  const type = getEquipmentType(equipmentTypeId);
  if (!type) throw new Error(`Unknown equipment type: ${equipmentTypeId}`);
  if (!customerId) throw new Error("customerId required");
  if (!locationId) throw new Error("locationId required");

  // Validate required form fields.
  const missing = (type.fields || [])
    .filter((f) => f.required && !String(formData?.[f.key] ?? "").trim())
    .map((f) => f.label);
  if (missing.length) {
    return { ok: false, error: `Missing required fields: ${missing.join(", ")}` };
  }

  const { decoded, warning } = previewSerial(formData.serialNumber, formData.installedOn);
  const warranty = type.computeWarranty(formData.installedOn, formData);
  const ctx = await gatherContext(customerId, locationId);

  const stPayload = type.buildStPayload({ locationId, formData, decoded, warranty });
  const registrationDate = todayISO();
  const proPortalRow = type.proPortal
    ? type.proPortal.buildRow({
        contact: ctx.contact, location: ctx.csvLocation, formData, registrationDate,
      })
    : null;

  // Duplicate detection — local DB + live ST location.
  const localDupes = repo.findBySerial(formData.serialNumber);
  let stDupes = [];
  try {
    const existing = await st.getInstalledEquipmentByLocation(locationId);
    const target = String(formData.serialNumber || "").trim().toUpperCase();
    stDupes = (existing || []).filter(
      (e) => String(e.serialNumber || "").trim().toUpperCase() === target && target
    );
  } catch (_) { /* non-fatal */ }

  return {
    ok: true,
    equipmentTypeId,
    customer: { id: Number(customerId), name: ctx.customerName },
    location: { id: Number(locationId), address: ctx.formattedAddress },
    decoded,
    warnings: [
      warning,
      localDupes.length ? `This serial was already entered here ${localDupes.length} time(s).` : null,
      stDupes.length ? `A unit with this serial already exists on this ST location.` : null,
    ].filter(Boolean),
    warranty,
    stPayload,
    proPortalRow,
    proPortalColumns: type.proPortal ? type.proPortal.columns : null,
    contact: ctx.contact,
    registrationDate,
  };
}

// ── submit (writes to ServiceTitan + persists) ────────────────────────────────

/**
 * @param {{equipmentTypeId, customerId, locationId, formData, createdBy}} args
 */
async function submitRegistration({ equipmentTypeId, customerId, locationId, formData, createdBy }) {
  const preview = await buildPreview({ equipmentTypeId, customerId, locationId, formData });
  if (!preview.ok) return preview;

  let stId = null;
  let stStatus = "created";
  let stError = null;
  try {
    const created = await st.createInstalledEquipment(preview.stPayload);
    stId = created?.id ?? null;
  } catch (err) {
    stStatus = "failed";
    stError = err.message;
  }

  const { id } = repo.recordRegistration({
    equipment_type_id: equipmentTypeId,
    st_installed_equipment_id: stId,
    st_customer_id: Number(customerId),
    st_customer_name: preview.customer.name,
    st_location_id: Number(locationId),
    location_address: preview.location.address,
    model: formData.model || null,
    serial_number: formData.serialNumber || null,
    installed_on: formData.installedOn || null,
    manufacture_date: preview.decoded?.manufactureDate || null,
    warranty_start: preview.warranty?.manufacturerWarrantyStart || null,
    warranty_end: preview.warranty?.manufacturerWarrantyEnd || null,
    form_data: formData,
    proportal_row: preview.proPortalRow,   // kept even on ST failure; CSV dedups by serial
    st_write_status: stStatus,
    st_error: stError,
    created_by: createdBy || null,
  });

  return {
    ok: stStatus === "created",
    id,
    stInstalledEquipmentId: stId,
    stWriteStatus: stStatus,
    stError,
    warranty: preview.warranty,
    decoded: preview.decoded,
    warnings: preview.warnings,
    proPortalPending: repo.countPendingProPortal(equipmentTypeId),
  };
}

// ── Rinnai ProPortal CSV export ───────────────────────────────────────────────

/**
 * Build the ProPortal CSV from not-yet-exported rows, dedup by serial (latest
 * wins so ST retries don't double-register), and mark those rows exported.
 * @param {string} equipmentTypeId
 * @param {{ markExported?: boolean }} opts
 */
function generateProPortalCsv(equipmentTypeId, { markExported = true } = {}) {
  const type = getEquipmentType(equipmentTypeId);
  if (!type || !type.proPortal) {
    throw new Error(`Equipment type ${equipmentTypeId} has no ProPortal export`);
  }
  const columns = type.proPortal.columns;
  const pending = repo.listPendingProPortal(equipmentTypeId);

  // Dedup by serial — keep the most recent row per serial, collect all ids so
  // superseded duplicates get marked exported too.
  const bySerial = new Map(); // serial → { row, ids:[] }
  for (const r of pending) {
    const key = String(r.serial_number || `__id${r.id}`).trim().toUpperCase();
    if (!bySerial.has(key)) bySerial.set(key, { row: r, ids: [] });
    const entry = bySerial.get(key);
    entry.ids.push(r.id);
    // pending is ordered ASC by created_at; keep the latest as the emitted row
    entry.row = r;
  }

  const dataRows = [];
  const allIds = [];
  for (const { row, ids } of bySerial.values()) {
    allIds.push(...ids);
    let parsed = {};
    try { parsed = row.proportal_row ? JSON.parse(row.proportal_row) : {}; } catch (_) {}
    dataRows.push(columns.map((c) => csvEscape(parsed[c])));
  }

  const header = columns.map(csvEscape).join(",");
  const csv = [header, ...dataRows.map((cells) => cells.join(","))].join("\r\n") + "\r\n";

  if (markExported && allIds.length) repo.markProPortalExported(allIds);

  return {
    csv,
    count: dataRows.length,
    ids: allIds,
    filename: `RinnaiProPortal_${todayISO()}.csv`,
  };
}

module.exports = {
  searchCustomers,
  getLocationsForCustomer,
  previewSerial,
  buildPreview,
  submitRegistration,
  generateProPortalCsv,
  // exported for tests
  splitName,
  formatAddress,
  csvEscape,
};
