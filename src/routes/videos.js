/**
 * src/routes/videos.js
 *
 * Endpoints for the YouTube Upload feature.
 *
 *   POST /api/videos/upload   (multipart form: jobNumber + videoFile)
 *     → uploads the provided video to YouTube (unlisted) with the job's
 *       street address as the title
 *     → responds with { youtubeUrl, title, ... } or { error }
 *
 *   GET  /api/videos/recent   ?limit=25
 *     → recent uploads log (most recent first)
 */

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const {
  uploadVideoToYouTube,
  listRecentUploads,
} = require("../services/youtubeUploadService");

const router = express.Router();

// ── Multer config — store uploads in /tmp/video-uploads ───────────────────────
const UPLOAD_DIR = process.env.VIDEO_UPLOAD_TMP || "/tmp/video-uploads";
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) {}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".mp4";
    cb(null, `upload-${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB max
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype.startsWith("video/") ||
      /\.(mp4|mov|m4v|avi|mkv|webm|3gp|wmv)$/i.test(file.originalname);
    cb(ok ? null : new Error("Only video files are allowed"), ok);
  },
});

// ── Upload endpoint ───────────────────────────────────────────────────────────
router.post("/upload", upload.single("videoFile"), async (req, res) => {
  const jobNumber = (req.body?.jobNumber || "").toString().trim();
  if (!jobNumber) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(400).json({ error: "jobNumber is required" });
  }
  if (!req.file) {
    return res.status(400).json({ error: "Video file is required" });
  }

  console.log(`[Videos] Upload request for job ${jobNumber} — file: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);

  try {
    const result = await uploadVideoToYouTube(
      jobNumber,
      req.file.path,
      req.file.originalname
    );
    console.log(`[Videos] Uploaded: ${result.youtubeUrl} (title: "${result.title}")`);
    return res.json({ ok: true, ...result });
  } catch (err) {
    // Clean up file on error
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    console.error(`[Videos] Upload failed for ${jobNumber}:`, err.message);
    const status = /not find|no street/i.test(err.message) ? 404 : 500;
    return res.status(status).json({ ok: false, error: err.message });
  }
});

// ── Recent uploads ────────────────────────────────────────────────────────────
router.get("/recent", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  try {
    const uploads = listRecentUploads(limit);
    return res.json({ uploads });
  } catch (err) {
    console.error("[Videos] listRecent failed:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
