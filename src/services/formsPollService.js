/**
 * formsPollService.js
 *
 * Polls ServiceTitan for recently submitted Happy Review forms and pushes
 * each new submission to GoHighLevel via the existing happyReviewService.
 *
 * Why polling instead of webhooks?
 * ServiceTitan's webhook/event subscription UI is not exposed on all plans.
 * The call pipeline (callPollService.js) uses the same cursor-based pattern;
 * this service mirrors it so there is one mental model for ST ingestion.
 *
 * How it works:
 *   - Tracks "forms_poll_last_run" in the kv_store table (ISO timestamp)
 *   - On each run, fetches submissions since that timestamp
 *   - Checks the persisted pause flag ("happy_review_paused") — if paused, skips
 *   - Processes each submission via happyReviewService.processSubmission
 *     (which already dedupes via processed_happy_reviews and posts to GHL)
 *   - Advances the cursor only after a successful fetch
 *
 * Env vars:
 *   FORMS_POLL_INTERVAL_MINUTES — how often to poll (default: 5)
 *   FORMS_POLL_LOOKBACK_HOURS   — on first run, how far back to look (default: 2)
 */

const { getDb, isHappyReviewProcessed, markHappyReviewProcessed } = require("../db/index");
const {
  getRecentHappyReviewSubmissionsSince,
  processSubmission,
} = require("./happyReviewService");

// ── State key/value store in SQLite ───────────────────────────────────────────

function ensureKvTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);
}

function getLastPolledAt() {
  ensureKvTable();
  const db = getDb();
  const row = db.prepare("SELECT value FROM kv_store WHERE key = 'forms_poll_last_run'").get();
  if (row) return row.value; // ISO string

  // First run — look back N hours
  const lookback = parseInt(process.env.FORMS_POLL_LOOKBACK_HOURS) || 2;
  return new Date(Date.now() - lookback * 60 * 60 * 1000).toISOString();
}

function setLastPolledAt(isoString) {
  ensureKvTable();
  const db = getDb();
  db.prepare(`
    INSERT INTO kv_store (key, value) VALUES ('forms_poll_last_run', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(isoString);
}

// ── Persisted pause flag (shared with routes/forms.js) ────────────────────────

function isPaused() {
  ensureKvTable();
  const db = getDb();
  const row = db.prepare("SELECT value FROM kv_store WHERE key = 'happy_review_paused'").get();
  return row?.value === "true";
}

// ── Main poll function ────────────────────────────────────────────────────────

let pollRunning = false;

async function pollForNewSubmissions() {
  // Re-entrancy guard: if a previous tick is still running (a big overnight
  // batch can exceed the interval), skip this one instead of running two copies
  // concurrently and double-sending to GoHighLevel.
  if (pollRunning) {
    console.log("[FormsPoll] Previous run still in progress — skipping this tick");
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
  if (isPaused()) {
    console.log("[FormsPoll] Paused — skipping this tick");
    return;
  }

  let since = getLastPolledAt();
  const now = new Date().toISOString();

  // Clamp the lookback floor. When a submission keeps failing we HOLD the cursor
  // (see end of this function) so the window keeps retrying it; this bounds how
  // far back that window can grow if something fails permanently.
  const maxLookbackHours = parseInt(process.env.FORMS_POLL_MAX_LOOKBACK_HOURS) || 48;
  const floor = new Date(Date.now() - maxLookbackHours * 60 * 60 * 1000).toISOString();
  if (since < floor) {
    console.warn(`[FormsPoll] Cursor ${since} is older than the ${maxLookbackHours}h floor — clamping to ${floor} (a submission may be failing permanently)`);
    since = floor;
  }

  console.log(`[FormsPoll] Checking for Happy Review submissions since ${since}`);

  let submissions;
  try {
    submissions = await getRecentHappyReviewSubmissionsSince(since);
  } catch (err) {
    console.error(`[FormsPoll] Failed to fetch submissions from ServiceTitan: ${err.response?.status || ""} ${err.message}`);
    return; // don't advance cursor — we'll retry the same window next tick
  }

  if (!submissions || submissions.length === 0) {
    console.log("[FormsPoll] No new submissions found");
    setLastPolledAt(now);
    return;
  }

  console.log(`[FormsPoll] Found ${submissions.length} submission(s) — processing`);

  let sent = 0, skipped = 0, errors = 0;
  for (const sub of submissions) {
    // Dedupe guard — second layer of defense in addition to the cursor.
    // Also protects against a startup-window overlap after a redeploy.
    if (isHappyReviewProcessed(sub.id)) {
      skipped++;
      continue;
    }
    try {
      const result = await processSubmission(sub);
      markHappyReviewProcessed(sub.id, result.name, result.jobNumber);
      sent++;
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`[FormsPoll] Error processing submission ${sub.id}: ${detail}`);
      errors++;
    }
  }

  console.log(`[FormsPoll] Done — ${sent} sent, ${skipped} skipped (already done), ${errors} errors`);
  // Only advance the cursor if everything succeeded. If any submission errored,
  // HOLD the cursor so the same window is retried next tick — the dedupe guard
  // (isHappyReviewProcessed) keeps the already-sent ones from re-sending, so
  // only the failed ones get another attempt instead of being lost forever.
  if (errors === 0) {
    setLastPolledAt(now);
  } else {
    console.warn(`[FormsPoll] ${errors} submission(s) failed — holding cursor at ${since} to retry them next tick`);
  }
}

// ── Start the poller ──────────────────────────────────────────────────────────

function startFormsPoller() {
  const intervalMinutes = parseInt(process.env.FORMS_POLL_INTERVAL_MINUTES) || 5;
  console.log(`[FormsPoll] Starting Happy Review poller — runs every ${intervalMinutes} minute(s)`);

  // Run once shortly after startup to catch anything missed during a redeploy
  setTimeout(() => {
    pollForNewSubmissions().catch((err) =>
      console.error("[FormsPoll] Startup poll error:", err.message)
    );
  }, 15000); // 15s delay to let DB init and call poller settle first

  setInterval(() => {
    pollForNewSubmissions().catch((err) =>
      console.error("[FormsPoll] Interval poll error:", err.message)
    );
  }, intervalMinutes * 60 * 1000);
}

module.exports = { startFormsPoller, pollForNewSubmissions };
