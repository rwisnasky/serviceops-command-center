/**
 * callProcessingService.js
 *
 * Pipeline orchestrator for a single call.
 * Called by the queue worker for every incoming call event.
 *
 * Pipeline steps:
 *   1. Fetch call metadata from ServiceTitan
 *   2. Save initial record to DB (status: processing)
 *   3. Download the call recording
 *   4. Transcribe the recording
 *   5. Classify the transcript
 *   6. Match the caller to a customer/job
 *   7. Update the DB record (status: completed)
 *   8. Cleanup temp files
 *
 * Error handling:
 *   - Each step logs clearly
 *   - A failure in any step marks the call as failed in the DB
 *   - The queue worker handles retries at the outer level
 *   - Recording cleanup always runs (even on failure) to avoid disk fill
 */

const st = require("../api/servicetitan");
const { fetchAndSaveRecording, cleanupRecording } = require("./recordingService");
const { transcribeCallRecording } = require("./transcriptionService");
const { classifyCall } = require("./classificationService");
const { matchCallToCustomer } = require("./matchingService");
const { autoSyncCallType, applyKnownCallerRule } = require("./callClassificationSync");
const { getKnownCaller } = require("../config/knownCallers");
const repo = require("../db/callRepository");

// ── Tag mapping ────────────────────────────────────────────────────────────────
// Maps AI call categories to ServiceTitan customer tag type IDs.
// Tag IDs come from Settings → Tags in ServiceTitan.
// Set ST_APPLY_TAGS=false to disable all tagging.
//
// To add/change mappings, update the IDs here:
//   Follow Up 🚩          → 8250769
//   High Value Job ⬆️     → 2447
//   Replacement Opp        → 2454
//   Potential Mbr Renewal  → 2453
//   Left A Voicemail       → 2449

const CATEGORY_TAG_MAP = {
  job_callback:           8250769,  // Follow Up 🚩  — they called back, needs attention
  unbooked_call:          8250769,  // Follow Up 🚩  — talked but didn't book
  scheduling_request:     null,     // routine booking — no tag needed
  new_service_request:    2447,     // High Value Job ⬆️ — potential new revenue
  emergency_request:      2447,     // High Value Job ⬆️ — urgent, high value
  estimate_followup:      2454,     // Replacement Opp  — following up on a quote
  warranty_concern:       2454,     // Replacement Opp  — may need equipment replaced
  membership_question:    2453,     // Potential Mbr Renewal — membership interest
  payment_billing:        null,
  complaint:              8250769,  // Follow Up 🚩  — unhappy customer needs follow-up
  compliment:             null,
  spam_robocall:          null,
  wrong_number:           null,
  internal_call:          null,
  recruiting_call:        null,
  other:                  null,
};

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Process a single call end-to-end.
 *
 * @param {string|number} callId   - ServiceTitan call ID
 * @param {object}        payload  - Raw webhook payload
 */
async function processCall(callId, payload) {
  const stCallId = String(callId);
  let recordingPath = null;

  console.log(`\n[Pipeline] ── Starting call ${stCallId} ─────────────────────────`);

  // ── Step 1: Fetch call metadata ─────────────────────────────────────────────
  let callData = null;
  let callerPhone = null;
  let callTimestamp = null;

  // ST call webhook payloads nest data under leadCall:
  //   payload.leadCall.id   = telecom call ID  (stCallId should already be this)
  //   payload.leadCall.from = caller phone
  //   payload.id            = job ID (NOT the call ID)
  const leadCall = payload?.leadCall || null;

  // Load the existing DB record first — used as the final fallback so that
  // re-processing a call never wipes out the original phone number or call time.
  const existingRecord = repo.getCallByStId(stCallId);

  // Pull phone + timestamp from webhook payload first (always available)
  callerPhone =
    leadCall?.from ||
    payload?.callerPhoneNumber ||
    payload?.from ||
    existingRecord?.callerPhoneNumber ||   // ← preserve original if payload is sparse
    null;

  callTimestamp =
    leadCall?.createdOn ||
    leadCall?.receivedOn ||
    payload?.timestamp ||
    existingRecord?.timestamp ||           // ← preserve original call time
    new Date().toISOString();

  // Optionally enrich with live ST call data (non-fatal if it fails)
  try {
    callData = await st.getCall(stCallId);
    callerPhone = callerPhone || callData.from || callData.callerPhoneNumber || null;
    callTimestamp = callTimestamp || callData.createdOn || callData.callDate || callData.startedOn;
    console.log(`[Pipeline] Call metadata fetched — caller: ${callerPhone || "unknown"}`);
  } catch (err) {
    console.warn(`[Pipeline] Could not fetch live call metadata for ${stCallId}: ${err.message}`);
  }

  // ── Step 2: Save initial record ─────────────────────────────────────────────
  try {
    const existing = repo.getCallByStId(stCallId);
    repo.upsertCall({
      serviceTitanCallId: stCallId,
      callerPhoneNumber: callerPhone,
      timestamp: callTimestamp,
      rawWebhookPayload: payload,
      status: "processing",
      processingAttempts: (existing?.processingAttempts || 0) + 1,
    });
    console.log(`[Pipeline] Initial DB record saved for call ${stCallId}`);
  } catch (err) {
    // DB errors should not block processing — log and continue
    console.error(`[Pipeline] DB save error (step 2): ${err.message}`);
  }

  // ── Steps 3–7 wrapped in try/catch so cleanup always runs ───────────────────
  try {
    // Step 3: Download recording ───────────────────────────────────────────────
    let transcript = "";
    let transcriptMeta = {};

    console.log(`[Pipeline] Step 3: Fetching recording for call ${stCallId}`);
    try {
      recordingPath = await fetchAndSaveRecording(stCallId);

      // Step 4: Transcribe ─────────────────────────────────────────────────────
      console.log(`[Pipeline] Step 4: Transcribing recording`);
      const result = await transcribeCallRecording(recordingPath);
      transcript = result.text;
      transcriptMeta = result.metadata;
    } catch (recordingErr) {
      // Recording unavailable — continue with metadata-only classification
      // Common causes: recording not ready yet, telecom API scope, short/missed calls
      console.warn(`[Pipeline] Step 3-4 skipped — recording unavailable for call ${stCallId}: ${recordingErr.message}`);
      transcript = "";
      transcriptMeta = { skipped: true, reason: recordingErr.message };
    }

    // Step 5: Classify ─────────────────────────────────────────────────────────
    console.log(`[Pipeline] Step 5: Classifying call`);
    const classification = await classifyCall(transcript, {
      callerPhone,
      callDuration: callData?.duration,
    });

    // Step 6: Match caller ─────────────────────────────────────────────────────
    // If ST already resolved the customer in the webhook payload, use it directly.
    // This is always more accurate than a phone lookup.
    console.log(`[Pipeline] Step 6: Matching caller to customer/job`);
    const payloadCustomer = leadCall?.customer || null;
    const payloadJobId    = payload?.id && payload.id !== 0 ? payload.id : null;
    const payloadJobNum   = payload?.jobNumber || null;

    let match;
    if (payloadCustomer?.id) {
      console.log(`[Pipeline] Using customer from webhook payload: ${payloadCustomer.name} (${payloadCustomer.id})`);
      match = {
        matchedCustomerId:   payloadCustomer.id,
        matchedCustomerName: payloadCustomer.name || null,
        matchedJobId:        payloadJobId,
        matchedJobNumber:    payloadJobNum,
        matchConfidence:     1.0,
        matchMethod:         "webhook_payload",
        candidateJobs:       [],
        internalEmployee:    null,
      };
    } else {
      match = await matchCallToCustomer(callerPhone, { transcriptText: transcript });
    }

    // Step 7: Save completed record ────────────────────────────────────────────
    console.log(`[Pipeline] Step 7: Saving completed record for call ${stCallId}`);
    repo.upsertCall({
      serviceTitanCallId: stCallId,
      callerPhoneNumber: callerPhone,
      timestamp: callTimestamp,
      rawWebhookPayload: payload,
      transcript,
      transcriptMetadata: transcriptMeta,
      summary: classification.summary,
      summaryBullets: classification.summaryBullets || null,
      category: classification.category,
      sentiment: classification.sentiment,
      isSpam: classification.isSpam,
      isJobRelated: classification.isJobRelated,
      confidence: classification.confidence,
      recommendedAction: classification.recommendedAction,
      classificationModel: classification.rawModel,
      matchedCustomerId: match.matchedCustomerId,
      matchedCustomerName: match.matchedCustomerName,
      matchedJobId: match.matchedJobId,
      matchedJobNumber: match.matchedJobNumber,
      matchConfidence: match.matchConfidence,
      matchMethod: match.matchMethod,
      candidateJobs: match.candidateJobs || [],
      internalEmployee: match.internalEmployee || null,
      status: "completed",
      processingAttempts: (repo.getCallByStId(stCallId)?.processingAttempts || 1),
    });

    console.log(`[Pipeline] ✓ Call ${stCallId} complete | category=${classification.category} | sentiment=${classification.sentiment} | matched_customer=${match.matchedCustomerId || "none"}`);

    // Step 7b: Sync the call classification back to the ST call record ────────
    // A known-caller rule (config/knownCallers.js) — e.g. a supply house that
    // calls for card authorizations — takes priority over the AI-derived type.
    // It hard-sets callType + reason (+ answering agent) so these recurring,
    // non-lead calls never sit "unlabeled" and skew ST metrics.
    // Otherwise we push the AI-derived callType. Notes, tags, and the call
    // reason for normal calls still require the manual Post flow — those can
    // touch customer/job records and we want a human in the loop.
    const existing = repo.getCallByStId(stCallId);
    const known = await applyKnownCallerRule(stCallId, callerPhone);
    if (known.applied) {
      try {
        // Persist to the DB so the review card + Advanced drawer reflect the rule.
        repo.setCallType(stCallId, known.rule.callType);
        repo.setCallReason(stCallId, known.rule.reason || null);
        repo.markClassificationSynced(stCallId, known.rule.callType);
      } catch (dbErr) {
        console.warn(`[Pipeline] Could not persist known-caller rule for ${stCallId}: ${dbErr.message}`);
      }
    } else {
      const syncResult = await autoSyncCallType(stCallId, {
        category: classification.category,
        manualCategory: existing?.manualCategory || null,
        existingCallType: existing?.callType || null,
      });
      if (syncResult.synced) {
        try {
          repo.markClassificationSynced(stCallId, syncResult.callType);
        } catch (dbErr) {
          console.warn(`[Pipeline] Could not record classificationSyncedAt: ${dbErr.message}`);
        }
      } else if (syncResult.reason && syncResult.reason !== "upload") {
        console.log(`[Pipeline] Auto-sync skipped for ${stCallId}: ${syncResult.reason}`);
      }
    }

    // Notes and tags are applied manually via the Apply Notes button in the UI.
    // Use applyNoteAndTagToSt(callRecord) for manual writeback.
  } catch (err) {
    console.error(`[Pipeline] ✗ Call ${stCallId} failed: ${err.message}`);

    // Save failure state to DB
    try {
      repo.updateCallStatus(stCallId, "failed", err.message);
    } catch (dbErr) {
      console.error(`[Pipeline] Could not update failure status in DB: ${dbErr.message}`);
    }

    throw err; // re-throw so the queue worker can handle retries
  } finally {
    // Step 8: Cleanup recording file ───────────────────────────────────────────
    if (recordingPath) {
      cleanupRecording(recordingPath);
    }
    console.log(`[Pipeline] ── Finished call ${stCallId} ──────────────────────────\n`);
  }
}

/**
 * Manually trigger processing for a call ID (for admin/testing routes).
 * Creates a minimal payload if none is available.
 */
async function reprocessCall(callId) {
  const stCallId = String(callId);
  const existing = repo.getCallByStId(stCallId);

  const payload = existing?.rawWebhookPayload || { callId: stCallId, _source: "manual_reprocess" };

  // Reset status so pipeline doesn't short-circuit
  if (existing) {
    repo.updateCallStatus(stCallId, "pending");
  }

  await processCall(stCallId, payload);
}

/**
 * Re-run classification (and customer matching) against the transcript ALREADY
 * stored on the call — no recording download, no re-transcription. This is the
 * "Re-classify now" action used after a transcript has been hand-edited, so the
 * AI summary/category reflect the corrected text.
 *
 * Returns the refreshed { classification, match }.
 */
async function reclassifyFromTranscript(callId) {
  const stCallId = String(callId);
  const existing = repo.getCallByStId(stCallId);
  if (!existing) {
    throw new Error(`Call ${stCallId} not found`);
  }

  const transcript = (existing.transcript || "").trim();
  if (!transcript) {
    throw new Error(`Call ${stCallId} has no transcript to classify`);
  }

  const callerPhone = existing.callerPhoneNumber || null;
  const callDuration = existing.transcriptMetadata?.duration || null;

  console.log(`[Reclassify] Re-classifying call ${stCallId} from stored transcript (${transcript.length} chars)`);

  const [classification, match] = await Promise.all([
    classifyCall(transcript, { callerPhone, callDuration }),
    matchCallToCustomer(callerPhone, { transcriptText: transcript }),
  ]);

  // Persist the refreshed AI fields. upsertCall COALESCEs, so passing the same
  // transcript/metadata leaves the hand-edited text untouched.
  repo.upsertCall({
    serviceTitanCallId: stCallId,
    callerPhoneNumber: callerPhone,
    timestamp: existing.timestamp,
    rawWebhookPayload: existing.rawWebhookPayload,
    transcript: existing.transcript,
    transcriptMetadata: existing.transcriptMetadata,
    summary: classification.summary,
    summaryBullets: classification.summaryBullets || null,
    category: classification.category,
    sentiment: classification.sentiment,
    isSpam: classification.isSpam,
    isJobRelated: classification.isJobRelated,
    confidence: classification.confidence,
    recommendedAction: classification.recommendedAction,
    classificationModel: classification.rawModel,
    matchedCustomerId: match.matchedCustomerId,
    matchedCustomerName: match.matchedCustomerName,
    matchedJobId: match.matchedJobId,
    matchedJobNumber: match.matchedJobNumber,
    matchConfidence: match.matchConfidence,
    matchMethod: match.matchMethod,
    candidateJobs: match.candidateJobs || [],
    internalEmployee: match.internalEmployee || null,
    status: "completed",
  });

  // Re-assert any known-caller rule so re-classifying doesn't revert a supply
  // house / vendor number back to the AI-guessed call type.
  if (getKnownCaller(callerPhone)) {
    const known = await applyKnownCallerRule(stCallId, callerPhone);
    if (known.applied) {
      try {
        repo.setCallType(stCallId, known.rule.callType);
        repo.setCallReason(stCallId, known.rule.reason || null);
        repo.markClassificationSynced(stCallId, known.rule.callType);
      } catch (dbErr) {
        console.warn(`[Reclassify] Could not persist known-caller rule for ${stCallId}: ${dbErr.message}`);
      }
    }
  }

  console.log(`[Reclassify] ✓ Call ${stCallId} re-classified | category=${classification.category} | sentiment=${classification.sentiment}`);
  return { classification, match };
}

// ── Note builder ──────────────────────────────────────────────────────────────

function buildNoteText({ stCallId, callerPhone, leadCall, classification, match, payload }) {
  // Map internal sentiment -> customer-facing "happiness" label the dispatcher actually reads.
  const happinessLabel = { positive: "Happy", neutral: "Neutral", negative: "Unhappy" }[classification.sentiment] || "Neutral";
  const sentimentIcon  = { positive: "😊", neutral: "😐", negative: "😟" }[classification.sentiment] || "😐";

  const date = leadCall?.createdOn
    ? new Date(leadCall.createdOn).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "short", timeStyle: "short" })
    : null;

  const duration = leadCall?.duration
    ? leadCall.duration.replace("00:", "").replace(/^0/, "")
    : null;

  const agent = leadCall?.agent?.name || null;

  // ── Header line: caller · date · duration · agent ─────────────────────────
  const headerParts = [
    callerPhone ? formatPhone(callerPhone) : null,
    date        ? date + (duration ? ` · ${duration}` : "") : null,
    agent       ? `Answered by ${agent}` : null,
  ].filter(Boolean);

  // ── Bullet body: prefer summaryBullets array, fall back to prose summary ──
  let bullets = Array.isArray(classification.summaryBullets) && classification.summaryBullets.length
    ? classification.summaryBullets
    : null;

  if (!bullets) {
    const fallback = classification.summary || "";
    bullets = fallback
      .split(/(?<=[.!?])\s+|\s•\s|\n+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 4);
    if (bullets.length === 0) bullets = ["No summary available."];
  }

  const action = classification.recommendedAction || null;

  const bodyLines = [
    `📞 Phone Call Recap${headerParts.length ? " — " + headerParts.join(" · ") : ""}`,
    ``,
    ...bullets.map((b) => `• ${b}`),
    action ? `` : null,
    action ? `→ ${action}` : null,
    ``,
    `Customer Happiness: ${sentimentIcon} ${happinessLabel}`,
  ].filter((l) => l !== null);

  return bodyLines.join("\n");
}

function formatPhone(phone) {
  const d = String(phone).replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return phone;
}

// ── Manual writeback ──────────────────────────────────────────────────────────

/**
 * Apply the AI-generated note + customer tag to ServiceTitan for a reviewed call.
 * Called by the /apply-note API endpoint when the user clicks "Post to ST".
 *
 * @param {object} callRecord      — DB record from callRepository.getCallByStId()
 * @param {object} [opts]
 * @param {string|number} [opts.jobIdOverride]      — job ID/number entered manually by user
 * @param {string|number} [opts.customerIdOverride] — ST customer ID entered manually by user.
 *                                                    Used as the post target when no job override is set.
 * @returns {{ noteTarget: string, tagApplied: boolean }}
 */
async function applyNoteAndTagToSt(callRecord, { jobIdOverride, customerIdOverride } = {}) {
  const {
    serviceTitanCallId: stCallId,
    callerPhoneNumber: callerPhone,
    rawWebhookPayload: payload,
    matchedJobId: autoMatchedJobId,
    matchMethod,
    category: aiCategory,
    manualCategory,
    summary,
    summaryBullets,
    sentiment,
    confidence,
    recommendedAction,
    isSpam,
  } = callRecord;

  // Customer can be overridden by the user — the override always wins over
  // auto-match. This lets dispatchers reattach a call to the correct customer
  // record when matching missed (e.g. caller used a different number than ST
  // has on file) or got it wrong.
  let matchedCustomerId = callRecord.matchedCustomerId;
  let matchedCustomerName = callRecord.matchedCustomerName;
  if (customerIdOverride) {
    const idNum = parseInt(String(customerIdOverride).trim(), 10);
    if (!Number.isFinite(idNum) || idNum <= 0) {
      throw new Error(`Customer ID "${customerIdOverride}" is not a valid number`);
    }
    let cust;
    try {
      cust = await st.getCustomer(idNum);
    } catch (err) {
      const status = err.response?.status;
      if (status === 404) {
        const e = new Error(`Customer ${idNum} not found in ServiceTitan (404)`);
        e.stStatus = 404;
        e.isCustomerNotFound = true;
        throw e;
      }
      throw new Error(`ServiceTitan returned ${status || "error"} when looking up customer ${idNum}: ${err.message}`);
    }
    if (!cust || !cust.id) {
      const e = new Error(`Customer ${idNum} not found in ServiceTitan`);
      e.isCustomerNotFound = true;
      throw e;
    }
    matchedCustomerId = cust.id;
    matchedCustomerName = cust.name || matchedCustomerName;
    console.log(`[ApplyNote] Customer override → ${cust.id} (${cust.name || "unnamed"})`);
  }

  // Prefer the user-supplied job number/ID, then the auto-matched one.
  // If the user supplied a value, resolve it via ST's jobs API — they may have
  // entered the display job number (e.g. "2602739") rather than the internal
  // job ID (e.g. "62695261"). findJobByNumber handles both transparently.
  let matchedJobId = autoMatchedJobId;
  // Track the human-readable job number too, for the "Posted → Job #…" label.
  let matchedJobNumber = callRecord.matchedJobNumber || null;
  if (jobIdOverride) {
    const resolved = await st.findJobByNumber(jobIdOverride);
    matchedJobId = resolved.jobId;
    matchedJobNumber = resolved.jobNumber || matchedJobNumber;
    console.log(`[ApplyNote] Job override "${jobIdOverride}" resolved to internal ID ${matchedJobId}`);
  }
  // If the user supplied a customer override but no job override, force the
  // post target to the customer (don't reuse a stale auto-matched job that
  // belongs to a different customer).
  if (customerIdOverride && !jobIdOverride) {
    matchedJobId = null;
    matchedJobNumber = null;
  }

  // Use manual override if set, otherwise fall back to AI category
  const effectiveCategory = manualCategory || aiCategory;

  // Never auto-write notes for spam or internal calls — these are explicitly
  // skipped on the one-click happy path so robocalls don't pollute customer
  // records. BUT: if the dispatcher has typed an explicit job # or customer ID
  // override, they're directing this post deliberately (e.g. an internal call
  // that's actually about a real customer issue and should be filed there).
  // In that case, honor their intent and bypass the skip.
  const userDirected = !!(jobIdOverride || customerIdOverride);
  const skippableCategory =
    isSpam ||
    ["spam_robocall", "wrong_number", "internal_call", "recruiting_call"].includes(effectiveCategory);

  if (skippableCategory && !userDirected) {
    const helpMsg = effectiveCategory === "internal_call" || effectiveCategory === "recruiting_call"
      ? `Cannot auto-post notes for category "${effectiveCategory}". To attach this call anyway, open Advanced → enter a Customer ID or Job # override, or change the Category.`
      : `Cannot apply notes for category "${effectiveCategory}" — spam/internal calls are skipped`;
    throw new Error(helpMsg);
  }
  if (skippableCategory && userDirected) {
    console.log(
      `[ApplyNote] Bypassing skip for category "${effectiveCategory}" — user supplied ` +
      `${customerIdOverride ? `customerId=${customerIdOverride}` : ""}` +
      `${jobIdOverride ? ` jobId=${jobIdOverride}` : ""} (explicit attach)`
    );
  }

  // Need either a job ID (from override or auto-match) OR a customer ID to write to
  if (!matchedJobId && !matchedCustomerId) {
    throw new Error("No job or customer matched — enter a job number to post the note manually");
  }

  // Build a fake classification object for buildNoteText
  const classification = { category: effectiveCategory, summary, summaryBullets, sentiment, confidence, recommendedAction };
  const leadCall = payload?.leadCall || {};
  const match = { matchedCustomerId, matchedCustomerName, matchedJobId };

  const noteText = buildNoteText({ stCallId, callerPhone, leadCall, classification, match, payload });

  let noteTarget = null;
  // Structured target for the DB — UI renders from these fields.
  let appliedJobId = null;
  let appliedJobNumber = null;
  let appliedCustomerId = null;

  if (matchedJobId) {
    try {
      await st.addJobNote(matchedJobId, noteText);
      noteTarget = matchedJobNumber ? `Job #${matchedJobNumber}` : `job ${matchedJobId}`;
      appliedJobId = matchedJobId;
      appliedJobNumber = matchedJobNumber;
      // Jobs always belong to a customer — record it too so the UI can cross-link.
      appliedCustomerId = matchedCustomerId || null;
      console.log(`[ApplyNote] Note written to ST job ${matchedJobId}${matchedJobNumber ? ` (#${matchedJobNumber})` : ""}`);
    } catch (jobErr) {
      const stStatus = jobErr.response?.status;
      const stBody   = JSON.stringify(jobErr.response?.data || {});
      console.error(`[ApplyNote] addJobNote failed: ${stStatus} ${stBody}`);

      if (stStatus === 404) {
        // Job ID is wrong or no longer exists — surface a clear error so the UI
        // can fall back to the manual job-number entry field
        const err = new Error(`Job ${matchedJobId} not found in ServiceTitan (404). Enter the correct job number.`);
        err.stStatus = 404;
        err.isJobNotFound = true;
        throw err;
      }
      // Other ST errors — re-throw with details
      const err = new Error(`ServiceTitan returned ${stStatus || "error"} when writing job note: ${stBody}`);
      err.stStatus = stStatus;
      throw err;
    }
  } else {
    try {
      await st.addCustomerNote(matchedCustomerId, noteText);
      noteTarget = matchedCustomerName ? `Customer ${matchedCustomerName}` : `customer ${matchedCustomerId}`;
      appliedCustomerId = matchedCustomerId;
      console.log(`[ApplyNote] Note written to ST customer ${matchedCustomerId}`);
    } catch (custErr) {
      const stStatus = custErr.response?.status;
      const stBody   = JSON.stringify(custErr.response?.data || {});
      console.error(`[ApplyNote] addCustomerNote failed: ${stStatus} ${stBody}`);
      const err = new Error(`ServiceTitan returned ${stStatus || "error"} when writing customer note: ${stBody}`);
      err.stStatus = stStatus;
      throw err;
    }
  }

  // Apply the tag for this category (only if we have a confirmed customer ID)
  const tagId = CATEGORY_TAG_MAP[effectiveCategory];
  let tagApplied = false;
  if (tagId && matchedCustomerId) {
    try {
      await st.applyTagToCustomer(matchedCustomerId, tagId);
      tagApplied = true;
      console.log(`[ApplyNote] Tag ${tagId} applied to customer ${matchedCustomerId} (${effectiveCategory})`);
    } catch (tagErr) {
      // Non-fatal — note is more important than tag
      console.warn(`[ApplyNote] Tag apply failed (non-fatal): ${tagErr.response?.status} ${tagErr.message}`);
    }
  }

  return {
    noteTarget,
    tagApplied,
    effectiveCategory,
    appliedJobId,
    appliedJobNumber,
    appliedCustomerId,
  };
}

module.exports = { processCall, reprocessCall, reclassifyFromTranscript, applyNoteAndTagToSt };
