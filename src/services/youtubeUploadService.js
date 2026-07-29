/**
 * src/services/youtubeUploadService.js
 *
 * Orchestrates: resolve ST job → get street address → upload user-provided
 *               video file to YouTube (unlisted) → log to DB.
 *
 * The video file is uploaded by the user through the dashboard (not pulled
 * from ST, since ST's API doesn't expose job photos/videos for download).
 */

const fs = require("fs");
const {
  findJobByNumber,
  getJob,
  getLocationById,
} = require("../api/servicetitan");
const { uploadVideo } = require("../api/youtube");
const { getDb } = require("../db/index");

/**
 * Given an ST job, return its primary street address (line 1 only).
 */
async function getJobStreetAddress(job) {
  if (job?.locationId) {
    try {
      const loc = await getLocationById(job.locationId);
      const street = loc?.address?.street;
      if (street) return street;
    } catch (err) {
      console.warn(`[ST] getLocationById failed: ${err.message}`);
    }
  }
  const street = job?.address?.street || job?.location?.address?.street;
  if (street) return street;
  return null;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function recordUpload({ jobNumber, jobId, streetAddress, youtubeVideoId, youtubeUrl, fileName }) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO video_uploads
      (job_number, job_id, street_address, youtube_video_id, youtube_url)
    VALUES (?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    String(jobNumber || ""),
    String(jobId || ""),
    streetAddress || null,
    youtubeVideoId,
    youtubeUrl
  );
  return info.lastInsertRowid;
}

function listRecentUploads(limit = 25) {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, job_number, job_id, street_address, youtube_video_id,
              youtube_url, created_at
         FROM video_uploads
         ORDER BY created_at DESC
         LIMIT ?`
    )
    .all(limit);
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Upload a user-provided video file to YouTube (unlisted), using the ST job's
 * street address as the video title.
 *
 * @param {string|number} jobNumberOrId — the ST job number
 * @param {string} filePath             — path to the uploaded video file on disk
 * @param {string} [originalFileName]   — original filename from the user
 * @returns {Promise<{ youtubeUrl, youtubeVideoId, title, jobNumber, jobId, streetAddress, fileName }>}
 */
async function uploadVideoToYouTube(jobNumberOrId, filePath, originalFileName) {
  const input = String(jobNumberOrId || "").trim();
  if (!input) throw new Error("Job number is required");
  if (!filePath) throw new Error("Video file is required");

  // 1. Resolve job
  const resolved = await findJobByNumber(input);
  if (!resolved?.jobId) {
    throw new Error(`Could not find a ServiceTitan job matching "${input}"`);
  }
  const { jobId, jobNumber } = resolved;

  const job = await getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  // 2. Resolve street address (will be YouTube title)
  const streetAddress = await getJobStreetAddress(job);
  if (!streetAddress) {
    throw new Error(
      `Job ${jobNumber || jobId} has no street address — cannot use as YouTube title`
    );
  }

  // 3. Stream the uploaded file into YouTube
  const mediaStream = fs.createReadStream(filePath);

  const { id: youtubeVideoId, url: youtubeUrl } = await uploadVideo({
    mediaStream,
    title: streetAddress,
    description: `ServiceTitan Job #${jobNumber || jobId}`,
    privacyStatus: "unlisted",
  });

  // 4. Clean up temp file
  try { fs.unlinkSync(filePath); } catch (_) {}

  // 5. Log to DB
  try {
    recordUpload({
      jobNumber: jobNumber || input,
      jobId,
      streetAddress,
      youtubeVideoId,
      youtubeUrl,
      fileName: originalFileName || null,
    });
  } catch (err) {
    console.warn(`[YT] Failed to log upload to DB: ${err.message}`);
  }

  return {
    youtubeUrl,
    youtubeVideoId,
    title: streetAddress,
    jobNumber: jobNumber || input,
    jobId,
    streetAddress,
    fileName: originalFileName || null,
  };
}

module.exports = {
  uploadVideoToYouTube,
  listRecentUploads,
};
