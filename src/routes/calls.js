/**
 * src/routes/calls.js
 *
 * Internal admin + testing routes for the call intelligence pipeline.
 * Mount at: /api/calls
 *
 * All routes require ADMIN_API_KEY header (x-admin-key) if ADMIN_API_KEY is set.
 *
 * Routes:
 *   GET  /api/calls                         — latest processed calls
 *   GET  /api/calls/stats                   — aggregate stats
 *   GET  /api/calls/queue                   — current in-process queue snapshot
 *   GET  /api/calls/:callId                 — single call record
 *   POST /api/calls/test-classify           — test classifier with a raw transcript (no recording needed)
 *   POST /api/calls/:callId/process         — manually process a call by ST ID
 *   POST /api/calls/:callId/reprocess       — reprocess a failed or completed call
 *   POST /api/calls/:callId/requeue         — push a dead-queued call back into the queue
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const router = express.Router();
const repo = require("../db/callRepository");
const { markNotesApplied, updateCallCategory, dismissCall, setCallReason, setCallType } = repo;
const { reprocessCall, reclassifyFromTranscript, applyNoteAndTagToSt } = require("../services/callProcessingService");
const { enqueueCall, getQueueSnapshot, requeueDeadCall } = require("../services/callQueueService");
const { processUploadedCall } = require("../services/uploadedCallService");
const { getKnownCaller } = require("../config/knownCallers");

/**
 * Attach a `knownCaller` descriptor to a call record when its caller matches a
 * configured known-caller rule (config/knownCallers.js). Lets the review card
 * show a badge explaining why the call was auto-labeled. Non-mutating.
 */
function annotateKnownCaller(call) {
  if (!call) return call;
  const rule = getKnownCaller(call.callerPhoneNumber);
  if (rule) {
    call.knownCaller = {
      label: rule.label,
      callType: rule.callType,
      reason: rule.reason || null,
      agentName: rule.agentName || null,
    };
  }
  return call;
}

// ── AI category → ST call type defaults ──────────────────────────────────────
// Canonical map lives in services/callClassificationSync.js so the pipeline's
// auto-sync and the Post-to-ServiceTitan flow agree on the same mapping.
const { CATEGORY_CALL_TYPE_DEFAULT } = require("../services/callClassificationSync");

// ── Multer setup for /upload ──────────────────────────────────────────────────
// Uploads land in the same tmp dir that polled recordings use, so disk usage
// stays predictable and cleanup is centralised.
const UPLOAD_DIR = process.env.RECORDINGS_TMP_DIR || "/tmp/recordings";
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) {}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      // Keep the extension — transcription services key off of it.
      const ext = path.extname(file.originalname || ".mp3") || ".mp3";
      cb(null, `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB ≈ 30–40 min of compressed audio
  fileFilter: (_req, file, cb) => {
    const ok = /^audio\//.test(file.mimetype) || /\.(mp3|mp4|m4a|wav|ogg|webm|aac|flac)$/i.test(file.originalname || "");
    if (!ok) return cb(new Error("File must be an audio recording (mp3, m4a, wav, etc.)"));
    cb(null, true);
  },
});

// ── Auth middleware ────────────────────────────────────────────────────────────

function requireAdminKey(req, res, next) {
  if (!process.env.ADMIN_API_KEY) {
    // No key configured — allow all (dev mode)
    return next();
  }
  const provided = req.headers["x-admin-key"] || req.query.admin_key;
  if (provided !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: "Unauthorized — missing or invalid x-admin-key header" });
  }
  next();
}

router.use(requireAdminKey);

// ── AI Instructions (editable prompts) ───────────────────────────────────────
//
// Backs the "⚙️ AI Instructions" popup on the call review page. Lets the office
// tune how the AI classifies calls and how the transcriber spells proper nouns,
// stored in the app_settings table so changes take effect live (no redeploy).
// The classification JSON output contract is locked in code and NOT editable
// here, so a bad edit can't break call processing.

/** Build the full state payload the popup renders from. */
function aiInstructionsState() {
  const { getSetting, getSettingMeta } = require("../db");
  const classification = require("../services/classificationService");
  const transcription = require("../services/transcriptionService");

  return {
    classification: {
      current: classification.getEffectiveInstructions(),
      default: classification.DEFAULT_INSTRUCTIONS,
      isCustom: getSetting("classification_instructions", null) != null,
      meta: getSettingMeta("classification_instructions"),
    },
    transcription: {
      current: transcription.getEffectiveTranscriptionPrompt(),
      default: transcription.DEFAULT_PROMPT,
      isCustom: getSetting("transcription_prompt", null) != null,
      meta: getSettingMeta("transcription_prompt"),
    },
  };
}

// GET /api/calls/ai-instructions — current + default text for both prompts.
router.get("/ai-instructions", (req, res) => {
  try {
    res.json(aiInstructionsState());
  } catch (err) {
    console.error("[AI Instructions] GET failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/calls/ai-instructions — save/edit or reset either prompt.
//   Body: { classificationInstructions?: string|null, transcriptionPrompt?: string|null }
//   • present + non-empty string → save that override
//   • present + null or ""       → reset to the built-in default
//   • absent                     → leave unchanged
router.put("/ai-instructions", (req, res) => {
  try {
    const { setSetting } = require("../db");
    const body = req.body || {};
    const who =
      (req.session &&
        (req.session.username ||
          (req.session.user && (req.session.user.username || req.session.user.name)))) ||
      null;

    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

    if (has("classificationInstructions")) {
      const v = body.classificationInstructions;
      setSetting("classification_instructions", v == null ? null : String(v).trim(), who);
    }
    if (has("transcriptionPrompt")) {
      const v = body.transcriptionPrompt;
      setSetting("transcription_prompt", v == null ? null : String(v).trim(), who);
    }

    res.json({ ok: true, ...aiInstructionsState() });
  } catch (err) {
    console.error("[AI Instructions] PUT failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/calls/test-classify ─────────────────────────────────────────────

/**
 * Test the classification (and optionally matching) pipeline with a raw transcript.
 * No recording download needed — paste any transcript text and get back the full result.
 *
 * Body:
 *   transcript    {string}  required — the call transcript text
 *   callerPhone   {string}  optional — to also test customer matching
 *   callDuration  {number}  optional — call length in seconds
 *   save          {boolean} optional — if true, saves the result to DB with a test- prefix ID
 *
 * Example body:
 *   {
 *     "transcript": "Hi, this is John calling about my water heater that was installed last week...",
 *     "callerPhone": "6145550142",
 *     "save": false
 *   }
 */
router.post("/test-classify", async (req, res) => {
  const { transcript, callerPhone, callDuration, save: shouldSave } = req.body;

  if (!transcript || transcript.trim().length === 0) {
    return res.status(400).json({ error: "transcript is required in the request body" });
  }

  console.log(`[API/calls] test-classify: ${transcript.length} chars, phone=${callerPhone || "none"}`);

  try {
    const { classifyCall } = require("../services/classificationService");
    const { matchCallToCustomer } = require("../services/matchingService");

    // Run classification and matching in parallel
    const [classification, match] = await Promise.all([
      classifyCall(transcript, { callerPhone, callDuration }),
      callerPhone ? matchCallToCustomer(callerPhone) : Promise.resolve(null),
    ]);

    const result = { classification, match };

    // Optionally persist to DB so you can see it in /api/calls
    if (shouldSave) {
      const repo = require("../db/callRepository");
      const testId = `test-${Date.now()}`;
      repo.upsertCall({
        serviceTitanCallId: testId,
        callerPhoneNumber: callerPhone || null,
        timestamp: new Date().toISOString(),
        rawWebhookPayload: { _source: "test-classify", transcript: transcript.slice(0, 200) },
        transcript,
        summary: classification.summary,
        category: classification.category,
        sentiment: classification.sentiment,
        isSpam: classification.isSpam,
        isJobRelated: classification.isJobRelated,
        confidence: classification.confidence,
        recommendedAction: classification.recommendedAction,
        classificationModel: classification.rawModel,
        matchedCustomerId: match?.matchedCustomerId || null,
        matchedCustomerName: match?.matchedCustomerName || null,
        matchedJobId: match?.matchedJobId || null,
        matchedJobNumber: match?.matchedJobNumber || null,
        matchConfidence: match?.matchConfidence || 0,
        matchMethod: match?.matchMethod || null,
        status: "completed",
      });
      result.savedAs = testId;
    }

    res.json(result);
  } catch (err) {
    console.error("[API/calls] test-classify error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/calls/upload ────────────────────────────────────────────────────

/**
 * Analyze an uploaded call recording — same pipeline as a polled ST call.
 *
 * Form fields (multipart/form-data):
 *   recording    {file}   required — mp3/m4a/wav/ogg/webm, ≤ 25 MB
 *   callerPhone  {string} optional — used for ST customer/job matching
 *   callerName   {string} optional — shown on the card when no ST match
 *   contextNote  {string} optional — extra context for the classifier (e.g.
 *                                    "tech's callback to Mrs. Henderson about the PRV leak")
 *
 * Returns the completed call record so the UI can prepend a card immediately.
 */
router.post("/upload", upload.single("recording"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "recording file is required (multipart field name: 'recording')" });
  }

  const filePath = req.file.path;
  const { callerPhone, callerName, contextNote } = req.body || {};

  console.log(`[API/calls] Upload received: ${req.file.originalname} (${(req.file.size / 1024).toFixed(1)} KB)`);

  try {
    const record = await processUploadedCall({
      filePath,
      callerPhone: callerPhone || null,
      callerName: callerName || null,
      contextNote: contextNote || null,
      originalFileName: req.file.originalname || null,
    });

    res.json({ success: true, call: record });
  } catch (err) {
    console.error("[API/calls] /upload error:", err.message);
    // processUploadedCall already cleans up the temp file
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/calls ─────────────────────────────────────────────────────────────

router.get("/", (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const status = req.query.status || null;
    const includeDismissed = req.query.includeDismissed === "true";
    const posted = req.query.posted === "true";
    const calls = repo.getRecentCalls({ limit, status, includeDismissed, posted });
    calls.forEach(annotateKnownCaller);
    res.json({ count: calls.length, calls });
  } catch (err) {
    console.error("[API/calls] GET / error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/calls/stats ───────────────────────────────────────────────────────

router.get("/stats", (req, res) => {
  try {
    const stats = repo.getCallStats();
    res.json(stats);
  } catch (err) {
    console.error("[API/calls] GET /stats error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/calls/queue ───────────────────────────────────────────────────────

router.get("/queue", (req, res) => {
  try {
    const snapshot = getQueueSnapshot();
    res.json({ queueDepth: snapshot.length, items: snapshot });
  } catch (err) {
    console.error("[API/calls] GET /queue error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/calls/review-since ───────────────────────────────────────────────
// Powers the dashboard "calls since the team last reviewed" hero.
router.get("/review-since", (req, res) => {
  try {
    res.json({ ok: true, ...repo.getReviewSince() });
  } catch (err) {
    console.error("[API/calls] GET /review-since error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/calls/mark-reviewed ─────────────────────────────────────────────
// Stamps the shared watermark to now. Called on visit to the call queue page
// (stamp-on-visit) so the dashboard count reflects "new since anyone looked."
router.post("/mark-reviewed", (req, res) => {
  try {
    const since = repo.markReviewed();
    res.json({ ok: true, since });
  } catch (err) {
    console.error("[API/calls] POST /mark-reviewed error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/calls/:callId ─────────────────────────────────────────────────────

router.get("/:callId", (req, res) => {
  try {
    const call = repo.getCallByStId(req.params.callId);
    if (!call) {
      return res.status(404).json({ error: `Call ${req.params.callId} not found` });
    }
    res.json(annotateKnownCaller(call));
  } catch (err) {
    console.error("[API/calls] GET /:callId error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/calls/:callId/process ───────────────────────────────────────────

/**
 * Manually kick off processing for a call that hasn't been seen yet.
 * Useful for testing with a real ST call ID.
 */
router.post("/:callId/process", async (req, res) => {
  const callId = req.params.callId;
  console.log(`[API/calls] Manual process requested for call ${callId}`);

  // Enqueue and return immediately
  enqueueCall(callId, { callId, _source: "manual_process", ...req.body });
  res.json({ queued: true, callId, message: "Call added to processing queue" });
});

// ── POST /api/calls/:callId/reprocess ─────────────────────────────────────────

/**
 * Reprocess a completed or failed call — reruns the full pipeline.
 * Useful for re-transcribing/re-classifying after a bug fix.
 */
router.post("/:callId/reprocess", async (req, res) => {
  const callId = req.params.callId;
  console.log(`[API/calls] Manual reprocess requested for call ${callId}`);

  // Run inline (not through the queue) so the response contains the result
  try {
    res.json({ started: true, callId, message: "Reprocessing started — check /api/calls/:callId for result" });
    await reprocessCall(callId);
  } catch (err) {
    console.error(`[API/calls] Reprocess failed for ${callId}:`, err.message);
    // Response already sent — just log
  }
});

// ── POST /api/calls/poll ──────────────────────────────────────────────────────

/**
 * Manually trigger a poll right now — useful for testing without waiting.
 */
router.post("/poll", async (req, res) => {
  console.log("[API/calls] Manual poll triggered");
  res.json({ started: true, message: "Poll started — check /api/calls in a moment" });
  const { pollForNewCalls } = require("../services/callPollService");
  pollForNewCalls().catch((err) =>
    console.error("[API/calls] Manual poll error:", err.message)
  );
});

// ── POST /api/calls/:callId/apply-note ────────────────────────────────────────

/**
 * Manually push the AI-generated note and customer tag to ServiceTitan.
 * This is the manual "Apply Notes to Job" action triggered from the UI.
 * Respects any manual category override the user set via PATCH /category.
 */
router.post("/:callId/apply-note", async (req, res) => {
  const callId = req.params.callId;
  const call = repo.getCallByStId(callId);

  if (!call) {
    return res.status(404).json({ error: `Call ${callId} not found` });
  }
  if (call.status !== "completed") {
    return res.status(400).json({
      error: `Call must be fully reviewed before applying notes (current status: ${call.status})`,
    });
  }

  // Optional overrides from the UI:
  //   jobId      — user entered a job number/ID (preferred target if set)
  //   customerId — user entered a ST customer ID (used when no job override).
  //                Useful when matching missed or got it wrong, or when the
  //                note should land on the customer record rather than a job.
  const { jobId: jobIdOverride, customerId: customerIdOverride } = req.body || {};

  try {
    const result = await applyNoteAndTagToSt(call, { jobIdOverride, customerIdOverride });
    markNotesApplied(callId, {
      appliedJobId: result.appliedJobId || null,
      appliedJobNumber: result.appliedJobNumber || null,
      appliedCustomerId: result.appliedCustomerId || null,
    });

    // Write the callType/callReason back to the ST call record.
    // One-click flow: the user probably didn't open the Advanced drawer, so
    // fall back to the AI-inferred call type derived from the category.
    // The user's explicit choice (if they set one) always wins.
    const effectiveCategory = call.manualCategory || call.category;
    const derivedCallType = CATEGORY_CALL_TYPE_DEFAULT[effectiveCategory] || null;
    const callTypeToWrite = call.callType || derivedCallType;
    const reasonToWrite   = call.callReason || null;

    // Only skip synthetic upload IDs — they have no ST call record to update.
    const isUpload = String(callId).startsWith("upload-");
    if (!isUpload && (callTypeToWrite || reasonToWrite)) {
      const { updateCallReasonOnST } = require("../api/servicetitan");
      updateCallReasonOnST(callId, { callType: callTypeToWrite, reasonName: reasonToWrite }).catch(() => {});
    }

    console.log(`[API/calls] Notes applied to ST for call ${callId} → ${result.noteTarget}`);
    res.json({ success: true, callId, ...result });
  } catch (err) {
    console.error(`[API/calls] apply-note error for ${callId}:`, err.message);
    // Pass isJobNotFound through so the UI can switch to manual job entry
    res.status(500).json({
      error: err.message,
      isJobNotFound: err.isJobNotFound || false,
      isCustomerNotFound: err.isCustomerNotFound || false,
      stStatus: err.stStatus || null,
    });
  }
});

// ── PATCH /api/calls/:callId/category ─────────────────────────────────────────

/**
 * Override the AI-detected category for a call before applying notes.
 * Body: { category: "job_callback" }  — or { category: null } to clear override.
 */
router.patch("/:callId/category", (req, res) => {
  const callId = req.params.callId;
  const { category } = req.body;

  const call = repo.getCallByStId(callId);
  if (!call) {
    return res.status(404).json({ error: `Call ${callId} not found` });
  }

  try {
    updateCallCategory(callId, category || null);
    console.log(`[API/calls] Category overridden for call ${callId}: ${category || "(cleared)"}`);
    res.json({ success: true, callId, manualCategory: category || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/calls/:callId/transcript ───────────────────────────────────────

/**
 * Save a hand-corrected transcript for this call. Does NOT re-run the AI —
 * the summary/category are refreshed only when the user explicitly clicks
 * "Re-classify now" (POST /:callId/reclassify).
 * Body: { transcript: "...corrected text..." }
 */
router.patch("/:callId/transcript", (req, res) => {
  const callId = req.params.callId;
  const { transcript } = req.body || {};

  if (typeof transcript !== "string" || transcript.trim().length === 0) {
    return res.status(400).json({ error: "transcript (non-empty string) is required" });
  }

  const call = repo.getCallByStId(callId);
  if (!call) return res.status(404).json({ error: `Call ${callId} not found` });

  try {
    const updated = repo.updateTranscript(callId, transcript);
    console.log(`[API/calls] Transcript hand-edited for call ${callId} (${transcript.length} chars)`);
    res.json({
      success: true,
      callId,
      transcript: updated?.transcript || transcript,
      editedAt: updated?.transcriptMetadata?.editedAt || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/calls/:callId/reclassify ────────────────────────────────────────

/**
 * Re-run the AI classification (and customer match) against the transcript
 * already stored on the call — no re-transcription. Used after editing a
 * transcript to refresh the summary, category, and recommended action.
 */
router.post("/:callId/reclassify", async (req, res) => {
  const callId = req.params.callId;
  const call = repo.getCallByStId(callId);
  if (!call) return res.status(404).json({ error: `Call ${callId} not found` });

  try {
    const result = await reclassifyFromTranscript(callId);
    console.log(`[API/calls] Re-classified call ${callId} → ${result.classification?.category}`);
    res.json({ success: true, callId, classification: result.classification, match: result.match });
  } catch (err) {
    console.error(`[API/calls] Reclassify failed for ${callId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/calls/:callId/dismiss ───────────────────────────────────────────

/**
 * Dismiss a call from the review queue (hides it from the default list).
 * Body: { reason: "Customer said they would call back" } — optional
 * Body: { undismiss: true } — restore a dismissed call
 */
router.post("/:callId/dismiss", (req, res) => {
  const callId = req.params.callId;
  const { reason, undismiss } = req.body || {};

  const call = repo.getCallByStId(callId);
  if (!call) return res.status(404).json({ error: `Call ${callId} not found` });

  try {
    if (reason) setCallReason(callId, reason);
    dismissCall(callId, undismiss === true);
    console.log(`[API/calls] Call ${callId} ${undismiss ? "restored" : "dismissed"} (reason: ${reason || "none"})`);
    res.json({ success: true, callId, dismissed: !undismiss, callReason: reason || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/calls/:callId/reason ───────────────────────────────────────────

/**
 * Save the selected ST call reason for this call and write it back to ST.
 * Body: { reason: "Hang up" }
 * The ST write is best-effort — failure does NOT fail this endpoint.
 */
router.patch("/:callId/reason", async (req, res) => {
  const callId = req.params.callId;
  const { reason } = req.body || {};
  try {
    setCallReason(callId, reason || null);

    if (reason) {
      // Read current callType from DB so we can derive the lead flag correctly
      const call = repo.getCallByStId(callId);
      const { updateCallReasonOnST } = require("../api/servicetitan");
      updateCallReasonOnST(callId, { reasonName: reason, callType: call?.callType || null }).catch(() => {});
    }

    res.json({ success: true, callReason: reason || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/calls/:callId/call-type ────────────────────────────────────────

/**
 * Save the ST call classification type and write it back to the ST call record.
 * Body: { callType: "Excused" }   — valid: Excused | Unbooked | NotLead | Booked | Abandoned
 * The ST write is best-effort — failure does NOT fail this endpoint.
 */
const VALID_CALL_TYPES = new Set(["Excused", "Unbooked", "NotLead", "Booked", "Abandoned"]);

router.patch("/:callId/call-type", async (req, res) => {
  const callId = req.params.callId;
  const { callType } = req.body || {};

  if (callType && !VALID_CALL_TYPES.has(callType)) {
    return res.status(400).json({ error: `Invalid callType "${callType}". Must be one of: ${[...VALID_CALL_TYPES].join(", ")}` });
  }

  try {
    setCallType(callId, callType || null);

    if (callType) {
      const call = repo.getCallByStId(callId);
      const { updateCallReasonOnST } = require("../api/servicetitan");
      updateCallReasonOnST(callId, { callType, reasonName: call?.callReason || null }).catch(() => {});
    }

    res.json({ success: true, callType: callType || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/calls/:callId/related-jobs ───────────────────────────────────────

/**
 * Find ST jobs related to this call — searches by matched customer ID and
 * falls back to phone number lookup.
 * Returns the 5 most recent jobs for the matched customer.
 */
router.get("/:callId/related-jobs", async (req, res) => {
  const call = repo.getCallByStId(req.params.callId);
  if (!call) return res.status(404).json({ error: "Call not found" });

  try {
    const st = require("../api/servicetitan");
    let jobs = [];

    // Check if webhook payload has a direct job ID attached
    const payloadJobId = call.rawWebhookPayload?.id || call.rawWebhookPayload?.jobId || null;

    if (call.matchedCustomerId) {
      const { getRecentJobsForCustomer } = st;
      jobs = await getRecentJobsForCustomer(call.matchedCustomerId, 8);
    } else if (call.callerPhoneNumber) {
      // Fall back to phone search
      const customers = await st.searchCustomersByPhone(call.callerPhoneNumber);
      if (customers.length > 0) {
        jobs = await st.getRecentJobsForCustomer(customers[0].id, 8);
      }
    }

    // Flag the job that came directly from the webhook payload
    const result = jobs.map(j => ({
      jobId:       String(j.id),
      jobNumber:   j.jobNumber,
      summary:     j.summary || j.type?.name || "No summary",
      status:      j.status,
      createdOn:   j.createdOn,
      isPayloadJob: String(j.id) === String(payloadJobId),
    }));

    // Put the payload job first if present
    result.sort((a, b) => (b.isPayloadJob ? 1 : 0) - (a.isPayloadJob ? 1 : 0));

    res.json({ jobs: result, payloadJobId });
  } catch (err) {
    console.error(`[API/calls] related-jobs error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/calls/:callId/requeue ───────────────────────────────────────────

/**
 * Push a "dead" (exhausted retries) queue item back into the queue.
 */
router.post("/:callId/requeue", (req, res) => {
  const callId = req.params.callId;
  const requeued = requeueDeadCall(callId);
  if (requeued) {
    res.json({ requeued: true, callId });
  } else {
    res.status(404).json({ error: `No dead queue item found for call ${callId}` });
  }
});

module.exports = router;
