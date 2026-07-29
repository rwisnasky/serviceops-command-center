const express = require("express");
const router = express.Router();
const { handleReturnVisit } = require("../services/returnVisitService");
const { enqueueCall } = require("../services/callQueueService");

// ── Helpers ────────────────────────────────────────────────────────────────────

const crypto = require("crypto");

/** Constant-time string compare — avoids leaking the secret via timing. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Validate webhook secret (constant-time).
 * Checks x-webhook-secret header, then ?secret query param.
 *
 * NOTE: still fails OPEN if WEBHOOK_SECRET is unset — left unchanged on purpose
 * so this can't break a live webhook we couldn't confirm. Tightening to
 * fail-CLOSED and dropping the ?secret query path (which can leak into access
 * logs) is queued for once webhook usage is confirmed.
 */
function validateSecret(req) {
  if (!process.env.WEBHOOK_SECRET) return true;
  const provided = req.headers["x-webhook-secret"] || req.query.secret;
  return safeEqual(provided || "", process.env.WEBHOOK_SECRET);
}

/**
 * Extract the ServiceTitan telecom call ID from various payload shapes.
 *
 * ST's call webhook wraps data like this:
 *   payload.leadCall.id  = telecom call ID  ← what we need for recording fetch
 *   payload.id           = job ID           ← NOT the call ID
 *
 * Always prefer leadCall.id over the outer id.
 */
function extractCallId(event) {
  return (
    event.leadCall?.id ||   // ST call webhook (most common)
    event.callId ||
    event.data?.callId ||
    event.data?.id ||
    event.call?.id ||
    null                    // deliberately exclude event.id — that's the job ID
  );
}

/**
 * Extract the caller phone number from the payload.
 */
function extractCallerPhone(event) {
  return (
    event.leadCall?.from ||         // ST call webhook
    event.callerPhoneNumber ||
    event.from ||
    event.data?.callerPhoneNumber ||
    event.data?.from ||
    event.call?.from ||
    null
  );
}

// ── POST /webhook/servicetitan ─────────────────────────────────────────────────

/**
 * Main ServiceTitan webhook receiver.
 * Handles both existing appointment events and new call events.
 *
 * Configure in ServiceTitan:
 *   Settings → Integrations → Webhooks → Add Endpoint
 *   URL: https://<your-railway-domain>/webhook/servicetitan
 *   Events: JobAppointmentScheduled, CallCompleted (or equivalent)
 */
router.post("/servicetitan", async (req, res) => {
  if (!validateSecret(req)) {
    console.warn("[Webhook] Unauthorized — invalid or missing secret");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const event = req.body;
  const eventType = (event.eventType || event.type || "").toLowerCase();

  console.log(`[Webhook] Received: ${event.eventType || event.type || "unknown"}`);

  // Respond immediately — ST expects a fast 200
  res.json({ received: true, eventType: event.eventType || event.type || "unknown" });

  // ── Call events ──────────────────────────────────────────────────────────────
  // ServiceTitan sends these event types for phone calls:
  //   CallCompleted, CallEnded, CallRecorded, PhoneCallActivity
  const isCallEvent =
    eventType.includes("call") ||
    eventType.includes("phonecall") ||
    eventType === "callactivity";

  if (isCallEvent) {
    const callId = extractCallId(event);
    if (!callId) {
      console.warn("[Webhook] Call event received but no callId found. Payload keys:", Object.keys(event || {}).join(", "));
      return;
    }
    console.log(`[Webhook] Queuing call ${callId} for pipeline processing`);
    enqueueCall(callId, event);
    return;
  }

  // ── Appointment / Return Visit events ────────────────────────────────────────
  const isAppointmentEvent =
    eventType === "jobappointmentscheduled" ||
    eventType === "appointmentscheduled" ||
    eventType.includes("appointment");

  if (isAppointmentEvent) {
    const jobId = event.jobId || event.data?.jobId;
    const appointmentId = event.appointmentId || event.data?.appointmentId || event.data?.id;

    if (jobId && appointmentId) {
      handleReturnVisit(jobId, appointmentId).catch((err) =>
        console.error("[Webhook] Return visit background error:", err.message)
      );
    }
    return;
  }

  // ── Job completed ─────────────────────────────────────────────────────────────
  if (eventType === "jobcompleted" || eventType === "jobstatuschanged") {
    console.log(`[Webhook] Job completed: ${event.jobId || event.data?.jobId}`);
    // Future: trigger follow-up workflows
    return;
  }

  console.log(`[Webhook] Unhandled event type: ${event.eventType || event.type}`);
});

// ── POST /webhook/servicetitan/calls ──────────────────────────────────────────

/**
 * Dedicated call webhook endpoint.
 * Use this if you want to configure a separate webhook in ST specifically for calls.
 * Route: POST /webhook/servicetitan/calls
 *
 * Same validation and queuing logic — just a cleaner dedicated URL.
 */
router.post("/servicetitan/calls", (req, res) => {
  if (!validateSecret(req)) {
    console.warn("[Webhook/Calls] Unauthorized — invalid or missing secret");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const event = req.body;
  console.log(`[Webhook/Calls] Received call event (callId: ${extractCallId(event) || "none"})`);

  const callId = extractCallId(event);

  if (!callId) {
    console.warn("[Webhook/Calls] No callId in payload — ignoring");
    return res.status(400).json({ error: "Missing callId in payload" });
  }

  // Fast 200
  res.json({ received: true, callId });

  console.log(`[Webhook/Calls] Queuing call ${callId}`);
  enqueueCall(callId, event);
});

module.exports = router;
