/**
 * src/db/index.js
 *
 * SQLite database setup using better-sqlite3.
 *
 * Why SQLite?
 * - Zero config, no external service needed
 * - Railway supports persistent volumes — point DB_PATH at your volume
 * - Single-instance Node apps are an ideal fit
 * - The schema and queries below are written to be easily ported to
 *   PostgreSQL (via pg/postgres.js) when you outgrow SQLite
 *
 * Env vars:
 *   DB_PATH — path to the SQLite database file
 *             default: /tmp/calls.db (ephemeral on Railway without a volume)
 *             recommended: /data/calls.db (Railway volume mount)
 *
 * IMPORTANT for Railway:
 *   Add a Volume in Railway at /data and set DB_PATH=/data/calls.db
 *   Without a volume, /tmp is reset on each deploy.
 */

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_PATH = process.env.DB_PATH || "/tmp/calls.db";

// Ensure directory exists
try {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
} catch (_) {}

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH, {
      // WAL mode = much better concurrent read performance
      verbose: process.env.DB_VERBOSE === "true" ? console.log : undefined,
    });
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  }
  return db;
}

// ── Schema ─────────────────────────────────────────────────────────────────────

function initSchema() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_calls (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,

      -- ServiceTitan identifiers
      service_titan_call_id TEXT    NOT NULL UNIQUE,
      caller_phone_number   TEXT,
      timestamp             TEXT,   -- ISO-8601 call timestamp

      -- Raw data
      raw_webhook_payload   TEXT,   -- JSON string of the original ST payload

      -- Transcription
      transcript            TEXT,
      transcript_metadata   TEXT,   -- JSON: provider, duration, etc.

      -- Classification
      summary               TEXT,
      category              TEXT,
      sentiment             TEXT,
      is_spam               INTEGER DEFAULT 0,  -- SQLite bool: 0/1
      is_job_related        INTEGER DEFAULT 0,
      confidence            REAL    DEFAULT 0,
      recommended_action    TEXT,
      classification_model  TEXT,

      -- Customer/job matching
      matched_customer_id   INTEGER,
      matched_customer_name TEXT,
      matched_job_id        INTEGER,
      matched_job_number    TEXT,
      match_confidence      REAL    DEFAULT 0,
      match_method          TEXT,

      -- Processing state
      status                TEXT    DEFAULT 'pending',
        -- pending | processing | completed | failed
      error_message         TEXT,
      processing_attempts   INTEGER DEFAULT 0,

      -- Timestamps
      created_at            TEXT    DEFAULT (datetime('now')),
      updated_at            TEXT    DEFAULT (datetime('now'))
    );

    -- Index on call ID for fast lookups
    CREATE INDEX IF NOT EXISTS idx_processed_calls_st_id
      ON processed_calls (service_titan_call_id);

    -- Index on phone number for matching lookups
    CREATE INDEX IF NOT EXISTS idx_processed_calls_phone
      ON processed_calls (caller_phone_number);

    -- Index on status for queue drain queries
    CREATE INDEX IF NOT EXISTS idx_processed_calls_status
      ON processed_calls (status);

    -- Index for recent calls queries
    CREATE INDEX IF NOT EXISTS idx_processed_calls_created_at
      ON processed_calls (created_at DESC);
  `);

  // Happy Review deduplication table
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_happy_reviews (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id  TEXT NOT NULL UNIQUE,
      customer_name  TEXT,
      job_number     TEXT,
      processed_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_phr_submission_id
      ON processed_happy_reviews (submission_id);
  `);

  // Installed Equipment registrations — one row per unit entered on the
  // Equipment page. Drives both the ServiceTitan write (st_installed_equipment_id)
  // and the Rinnai ProPortal CSV export (proportal_row / proportal_exported).
  db.exec(`
    CREATE TABLE IF NOT EXISTS installed_equipment_registrations (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_type_id         TEXT NOT NULL,        -- e.g. rinnai-sensei-tankless

      -- ServiceTitan linkage
      st_installed_equipment_id INTEGER,              -- ST record id (null if write failed)
      st_customer_id            INTEGER,
      st_customer_name          TEXT,
      st_location_id            INTEGER,
      location_address          TEXT,                 -- formatted, for display

      -- Unit details
      model                     TEXT,
      serial_number             TEXT,
      installed_on              TEXT,                 -- YYYY-MM-DD
      manufacture_date          TEXT,                 -- decoded from serial (YYYY-MM-01)
      warranty_start            TEXT,
      warranty_end              TEXT,

      -- Full payloads (JSON) for audit + CSV regeneration
      form_data                 TEXT,                 -- JSON of the submitted form
      proportal_row             TEXT,                 -- JSON of the ProPortal CSV row

      -- ProPortal export state
      proportal_exported        INTEGER DEFAULT 0,    -- 0 = not yet downloaded, 1 = exported
      proportal_exported_at     TEXT,

      -- ServiceTitan write state
      st_write_status           TEXT DEFAULT 'created', -- created | failed | skipped
      st_error                  TEXT,

      created_by                TEXT,                 -- dashboard user email
      created_at                TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ier_serial
      ON installed_equipment_registrations (serial_number);
    CREATE INDEX IF NOT EXISTS idx_ier_location
      ON installed_equipment_registrations (st_location_id);
    CREATE INDEX IF NOT EXISTS idx_ier_proportal
      ON installed_equipment_registrations (proportal_exported);
    CREATE INDEX IF NOT EXISTS idx_ier_created_at
      ON installed_equipment_registrations (created_at DESC);
  `);

  console.log(`[DB] Schema ready at ${DB_PATH}`);

  // ── Migrations ─────────────────────────────────────────────────────────────
  // SQLite doesn't support ADD COLUMN IF NOT EXISTS, so we use try/catch.
  // Each migration is idempotent — safe to run repeatedly on startup.

  // v2: track whether ST notes/tags have been applied manually
  try { db.exec("ALTER TABLE processed_calls ADD COLUMN notes_applied_at TEXT DEFAULT NULL"); } catch (_) {}

  // v2: allow user to override the AI-detected category before applying notes
  try { db.exec("ALTER TABLE processed_calls ADD COLUMN manual_category TEXT DEFAULT NULL"); } catch (_) {}

  // v3: ST call reason selected by user (why the call wasn't booked)
  try { db.exec("ALTER TABLE processed_calls ADD COLUMN call_reason TEXT DEFAULT NULL"); } catch (_) {}

  // v3: when a call is dismissed from the review queue
  try { db.exec("ALTER TABLE processed_calls ADD COLUMN dismissed_at TEXT DEFAULT NULL"); } catch (_) {}

  // v4: ST call classification type (Excused | Unbooked | NotLead | Booked | Abandoned)
  try { db.exec("ALTER TABLE processed_calls ADD COLUMN call_type TEXT DEFAULT NULL"); } catch (_) {}

  // v10: AI recap as 3–4 bullet points (JSON array string). Stored alongside the
  // legacy `summary` field so existing records keep rendering until they're reprocessed.
  try { db.exec("ALTER TABLE processed_calls ADD COLUMN summary_bullets TEXT DEFAULT NULL"); } catch (_) {}

  // v10: Distinguish calls that came from an uploaded recording vs. a polled ST call.
  //      "polled" (default) | "upload" | "webhook"
  try { db.exec("ALTER TABLE processed_calls ADD COLUMN source TEXT DEFAULT 'polled'"); } catch (_) {}

  // v11: Record the exact ST target the note was written to when posting.
  //      applied_job_number is the human-readable number the card shows.
  try { db.exec("ALTER TABLE processed_calls ADD COLUMN applied_job_id INTEGER DEFAULT NULL"); } catch (_) {}
  try { db.exec("ALTER TABLE processed_calls ADD COLUMN applied_job_number TEXT DEFAULT NULL"); } catch (_) {}
  try { db.exec("ALTER TABLE processed_calls ADD COLUMN applied_customer_id INTEGER DEFAULT NULL"); } catch (_) {}

  // v12: Out-of-window jobs for the matched customer. Stored as a JSON array
  //      so the calls page can render "review manually" candidates when the
  //      customer had jobs but none fell within the ±14-day auto-assign window.
  try { db.exec("ALTER TABLE processed_calls ADD COLUMN candidate_jobs TEXT DEFAULT NULL"); } catch (_) {}

  // v13: Auto-sync of AI-derived ST callType. Track when + what was pushed so
  //      the UI can show "✓ ST synced as Unbooked" and we don't re-sync needlessly.
  try { db.exec("ALTER TABLE processed_calls ADD COLUMN classification_synced_at TEXT DEFAULT NULL"); } catch (_) {}
  try { db.exec("ALTER TABLE processed_calls ADD COLUMN classification_synced_type TEXT DEFAULT NULL"); } catch (_) {}

  // v18: Internal employee identification. When a call's caller number matches
  //      a row in the employee_phones roster, we persist a small JSON snapshot
  //      of who it was (name, trade, truck, phone type) so the UI can render a
  //      "🏢 Employee call" badge without a join every render.
  try { db.exec("ALTER TABLE processed_calls ADD COLUMN internal_employee TEXT DEFAULT NULL"); } catch (_) {}

  // v18: Employee phone roster. Seeded on startup from data/employee-roster.json
  //      (parsed from EmployeePhoneRoster.xls). Used by matching to short-circuit
  //      caller-is-an-employee calls so they don't hit the customer lookup path.
  db.exec(`
    CREATE TABLE IF NOT EXISTS employee_phones (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number   TEXT NOT NULL UNIQUE,     -- 10-digit normalized
      employee_name  TEXT NOT NULL,
      trade          TEXT,
      extension      TEXT,
      truck_number   TEXT,
      phone_type     TEXT,                     -- personal | company | mobile | facility
      active         INTEGER DEFAULT 1,
      source         TEXT DEFAULT 'roster',    -- roster | manual | auto
      created_at     TEXT DEFAULT (datetime('now')),
      updated_at     TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_employee_phones_active
      ON employee_phones (active);
  `);

  // v5: YouTube upload log — one row per video pushed from an ST job to YouTube
  db.exec(`
    CREATE TABLE IF NOT EXISTS video_uploads (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      job_number        TEXT,
      job_id            TEXT,
      street_address    TEXT,
      youtube_video_id  TEXT NOT NULL,
      youtube_url       TEXT NOT NULL,
      created_at        TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_video_uploads_created_at
      ON video_uploads (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_video_uploads_job_number
      ON video_uploads (job_number);
  `);

  // v6: Fleet tracking — technician/truck mapping and known addresses
  db.exec(`
    CREATE TABLE IF NOT EXISTS fleet_technicians (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      truck_number TEXT NOT NULL UNIQUE,
      tech_name   TEXT NOT NULL,
      group_name  TEXT,
      active      INTEGER DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS known_addresses (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      address        TEXT NOT NULL,
      normalized     TEXT NOT NULL,
      label          TEXT DEFAULT '',
      truck_number   TEXT,
      sample_visit   TEXT,
      created_at     TEXT DEFAULT (datetime('now')),
      updated_at     TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_known_addresses_normalized
      ON known_addresses (normalized);
  `);

  // v7: Invoice → PO import log — one row per supplier invoice run through the parser
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoice_uploads (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor          TEXT,
      invoice_number  TEXT,
      invoice_date    TEXT,
      job_number      TEXT,
      job_id          TEXT,
      vendor_id       TEXT,
      total           REAL,
      po_id           TEXT,
      po_number       TEXT,
      status          TEXT NOT NULL,          -- 'created' | 'failed'
      error           TEXT,
      file_name       TEXT,
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_invoice_uploads_created_at
      ON invoice_uploads (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_invoice_uploads_job_number
      ON invoice_uploads (job_number);
  `);

  // v8: Track whether the original PDF was successfully attached to the PO in ST
  try {
    db.exec(`ALTER TABLE invoice_uploads ADD COLUMN attached INTEGER DEFAULT 0`);
  } catch (_) {}
  try {
    db.exec(`ALTER TABLE invoice_uploads ADD COLUMN attach_error TEXT`);
  } catch (_) {}

  // v9: Track whether the PO was auto-marked Sent in ST after creation
  try {
    db.exec(`ALTER TABLE invoice_uploads ADD COLUMN sent INTEGER DEFAULT 0`);
  } catch (_) {}
  try {
    db.exec(`ALTER TABLE invoice_uploads ADD COLUMN sent_error TEXT`);
  } catch (_) {}

  // v14: Local pricebook index — services, materials, equipment cached from ST
  //      for fast fuzzy matching during scope-of-work parsing. Refreshed by
  //      a nightly cron plus an on-demand refresh button.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pricebook_index (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      st_id         INTEGER NOT NULL,
      sku_type      TEXT NOT NULL,          -- 'Service' | 'Material' | 'Equipment'
      name          TEXT,
      code          TEXT,
      description   TEXT,
      price         REAL,
      active        INTEGER DEFAULT 1,
      tokens        TEXT,                   -- space-joined lowercased tokens for fuzzy search
      synced_at     TEXT DEFAULT (datetime('now')),
      UNIQUE(st_id, sku_type)
    );
    CREATE INDEX IF NOT EXISTS idx_pricebook_index_sku_type
      ON pricebook_index (sku_type);
    CREATE INDEX IF NOT EXISTS idx_pricebook_index_active
      ON pricebook_index (active);

    CREATE TABLE IF NOT EXISTS pricebook_sync_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at    TEXT DEFAULT (datetime('now')),
      finished_at   TEXT,
      status        TEXT NOT NULL,          -- 'running' | 'ok' | 'failed'
      services      INTEGER DEFAULT 0,
      materials     INTEGER DEFAULT 0,
      equipment     INTEGER DEFAULT 0,
      error         TEXT
    );

    -- v15: Scope parse audit log — one row per estimate created from a parsed scope
    CREATE TABLE IF NOT EXISTS scope_estimate_uploads (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name         TEXT,
      job_number        TEXT,
      job_id            INTEGER,
      estimate_id       INTEGER,
      line_item_count   INTEGER,
      total             REAL,
      status            TEXT NOT NULL,      -- 'created' | 'failed'
      error             TEXT,
      created_at        TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_scope_estimate_uploads_created_at
      ON scope_estimate_uploads (created_at DESC);

    -- v16: Pricebook merge log — one row per soft-merge action, for audit + undo.
    -- Each merge action deactivates one or more duplicates, optionally copies fields
    -- from the canonical record. canonical_id points to the SKU kept active.
    CREATE TABLE IF NOT EXISTS pricebook_merge_log (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      merged_at           TEXT DEFAULT (datetime('now')),
      sku_type            TEXT NOT NULL,        -- 'Service' | 'Material' | 'Equipment'
      canonical_st_id     INTEGER NOT NULL,     -- the SKU kept active
      canonical_code      TEXT,                 -- snapshot for audit
      canonical_name      TEXT,                 -- snapshot for audit
      duplicate_st_ids    TEXT NOT NULL,        -- JSON array of st_ids deactivated
      duplicate_snapshot  TEXT,                 -- JSON array of {st_id, code, name, price, active} pre-merge
      field_copy          INTEGER DEFAULT 0,    -- 0 or 1, whether fields were copied to canonical
      fields_copied       TEXT,                 -- JSON object {field: new_value}
      canonical_snapshot  TEXT,                 -- JSON {code, name, price, ...} pre-merge (for undo)
      status              TEXT NOT NULL,        -- 'ok' | 'partial' | 'failed' | 'undone'
      error               TEXT,
      user_note           TEXT,
      undone_at           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pricebook_merge_log_merged_at
      ON pricebook_merge_log (merged_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pricebook_merge_log_canonical
      ON pricebook_merge_log (canonical_st_id, sku_type);

    -- v17: Material rename tool — audit + reviewed-item tracking so the
    -- rename review queue doesn't keep surfacing items you've already
    -- accepted or skipped. The log doubles as an undo breadcrumb.
    CREATE TABLE IF NOT EXISTS pricebook_rename_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      st_id          INTEGER NOT NULL,
      sku_type       TEXT NOT NULL,          -- 'Material' | 'Service' | 'Equipment'
      old_name       TEXT,
      new_name       TEXT,                   -- null on status='skipped'
      status         TEXT NOT NULL,          -- 'applied' | 'skipped' | 'failed'
      error          TEXT,
      created_at     TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pricebook_rename_log_created_at
      ON pricebook_rename_log (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pricebook_rename_log_st_id
      ON pricebook_rename_log (st_id, sku_type);

    -- v18: Pricebook image tool — audit every auto-generated/fetched image.
    -- One row per generation attempt (source, status, path, error). Lets us
    -- show an audit panel and not re-generate the same SKU's image repeatedly.
    CREATE TABLE IF NOT EXISTS pricebook_image_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      st_id          INTEGER NOT NULL,
      sku_type       TEXT NOT NULL,          -- 'Material' | 'Service' | 'Equipment'
      source         TEXT NOT NULL,          -- 'manufacturer' | 'ai' | 'skipped' | 'existing'
      image_path     TEXT,                   -- ST storage path (Images/...)
      prompt         TEXT,                   -- AI prompt used when source='ai'
      status         TEXT NOT NULL,          -- 'ok' | 'failed' | 'skipped'
      error          TEXT,
      created_at     TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pricebook_image_log_created_at
      ON pricebook_image_log (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pricebook_image_log_st_id
      ON pricebook_image_log (st_id, sku_type);
  `);

  // v17 (cont'd): Add rename-tracking columns to pricebook_index. Wrapped
  // in try/catch because ALTER TABLE errors when the column already exists
  // and SQLite has no IF NOT EXISTS for ADD COLUMN.
  try {
    db.exec(`ALTER TABLE pricebook_index ADD COLUMN renamed_at TEXT`);
  } catch (_) {}
  try {
    db.exec(`ALTER TABLE pricebook_index ADD COLUMN rename_reviewed_at TEXT`);
  } catch (_) {}
  // v18: Image cache — the ST storage path on the canonical SKU. Lets the UI
  // show "has image / missing" without a per-row ST GET. Populated during
  // syncAll + any time we call ensureImage() with a successful result.
  try {
    db.exec(`ALTER TABLE pricebook_index ADD COLUMN image_path TEXT`);
  } catch (_) {}
  try {
    db.exec(`ALTER TABLE pricebook_index ADD COLUMN image_checked_at TEXT`);
  } catch (_) {}

  // v19: Auth — users table for dashboard login.
  //      Password hashed with bcrypt (cost 12) before storage.
  //      Lives on the same /data volume as everything else, so logins
  //      survive Railway redeploys.
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash   TEXT NOT NULL,
      display_name    TEXT,
      active          INTEGER DEFAULT 1,
      must_change_pw  INTEGER DEFAULT 0,   -- forces password rotation on next login
      created_at      TEXT DEFAULT (datetime('now')),
      last_login_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
  `);

  // v21: Address audit cache — one row per ST location we've verified.
  //      Lets us skip Google calls on locations whose addresses haven't
  //      changed since the last audit (fingerprint match). Schema is kept
  //      additive-friendly: every read path tolerates the absence of a row.
  db.exec(`
    CREATE TABLE IF NOT EXISTS address_audit_cache (
      location_id          INTEGER PRIMARY KEY,
      customer_id          INTEGER,
      address_fingerprint  TEXT NOT NULL,         -- SHA-1 of normalized street|unit|city|state|zip5
      status               TEXT NOT NULL,         -- ok | standardized | partial | undeliverable | no-match | incomplete | error
      verified_json        TEXT,                  -- JSON of the verified address (Google-standardized)
      verified_formatted   TEXT,                  -- Google's formatted_address
      partial_match        INTEGER DEFAULT 0,
      location_type        TEXT,                  -- ROOFTOP | RANGE_INTERPOLATED | GEOMETRIC_CENTER | APPROXIMATE
      lat                  REAL,
      lng                  REAL,
      place_id             TEXT,
      error                TEXT,
      checked_at           TEXT DEFAULT (datetime('now')),
      applied_at           TEXT,                  -- when the user pushed the correction back to ST
      dismissed_at         TEXT,                  -- when the user marked it "ignore"
      updated_at           TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_address_audit_status
      ON address_audit_cache (status);
    CREATE INDEX IF NOT EXISTS idx_address_audit_checked_at
      ON address_audit_cache (checked_at DESC);
  `);

  // v21.1: Store the original ST address alongside the verified one so we can
  // re-classify the cache in-process when the classifier itself improves
  // (e.g. smarter street-suffix normalization). Without this, reclassify
  // can't compare the two sides — it'd just be comparing verified to itself.
  try { db.exec("ALTER TABLE address_audit_cache ADD COLUMN original_json TEXT"); } catch (_) {}

  // v21.2: Track the ST location.name + the suggested rewrite, so name
  // audit suggestions persist across scans and the manual override sub-row
  // can pre-fill them. Name fixes only surface when the address row is
  // already an issue (per user preference).
  try { db.exec("ALTER TABLE address_audit_cache ADD COLUMN original_name TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE address_audit_cache ADD COLUMN suggested_name TEXT"); } catch (_) {}

  // v22: Open-jobs review status — lets the office mark a flagged job as
  //      reviewed, escalated for deeper investigation, or fully resolved.
  //      Keyed on jobNumber so the Open Jobs page can match without needing
  //      a stable ST id. Notes + actor + timestamp let us audit who did what.
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_review_status (
      job_number    TEXT PRIMARY KEY,
      status        TEXT NOT NULL,             -- 'reviewed' | 'escalated' | 'resolved'
      notes         TEXT,
      reviewed_by   TEXT,
      reviewed_at   TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_job_review_status_status
      ON job_review_status (status);
    CREATE INDEX IF NOT EXISTS idx_job_review_status_updated_at
      ON job_review_status (updated_at DESC);
  `);

  // v22.1: Track if/when this note was pushed to the actual ServiceTitan
  //        job-notes feed so accounting sees it when they pull up the job.
  //        Storing the synced text lets us skip a re-push when nothing changed.
  try { db.exec("ALTER TABLE job_review_status ADD COLUMN st_note_synced_at   TEXT DEFAULT NULL"); } catch (_) {}
  try { db.exec("ALTER TABLE job_review_status ADD COLUMN st_note_synced_text TEXT DEFAULT NULL"); } catch (_) {}
  try { db.exec("ALTER TABLE job_review_status ADD COLUMN st_note_error       TEXT DEFAULT NULL"); } catch (_) {}

  // v22.2: Corrections — reviewer can override the ST job's status and/or
  //        job type. These are non-destructive: jobs.json (Excel-imported
  //        cache) is never rewritten. The monthly data loader applies these
  //        as an overlay at read time, and the "push to ServiceTitan" flow
  //        on the Resolved tab PATCHes ST with the corrected values.
  //        Per-field sync state lets a partial push (status synced, jobType
  //        rejected by tenant) be recorded honestly.
  try { db.exec("ALTER TABLE job_review_status ADD COLUMN corrected_status              TEXT DEFAULT NULL"); } catch (_) {}
  try { db.exec("ALTER TABLE job_review_status ADD COLUMN corrected_job_type            TEXT DEFAULT NULL"); } catch (_) {}
  try { db.exec("ALTER TABLE job_review_status ADD COLUMN status_synced_at              TEXT DEFAULT NULL"); } catch (_) {}
  try { db.exec("ALTER TABLE job_review_status ADD COLUMN status_synced_value           TEXT DEFAULT NULL"); } catch (_) {}
  try { db.exec("ALTER TABLE job_review_status ADD COLUMN status_sync_error             TEXT DEFAULT NULL"); } catch (_) {}
  try { db.exec("ALTER TABLE job_review_status ADD COLUMN job_type_synced_at            TEXT DEFAULT NULL"); } catch (_) {}
  try { db.exec("ALTER TABLE job_review_status ADD COLUMN job_type_synced_value         TEXT DEFAULT NULL"); } catch (_) {}
  try { db.exec("ALTER TABLE job_review_status ADD COLUMN job_type_sync_error           TEXT DEFAULT NULL"); } catch (_) {}

  // v22.3: Append-only note log. The legacy `notes` column on job_review_status
  //        is a single editable string — fine for the original "drop a quick
  //        note" workflow. For the new "add a note while reviewing, then push
  //        all of them to ST as separate notes" flow we want each addition
  //        tracked individually with its own sync state. New rows are created
  //        via appendNote(); marked synced via markNoteSynced(noteId, ...).
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_review_notes (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      job_number          TEXT    NOT NULL,
      text                TEXT    NOT NULL,
      author              TEXT,
      added_at            TEXT    DEFAULT (datetime('now')),
      st_note_synced_at   TEXT    DEFAULT NULL,
      st_note_synced_text TEXT    DEFAULT NULL,
      st_note_error       TEXT    DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_review_notes_job
      ON job_review_notes (job_number, added_at DESC);
    CREATE INDEX IF NOT EXISTS idx_job_review_notes_unsynced
      ON job_review_notes (job_number) WHERE st_note_synced_at IS NULL;
  `);

  // v20: User roles — admin gate for the /users management page.
  //      Only admins can add/remove/reset other users. Everyone else still
  //      has full access to the rest of the dashboard.
  try { db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0"); } catch (_) {}

  // v25: First/last name on users. display_name stays the casual label shown
  //      in the nav (set to the first name), while first_name + last_name give
  //      the full legal name the timesheet prints. Both nullable + additive.
  try { db.exec("ALTER TABLE users ADD COLUMN first_name TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE users ADD COLUMN last_name  TEXT"); } catch (_) {}

  // Bootstrap: ensure at least one admin exists. If no user is flagged as
  // admin yet but users do exist, promote the oldest user (the seeded one).
  // Idempotent — once an admin exists this is a no-op.
  try {
    const adminCount = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE is_admin = 1`).get().c;
    const userCount  = db.prepare(`SELECT COUNT(*) AS c FROM users`).get().c;
    if (adminCount === 0 && userCount > 0) {
      const first = db.prepare(`SELECT id, email FROM users ORDER BY id ASC LIMIT 1`).get();
      db.prepare(`UPDATE users SET is_admin = 1 WHERE id = ?`).run(first.id);
      console.log(`[DB] Bootstrap: promoted ${first.email} to admin`);
    }
  } catch (err) {
    console.error(`[DB] Admin bootstrap failed (non-fatal): ${err.message}`);
  }

  // v23: Employee timesheets — administrative weekly grid (Wed→Tue) with a
  //      per-employee running Comp Time balance and a frontloaded P-Law
  //      balance that only counts down. One row per (employee, pay period).
  //
  //      grid_json holds the 6×7 hour grid exactly as entered. The server
  //      always recomputes totals from it (see timesheetBalanceService) so
  //      the client can't spoof numbers.
  //
  //      When a sheet is PROCESSED we snapshot the exact balance change it
  //      caused into applied_comp_delta / applied_plaw_delta (the ongoing
  //      change) plus applied_init_comp / applied_init_plaw (the one-time
  //      starting-balance seed, if this was the employee's first sheet).
  //      Reopening a sheet reverses precisely those recorded amounts, so an
  //      edited week reverses-then-reapplies without ever double counting.
  db.exec(`
    CREATE TABLE IF NOT EXISTS timesheets (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             INTEGER NOT NULL,       -- FK → users.id (the employee)
      employee_name       TEXT,                   -- snapshot of display name at save time
      period_start        TEXT NOT NULL,          -- 'YYYY-MM-DD' (a Wednesday)
      period_end          TEXT,                   -- 'YYYY-MM-DD' (the Tuesday)
      status              TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'processed'
      grid_json           TEXT,                   -- JSON: { rowKey: { dayKey: "hours" } }
      notes               TEXT,
      comp_used           REAL DEFAULT 0,         -- comp hours taken as leave this period
      banked_comp_input   REAL,                   -- starting comp, entered on the first sheet
      plaw_start_input    REAL,                   -- starting P-Law, entered on the first sheet

      -- Snapshot of the exact balance change applied at process time. NULL
      -- while the sheet is a draft. init_* are NULL unless this sheet was the
      -- one that seeded the employee's starting balance.
      applied_comp_delta  REAL,
      applied_plaw_delta  REAL,
      applied_init_comp   REAL,
      applied_init_plaw   REAL,

      processed_at        TEXT,
      created_at          TEXT DEFAULT (datetime('now')),
      updated_at          TEXT DEFAULT (datetime('now')),

      UNIQUE (user_id, period_start)
    );
    CREATE INDEX IF NOT EXISTS idx_timesheets_user
      ON timesheets (user_id, period_start DESC);
    CREATE INDEX IF NOT EXISTS idx_timesheets_status
      ON timesheets (user_id, status);
  `);

  // v23: Per-employee leave balances. One row per user. comp_balance is a
  //      running two-way total (earned − used, 1:1). plaw_balance is set once
  //      (frontloaded) and only decreases. The *_initialized flags gate the
  //      one-time seeding so the "Banked / P-Law start" fields on the first
  //      sheet can't be re-applied on later sheets.
  db.exec(`
    CREATE TABLE IF NOT EXISTS timesheet_balances (
      user_id           INTEGER PRIMARY KEY,      -- FK → users.id
      comp_balance      REAL DEFAULT 0,
      plaw_balance      REAL DEFAULT 0,
      comp_initialized  INTEGER DEFAULT 0,
      plaw_initialized  INTEGER DEFAULT 0,
      updated_at        TEXT DEFAULT (datetime('now'))
    );
  `);

  // v23.1: Overtime handling. pay_overtime=1 means this shop paid OT that week
  //        (the week may exceed 40, nothing is banked). When 0 (the norm), any
  //        hours over 40 are banked to comp: ot_banked holds that amount, and
  //        it's applied as a negative to the comp total so payable = 40.
  try { db.exec("ALTER TABLE timesheets ADD COLUMN pay_overtime INTEGER DEFAULT 0"); } catch (_) {}
  try { db.exec("ALTER TABLE timesheets ADD COLUMN ot_banked REAL DEFAULT 0"); } catch (_) {}

  // v24: Live time clock (HoursTracker-style punches). One row per clock-in.
  //      Times are ISO timestamps the browser sends in the employee's local
  //      zone; work_date is the LOCAL calendar day the punch counts toward.
  //      On clock-out we compute rounded worked hours and drop them onto that
  //      day's Regular cell of the matching pay period (applied_* records
  //      where they landed). Only one 'active' punch per employee at a time.
  db.exec(`
    CREATE TABLE IF NOT EXISTS time_punches (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             INTEGER NOT NULL,
      work_date           TEXT NOT NULL,          -- 'YYYY-MM-DD' local
      clock_in            TEXT NOT NULL,          -- ISO timestamp
      clock_out           TEXT,                   -- ISO timestamp (null while active)
      break_seconds       INTEGER DEFAULT 0,      -- accumulated break time
      break_started_at    TEXT,                   -- ISO while currently on break, else null
      hours               REAL,                   -- rounded worked hours, set on clock-out
      status              TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'closed'
      applied_period_start TEXT,                  -- pay period the hours landed in
      applied_day         TEXT,                   -- grid day-key (wed…tue)
      note                TEXT,
      source              TEXT DEFAULT 'clock',   -- 'clock' | 'manual'
      created_at          TEXT DEFAULT (datetime('now')),
      updated_at          TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_time_punches_user_status
      ON time_punches (user_id, status);
    CREATE INDEX IF NOT EXISTS idx_time_punches_user_date
      ON time_punches (user_id, work_date DESC);

    -- Editable app settings (key/value). Backs the AI Instructions popup so the
    -- classification + transcription prompts can be tuned from the UI without a
    -- code change or redeploy. NULL/absent value = "use the built-in default".
    CREATE TABLE IF NOT EXISTS app_settings (
      key         TEXT PRIMARY KEY,
      value       TEXT,
      updated_at  TEXT DEFAULT (datetime('now')),
      updated_by  TEXT
    );
  `);

  // Install Tracker overlay. The list of completed installs is always pulled
  // live from ServiceTitan; this table stores only what the office manually
  // confirms on top of that list — that the equipment was listed in
  // ServiceTitan and the manufacturer warranty was registered — plus notes.
  // Keyed by the ServiceTitan internal job id; a display snapshot is kept so
  // the row still reads well if the job later drops out of the date window.
  // See services/installTrackerService.js + db/installTrackerRepository.js.
  db.exec(`
    CREATE TABLE IF NOT EXISTS install_tracker (
      st_job_id               INTEGER PRIMARY KEY,   -- ServiceTitan internal job id
      job_number              TEXT,                  -- snapshot for display/search
      job_type_id             INTEGER,
      job_type_name           TEXT,
      category                TEXT,                  -- 'HVAC' | 'Water Heater'
      customer_id             INTEGER,
      customer_name           TEXT,
      location_id             INTEGER,
      completed_on            TEXT,                  -- ISO completion date snapshot
      equipment_listed        INTEGER DEFAULT 0,     -- office confirmed unit is in ST
      equipment_listed_at     TEXT,
      equipment_listed_by     TEXT,
      warranty_registered     INTEGER DEFAULT 0,     -- office confirmed warranty done
      warranty_registered_at  TEXT,
      warranty_registered_by  TEXT,
      notes                   TEXT,
      created_at              TEXT DEFAULT (datetime('now')),
      updated_at              TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_install_tracker_completed
      ON install_tracker (completed_on DESC);
  `);

  console.log("[DB] Migrations applied");
}

// ── App settings (key/value) ────────────────────────────────────────────────────

/**
 * Read a single app setting. Returns the stored string, or `fallback` when the
 * key is absent or its value is NULL/empty.
 */
function getSetting(key, fallback = null) {
  const db = getDb();
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(String(key));
  if (!row || row.value == null || row.value === "") return fallback;
  return row.value;
}

/**
 * Upsert a single app setting. Passing null/undefined/"" deletes the row so the
 * caller falls back to the built-in default ("reset to default").
 */
function setSetting(key, value, updatedBy = null) {
  const db = getDb();
  if (value == null || value === "") {
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(String(key));
    return;
  }
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at, updated_by)
    VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(String(key), String(value), updatedBy || null);
}

/** Return { updatedAt, updatedBy } metadata for a setting, or null if unset. */
function getSettingMeta(key) {
  const db = getDb();
  const row = db.prepare("SELECT updated_at, updated_by FROM app_settings WHERE key = ?").get(String(key));
  if (!row) return null;
  return { updatedAt: row.updated_at || null, updatedBy: row.updated_by || null };
}

function isHappyReviewProcessed(submissionId) {
  const db = getDb();
  const row = db.prepare("SELECT id FROM processed_happy_reviews WHERE submission_id = ?").get(String(submissionId));
  return !!row;
}

function markHappyReviewProcessed(submissionId, customerName, jobNumber) {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO processed_happy_reviews (submission_id, customer_name, job_number) VALUES (?, ?, ?)"
  ).run(String(submissionId), customerName || null, jobNumber || null);
}

module.exports = {
  getDb,
  initSchema,
  isHappyReviewProcessed,
  markHappyReviewProcessed,
  getSetting,
  setSetting,
  getSettingMeta,
};
