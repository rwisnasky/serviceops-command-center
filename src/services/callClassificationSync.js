/**
 * callClassificationSync.js
 *
 * Pushes AI-derived call classification back to the ServiceTitan call record
 * without waiting for the user to click Post to ServiceTitan.
 *
 * What gets synced:
 *   - callType (Excused | Unbooked | NotLead | Booked | Abandoned)
 *     — derived from the AI category via CATEGORY_CALL_TYPE_DEFAULT below.
 *
 * What DOESN'T get synced automatically:
 *   - callReason — the dropdown is tenant-specific free text; the AI can't
 *     reliably pick a valid value, so we leave it to the user / Advanced drawer.
 *   - notes / customer tags — these still require the manual Post flow so we
 *     don't write noisy notes onto real customer/job records.
 *
 * Guards:
 *   - Skip synthetic upload IDs (`upload-*`) — they have no ST call record.
 *   - Skip if a manual callType was already set (respect user override).
 *   - Failures are non-fatal: we log and move on so the main pipeline never
 *     breaks because of an ST-side hiccup.
 */

const { updateCallReasonOnST } = require("../api/servicetitan");
const { getKnownCaller } = require("../config/knownCallers");

// AI category → ST call type. Mirrors the frontend CATEGORY_CALL_TYPE map.
// Single source of truth — imported from routes/calls.js and the pipeline.
const CATEGORY_CALL_TYPE_DEFAULT = {
  job_callback:         "NotLead",
  unbooked_call:        "Unbooked",
  scheduling_request:   "Unbooked",
  new_service_request:  "Unbooked",
  emergency_request:    "Unbooked",
  estimate_followup:    "Unbooked",
  warranty_concern:     "NotLead",
  membership_question:  "NotLead",
  payment_billing:      "NotLead",
  complaint:            "NotLead",
  compliment:           "NotLead",
  spam_robocall:        "Excused",
  wrong_number:         "Excused",
  internal_call:        "Excused",
  recruiting_call:      "Excused",
};

/**
 * Auto-push the AI-derived callType back to the ST call record.
 *
 * @param {string} stCallId
 * @param {object} opts
 * @param {string|null} opts.category          AI category (may be null)
 * @param {string|null} opts.manualCategory    User-overridden category (wins over AI)
 * @param {string|null} opts.existingCallType  If set, we treat it as a manual override and skip
 *
 * @returns {Promise<{ synced: boolean, callType: string|null, reason: string|null }>}
 *   reason: null on success, or one of: "upload" | "already_set" | "no_category" |
 *   "no_mapping" | "api_error"
 */
async function autoSyncCallType(stCallId, { category, manualCategory, existingCallType } = {}) {
  // Uploaded calls don't have an ST call record to update.
  if (!stCallId || String(stCallId).startsWith("upload-")) {
    return { synced: false, callType: null, reason: "upload" };
  }

  // Respect a manual override — reprocess shouldn't stomp a user's choice.
  if (existingCallType) {
    return { synced: false, callType: existingCallType, reason: "already_set" };
  }

  const effectiveCategory = manualCategory || category;
  if (!effectiveCategory) {
    return { synced: false, callType: null, reason: "no_category" };
  }

  const callType = CATEGORY_CALL_TYPE_DEFAULT[effectiveCategory];
  if (!callType) {
    return { synced: false, callType: null, reason: "no_mapping" };
  }

  try {
    const result = await updateCallReasonOnST(stCallId, { callType });
    // updateCallReasonOnST returns null on failure (it swallows its own errors).
    if (result === null) {
      return { synced: false, callType, reason: "api_error" };
    }
    console.log(`[AutoSync] Call ${stCallId} → ST callType=${callType} (from category=${effectiveCategory})`);
    return { synced: true, callType, reason: null };
  } catch (err) {
    console.warn(`[AutoSync] Call ${stCallId} sync failed: ${err.message}`);
    return { synced: false, callType, reason: "api_error" };
  }
}

/**
 * Apply a fixed known-caller rule to the ST call record, bypassing the AI guess.
 *
 * Used for recurring non-lead numbers (supply houses, vendors) configured in
 * config/knownCallers.js. Writes the exact callType + reason, then sets the
 * answering agent as a SEPARATE best-effort call so that a fussy/unknown agentId
 * can never block the essential call-type/reason labeling (the metrics fix).
 *
 * @param {string} stCallId
 * @param {string|number|null} callerPhone
 * @returns {Promise<{applied:boolean, reason?:string, rule?:object, agentApplied?:boolean}>}
 *   reason (when not applied): "upload" | "no_rule" | "api_error"
 */
async function applyKnownCallerRule(stCallId, callerPhone) {
  // Uploaded calls have no ST call record to update.
  if (!stCallId || String(stCallId).startsWith("upload-")) {
    return { applied: false, reason: "upload" };
  }

  const rule = getKnownCaller(callerPhone);
  if (!rule) return { applied: false, reason: "no_rule" };

  try {
    // 1) Essential: call type + reason. This is what removes the call from the
    //    "unlabeled" metrics buckets in ServiceTitan.
    const result = await updateCallReasonOnST(stCallId, {
      callType: rule.callType,
      reasonName: rule.reason || null,
    });
    if (result === null) {
      return { applied: false, reason: "api_error", rule };
    }

    // 2) Best-effort: set the answering agent. Isolated so a rejected agentId
    //    never undoes the labeling above.
    let agentApplied = false;
    if (rule.agentId) {
      const agentRes = await updateCallReasonOnST(stCallId, { agentId: rule.agentId });
      agentApplied = agentRes !== null;
      if (!agentApplied) {
        console.warn(`[KnownCaller] Call ${stCallId}: agent set to ${rule.agentName || rule.agentId} failed (labeling still applied)`);
      }
    }

    console.log(
      `[KnownCaller] Call ${stCallId} from ${callerPhone} → ${rule.callType}` +
      `${rule.reason ? "/" + rule.reason : ""}` +
      `${rule.agentId ? `, agent=${rule.agentName || rule.agentId}${agentApplied ? "" : " (agent write failed)"}` : ""}` +
      ` [${rule.label}]`
    );
    return { applied: true, rule, agentApplied };
  } catch (err) {
    console.warn(`[KnownCaller] Call ${stCallId} rule apply failed: ${err.message}`);
    return { applied: false, reason: "api_error", rule };
  }
}

module.exports = {
  CATEGORY_CALL_TYPE_DEFAULT,
  autoSyncCallType,
  applyKnownCallerRule,
};
