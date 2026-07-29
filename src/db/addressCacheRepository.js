/**
 * src/db/addressCacheRepository.js
 * ────────────────────────────────────────────────────────────────────────────
 * Cache of Google Geocoding results, keyed by ServiceTitan location ID.
 *
 * The point: stop re-paying Google for addresses we already verified. Each
 * cache row stores the address fingerprint at the time of check (a normalized
 * hash of street+unit+city+state+zip). On the next audit pass we re-compute
 * the fingerprint from the *current* ST address and compare — if it matches,
 * the prior verification is still valid and we skip Google entirely. If it
 * differs (someone in the office edited the address since last check), we
 * geocode again and overwrite the cache row.
 *
 * Schema lives in db/index.js so it gets the same /data-volume treatment as
 * the rest of the persistent state.
 * ────────────────────────────────────────────────────────────────────────────
 */

const crypto = require("crypto");
const { getDb } = require("./index");

// ── Fingerprint ──────────────────────────────────────────────────────────────
// Deliberately loose: lowercase, strip punctuation, collapse whitespace. The
// point is "did the meaningful content of this address change since we last
// looked at it" — not "is it byte-identical." A capitalization or trailing-
// comma edit in ST shouldn't blow up the cache.
function normalizePart(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fingerprintAddress(addr = {}) {
  const joined = [
    normalizePart(addr.street),
    normalizePart(addr.unit),
    normalizePart(addr.city),
    normalizePart(addr.state),
    String(addr.zip || "").slice(0, 5),
  ].join("|");
  return crypto.createHash("sha1").update(joined).digest("hex").slice(0, 16);
}

// ── Reads ────────────────────────────────────────────────────────────────────
function getCachedByLocationId(locationId) {
  if (!locationId) return null;
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM address_audit_cache WHERE location_id = ?")
    .get(Number(locationId));
  if (!row) return null;
  return hydrate(row);
}

function getCachedMany(locationIds = []) {
  if (!locationIds.length) return new Map();
  const db = getDb();
  // chunk the IN clause to keep parameter counts sane
  const out = new Map();
  const CHUNK = 500;
  for (let i = 0; i < locationIds.length; i += CHUNK) {
    const slice = locationIds.slice(i, i + CHUNK).map(Number);
    const placeholders = slice.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT * FROM address_audit_cache WHERE location_id IN (${placeholders})`)
      .all(...slice);
    for (const r of rows) out.set(r.location_id, hydrate(r));
  }
  return out;
}

function hydrate(row) {
  return {
    locationId: row.location_id,
    customerId: row.customer_id,
    fingerprint: row.address_fingerprint,
    status: row.status,
    verified: row.verified_json ? safeParse(row.verified_json) : null,
    verifiedFormatted: row.verified_formatted || null,
    originalName: row.original_name || null,
    suggestedName: row.suggested_name || null,
    partialMatch: !!row.partial_match,
    locationType: row.location_type || null,
    lat: row.lat,
    lng: row.lng,
    placeId: row.place_id || null,
    error: row.error || null,
    checkedAt: row.checked_at,
    appliedAt: row.applied_at,
    dismissedAt: row.dismissed_at,
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

// ── Writes ───────────────────────────────────────────────────────────────────
// upsert called after every geocode call. Overwrites the prior row whether the
// geocode succeeded or errored — an error is still a useful cache value (it
// tells the next caller "Google didn't like this address last time, don't
// burn a quota call trying again right away"). The UI can present the error
// status the same way it does for "no-match".
function upsertCacheRow({
  locationId,
  customerId,
  fingerprint,
  status,
  original,
  originalName,
  suggestedName,
  verified,
  verifiedFormatted,
  partialMatch,
  locationType,
  lat,
  lng,
  placeId,
  error,
}) {
  if (!locationId) throw new Error("upsertCacheRow: locationId required");
  const db = getDb();
  db.prepare(`
    INSERT INTO address_audit_cache (
      location_id, customer_id, address_fingerprint,
      status, original_json, verified_json, verified_formatted,
      original_name, suggested_name,
      partial_match, location_type, lat, lng, place_id,
      error, checked_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(location_id) DO UPDATE SET
      customer_id         = excluded.customer_id,
      address_fingerprint = excluded.address_fingerprint,
      status              = excluded.status,
      original_json       = excluded.original_json,
      verified_json       = excluded.verified_json,
      verified_formatted  = excluded.verified_formatted,
      original_name       = excluded.original_name,
      suggested_name      = excluded.suggested_name,
      partial_match       = excluded.partial_match,
      location_type       = excluded.location_type,
      lat                 = excluded.lat,
      lng                 = excluded.lng,
      place_id            = excluded.place_id,
      error               = excluded.error,
      checked_at          = excluded.checked_at,
      updated_at          = datetime('now')
  `).run(
    Number(locationId),
    customerId != null ? Number(customerId) : null,
    String(fingerprint || ""),
    String(status || ""),
    original ? JSON.stringify(original) : null,
    verified ? JSON.stringify(verified) : null,
    verifiedFormatted || null,
    originalName || null,
    suggestedName || null,
    partialMatch ? 1 : 0,
    locationType || null,
    lat != null ? Number(lat) : null,
    lng != null ? Number(lng) : null,
    placeId || null,
    error || null,
  );
}

// Mark a row as having had its correction pushed to ST. The UI uses this to
// stop offering "Apply correction" on a row that's already been fixed (and to
// strike it out / hide it in the listing).
function markApplied(locationId) {
  const db = getDb();
  db.prepare(
    "UPDATE address_audit_cache SET applied_at = datetime('now'), updated_at = datetime('now') WHERE location_id = ?"
  ).run(Number(locationId));
}

function markDismissed(locationId) {
  const db = getDb();
  db.prepare(
    "UPDATE address_audit_cache SET dismissed_at = datetime('now'), updated_at = datetime('now') WHERE location_id = ?"
  ).run(Number(locationId));
}

// ── Re-classification ────────────────────────────────────────────────────────
// Re-runs the in-process classifier against every cached row WITHOUT calling
// Google. Useful when the classifier logic itself improves (e.g. smarter
// street-suffix normalization) — we already have the verified address stored
// as JSON, so we just need to re-decide each row's status locally.
//
// Callback receives ({ original, verified, partialMatch, locationType }) and
// must return the new status string. We pass the row's stored geoResult-like
// object so the classifier can be reused as-is.
function reclassifyAll(classifyFn) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT location_id, original_json, verified_json, verified_formatted,
           partial_match, location_type, status
    FROM address_audit_cache
    WHERE original_json IS NOT NULL
  `).all();

  const upd = db.prepare(`
    UPDATE address_audit_cache
    SET status = ?, updated_at = datetime('now')
    WHERE location_id = ?
  `);

  let changed = 0;
  let skipped = 0;
  const tx = db.transaction((records) => {
    for (const r of records) {
      const original = r.original_json ? safeParse(r.original_json) : null;
      const verified = r.verified_json ? safeParse(r.verified_json) : null;
      if (!original) { skipped++; continue; }

      const geoResult = verified
        ? {
            verified,
            formatted: r.verified_formatted,
            partialMatch: !!r.partial_match,
            locationType: r.location_type,
            status: "ok",
          }
        : { status: "no-match" };
      const newStatus = classifyFn(original, geoResult);
      if (newStatus !== r.status) {
        upd.run(newStatus, r.location_id);
        changed++;
      }
    }
  });
  tx(rows);

  // Count legacy rows that pre-date the original_json column so the UI
  // can suggest re-scanning to upgrade them.
  const legacyCount = db.prepare(
    "SELECT COUNT(*) AS c FROM address_audit_cache WHERE original_json IS NULL"
  ).get().c;

  return { total: rows.length, changed, legacyCount, skipped };
}

// Wipe the entire cache. Used by the "Clear cache" button when the user
// wants a forced re-scan (e.g. after a provider change).
function clearCache() {
  const db = getDb();
  const before = db.prepare("SELECT COUNT(*) AS c FROM address_audit_cache").get().c;
  db.prepare("DELETE FROM address_audit_cache").run();
  return { deleted: before };
}

// ── Stats (for the page header strip) ────────────────────────────────────────
function getCacheStats() {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) AS c FROM address_audit_cache").get().c;
  const applied = db.prepare("SELECT COUNT(*) AS c FROM address_audit_cache WHERE applied_at IS NOT NULL").get().c;
  const byStatus = db.prepare(
    "SELECT status, COUNT(*) AS c FROM address_audit_cache GROUP BY status"
  ).all().reduce((m, r) => { m[r.status] = r.c; return m; }, {});
  const lastCheckedAt = db.prepare(
    "SELECT MAX(checked_at) AS t FROM address_audit_cache"
  ).get().t;
  return { total, applied, byStatus, lastCheckedAt };
}

module.exports = {
  fingerprintAddress,
  getCachedByLocationId,
  getCachedMany,
  upsertCacheRow,
  markApplied,
  markDismissed,
  getCacheStats,
  reclassifyAll,
  clearCache,
};
