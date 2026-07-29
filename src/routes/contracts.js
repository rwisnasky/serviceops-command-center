/**
 * src/routes/contracts.js
 *
 * HTTP surface for the Contract Compare tool.
 *
 *   POST /api/contracts/compare
 *     multipart/form-data with up to two files:
 *       - oldFile         (PDF, DOCX, or text)
 *       - newFile         (PDF, DOCX, or text)
 *     OR text fields:
 *       - oldText         pasted contents of the original
 *       - newText         pasted contents of the new version
 *
 *     Either side can be a file OR a paste — they can mix (e.g. paste old,
 *     upload new). Returns the structured diff payload from the service.
 *
 * Multer holds uploads in memory (no disk write) — contract text is sensitive
 * and there's no reason to leave a copy on the volume. 25 MB cap matches the
 * invoice import route.
 */

const express = require("express");
const multer = require("multer");
const { compareContracts } = require("../services/contractDiffService");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per file
  fileFilter: (_req, file, cb) => {
    const name = (file.originalname || "").toLowerCase();
    const ok =
      file.mimetype === "application/pdf" ||
      file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      file.mimetype?.startsWith("text/") ||
      /\.(pdf|docx|txt|md)$/i.test(name);
    cb(ok ? null : new Error("Only PDF, DOCX, or plain text files are allowed"), ok);
  },
});

// Accept up to one file in each named field. .fields() gives us a map of
// arrays — we read [0] of each below.
const uploadFields = upload.fields([
  { name: "oldFile", maxCount: 1 },
  { name: "newFile", maxCount: 1 },
]);

router.post("/compare", (req, res) => {
  uploadFields(req, res, async (uploadErr) => {
    if (uploadErr) {
      const status = uploadErr.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).json({ ok: false, error: uploadErr.message });
    }
    try {
      const oldFile = req.files?.oldFile?.[0];
      const newFile = req.files?.newFile?.[0];
      const oldText = req.body?.oldText;
      const newText = req.body?.newText;

      // Each side must have *something* — file or text.
      if (!oldFile && !(oldText && oldText.trim())) {
        return res
          .status(400)
          .json({ ok: false, error: "Provide the original contract: upload a file or paste the text." });
      }
      if (!newFile && !(newText && newText.trim())) {
        return res
          .status(400)
          .json({ ok: false, error: "Provide the new contract: upload a file or paste the text." });
      }

      const oldInput = oldFile
        ? { buffer: oldFile.buffer, mime: oldFile.mimetype, filename: oldFile.originalname }
        : { pastedText: oldText };
      const newInput = newFile
        ? { buffer: newFile.buffer, mime: newFile.mimetype, filename: newFile.originalname }
        : { pastedText: newText };

      const result = await compareContracts(oldInput, newInput);

      return res.json({
        ok: true,
        ...result,
        meta: {
          oldName: oldFile?.originalname || "(pasted)",
          newName: newFile?.originalname || "(pasted)",
          oldBytes: oldFile?.size || (oldText?.length || 0),
          newBytes: newFile?.size || (newText?.length || 0),
        },
      });
    } catch (err) {
      const status = err.status || 500;
      console.error(`[contracts/compare] ${err.message}`);
      return res.status(status).json({ ok: false, error: err.message });
    }
  });
});

module.exports = router;
