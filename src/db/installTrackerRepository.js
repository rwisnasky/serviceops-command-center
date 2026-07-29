/**
 * src/db/installTrackerRepository.js
 *
 * Persistence for the Install Tracker's *overlay* state. The list of completed
 * installs is always pulled live from ServiceTitan; this table only stores what
 * the office has manually confirmed on top of that list:
 *   • equipment_listed     — the unit(s) are in ServiceTitan's Installed Equipment
 *   • warranty_registered  — the manufacturer warranty has been registered
 *   • notes                — free-text follow-up notes
 *
 * Rows are keyed by the ServiceTitan internal job id and created lazily the
 * first time someone toggles a status on that job (see ensureRow). A snapshot
 * of the job's display fields is stored alongside so the row still reads well
 * even if the job later drops out of the current date window.
 */

const { getDb } = require("./index");

// Whitelist the toggle columns. `flag` is interpolated into SQL below, so it
// must never come straight from the request — it's validated against this set.
const VALID_FLAGS = new Set(["equipment_listed", "warranty_registered"]);

/**
 * Insert the row on first touch; refresh the display snapshot on every touch so
 * a renamed job type / updated customer name stays current. Never clears a
 * field back to null (COALESCE keeps the existing value when a snapshot field
 * is omitted).
 */
function ensureRow(snap) {
  if (!snap || snap.st_job_id == null) throw new Error("ensureRow: st_job_id required");
  const db = getDb();
  db.prepare(`
    INSERT INTO install_tracker (
      st_job_id, job_number, job_type_id, job_type_name, category,
      customer_id, customer_name, location_id, completed_on
    ) VALUES (
      @st_job_id, @job_number, @job_type_id, @job_type_name, @category,
      @customer_id, @customer_name, @location_id, @completed_on
    )
    ON CONFLICT(st_job_id) DO UPDATE SET
      job_number    = COALESCE(excluded.job_number,    install_tracker.job_number),
      job_type_id   = COALESCE(excluded.job_type_id,   install_tracker.job_type_id),
      job_type_name = COALESCE(excluded.job_type_name, install_tracker.job_type_name),
      category      = COALESCE(excluded.category,       install_tracker.category),
      customer_id   = COALESCE(excluded.customer_id,   install_tracker.customer_id),
      customer_name = COALESCE(excluded.customer_name, install_tracker.customer_name),
      location_id   = COALESCE(excluded.location_id,   install_tracker.location_id),
      completed_on  = COALESCE(excluded.completed_on,  install_tracker.completed_on),
      updated_at    = datetime('now')
  `).run({
    st_job_id:     Number(snap.st_job_id),
    job_number:    snap.job_number ?? null,
    job_type_id:   snap.job_type_id ?? null,
    job_type_name: snap.job_type_name ?? null,
    category:      snap.category ?? null,
    customer_id:   snap.customer_id ?? null,
    customer_name: snap.customer_name ?? null,
    location_id:   snap.location_id ?? null,
    completed_on:  snap.completed_on ?? null,
  });
}

/**
 * Set one status flag on a job. `value` truthiness stamps/clears the matching
 * *_at (timestamp) and *_by (actor) columns so the UI can show who confirmed
 * it and when. Returns the fresh row.
 */
function setFlag(jobId, flag, value, actor, snap = {}) {
  if (!VALID_FLAGS.has(flag)) throw new Error(`Unknown flag: ${flag}`);
  ensureRow({ ...snap, st_job_id: jobId });
  const db = getDb();
  const on = value ? 1 : 0;
  const atCol = `${flag}_at`;
  const byCol = `${flag}_by`;
  db.prepare(`
    UPDATE install_tracker
       SET ${flag}   = ?,
           ${atCol}  = ${on ? "datetime('now')" : "NULL"},
           ${byCol}  = ?,
           updated_at = datetime('now')
     WHERE st_job_id = ?
  `).run(on, on ? (actor || null) : null, Number(jobId));
  return getByJobId(jobId);
}

/** Replace the notes for a job (null/empty clears them). Returns the row. */
function setNotes(jobId, notes, snap = {}) {
  ensureRow({ ...snap, st_job_id: jobId });
  const db = getDb();
  const trimmed = notes == null ? "" : String(notes).trim();
  const clean = trimmed === "" ? null : trimmed.slice(0, 4000);
  db.prepare(`
    UPDATE install_tracker
       SET notes = ?, updated_at = datetime('now')
     WHERE st_job_id = ?
  `).run(clean, Number(jobId));
  return getByJobId(jobId);
}

function getByJobId(jobId) {
  const db = getDb();
  return db.prepare(`SELECT * FROM install_tracker WHERE st_job_id = ?`).get(Number(jobId)) || null;
}

/** Bulk-fetch overlay rows for a set of job ids → Map keyed by String(jobId). */
function getByJobIds(ids = []) {
  const db = getDb();
  const map = new Map();
  if (!ids.length) return map;
  const CHUNK = 400; // stay well under SQLite's bound-variable limit
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK).map(Number);
    const placeholders = slice.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT * FROM install_tracker WHERE st_job_id IN (${placeholders})`)
      .all(...slice);
    for (const r of rows) map.set(String(r.st_job_id), r);
  }
  return map;
}

module.exports = { ensureRow, setFlag, setNotes, getByJobId, getByJobIds };
