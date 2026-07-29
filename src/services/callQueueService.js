/**
 * callQueueService.js
 *
 * In-process call processing queue with retry logic.
 *
 * Why in-process instead of Redis/Bull?
 * - Zero extra infrastructure on Railway
 * - Survives typical transient errors via retry backoff
 * - Easy to swap for Bull/BullMQ later: just replace enqueue() and startWorker()
 *
 * Limitations:
 * - Queue is lost on process restart (acceptable — ST will retry the webhook)
 * - Not suitable for multi-instance deployments without a shared backend
 *
 * If you scale to multiple Railway replicas, replace this with Bull + Railway Redis add-on.
 */

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 5000; // 5 s initial retry delay
const WORKER_POLL_MS = 1000; // how often the worker checks for pending items

const queue = []; // { callId, payload, attempt, nextRunAt, status }
let workerRunning = false;

// ── Enqueue ────────────────────────────────────────────────────────────────────

/**
 * Add a call event to the processing queue.
 * @param {string|number} callId  - ServiceTitan call ID
 * @param {object} payload        - Raw webhook payload
 */
function enqueueCall(callId, payload) {
  const existing = queue.find((item) => item.callId === String(callId));
  if (existing && existing.status === "pending") {
    console.log(`[Queue] Call ${callId} already queued — skipping duplicate`);
    return;
  }

  queue.push({
    callId: String(callId),
    payload,
    attempt: 0,
    nextRunAt: Date.now(),
    status: "pending",
  });

  console.log(`[Queue] Enqueued call ${callId} (queue depth: ${queue.length})`);
}

// ── Worker ─────────────────────────────────────────────────────────────────────

/**
 * Start the background worker loop.
 * Safe to call multiple times — only one loop ever runs.
 */
function startWorker() {
  if (workerRunning) return;
  workerRunning = true;
  console.log("[Queue] Worker started");
  processNext();
}

async function processNext() {
  const now = Date.now();
  const item = queue.find((i) => i.status === "pending" && i.nextRunAt <= now);

  if (!item) {
    setTimeout(processNext, WORKER_POLL_MS);
    return;
  }

  item.status = "processing";
  item.attempt += 1;

  console.log(`[Queue] Processing call ${item.callId} (attempt ${item.attempt}/${MAX_RETRIES})`);

  try {
    // Lazy-require to avoid circular deps at startup
    const { processCall } = require("./callProcessingService");
    await processCall(item.callId, item.payload);

    // Success — remove from queue
    const idx = queue.indexOf(item);
    if (idx !== -1) queue.splice(idx, 1);
    console.log(`[Queue] Call ${item.callId} processed successfully`);
  } catch (err) {
    console.error(`[Queue] Call ${item.callId} failed (attempt ${item.attempt}):`, err.message);

    if (item.attempt >= MAX_RETRIES) {
      item.status = "dead";
      console.error(`[Queue] Call ${item.callId} exhausted retries — marked dead`);
    } else {
      // Exponential backoff: 5s, 25s, 125s
      const delay = BASE_DELAY_MS * Math.pow(5, item.attempt - 1);
      item.nextRunAt = Date.now() + delay;
      item.status = "pending";
      console.log(`[Queue] Will retry call ${item.callId} in ${Math.round(delay / 1000)}s`);
    }
  }

  // Schedule next tick
  setTimeout(processNext, WORKER_POLL_MS);
}

// ── Introspection (for admin routes) ──────────────────────────────────────────

function getQueueSnapshot() {
  return queue.map((item) => ({
    callId: item.callId,
    status: item.status,
    attempt: item.attempt,
    nextRunAt: new Date(item.nextRunAt).toISOString(),
  }));
}

function requeueDeadCall(callId) {
  const item = queue.find((i) => i.callId === String(callId) && i.status === "dead");
  if (!item) return false;
  item.status = "pending";
  item.attempt = 0;
  item.nextRunAt = Date.now();
  console.log(`[Queue] Manually requeued dead call ${callId}`);
  return true;
}

module.exports = { enqueueCall, startWorker, getQueueSnapshot, requeueDeadCall };
