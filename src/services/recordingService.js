/**
 * recordingService.js
 *
 * Downloads a call recording from ServiceTitan and saves it to a temp directory.
 * Supports retries for cases where the recording is not yet ready (ST processes
 * recordings asynchronously after a call ends).
 *
 * Env vars:
 *   RECORDINGS_TMP_DIR — where to save audio files (default: /tmp/recordings)
 */

const fs = require("fs");
const path = require("path");
const { getCallRecordingStream } = require("../api/servicetitan");

const TMP_DIR = process.env.RECORDINGS_TMP_DIR || "/tmp/recordings";
const MAX_RECORDING_ATTEMPTS = 5;
const RECORDING_RETRY_DELAY_MS = 15000; // 15 s between attempts

// Ensure tmp dir exists at startup (won't throw if already there)
try {
  fs.mkdirSync(TMP_DIR, { recursive: true });
} catch (_) {}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Fetch and save the recording for a call.
 * Returns the local file path on success.
 * Throws if the recording cannot be fetched after all retries.
 *
 * @param {string|number} callId
 * @returns {Promise<string>} filePath
 */
async function fetchAndSaveRecording(callId) {
  const filePath = path.join(TMP_DIR, `call_${callId}.mp3`);

  // If already downloaded (e.g. retry of a later pipeline step), skip re-download
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
    console.log(`[Recording] Using cached file for call ${callId}: ${filePath}`);
    return filePath;
  }

  for (let attempt = 1; attempt <= MAX_RECORDING_ATTEMPTS; attempt++) {
    try {
      console.log(`[Recording] Fetching recording for call ${callId} (attempt ${attempt}/${MAX_RECORDING_ATTEMPTS})`);
      const response = await getCallRecordingStream(callId);

      await streamToFile(response.data, filePath);

      const stats = fs.statSync(filePath);
      if (stats.size === 0) {
        throw new Error("Downloaded file is empty");
      }

      console.log(`[Recording] Saved ${(stats.size / 1024).toFixed(1)} KB → ${filePath}`);
      return filePath;
    } catch (err) {
      const status = err.response?.status;

      // 404 = recording not ready yet, 202 = still processing — retry
      if ((status === 404 || status === 202) && attempt < MAX_RECORDING_ATTEMPTS) {
        console.log(`[Recording] Call ${callId} recording not ready (${status}) — retrying in ${RECORDING_RETRY_DELAY_MS / 1000}s`);
        await sleep(RECORDING_RETRY_DELAY_MS);
        continue;
      }

      // Clean up partial file if it exists
      cleanupFile(filePath);

      const msg = `[Recording] Failed to fetch recording for call ${callId} after ${attempt} attempt(s): ${err.response?.status || ""} ${err.message}`;
      console.error(msg);
      throw new Error(msg);
    }
  }
}

/**
 * Delete a recording file after it has been processed.
 * Call this after transcription to avoid filling up the temp directory.
 *
 * @param {string} filePath
 */
function cleanupRecording(filePath) {
  cleanupFile(filePath);
  console.log(`[Recording] Cleaned up: ${filePath}`);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function streamToFile(stream, filePath) {
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(filePath);
    stream.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
    stream.on("error", reject);
  });
}

function cleanupFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { fetchAndSaveRecording, cleanupRecording };
