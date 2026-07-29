/**
 * jobReviewRepository.js
 * ───────────────────────────────────────────────────────────────────────
 * CRUD helpers for the job_review_status table.
 *
 * Used by the Open Jobs / Monthly Review pages so office staff can:
 *   • Mark a flagged job "reviewed" (looked at, nothing to fix)
 *   • Mark a job "escalated" (needs a deeper dive — surfaces in red)
 *   • Mark a job "resolved" (action taken, e.g. invoice corrected)
 *   • Override status / job type as a non-destructive correction layer
 *   • Append timestamped notes that can be pushed to ServiceTitan
 *
 * Status values are kept as free-form strings so we can add more states
 * later (e.g. "waiting on customer") without a schema migration.
 *
 * The corrections (`corrected_status`, `corrected_job_type`) and the
 * append-only `job_review_notes` table back the Resolved-tab flow:
 *   1. Reviewer makes edits while triaging a month
 *   2. Marks resolved → row surfaces on the Resolved list
 *   3. "Push to ServiceTitan" PATCHes ST job + posts each unsynced note
 *   4. Per-field sync flags let partial successes be recorded honestly
 * ───────────────────────────────────────────────────────────────────────
 */

const { getDb } = require("./index");

const VALID_STATUSES = new Set(["reviewed", "escalated", "resolved", "open"]);

const SELECT_COLS = `
  job_number, status, notes, reviewed_by, reviewed_at, updated_at,
  st_note_synced_at, st_note_synced_text, st_note_error,
  corrected_status, corrected_job_type,
  status_synced_at, status_synced_value, status_sync_error,
  job_type_synced_at, job_type_synced_value, job_type_sync_error
`;

// ── Row helpers ────────────────────────────────────────────────────────

function list() {
  const rows = getDb()
    .prepare(`SELECT ${SELECT_COLS} FROM job_review_status`)
    .all();
  const byJob = Object.create(null);
  for (const r of rows) byJob[r.job_number] = r;
  return byJob;
}

function get(jobNumber) {
  return getDb()
    .prepare(`SELECT ${SELECT_COLS} FROM job_review_status WHERE job_number = ?`)
    .get(String(jobNumber));
}

/**
 * All resolved rows, in updated_at DESC order, with their note log attached.
 *
 * Used by the Resolved tab. `pendingPush` is true if any field on the row
 * still needs to hit ServiceTitan — i.e. corrections that have changed
 * since last sync, OR unsynced notes.
 */
function listResolved() {
  const db = getDb();
  const rows = db
    .prepare(`SELECT ${SELECT_COLS} FROM job_review_status WHERE status = 'resolved' ORDER BY updated_at DESC`)
    .all();
  return rows.map(r => decorateWithSyncState(r));
}

/**
 * Only resolved rows that have at least one pending push (corrections that
 * haven't been pushed yet, or notes that haven't been synced). Used by the
 * batch "Push all to ServiceTitan" endpoint to skip rows that are fully
 * synced already.
 */
function listResolvedUnsynced() {
  return listResolved().filter(r => r.pendingPush);
}

// ── Mutations ──────────────────────────────────────────────────────────

/**
 * Upsert a status row. Pass status='open' (or null) to clear the override
 * — but only if there are no corrections or notes that would be orphaned.
 * If corrections exist we keep the row and just blank the status field.
 *
 * Accepts (any of):
 *   - status                (open|reviewed|escalated|resolved)
 *   - notes                 legacy single-string field; appendNote() is
 *                           preferred for the audit-tracked log
 *   - reviewedBy            actor name
 *   - correctedStatus       null clears the override; '' is treated as null
 *   - correctedJobType      same convention
 *
 * Returns the resulting row, or null if cleared.
 */
function upsert({
  jobNumber,
  status,
  notes,
  reviewedBy,
  correctedStatus,
  correctedJobType,
}) {
  const db = getDb();
  const jn = String(jobNumber || "").trim();
  if (!jn) throw new Error("jobNumber required");

  const hasCorrectionOp =
    correctedStatus !== undefined || correctedJobType !== undefined;

  // Clearing — but only if no correction is being applied in the same call
  // and there are no notes left on the row. Otherwise keep the row alive.
  if (!hasCorrectionOp && (!status || status === "open")) {
    const noteCount = db
      .prepare(`SELECT COUNT(*) AS c FROM job_review_notes WHERE job_number = ?`)
      .get(jn).c;
    const existing = get(jn);
    const hasCorrections = existing && (existing.corrected_status || existing.corrected_job_type);
    if (noteCount === 0 && !hasCorrections) {
      db.prepare(`DELETE FROM job_review_status WHERE job_number = ?`).run(jn);
      return null;
    }
    // Keep the row but blank status — corrections / notes remain.
    db.prepare(`
      UPDATE job_review_status
      SET status = 'open', updated_at = datetime('now')
      WHERE job_number = ?
    `).run(jn);
    return get(jn);
  }

  if (status && !VALID_STATUSES.has(status)) {
    throw new Error(`Invalid status: ${status}`);
  }

  // Normalize correction fields: undefined = "don't touch", null|'' = "clear"
  const cs = normalizeCorrection(correctedStatus);
  const ct = normalizeCorrection(correctedJobType);

  // Insert path uses defaults; update path uses COALESCE to leave untouched
  // fields alone unless explicitly provided.
  db.prepare(`
    INSERT INTO job_review_status (
      job_number, status, notes, reviewed_by,
      corrected_status, corrected_job_type,
      reviewed_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(job_number) DO UPDATE SET
      status              = COALESCE(excluded.status, job_review_status.status),
      notes               = COALESCE(excluded.notes, job_review_status.notes),
      reviewed_by         = COALESCE(excluded.reviewed_by, job_review_status.reviewed_by),
      corrected_status    = CASE WHEN ? = 1 THEN excluded.corrected_status ELSE job_review_status.corrected_status END,
      corrected_job_type  = CASE WHEN ? = 1 THEN excluded.corrected_job_type ELSE job_review_status.corrected_job_type END,
      updated_at          = datetime('now')
  `).run(
    jn,
    status || "open",
    notes || null,
    reviewedBy || null,
    cs.value,
    ct.value,
    cs.touched ? 1 : 0,
    ct.touched ? 1 : 0,
  );

  // If the user cleared a correction (set to null), wipe the sync state so
  // we don't show "synced to ServiceTitan" pointing at an old value.
  if (cs.touched && cs.value === null) {
    db.prepare(`
      UPDATE job_review_status
      SET status_synced_at = NULL, status_synced_value = NULL, status_sync_error = NULL
      WHERE job_number = ?
    `).run(jn);
  }
  if (ct.touched && ct.value === null) {
    db.prepare(`
      UPDATE job_review_status
      SET job_type_synced_at = NULL, job_type_synced_value = NULL, job_type_sync_error = NULL
      WHERE job_number = ?
    `).run(jn);
  }

  return get(jn);
}

function clear(jobNumber) {
  const db = getDb();
  const jn = String(jobNumber);
  // Cascade: clear the note log too. The review row is the user-facing
  // anchor; if it's gone, orphan notes would just clutter the table.
  db.prepare(`DELETE FROM job_review_notes WHERE job_number = ?`).run(jn);
  db.prepare(`DELETE FROM job_review_status WHERE job_number = ?`).run(jn);
}

// ── Sync flags ─────────────────────────────────────────────────────────

/**
 * Record the result of pushing this row's legacy `notes` field to ST.
 * (Kept for backward compat with the single-notes-field flow. The new
 * append-only log uses markNoteSynced/markNoteError below.)
 */
function markStSynced(jobNumber, syncedText, error = null) {
  const db = getDb();
  if (error) {
    db.prepare(`
      UPDATE job_review_status
      SET st_note_error = ?, updated_at = datetime('now')
      WHERE job_number = ?
    `).run(String(error).slice(0, 500), String(jobNumber));
  } else {
    db.prepare(`
      UPDATE job_review_status
      SET st_note_synced_at   = datetime('now'),
          st_note_synced_text = ?,
          st_note_error       = NULL,
          updated_at          = datetime('now')
      WHERE job_number = ?
    `).run(syncedText || null, String(jobNumber));
  }
  return get(jobNumber);
}

function markStatusSynced(jobNumber, syncedValue, error = null) {
  const db = getDb();
  if (error) {
    db.prepare(`
      UPDATE job_review_status
      SET status_sync_error = ?, updated_at = datetime('now')
      WHERE job_number = ?
    `).run(String(error).slice(0, 500), String(jobNumber));
  } else {
    db.prepare(`
      UPDATE job_review_status
      SET status_synced_at    = datetime('now'),
          status_synced_value = ?,
          status_sync_error   = NULL,
          updated_at          = datetime('now')
      WHERE job_number = ?
    `).run(syncedValue || null, String(jobNumber));
  }
  return get(jobNumber);
}

function markJobTypeSynced(jobNumber, syncedValue, error = null) {
  const db = getDb();
  if (error) {
    db.prepare(`
      UPDATE job_review_status
      SET job_type_sync_error = ?, updated_at = datetime('now')
      WHERE job_number = ?
    `).run(String(error).slice(0, 500), String(jobNumber));
  } else {
    db.prepare(`
      UPDATE job_review_status
      SET job_type_synced_at    = datetime('now'),
          job_type_synced_value = ?,
          job_type_sync_error   = NULL,
          updated_at            = datetime('now')
      WHERE job_number = ?
    `).run(syncedValue || null, String(jobNumber));
  }
  return get(jobNumber);
}

// ── Append-only note log ───────────────────────────────────────────────

function appendNote({ jobNumber, text, author }) {
  const db = getDb();
  const jn = String(jobNumber || "").trim();
  if (!jn) throw new Error("jobNumber required");
  const t = String(text || "").trim();
  if (!t) throw new Error("note text required");

  // Make sure a parent row exists so the Resolved tab and review-status
  // overlays can find it. We don't change status here — just ensure the
  // row is present so the note has somewhere to hang off.
  db.prepare(`
    INSERT INTO job_review_status (job_number, status, reviewed_at, updated_at)
    VALUES (?, 'open', datetime('now'), datetime('now'))
    ON CONFLICT(job_number) DO UPDATE SET updated_at = datetime('now')
  `).run(jn);

  const info = db.prepare(`
    INSERT INTO job_review_notes (job_number, text, author)
    VALUES (?, ?, ?)
  `).run(jn, t, author || null);

  return getNote(info.lastInsertRowid);
}

function getNote(id) {
  return getDb()
    .prepare(`SELECT * FROM job_review_notes WHERE id = ?`)
    .get(Number(id));
}

function listNotes(jobNumber) {
  return getDb()
    .prepare(`SELECT * FROM job_review_notes WHERE job_number = ? ORDER BY added_at ASC, id ASC`)
    .all(String(jobNumber));
}

function listUnsyncedNotes(jobNumber) {
  return getDb()
    .prepare(`
      SELECT * FROM job_review_notes
      WHERE job_number = ? AND st_note_synced_at IS NULL
      ORDER BY added_at ASC, id ASC
    `)
    .all(String(jobNumber));
}

function markNoteSynced(id, syncedText) {
  getDb().prepare(`
    UPDATE job_review_notes
    SET st_note_synced_at   = datetime('now'),
        st_note_synced_text = ?,
        st_note_error       = NULL
    WHERE id = ?
  `).run(syncedText || null, Number(id));
  return getNote(id);
}

function markNoteError(id, error) {
  getDb().prepare(`
    UPDATE job_review_notes
    SET st_note_error = ?
    WHERE id = ?
  `).run(String(error || "").slice(0, 500), Number(id));
  return getNote(id);
}

function deleteNote(id) {
  getDb().prepare(`DELETE FROM job_review_notes WHERE id = ?`).run(Number(id));
}

// ── Helpers ────────────────────────────────────────────────────────────

function normalizeCorrection(v) {
  // undefined = don't touch; null|'' = clear; everything else = string
  if (v === undefined) return { touched: false, value: null };
  if (v === null || v === "") return { touched: true, value: null };
  return { touched: true, value: String(v).trim() || null };
}

/**
 * Annotate a row with its notes log and a `pendingPush` boolean so the
 * Resolved tab knows what still needs to hit ST.
 *
 * pendingPush is true when:
 *   - corrected_status is set and (never synced OR synced value differs)
 *   - corrected_job_type is set and (never synced OR synced value differs)
 *   - any note in the log is still unsynced
 */
function decorateWithSyncState(row) {
  const notes = listNotes(row.job_number);
  const statusPending =
    !!row.corrected_status &&
    row.status_synced_value !== row.corrected_status;
  const jobTypePending =
    !!row.corrected_job_type &&
    row.job_type_synced_value !== row.corrected_job_type;
  const notesPending = notes.some(n => !n.st_note_synced_at);
  return {
    ...row,
    notesLog: notes,
    pendingStatus: statusPending,
    pendingJobType: jobTypePending,
    pendingNotes: notesPending,
    pendingPush: statusPending || jobTypePending || notesPending,
  };
}

module.exports = {
  VALID_STATUSES,
  list,
  get,
  upsert,
  clear,
  listResolved,
  listResolvedUnsynced,
  markStSynced,
  markStatusSynced,
  markJobTypeSynced,
  appendNote,
  getNote,
  listNotes,
  listUnsyncedNotes,
  markNoteSynced,
  markNoteError,
  deleteNote,
  decorateWithSyncState,
};
