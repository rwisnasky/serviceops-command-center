/**
 * src/db/installedEquipmentRepository.js
 *
 * Persistence for Installed Equipment registrations entered on the Equipment
 * page. Each row captures the ServiceTitan write result AND the Rinnai ProPortal
 * CSV row, so the CSV can be (re)generated on demand and we can guard duplicates.
 */

const { getDb } = require("./index");

/**
 * Insert a registration row.
 * @param {object} r
 * @returns {{ id:number }}
 */
function recordRegistration(r) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO installed_equipment_registrations (
      equipment_type_id, st_installed_equipment_id, st_customer_id,
      st_customer_name, st_location_id, location_address,
      model, serial_number, installed_on, manufacture_date,
      warranty_start, warranty_end, form_data, proportal_row,
      proportal_exported, st_write_status, st_error, created_by
    ) VALUES (
      @equipment_type_id, @st_installed_equipment_id, @st_customer_id,
      @st_customer_name, @st_location_id, @location_address,
      @model, @serial_number, @installed_on, @manufacture_date,
      @warranty_start, @warranty_end, @form_data, @proportal_row,
      0, @st_write_status, @st_error, @created_by
    )
  `);
  const info = stmt.run({
    equipment_type_id: r.equipment_type_id,
    st_installed_equipment_id: r.st_installed_equipment_id ?? null,
    st_customer_id: r.st_customer_id ?? null,
    st_customer_name: r.st_customer_name ?? null,
    st_location_id: r.st_location_id ?? null,
    location_address: r.location_address ?? null,
    model: r.model ?? null,
    serial_number: r.serial_number ?? null,
    installed_on: r.installed_on ?? null,
    manufacture_date: r.manufacture_date ?? null,
    warranty_start: r.warranty_start ?? null,
    warranty_end: r.warranty_end ?? null,
    form_data: r.form_data ? JSON.stringify(r.form_data) : null,
    proportal_row: r.proportal_row ? JSON.stringify(r.proportal_row) : null,
    st_write_status: r.st_write_status || "created",
    st_error: r.st_error ?? null,
    created_by: r.created_by ?? null,
  });
  return { id: info.lastInsertRowid };
}

/**
 * Find prior registrations for a serial number (case-insensitive, trimmed).
 * Used to warn about duplicates before writing.
 * @returns {object[]}
 */
function findBySerial(serialNumber) {
  if (!serialNumber) return [];
  const db = getDb();
  const norm = String(serialNumber).trim();
  return db.prepare(`
    SELECT * FROM installed_equipment_registrations
    WHERE serial_number IS NOT NULL
      AND UPPER(TRIM(serial_number)) = UPPER(?)
    ORDER BY created_at DESC
  `).all(norm);
}

/** Recent registrations, newest first. */
function listRecent(limit = 50) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM installed_equipment_registrations
    ORDER BY created_at DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(500, Number(limit) || 50)));
}

/**
 * Rows not yet exported to ProPortal (successful ST writes or skipped, but with
 * a proportal_row present). equipmentTypeId optional filter.
 */
function listPendingProPortal(equipmentTypeId = null) {
  const db = getDb();
  if (equipmentTypeId) {
    return db.prepare(`
      SELECT * FROM installed_equipment_registrations
      WHERE proportal_exported = 0 AND proportal_row IS NOT NULL
        AND equipment_type_id = ?
      ORDER BY created_at ASC
    `).all(equipmentTypeId);
  }
  return db.prepare(`
    SELECT * FROM installed_equipment_registrations
    WHERE proportal_exported = 0 AND proportal_row IS NOT NULL
    ORDER BY created_at ASC
  `).all();
}

function countPendingProPortal(equipmentTypeId = null) {
  const db = getDb();
  if (equipmentTypeId) {
    return db.prepare(`
      SELECT COUNT(*) AS n FROM installed_equipment_registrations
      WHERE proportal_exported = 0 AND proportal_row IS NOT NULL
        AND equipment_type_id = ?
    `).get(equipmentTypeId).n;
  }
  return db.prepare(`
    SELECT COUNT(*) AS n FROM installed_equipment_registrations
    WHERE proportal_exported = 0 AND proportal_row IS NOT NULL
  `).get().n;
}

/** Mark a set of rows as exported to ProPortal. */
function markProPortalExported(ids = []) {
  if (!ids.length) return 0;
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE installed_equipment_registrations
    SET proportal_exported = 1, proportal_exported_at = datetime('now')
    WHERE id = ?
  `);
  const tx = db.transaction((idList) => {
    let n = 0;
    for (const id of idList) n += stmt.run(id).changes;
    return n;
  });
  return tx(ids);
}

module.exports = {
  recordRegistration,
  findBySerial,
  listRecent,
  listPendingProPortal,
  countPendingProPortal,
  markProPortalExported,
};
