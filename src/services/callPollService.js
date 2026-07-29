/**
 * callPollService.js
 *
 * Polls ServiceTitan for recently completed calls and feeds them into
 * the call intelligence pipeline.
 *
 * Why polling instead of webhooks?
 * ServiceTitan's webhook/event subscription UI is not exposed on all plans.
 * Polling every few minutes is reliable, simple, and catches everything.
 *
 * How it works:
 *   - Tracks a "last checked" timestamp in the DB (a simple key/value row)
 *   - On each run, fetches calls completed since that timestamp
 *   - Skips calls already in the DB (prevents reprocessing)
 *   - Enqueues new calls for full pipeline processing
 *
 * Env vars:
 *   CALL_POLL_INTERVAL_MINUTES — how often to poll (default: 5)
 *   CALL_POLL_LOOKBACK_HOURS   — on first run, how far back to look (default: 2)
 *   CALL_AUTO_PROCESS          — set to "true" to auto-transcribe every detected call
 *                                (default: "false" — calls queue for manual review in the UI)
 */

const axios = require("axios");
const { getAccessToken } = require("../api/servicetitan");
const { enqueueCall } = require("./callQueueService");
const { getCallByStId, upsertCall, setCallType, setCallReason } = require("../db/callRepository");
const { getDb } = require("../db/index");
const { getKnownCaller } = require("../config/knownCallers");
const { applyKnownCallerRule } = require("./callClassificationSync");

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse an ST duration string ("HH:MM:SS" or "MM:SS") to total seconds.
 * Returns null if the string is unparseable.
 */
function parseDurationSeconds(durationStr) {
  if (!durationStr) return null;
  const parts = String(durationStr).split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parseInt(durationStr) || 0;
}

const SHORT_CALL_THRESHOLD_SECONDS = 45;

// ── State key/value store in SQLite ───────────────────────────────────────────

function getLastPolledAt() {
  const db = getDb();

  // Ensure the kv table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  const row = db.prepare("SELECT value FROM kv_store WHERE key = 'call_poll_last_run'").get();
  if (row) return row.value; // ISO string

  // First run — look back N hours
  const lookback = parseInt(process.env.CALL_POLL_LOOKBACK_HOURS) || 2;
  const since = new Date(Date.now() - lookback * 60 * 60 * 1000).toISOString();
  return since;
}

function setLastPolledAt(isoString) {
  const db = getDb();
  db.prepare(`
    INSERT INTO kv_store (key, value) VALUES ('call_poll_last_run', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(isoString);
}

// ── ServiceTitan call fetch ────────────────────────────────────────────────────

async function fetchCompletedCallsSince(since) {
  const token = await getAccessToken();
  const tenantId = process.env.ST_TENANT_ID;
  const appKey = process.env.ST_APP_KEY;

  const response = await axios.get(
    `https://api.servicetitan.io/telecom/v2/tenant/${tenantId}/calls`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "ST-App-Key": appKey,
      },
      params: {
        createdOnOrAfter: since,
        pageSize: 100,
        // Only grab calls that have ended (have a recording to fetch)
        active: false,
      },
    }
  );

  return response.data?.data || [];
}

// ── Main poll function ────────────────────────────────────────────────────────

let pollRunning = false;

async function pollForNewCalls() {
  // Re-entrancy guard: skip a tick if the previous run hasn't finished, so two
  // overlapping runs can't process the same window twice.
  if (pollRunning) {
    console.log("[Poll] Previous run still in progress — skipping this tick");
    return;
  }
  pollRunning = true;
  try {
    return await _runPoll();
  } finally {
    pollRunning = false;
  }
}

async function _runPoll() {
  const since = getLastPolledAt();
  const now = new Date().toISOString();

  // Calls are only fetched once completed (active:false), but the cursor filters
  // on the call's START time — so a call that starts before a tick and finishes
  // after it would fall through the gap and be lost forever. Re-scan an overlap
  // window each tick and lean on the getCallByStId dedupe below to skip anything
  // already saved. The overlap must exceed the longest expected call.
  const overlapMinutes = parseInt(process.env.CALL_POLL_OVERLAP_MINUTES) || 60;
  const fetchSince = new Date(new Date(since).getTime() - overlapMinutes * 60 * 1000).toISOString();

  console.log(`[Poll] Checking for calls since ${since} (fetching from ${fetchSince}, ${overlapMinutes}m overlap)`);

  let calls;
  try {
    calls = await fetchCompletedCallsSince(fetchSince);
  } catch (err) {
    console.error(`[Poll] Failed to fetch calls from ServiceTitan: ${err.response?.status || ""} ${err.message}`);
    return;
  }

  if (calls.length === 0) {
    console.log("[Poll] No new calls found");
    setLastPolledAt(now);
    return;
  }

  console.log(`[Poll] Found ${calls.length} call(s) — checking which are new`);

  let queued = 0;
  for (const call of calls) {
    // ST call poll responses may be direct call objects OR wrapped in leadCall
    // Use the telecom call ID (leadCall.id if nested, otherwise call.id)
    const callId = String(call.leadCall?.id || call.id);
    const callerPhone = call.leadCall?.from || call.from || call.callerPhoneNumber || null;
    const callTimestamp = call.leadCall?.createdOn || call.createdOn || now;

    // Skip calls with no duration — no recording means nothing to review
    const callDuration = call.leadCall?.duration || call.duration || null;
    if (!callDuration || callDuration === "00:00:00" || callDuration === "0") {
      console.log(`[Poll] Skipping call ${callId} — no duration (no recording)`);
      continue;
    }

    // Skip if we've already saved this call at all. The overlap re-scan above
    // re-surfaces recent calls every tick; once a call is in the DB it has been
    // detected, so skip it — this also stops repeated auto-classify writes to
    // ServiceTitan for a call that's sitting in the review queue.
    const existing = getCallByStId(callId);
    if (existing) {
      continue;
    }

    // Save the call so it appears in the review queue.
    // If CALL_AUTO_PROCESS=true, also enqueue for immediate transcription/classification.
    // Default is manual-review mode — calls sit as "pending" until the user reviews them.
    const autoProcess = process.env.CALL_AUTO_PROCESS === "true";

    upsertCall({
      serviceTitanCallId: callId,
      callerPhoneNumber: callerPhone,
      timestamp: callTimestamp,
      rawWebhookPayload: call,
      status: "pending",
    });

    // Known-caller rule takes priority: a configured supply-house/vendor number
    // (config/knownCallers.js) gets its fixed callType + reason (+ agent) the
    // instant it's detected — no recap needed. This is what keeps recurring
    // vendor calls (e.g. card-authorization calls) out of the "unlabeled"
    // metrics buckets even though they sit as "pending" in the review queue.
    const knownRule = getKnownCaller(callerPhone);
    if (knownRule) {
      setCallType(callId, knownRule.callType);
      setCallReason(callId, knownRule.reason || null);
      // Write callType + reason (+ agent) to the ST call record in the background.
      applyKnownCallerRule(callId, callerPhone).catch((e) =>
        console.warn(`[Poll] Known-caller ST write failed for ${callId}: ${e.message}`)
      );
      console.log(`[Poll] Call ${callId} from ${callerPhone} matched known caller — labeled ${knownRule.callType}/${knownRule.reason || "—"} (${knownRule.label})`);
    } else {
      // Auto-classify short calls as "Not a service request" (Excused)
      const durationSeconds = parseDurationSeconds(callDuration);
      if (durationSeconds !== null && durationSeconds < SHORT_CALL_THRESHOLD_SECONDS) {
        setCallType(callId, "Excused");
        console.log(`[Poll] Call ${callId} is ${durationSeconds}s — auto-classified as Excused`);
        // Also write to ST asynchronously so it shows up in their Call Playback panel
        const { updateCallReasonOnST } = require("../api/servicetitan");
        updateCallReasonOnST(callId, { callType: "Excused" }).catch(() => {});
      }
    }

    if (autoProcess) {
      enqueueCall(callId, call);
    }
    queued++;
  }

  const autoProcess = process.env.CALL_AUTO_PROCESS === "true";
  console.log(`[Poll] Detected ${queued} new call(s)${autoProcess ? " — queued for auto-processing" : " — awaiting manual review"}`);
  setLastPolledAt(now);
}

// ── Start the poller ──────────────────────────────────────────────────────────

function startPoller() {
  const intervalMinutes = parseInt(process.env.CALL_POLL_INTERVAL_MINUTES) || 5;
  console.log(`[Poll] Starting call poller — runs every ${intervalMinutes} minute(s)`);

  // Run once immediately on startup (catches anything missed during a redeploy)
  setTimeout(() => {
    pollForNewCalls().catch((err) =>
      console.error("[Poll] Startup poll error:", err.message)
    );
  }, 10000); // 10s delay to let DB init and queue worker settle first

  // Then on the regular interval
  setInterval(() => {
    pollForNewCalls().catch((err) =>
      console.error("[Poll] Interval poll error:", err.message)
    );
  }, intervalMinutes * 60 * 1000);
}

module.exports = { startPoller, pollForNewCalls };
