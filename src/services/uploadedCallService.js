/**
 * uploadedCallService.js
 *
 * Process an ad-hoc uploaded call recording — same pipeline as a polled ST call,
 * but starting from a local file instead of the ServiceTitan recording API.
 *
 * Pipeline:
 *   1. Transcribe the uploaded file
 *   2. Classify the transcript
 *   3. Match caller to ST customer/job (if phone supplied)
 *   4. Save to DB with a synthetic call ID (upload-<timestamp>)
 *   5. Clean up the temp upload file
 *
 * A synthetic ID is used because these calls have no corresponding ST call record.
 * The ST writeback path (applyNoteAndTagToSt) still works: it writes to the matched
 * job or customer, not to the ST call record itself.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { transcribeCallRecording } = require("./transcriptionService");
const { classifyCall } = require("./classificationService");
const { matchCallToCustomer } = require("./matchingService");
const repo = require("../db/callRepository");

/**
 * Process an already-downloaded audio file.
 *
 * @param {object} opts
 * @param {string} opts.filePath      Absolute path to the uploaded audio file
 * @param {string} [opts.callerPhone] Caller's phone for ST matching (optional)
 * @param {string} [opts.callerName]  Pre-supplied caller name (used as fallback when no match)
 * @param {string} [opts.contextNote] Freeform text from the user, passed as extra context to the classifier
 * @param {string} [opts.originalFileName] For logging / provenance in the DB payload
 * @returns {Promise<object>} The completed DB record
 */
async function processUploadedCall({ filePath, callerPhone = null, callerName = null, contextNote = null, originalFileName = null }) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Upload file not found at ${filePath}`);
  }

  const syntheticId = `upload-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const callTimestamp = new Date().toISOString();

  console.log(`\n[Upload] ── Starting upload ${syntheticId} ──────────────────`);
  console.log(`[Upload] File: ${originalFileName || filePath} · caller: ${callerPhone || "unknown"}`);

  // Initial "processing" row so the UI can show progress
  const initialPayload = {
    _source: "upload",
    uploadedAt: callTimestamp,
    originalFileName: originalFileName || null,
    callerName: callerName || null,
    contextNote: contextNote || null,
  };

  repo.upsertCall({
    serviceTitanCallId: syntheticId,
    callerPhoneNumber: callerPhone,
    timestamp: callTimestamp,
    rawWebhookPayload: initialPayload,
    status: "processing",
    source: "upload",
    processingAttempts: 1,
  });

  try {
    // Step 1: Transcribe ─────────────────────────────────────────────────────
    console.log(`[Upload] Step 1: Transcribing`);
    const { text: transcript, metadata: transcriptMeta } = await transcribeCallRecording(filePath);

    // If the user supplied contextual notes, prepend them to the transcript so the
    // classifier has them — but keep them clearly separated.
    const transcriptForClassifier = contextNote
      ? `[Uploader notes: ${contextNote}]\n\n${transcript}`
      : transcript;

    // Step 2: Classify ──────────────────────────────────────────────────────
    console.log(`[Upload] Step 2: Classifying`);
    const classification = await classifyCall(transcriptForClassifier, {
      callerPhone,
      callDuration: transcriptMeta?.duration,
    });

    // Step 3: Match customer ────────────────────────────────────────────────
    let match = { matchedCustomerId: null, matchedCustomerName: null, matchedJobId: null, matchedJobNumber: null, matchConfidence: 0, matchMethod: null };
    if (callerPhone) {
      console.log(`[Upload] Step 3: Matching caller`);
      match = await matchCallToCustomer(callerPhone, { transcriptText: transcript });
    } else {
      console.log(`[Upload] Step 3 skipped — no phone number supplied`);
    }

    // Step 4: Save completed record ─────────────────────────────────────────
    console.log(`[Upload] Step 4: Saving completed record`);
    repo.upsertCall({
      serviceTitanCallId: syntheticId,
      callerPhoneNumber: callerPhone,
      timestamp: callTimestamp,
      rawWebhookPayload: initialPayload,
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
      matchedCustomerName: match.matchedCustomerName || callerName || null,
      matchedJobId: match.matchedJobId,
      matchedJobNumber: match.matchedJobNumber,
      matchConfidence: match.matchConfidence,
      matchMethod: match.matchMethod,
      status: "completed",
      source: "upload",
      processingAttempts: 1,
    });

    console.log(`[Upload] ✓ Upload ${syntheticId} complete | category=${classification.category} | matched=${match.matchedCustomerId || "none"}`);
    return repo.getCallByStId(syntheticId);
  } catch (err) {
    console.error(`[Upload] ✗ Upload ${syntheticId} failed: ${err.message}`);
    try { repo.updateCallStatus(syntheticId, "failed", err.message); } catch (_) {}
    throw err;
  } finally {
    // Always clean up the temp upload — we've extracted the transcript we need.
    try {
      fs.unlinkSync(filePath);
      console.log(`[Upload] Cleaned up ${filePath}`);
    } catch (_) {}
    console.log(`[Upload] ── Finished upload ${syntheticId} ──────────────────\n`);
  }
}

module.exports = { processUploadedCall };
