/**
 * callRepository.js
 *
 * All database access for the processed_calls table.
 * All methods are synchronous (better-sqlite3 is sync by design).
 *
 * Column name convention: snake_case in DB, camelCase in JS.
 * The toJs() helper converts on the way out.
 */

const { getDb } = require("./index");

// ── Write ──────────────────────────────────────────────────────────────────────

/**
 * Insert or update a call record.
 * Uses UPSERT so a reprocessed call replaces its previous row.
 *
 * @param {object} data - See column list in schema
 * @returns {object} The inserted/updated row
 */
function upsertCall(data) {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT INTO processed_calls (
      service_titan_call_id,
      caller_phone_number,
      timestamp,
      raw_webhook_payload,
      transcript,
      transcript_metadata,
      summary,
      summary_bullets,
      source,
      category,
      sentiment,
      is_spam,
      is_job_related,
      confidence,
      recommended_action,
      classification_model,
      matched_customer_id,
      matched_customer_name,
      matched_job_id,
      matched_job_number,
      match_confidence,
      match_method,
      candidate_jobs,
      internal_employee,
      status,
      error_message,
      processing_attempts,
      updated_at
    ) VALUES (
      @serviceTitanCallId,
      @callerPhoneNumber,
      @timestamp,
      @rawWebhookPayload,
      @transcript,
      @transcriptMetadata,
      @summary,
      @summaryBullets,
      @source,
      @category,
      @sentiment,
      @isSpam,
      @isJobRelated,
      @confidence,
      @recommendedAction,
      @classificationModel,
      @matchedCustomerId,
      @matchedCustomerName,
      @matchedJobId,
      @matchedJobNumber,
      @matchConfidence,
      @matchMethod,
      @candidateJobs,
      @internalEmployee,
      @status,
      @errorMessage,
      @processingAttempts,
      datetime('now')
    )
    ON CONFLICT(service_titan_call_id) DO UPDATE SET
      caller_phone_number   = excluded.caller_phone_number,
      timestamp             = excluded.timestamp,
      raw_webhook_payload   = COALESCE(excluded.raw_webhook_payload, raw_webhook_payload),
      transcript            = COALESCE(excluded.transcript, transcript),
      transcript_metadata   = COALESCE(excluded.transcript_metadata, transcript_metadata),
      summary               = COALESCE(excluded.summary, summary),
      summary_bullets       = COALESCE(excluded.summary_bullets, summary_bullets),
      source                = COALESCE(excluded.source, source),
      category              = COALESCE(excluded.category, category),
      sentiment             = COALESCE(excluded.sentiment, sentiment),
      is_spam               = excluded.is_spam,
      is_job_related        = excluded.is_job_related,
      confidence            = excluded.confidence,
      recommended_action    = COALESCE(excluded.recommended_action, recommended_action),
      classification_model  = COALESCE(excluded.classification_model, classification_model),
      matched_customer_id   = excluded.matched_customer_id,
      matched_customer_name = excluded.matched_customer_name,
      matched_job_id        = excluded.matched_job_id,
      matched_job_number    = excluded.matched_job_number,
      match_confidence      = excluded.match_confidence,
      match_method          = excluded.match_method,
      candidate_jobs        = excluded.candidate_jobs,
      internal_employee     = COALESCE(excluded.internal_employee, internal_employee),
      status                = excluded.status,
      error_message         = excluded.error_message,
      processing_attempts   = excluded.processing_attempts,
      updated_at            = datetime('now')
  `);

  stmt.run({
    serviceTitanCallId: String(data.serviceTitanCallId),
    callerPhoneNumber: data.callerPhoneNumber || null,
    timestamp: data.timestamp || null,
    rawWebhookPayload: typeof data.rawWebhookPayload === "object"
      ? JSON.stringify(data.rawWebhookPayload)
      : data.rawWebhookPayload || null,
    transcript: data.transcript || null,
    transcriptMetadata: data.transcriptMetadata
      ? JSON.stringify(data.transcriptMetadata)
      : null,
    summary: data.summary || null,
    summaryBullets: Array.isArray(data.summaryBullets)
      ? JSON.stringify(data.summaryBullets)
      : (typeof data.summaryBullets === "string" ? data.summaryBullets : null),
    source: data.source || null,
    category: data.category || null,
    sentiment: data.sentiment || null,
    isSpam: data.isSpam ? 1 : 0,
    isJobRelated: data.isJobRelated ? 1 : 0,
    confidence: data.confidence ?? 0,
    recommendedAction: data.recommendedAction || null,
    classificationModel: data.classificationModel || null,
    matchedCustomerId: data.matchedCustomerId || null,
    matchedCustomerName: data.matchedCustomerName || null,
    matchedJobId: data.matchedJobId || null,
    matchedJobNumber: data.matchedJobNumber || null,
    matchConfidence: data.matchConfidence ?? 0,
    matchMethod: data.matchMethod || null,
    candidateJobs: Array.isArray(data.candidateJobs)
      ? JSON.stringify(data.candidateJobs)
      : (typeof data.candidateJobs === "string" ? data.candidateJobs : null),
    internalEmployee: data.internalEmployee
      ? (typeof data.internalEmployee === "string"
          ? data.internalEmployee
          : JSON.stringify(data.internalEmployee))
      : null,
    status: data.status || "pending",
    errorMessage: data.errorMessage || null,
    processingAttempts: data.processingAttempts ?? 0,
  });

  return getCallByStId(String(data.serviceTitanCallId));
}

/**
 * Dismiss a call from the review queue (hides it from the default list).
 * Pass undismiss=true to bring it back.
 */
function dismissCall(serviceTitanCallId, undismiss = false) {
  const db = getDb();
  db.prepare(`
    UPDATE processed_calls
    SET dismissed_at = ${undismiss ? "NULL" : "datetime('now')"}, updated_at = datetime('now')
    WHERE service_titan_call_id = ?
  `).run(String(serviceTitanCallId));
}

/**
 * Record that the pipeline auto-synced the AI-derived callType to ST.
 * This is separate from setCallType (which stores a user override).
 */
function markClassificationSynced(serviceTitanCallId, callType) {
  const db = getDb();
  db.prepare(`
    UPDATE processed_calls
    SET classification_synced_at = datetime('now'),
        classification_synced_type = ?,
        updated_at = datetime('now')
    WHERE service_titan_call_id = ?
  `).run(callType || null, String(serviceTitanCallId));
}

/**
 * Save the ST call classification type selected by the user.
 * Valid values: Excused | Unbooked | NotLead | Booked | Abandoned
 */
function setCallType(serviceTitanCallId, callType) {
  const db = getDb();
  db.prepare(`
    UPDATE processed_calls
    SET call_type = ?, updated_at = datetime('now')
    WHERE service_titan_call_id = ?
  `).run(callType || null, String(serviceTitanCallId));
}

/**
 * Save the ST call reason selected by the user.
 */
function setCallReason(serviceTitanCallId, callReason) {
  const db = getDb();
  db.prepare(`
    UPDATE processed_calls
    SET call_reason = ?, updated_at = datetime('now')
    WHERE service_titan_call_id = ?
  `).run(callReason || null, String(serviceTitanCallId));
}

/**
 * Mark that notes + tags have been applied to this call in ServiceTitan.
 * Optionally record the exact target the note was written to so the UI can
 * show "Posted → Job #2601915" instead of a generic confirmation.
 *
 * @param {string} serviceTitanCallId
 * @param {object} [target]
 * @param {number|null} [target.appliedJobId]
 * @param {string|null} [target.appliedJobNumber]
 * @param {number|null} [target.appliedCustomerId]
 */
function markNotesApplied(serviceTitanCallId, target = {}) {
  const db = getDb();
  db.prepare(`
    UPDATE processed_calls
    SET notes_applied_at = datetime('now'),
        applied_job_id = COALESCE(?, applied_job_id),
        applied_job_number = COALESCE(?, applied_job_number),
        applied_customer_id = COALESCE(?, applied_customer_id),
        updated_at = datetime('now')
    WHERE service_titan_call_id = ?
  `).run(
    target.appliedJobId || null,
    target.appliedJobNumber || null,
    target.appliedCustomerId || null,
    String(serviceTitanCallId)
  );
}

/**
 * Override the AI-detected category with a user's manual selection.
 * Pass null to clear the override and revert to AI category.
 */
function updateCallCategory(serviceTitanCallId, manualCategory) {
  const db = getDb();
  db.prepare(`
    UPDATE processed_calls
    SET manual_category = ?, updated_at = datetime('now')
    WHERE service_titan_call_id = ?
  `).run(manualCategory || null, String(serviceTitanCallId));
}

/**
 * Replace the transcript text with a hand-corrected version.
 * Records an edit marker inside transcript_metadata (manuallyEdited + editedAt)
 * so the UI can show "edited" and the original provider metadata is preserved.
 * Does NOT touch the AI summary/category — re-classification is a separate,
 * explicit step (POST /api/calls/:callId/reclassify).
 */
function updateTranscript(serviceTitanCallId, transcript) {
  const db = getDb();
  const existing = getCallByStId(serviceTitanCallId);
  if (!existing) return null;

  const meta = existing.transcriptMetadata && typeof existing.transcriptMetadata === "object"
    ? { ...existing.transcriptMetadata }
    : {};
  meta.manuallyEdited = true;
  meta.editedAt = new Date().toISOString();

  db.prepare(`
    UPDATE processed_calls
    SET transcript = ?, transcript_metadata = ?, updated_at = datetime('now')
    WHERE service_titan_call_id = ?
  `).run(transcript == null ? null : String(transcript), JSON.stringify(meta), String(serviceTitanCallId));

  return getCallByStId(serviceTitanCallId);
}

/**
 * Update just the status (and optionally error message) for a call.
 */
function updateCallStatus(serviceTitanCallId, status, errorMessage = null) {
  const db = getDb();
  db.prepare(`
    UPDATE processed_calls
    SET status = ?, error_message = ?, updated_at = datetime('now')
    WHERE service_titan_call_id = ?
  `).run(status, errorMessage, String(serviceTitanCallId));
}

// ── Read ───────────────────────────────────────────────────────────────────────

function getCallByStId(serviceTitanCallId) {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM processed_calls WHERE service_titan_call_id = ?")
    .get(String(serviceTitanCallId));
  return row ? toJs(row) : null;
}

function getCallById(id) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM processed_calls WHERE id = ?").get(id);
  return row ? toJs(row) : null;
}

/**
 * Get the most recent N calls (default 50).
 */
function getRecentCalls({ limit = 50, status = null, includeDismissed = false, posted = null } = {}) {
  const db = getDb();
  const conditions = [];
  const params = [];

  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }
  if (posted === true) {
    // "Posted" = notes/tags have been pushed to ServiceTitan.
    conditions.push("notes_applied_at IS NOT NULL");
  }
  if (!includeDismissed) {
    conditions.push("dismissed_at IS NULL");
  }

  let sql = "SELECT * FROM processed_calls";
  if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);

  return db.prepare(sql).all(...params).map(toJs);
}

/**
 * Get calls that failed and haven't exceeded retry limit.
 */
function getFailedCalls() {
  return getRecentCalls({ status: "failed", limit: 100 });
}

/**
 * Simple stats summary for the admin dashboard.
 */
function getCallStats() {
  const db = getDb();
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN is_spam = 1          THEN 1 ELSE 0 END) AS spam,
      SUM(CASE WHEN is_job_related = 1   THEN 1 ELSE 0 END) AS jobRelated,
      SUM(CASE WHEN dismissed_at IS NOT NULL THEN 1 ELSE 0 END) AS dismissed
    FROM processed_calls
  `).get();

  const byCategory = db.prepare(`
    SELECT category, COUNT(*) AS count
    FROM processed_calls
    WHERE status = 'completed' AND category IS NOT NULL
    GROUP BY category
    ORDER BY count DESC
  `).all();

  const bySentiment = db.prepare(`
    SELECT sentiment, COUNT(*) AS count
    FROM processed_calls
    WHERE status = 'completed' AND sentiment IS NOT NULL
    GROUP BY sentiment
  `).all();

  return { totals, byCategory, bySentiment };
}

// ── Serialization ──────────────────────────────────────────────────────────────

/**
 * Convert a DB row (snake_case) to a JS object (camelCase).
 * Also parses JSON fields back to objects.
 */
function toJs(row) {
  if (!row) return null;
  return {
    id: row.id,
    serviceTitanCallId: row.service_titan_call_id,
    callerPhoneNumber: row.caller_phone_number,
    timestamp: row.timestamp,
    rawWebhookPayload: safeParseJson(row.raw_webhook_payload),
    transcript: row.transcript,
    transcriptMetadata: safeParseJson(row.transcript_metadata),
    summary: row.summary,
    summaryBullets: (() => {
      const parsed = safeParseJson(row.summary_bullets);
      if (Array.isArray(parsed)) return parsed;
      // Fallback for legacy records: split the prose summary into sentences
      if (row.summary && typeof row.summary === "string") {
        return row.summary
          .split(/(?<=[.!?])\s+|\s•\s|\n+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 4);
      }
      return [];
    })(),
    source: row.source || "polled",
    category: row.category,
    sentiment: row.sentiment,
    isSpam: Boolean(row.is_spam),
    isJobRelated: Boolean(row.is_job_related),
    confidence: row.confidence,
    recommendedAction: row.recommended_action,
    classificationModel: row.classification_model,
    matchedCustomerId: row.matched_customer_id,
    matchedCustomerName: row.matched_customer_name,
    matchedJobId: row.matched_job_id,
    matchedJobNumber: row.matched_job_number,
    matchConfidence: row.match_confidence,
    matchMethod: row.match_method,
    candidateJobs: (() => {
      const parsed = safeParseJson(row.candidate_jobs);
      return Array.isArray(parsed) ? parsed : [];
    })(),
    internalEmployee: (() => {
      const parsed = safeParseJson(row.internal_employee);
      return parsed && typeof parsed === "object" ? parsed : null;
    })(),
    status: row.status,
    errorMessage: row.error_message,
    processingAttempts: row.processing_attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    notesAppliedAt: row.notes_applied_at || null,
    appliedJobId: row.applied_job_id || null,
    appliedJobNumber: row.applied_job_number || null,
    appliedCustomerId: row.applied_customer_id || null,
    classificationSyncedAt: row.classification_synced_at || null,
    classificationSyncedType: row.classification_synced_type || null,
    manualCategory: row.manual_category || null,
    callReason: row.call_reason || null,
    callType: row.call_type || null,
    dismissedAt: row.dismissed_at || null,
  };
}

function safeParseJson(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch (_) { return str; }
}

// ── "New calls since the team last reviewed" (shared team watermark) ─────────
// A single team-wide watermark in kv_store. The dashboard shows how many
// review-worthy calls have landed since it; visiting the call queue stamps it
// forward (POST /api/calls/mark-reviewed). Shared, not per-user, by design —
// reviewing is a shared duty here, so one watermark matches the workflow.
const REVIEW_MARK_KEY = "calls_last_reviewed_at";

function ensureKvTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT)`);
}

/**
 * Count review-worthy calls received since the shared watermark.
 * Review-worthy = not spam and not dismissed. With no watermark yet (first
 * run) we count everything, so the backlog stays visible until the first
 * queue visit stamps the marker.
 * @returns {{ count:number, since:(string|null) }}
 */
function getReviewSince() {
  const db = getDb();
  ensureKvTable(db);
  const row = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(REVIEW_MARK_KEY);
  const since = row && row.value ? row.value : null;
  const sql =
    "SELECT COUNT(*) AS n FROM processed_calls WHERE is_spam = 0 AND dismissed_at IS NULL" +
    (since ? " AND created_at > ?" : "");
  const res = since ? db.prepare(sql).get(since) : db.prepare(sql).get();
  return { count: (res && res.n) || 0, since };
}

/**
 * Stamp the shared watermark to now — the team is caught up.
 * @returns {string} new watermark (UTC 'YYYY-MM-DD HH:MM:SS')
 */
function markReviewed() {
  const db = getDb();
  ensureKvTable(db);
  const now = db.prepare("SELECT datetime('now') AS t").get().t;
  db.prepare(
    "INSERT INTO kv_store (key, value) VALUES (?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(REVIEW_MARK_KEY, now);
  return now;
}

module.exports = {
  upsertCall,
  updateTranscript,
  updateCallStatus,
  markNotesApplied,
  markClassificationSynced,
  updateCallCategory,
  dismissCall,
  setCallReason,
  setCallType,
  getCallByStId,
  getCallById,
  getRecentCalls,
  getFailedCalls,
  getCallStats,
  getReviewSince,
  markReviewed,
};
