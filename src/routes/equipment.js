/**
 * src/routes/equipment.js
 *
 * HTTP surface for the Equipment page (Installed Equipment → ServiceTitan +
 * Rinnai ProPortal CSV).
 *
 *   GET  /api/equipment/types                         → tab/field config (JSON-safe)
 *   GET  /api/equipment/customers?q=                  → customer search (name or ID)
 *   GET  /api/equipment/locations?customerId=         → that customer's locations
 *   POST /api/equipment/decode-serial {serial,installedOn}
 *                                                     → live serial → manufacture date
 *   POST /api/equipment/preview {equipmentTypeId,customerId,locationId,formData}
 *                                                     → full preview (no writes)
 *   POST /api/equipment/submit  {...same...}          → write to ST + persist row
 *   GET  /api/equipment/proportal/pending?typeId=     → { count }
 *   POST /api/equipment/proportal/export {typeId}     → { csv, count, filename } + marks exported
 *   GET  /api/equipment/recent?limit=                 → recent registrations
 */

const express = require("express");
const multer = require("multer");
const {
  listEquipmentTypes,
  getEquipmentType,
  publicView,
} = require("../config/equipmentTypes");
const svc = require("../services/equipmentRegistrationService");
const asSvc = require("../services/americanStandardService");
const bwSvc = require("../services/bradfordWhiteService");
const repo = require("../db/installedEquipmentRepository");

const router = express.Router();

// ── Multer — American Standard warranty PDF, kept in memory (parse then discard).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // warranty PDFs are tiny; 15 MB is plenty
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === "application/pdf" || /\.pdf$/i.test(file.originalname);
    cb(ok ? null : new Error("Please upload a PDF."), ok);
  },
});
// Wrap so a rejected upload returns clean 400 JSON instead of Express's 500 HTML.
function uploadWarrantyPdf(req, res, next) {
  upload.single("warrantyPdf")(req, res, (err) => {
    if (!err) return next();
    const msg =
      err instanceof multer.MulterError
        ? (err.code === "LIMIT_FILE_SIZE" ? "That PDF is too large (max 15 MB)." : err.message)
        : (err.message || "Upload failed.");
    return res.status(400).json({ ok: false, error: msg });
  });
}

// ── Multer — Bradford White registration screenshot (image) OR a PDF, in memory.
const uploadImg = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\//.test(file.mimetype) || file.mimetype === "application/pdf" ||
      /\.(png|jpe?g|webp|gif|pdf)$/i.test(file.originalname);
    cb(ok ? null : new Error("Please upload an image (PNG/JPG) or PDF."), ok);
  },
});
function uploadWarrantyImage(req, res, next) {
  uploadImg.single("warrantyPdf")(req, res, (err) => {
    if (!err) return next();
    const msg =
      err instanceof multer.MulterError
        ? (err.code === "LIMIT_FILE_SIZE" ? "That file is too large (max 15 MB)." : err.message)
        : (err.message || "Upload failed.");
    return res.status(400).json({ ok: false, error: msg });
  });
}

// Resolve a human label for created_by from the session, best-effort.
function createdByFrom(req) {
  const uid = req.session?.userId;
  if (!uid) return null;
  try {
    const { findById } = require("../db/userRepository");
    const u = findById(uid);
    return u?.email || u?.name || String(uid);
  } catch (_) {
    return String(uid);
  }
}

router.get("/types", (_req, res) => {
  res.json({ ok: true, types: listEquipmentTypes().map(publicView) });
});

router.get("/customers", async (req, res) => {
  try {
    const results = await svc.searchCustomers(req.query.q);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get("/locations", async (req, res) => {
  try {
    if (!req.query.customerId) {
      return res.status(400).json({ ok: false, error: "customerId required" });
    }
    const locations = await svc.getLocationsForCustomer(req.query.customerId);
    res.json({ ok: true, locations });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post("/decode-serial", (req, res) => {
  const { serial, installedOn } = req.body || {};
  res.json({ ok: true, ...svc.previewSerial(serial, installedOn) });
});

router.post("/preview", async (req, res) => {
  try {
    const { equipmentTypeId, customerId, locationId, formData } = req.body || {};
    const preview = await svc.buildPreview({ equipmentTypeId, customerId, locationId, formData });
    res.json(preview);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post("/submit", async (req, res) => {
  try {
    const { equipmentTypeId, customerId, locationId, formData } = req.body || {};
    const result = await svc.submitRegistration({
      equipmentTypeId, customerId, locationId, formData,
      createdBy: createdByFrom(req),
    });
    // A failed ST write still returns 200 with ok:false + stError so the UI can
    // show what happened (the unit is captured for the ProPortal CSV regardless).
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get("/proportal/pending", (req, res) => {
  const typeId = req.query.typeId || null;
  if (typeId && !getEquipmentType(typeId)) {
    return res.status(400).json({ ok: false, error: "unknown typeId" });
  }
  res.json({ ok: true, count: repo.countPendingProPortal(typeId) });
});

router.post("/proportal/export", (req, res) => {
  try {
    const typeId = (req.body && req.body.typeId) || null;
    if (!typeId) return res.status(400).json({ ok: false, error: "typeId required" });
    if (!getEquipmentType(typeId)) return res.status(400).json({ ok: false, error: "unknown typeId" });
    const out = svc.generateProPortalCsv(typeId, { markExported: true });
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get("/recent", (req, res) => {
  try {
    const rows = repo.listRecent(req.query.limit);
    res.json({ ok: true, rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── American Standard: warranty-PDF import (whole system OR a single piece) ────
//
//   POST /api/equipment/american-standard/parse   (multipart: warrantyPdf)
//        → { warrantyNumber, customer, dealer, units[] }  (no writes)
//   POST /api/equipment/american-standard/preview {locationId, units, warrantyNumber}
//        → { items:[{unit, stPayload, warnings}] }         (no writes)
//   POST /api/equipment/american-standard/submit  {customerId, locationId,
//                customerName, locationAddress, units, warrantyNumber}
//        → { ok, created, failed, results[] }  (one ST Installed Equipment write
//          + one DB row per unit)

router.post("/american-standard/parse", uploadWarrantyPdf, async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, error: "No PDF uploaded." });
    }
    const parsed = await asSvc.parseUploadedPdf(req.file.buffer);
    res.json({
      ok: true,
      warrantyNumber: parsed.warrantyNumber,
      customer: parsed.customer,
      dealer: parsed.dealer,
      units: parsed.units,
      note: parsed.units.length
        ? null
        : "No equipment rows were found in this PDF — you can add units manually.",
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post("/american-standard/preview", async (req, res) => {
  try {
    const { locationId, units, warrantyNumber, applyLaborWarranty } = req.body || {};
    if (!locationId) return res.status(400).json({ ok: false, error: "locationId required" });
    const items = await asSvc.buildBatchPreview({ locationId, units, warrantyNumber, applyLaborWarranty });
    res.json({
      ok: true,
      items,
      wholeSystem: asSvc.isWholeSystem(units),
      laborWarrantyYears: asSvc.LABOR_WARRANTY_YEARS,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post("/american-standard/submit", async (req, res) => {
  try {
    const {
      customerId, locationId, customerName, locationAddress, units, warrantyNumber,
      applyLaborWarranty, createMembership,
    } = req.body || {};
    if (!locationId) return res.status(400).json({ ok: false, error: "locationId required" });
    if (!Array.isArray(units) || !units.length) {
      return res.status(400).json({ ok: false, error: "No units to register." });
    }
    const out = await asSvc.submitBatch({
      customerId, locationId, customerName, locationAddress, units, warrantyNumber,
      applyLaborWarranty, createMembership,
      createdBy: createdByFrom(req),
    });
    // Partial/total ST failures still return 200 with per-unit detail so the UI
    // can show exactly which units wrote and which didn't.
    res.json(out);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/equipment/american-standard/jobs?customerId=&locationId=
// Suggests the customer's recent jobs (newest first), filtered to the chosen
// location, so the office can attach the warranty PDF to the right job.
router.get("/american-standard/jobs", async (req, res) => {
  try {
    const st = require("../api/servicetitan");
    const { customerId, locationId } = req.query;
    if (!customerId || !/^\d+$/.test(String(customerId))) {
      return res.status(400).json({ ok: false, error: "numeric customerId required" });
    }
    let jobs = await st.getRecentJobsForCustomer(Number(customerId), { pageSize: 20 });
    if (locationId) jobs = jobs.filter((j) => String(j.locationId) === String(locationId));
    const mapped = jobs.map((j) => ({
      id: j.id,
      jobNumber: j.jobNumber || String(j.id),
      status: j.jobStatus || j.status || "",
      date: String(j.modifiedOn || j.createdOn || "").slice(0, 10),
      locationId: j.locationId,
    }));
    res.json({ ok: true, jobs: mapped });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/equipment/american-standard/job-lookup?jobNumber=2602739
// Confirms a typed job number exists and resolves it to the internal job ID.
router.get("/american-standard/job-lookup", async (req, res) => {
  try {
    const st = require("../api/servicetitan");
    const jobNumber = req.query.jobNumber;
    if (!jobNumber || !String(jobNumber).trim()) {
      return res.status(400).json({ ok: false, error: "jobNumber required" });
    }
    const found = await st.findJobByNumber(String(jobNumber).trim());
    if (!found.jobId) return res.json({ ok: false, error: "No job found for that number." });
    res.json({ ok: true, jobId: found.jobId, jobNumber: found.jobNumber || String(jobNumber).trim() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/equipment/american-standard/attach-pdf  (multipart: warrantyPdf + jobId|jobNumber)
// Attaches the warranty PDF to a ServiceTitan job (Forms v2 job attachments).
router.post("/american-standard/attach-pdf", uploadWarrantyPdf, async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ ok: false, error: "No PDF uploaded." });
    const st = require("../api/servicetitan");
    let jobId = req.body && req.body.jobId;
    const jobNumber = req.body && req.body.jobNumber;
    if (!jobId && jobNumber) {
      const found = await st.findJobByNumber(String(jobNumber).trim());
      jobId = found.jobId;
    }
    if (!jobId) return res.status(400).json({ ok: false, error: "A valid jobId or jobNumber is required." });
    const wn = req.body.warrantyNumber ? String(req.body.warrantyNumber).replace(/[^\w-]/g, "") : "";
    const tag = wn || new Date().toISOString().slice(0, 10);
    const filename = `AmericanStandard_Warranty_${tag}.pdf`;
    const result = await st.createJobAttachment(Number(jobId), req.file.buffer, {
      filename, contentType: "application/pdf",
    });
    res.json({ ok: true, fileName: (result && result.fileName) || filename });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Bradford White: registration-screenshot import (OCR via OpenAI Vision) ────
//
//   POST /api/equipment/bradford-white/parse    (multipart: warrantyPdf = image/PDF)
//   POST /api/equipment/bradford-white/preview   {locationId, units}
//   POST /api/equipment/bradford-white/submit    {customerId, locationId, ...units}
//   GET  /api/equipment/bradford-white/job-lookup?jobNumber=
//   POST /api/equipment/bradford-white/attach-pdf (multipart: warrantyPdf image + jobId|jobNumber)

router.post("/bradford-white/parse", uploadWarrantyImage, async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ ok: false, error: "No file uploaded." });
    const out = await bwSvc.parseUploadedImage(req.file.buffer, req.file.originalname || "upload.png");
    res.json({
      ok: true,
      units: out.units,
      note: out.units.length ? null : "Couldn't read a serial/model from that image — try a clearer screenshot or add the unit by hand.",
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post("/bradford-white/preview", async (req, res) => {
  try {
    const { locationId, units } = req.body || {};
    if (!locationId) return res.status(400).json({ ok: false, error: "locationId required" });
    const items = await bwSvc.buildBatchPreview({ locationId, units });
    res.json({ ok: true, items });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post("/bradford-white/submit", async (req, res) => {
  try {
    const { customerId, locationId, customerName, locationAddress, units } = req.body || {};
    if (!locationId) return res.status(400).json({ ok: false, error: "locationId required" });
    if (!Array.isArray(units) || !units.length) return res.status(400).json({ ok: false, error: "No units to register." });
    const out = await bwSvc.submitBatch({
      customerId, locationId, customerName, locationAddress, units,
      createdBy: createdByFrom(req),
    });
    res.json(out);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get("/bradford-white/job-lookup", async (req, res) => {
  try {
    const st = require("../api/servicetitan");
    const jobNumber = req.query.jobNumber;
    if (!jobNumber || !String(jobNumber).trim()) return res.status(400).json({ ok: false, error: "jobNumber required" });
    const found = await st.findJobByNumber(String(jobNumber).trim());
    if (!found.jobId) return res.json({ ok: false, error: "No job found for that number." });
    res.json({ ok: true, jobId: found.jobId, jobNumber: found.jobNumber || String(jobNumber).trim() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Attach the registration screenshot (image or PDF) to a ServiceTitan job.
router.post("/bradford-white/attach-pdf", uploadWarrantyImage, async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ ok: false, error: "No file uploaded." });
    const st = require("../api/servicetitan");
    let jobId = req.body && req.body.jobId;
    const jobNumber = req.body && req.body.jobNumber;
    if (!jobId && jobNumber) {
      const found = await st.findJobByNumber(String(jobNumber).trim());
      jobId = found.jobId;
    }
    if (!jobId) return res.status(400).json({ ok: false, error: "A valid jobId or jobNumber is required." });
    const ct = req.file.mimetype && /^image\/|application\/pdf/.test(req.file.mimetype) ? req.file.mimetype : "image/png";
    const ext = ct === "application/pdf" ? "pdf" : (ct.split("/")[1] || "png");
    const filename = `BradfordWhite_Registration_${new Date().toISOString().slice(0, 10)}.${ext}`;
    const result = await st.createJobAttachment(Number(jobId), req.file.buffer, { filename, contentType: ct });
    res.json({ ok: true, fileName: (result && result.fileName) || filename });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
