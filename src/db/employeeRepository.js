/**
 * employeeRepository.js
 *
 * All DB access for the employee_phones table.
 * Seeded on startup from data/employee-roster.json (parsed from
 * EmployeePhoneRoster.xls). Used by matchingService to short-circuit calls
 * placed from known employee numbers, so they don't hit the customer-lookup
 * path and clutter the review queue as "no match".
 */

const fs = require("fs");
const path = require("path");
const { getDb } = require("./index");

const ROSTER_PATH = path.join(__dirname, "..", "..", "data", "employee-roster.json");

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Look up an employee by their phone number. Accepts any format; normalizes.
 * Returns null if not found or if the number can't be normalized.
 */
function lookupEmployeeByPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM employee_phones WHERE phone_number = ? AND active = 1"
    )
    .get(normalized);
  return row ? toJs(row) : null;
}

/**
 * List all employee phones for admin views.
 */
function listEmployeePhones({ includeInactive = false } = {}) {
  const db = getDb();
  const sql = includeInactive
    ? "SELECT * FROM employee_phones ORDER BY employee_name ASC"
    : "SELECT * FROM employee_phones WHERE active = 1 ORDER BY employee_name ASC";
  return db.prepare(sql).all().map(toJs);
}

function getEmployeeCount() {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM employee_phones WHERE active = 1")
    .get();
  return row?.count || 0;
}

// ── Writes ────────────────────────────────────────────────────────────────────

/**
 * Idempotent upsert for a single employee phone entry.
 * Keyed on phone_number (which is UNIQUE). If the row exists, non-null incoming
 * fields overwrite the existing ones; nulls are ignored so we don't wipe data.
 */
function upsertEmployeePhone(entry) {
  const db = getDb();
  const normalized = normalizePhone(entry.phoneNumber);
  if (!normalized) return null;

  db.prepare(`
    INSERT INTO employee_phones (
      phone_number, employee_name, trade, extension, truck_number, phone_type, source, active, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(phone_number) DO UPDATE SET
      employee_name = COALESCE(excluded.employee_name, employee_name),
      trade         = COALESCE(excluded.trade, trade),
      extension     = COALESCE(excluded.extension, extension),
      truck_number  = COALESCE(excluded.truck_number, truck_number),
      phone_type    = COALESCE(excluded.phone_type, phone_type),
      source        = COALESCE(excluded.source, source),
      active        = 1,
      updated_at    = datetime('now')
  `).run(
    normalized,
    entry.employeeName || null,
    entry.trade || null,
    entry.extension || null,
    entry.truckNumber ? String(entry.truckNumber) : null,
    entry.phoneType || null,
    entry.source || "roster"
  );

  return lookupEmployeeByPhone(normalized);
}

// ── Seed ──────────────────────────────────────────────────────────────────────

/**
 * Seed employee_phones from data/employee-roster.json if the table is empty.
 * Safe to call on every startup: it checks getEmployeeCount() first, and the
 * insert itself is keyed on phone_number so duplicate inserts would no-op anyway.
 *
 * Returns { inserted, skipped, total }.
 */
function seedEmployeePhonesIfEmpty() {
  const existing = getEmployeeCount();
  if (existing > 0) {
    console.log(
      `[EmployeePhones] Roster already has ${existing} entries — skipping seed`
    );
    return { inserted: 0, skipped: existing, total: existing };
  }

  if (!fs.existsSync(ROSTER_PATH)) {
    console.warn(
      `[EmployeePhones] No roster file at ${ROSTER_PATH} — skipping seed`
    );
    return { inserted: 0, skipped: 0, total: 0 };
  }

  let rosterJson;
  try {
    rosterJson = JSON.parse(fs.readFileSync(ROSTER_PATH, "utf-8"));
  } catch (err) {
    console.error(
      `[EmployeePhones] Could not parse ${ROSTER_PATH}: ${err.message}`
    );
    return { inserted: 0, skipped: 0, total: 0 };
  }

  const entries = Array.isArray(rosterJson?.entries) ? rosterJson.entries : [];
  if (entries.length === 0) {
    console.warn(`[EmployeePhones] Roster file has no entries — skipping seed`);
    return { inserted: 0, skipped: 0, total: 0 };
  }

  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO employee_phones (
      phone_number, employee_name, trade, extension, truck_number, phone_type, source
    ) VALUES (?, ?, ?, ?, ?, ?, 'roster')
  `);

  let inserted = 0;
  let skipped = 0;

  // Wrap in a transaction so 92 inserts run as one fsync.
  const tx = db.transaction(() => {
    for (const e of entries) {
      const normalized = normalizePhone(e.phoneNumber);
      if (!normalized || !e.employeeName) {
        skipped++;
        continue;
      }
      const result = insert.run(
        normalized,
        e.employeeName,
        e.trade || null,
        e.extension || null,
        e.truckNumber ? String(e.truckNumber) : null,
        e.phoneType || null
      );
      if (result.changes > 0) inserted++;
      else skipped++;
    }
  });
  tx();

  const total = getEmployeeCount();
  console.log(
    `[EmployeePhones] Seeded from ${path.basename(ROSTER_PATH)}: ` +
      `${inserted} inserted, ${skipped} skipped (${total} active in DB)`
  );
  return { inserted, skipped, total };
}

// ── Serialization ─────────────────────────────────────────────────────────────

function toJs(row) {
  if (!row) return null;
  return {
    id: row.id,
    phoneNumber: row.phone_number,
    employeeName: row.employee_name,
    trade: row.trade,
    extension: row.extension,
    truckNumber: row.truck_number,
    phoneType: row.phone_type,
    active: Boolean(row.active),
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  lookupEmployeeByPhone,
  listEmployeePhones,
  getEmployeeCount,
  upsertEmployeePhone,
  seedEmployeePhonesIfEmpty,
  normalizePhone,
};
