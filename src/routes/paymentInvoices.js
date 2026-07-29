/**
 * src/routes/paymentInvoices.js
 *
 * HTTP surface for the "Payment → Invoices" page.
 *
 *   GET /api/payment-invoices/lookup?paymentId=123
 *     → { ok, payment, invoices:[…summary…], invoiceCount, missingInvoiceIds }
 *       Used to populate the on-screen preview table before download.
 *
 *   GET /api/payment-invoices/download?paymentId=123
 *     → streams a single combined, full-detail PDF of every invoice tied to the
 *       payment. Content-Disposition attachment: payment-<id>-invoices.pdf
 *
 * The PDF is rendered by us from ServiceTitan invoice data (ST does not expose
 * its own branded invoice PDF via the API).
 */

const express = require("express");
const {
  getPaymentPreview,
  getPaymentDebug,
  buildPaymentInvoicesPdf,
  buildSingleInvoicePdf,
  buildInvoicesZip,
} = require("../services/paymentInvoiceService");

const router = express.Router();

function cleanPaymentId(raw) {
  const s = (raw ?? "").toString().trim();
  // ST payment IDs are numeric. Accept digits only; strip a leading # if pasted.
  const m = s.replace(/^#/, "");
  return /^\d+$/.test(m) ? m : null;
}

// ── GET /lookup ───────────────────────────────────────────────────────────────
router.get("/lookup", async (req, res) => {
  const paymentId = cleanPaymentId(req.query.paymentId);
  if (!paymentId) {
    return res
      .status(400)
      .json({ ok: false, error: "A numeric payment ID is required." });
  }

  // Temporary diagnostics: /lookup?paymentId=123&debug=1 returns the raw ST
  // response shape so we can confirm field mappings. Safe to remove later.
  if (req.query.debug) {
    try {
      const dbg = await getPaymentDebug(paymentId);
      return res.json({ ok: true, debug: dbg });
    } catch (err) {
      return handleErr(res, paymentId, err, "debug");
    }
  }

  try {
    const data = await getPaymentPreview(paymentId);
    console.log(
      `[PaymentInvoices] Lookup payment ${paymentId} → ${data.invoiceCount} invoice(s)` +
        (data.missingInvoiceIds.length
          ? ` (${data.missingInvoiceIds.length} applied ID(s) not returned as invoices)`
          : "")
    );
    return res.json({ ok: true, ...data });
  } catch (err) {
    return handleErr(res, paymentId, err, "lookup");
  }
});

// ── GET /download ─────────────────────────────────────────────────────────────
router.get("/download", async (req, res) => {
  const paymentId = cleanPaymentId(req.query.paymentId);
  if (!paymentId) {
    return res
      .status(400)
      .json({ ok: false, error: "A numeric payment ID is required." });
  }

  try {
    const { buffer, invoiceCount } = await buildPaymentInvoicesPdf(paymentId);
    if (invoiceCount === 0) {
      return res.status(404).json({
        ok: false,
        error: `Payment ${paymentId} has no invoices applied to it.`,
      });
    }
    console.log(
      `[PaymentInvoices] Download payment ${paymentId} → ${invoiceCount} invoice(s), ${(
        buffer.length / 1024
      ).toFixed(0)}KB PDF`
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="payment-${paymentId}-invoices.pdf"`
    );
    res.setHeader("Content-Length", buffer.length);
    return res.send(buffer);
  } catch (err) {
    return handleErr(res, paymentId, err, "download");
  }
});

// ── GET /download-zip ─────────────────────────────────────────────────────────
// One PDF per invoice, bundled into a single .zip.
router.get("/download-zip", async (req, res) => {
  const paymentId = cleanPaymentId(req.query.paymentId);
  if (!paymentId) {
    return res.status(400).json({ ok: false, error: "A numeric payment ID is required." });
  }
  try {
    const { buffer, invoiceCount } = await buildInvoicesZip(paymentId);
    if (invoiceCount === 0 || !buffer) {
      return res.status(404).json({
        ok: false,
        error: `Payment ${paymentId} has no invoices applied to it.`,
      });
    }
    console.log(
      `[PaymentInvoices] Zip payment ${paymentId} → ${invoiceCount} PDF(s), ${(
        buffer.length / 1024
      ).toFixed(0)}KB zip`
    );
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="payment-${paymentId}-invoices.zip"`
    );
    res.setHeader("Content-Length", buffer.length);
    return res.send(buffer);
  } catch (err) {
    return handleErr(res, paymentId, err, "download-zip");
  }
});

// ── GET /download-one ─────────────────────────────────────────────────────────
// A single invoice as its own PDF.
router.get("/download-one", async (req, res) => {
  const paymentId = cleanPaymentId(req.query.paymentId);
  const invoiceId = (req.query.invoiceId || "").toString().trim();
  if (!paymentId || !/^\d+$/.test(invoiceId)) {
    return res
      .status(400)
      .json({ ok: false, error: "A numeric payment ID and invoice ID are required." });
  }
  try {
    const { buffer, fileName } = await buildSingleInvoicePdf(paymentId, invoiceId);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Length", buffer.length);
    return res.send(buffer);
  } catch (err) {
    return handleErr(res, paymentId, err, "download-one");
  }
});

function handleErr(res, paymentId, err, where) {
  const status = err.code === "PAYMENT_NOT_FOUND" ? 404 : (err.response?.status || 500);
  const apiMsg =
    err.response?.data?.title ||
    err.response?.data?.message ||
    err.message ||
    "Unexpected error";
  console.error(`[PaymentInvoices] ${where} failed for payment ${paymentId}: ${apiMsg}`);
  return res.status(status).json({ ok: false, error: apiMsg });
}

module.exports = router;
