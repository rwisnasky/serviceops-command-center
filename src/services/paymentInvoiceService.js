/**
 * src/services/paymentInvoiceService.js
 *
 * "Payment → Invoices" feature.
 *
 * Given a ServiceTitan payment ID we:
 *   1. Fetch the payment (accounting/v2) and read its `appliedTo` array to find
 *      every invoice the payment was applied to.
 *   2. Fetch the full invoice records (with line items) for those IDs.
 *   3. Either return a lightweight preview (for the on-screen table) or render
 *      a single combined, full-detail PDF containing every invoice.
 *
 * NOTE: ServiceTitan's API does NOT expose its own branded invoice PDF, so the
 * PDF here is rendered by us from the invoice data. It contains the same
 * numbers ST has (line items, totals, customer, job) but is our own layout.
 */

const PDFDocument = require("pdfkit");
const JSZip = require("jszip");
const {
  getPayment,
  getInvoicesByIds,
  getInvoicesByCustomer,
} = require("../api/servicetitan");

// ── Field helpers (defensive — ST payloads vary a little by tenant/version) ──
const firstDefined = (...vals) => vals.find((v) => v !== undefined && v !== null);

// Is this a usable scalar entity ID (number or numeric string)?
const isScalarId = (v) =>
  typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v));

function money(n) {
  const num = Number(n);
  if (!isFinite(num)) return "$0.00";
  return num.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtDate(raw) {
  if (!raw) return "—";
  const d = new Date(raw);
  if (isNaN(d)) return String(raw);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Pull the invoice IDs (and the amount applied to each) out of a payment.
//
// In ServiceTitan's payment payload each `appliedTo[]` entry looks like:
//   { appliedId: 66957293,      // the application/split record ID (NOT the invoice)
//     appliedTo: 64186094,      // ← the INVOICE ID
//     appliedToReferenceNumber: "2603497",  // the invoice's reference number
//     appliedAmount: "95.00", appliedOn, appliedBy }
//
// So the invoice ID is the entry's `appliedTo` field. We also tolerate a couple
// of alternate shapes (`invoiceId`, nested `invoice.id`). We never use
// `appliedId` — that's the split record, not the invoice.
function extractAppliedInvoices(payment) {
  const arr =
    (Array.isArray(payment?.appliedTo) && payment.appliedTo) ||
    (Array.isArray(payment?.splits) && payment.splits) ||
    (Array.isArray(payment?.invoices) && payment.invoices) ||
    [];

  const byId = new Map();
  for (const e of arr) {
    const id = firstDefined(
      isScalarId(e?.appliedTo) ? e.appliedTo : undefined,
      e?.invoiceId,
      e?.invoice?.id
    );
    if (id === undefined || id === null) continue;
    const key = String(id);
    const amount = Number(firstDefined(e.appliedAmount, e.amount, 0)) || 0;
    byId.set(key, (byId.get(key) || 0) + amount);
  }
  return byId; // Map<invoiceId, appliedAmount>
}

function paymentSummary(payment) {
  return {
    id: firstDefined(payment?.id, payment?.paymentId),
    referenceNumber: firstDefined(payment?.referenceNumber, payment?.reference, ""),
    date: firstDefined(payment?.paidOn, payment?.date, payment?.createdOn),
    total: Number(firstDefined(payment?.total, payment?.amount, 0)) || 0,
    unappliedAmount: Number(firstDefined(payment?.unappliedAmount, 0)) || 0,
    typeName: firstDefined(payment?.type, payment?.typeName, payment?.paymentType, ""),
    status: firstDefined(payment?.status, payment?.transactionStatus, ""),
    memo: firstDefined(payment?.memo, ""),
    customerName: firstDefined(payment?.customer?.name, ""),
    customerId: firstDefined(payment?.customer?.id, null),
  };
}

// Normalize one invoice record into the fields we render.
function invoiceView(inv, appliedAmount) {
  const items = Array.isArray(inv?.items) ? inv.items : [];
  return {
    id: inv?.id,
    number: firstDefined(inv?.number, inv?.referenceNumber, inv?.id),
    date: firstDefined(inv?.invoiceDate, inv?.createdOn, inv?.date),
    customerName: firstDefined(inv?.customer?.name, ""),
    locationName: firstDefined(inv?.location?.name, ""),
    businessUnit: firstDefined(inv?.businessUnit?.name, ""),
    jobNumber: firstDefined(inv?.job?.number, inv?.jobNumber, null),
    jobId: firstDefined(inv?.job?.id, null),
    summary: firstDefined(inv?.summary, ""),
    subTotal: Number(firstDefined(inv?.subTotal, inv?.subtotal, 0)) || 0,
    tax: Number(firstDefined(inv?.salesTax, inv?.tax, 0)) || 0,
    total: Number(firstDefined(inv?.total, 0)) || 0,
    balance: Number(firstDefined(inv?.balance, 0)) || 0,
    appliedAmount: Number(appliedAmount) || 0,
    items: items.map((it) => {
      const qty = Number(firstDefined(it?.quantity, it?.qty, 1)) || 0;
      const unit = Number(
        firstDefined(it?.price, it?.unitPrice, it?.total != null && qty ? it.total / qty : 0)
      ) || 0;
      const total = Number(firstDefined(it?.total, qty * unit)) || 0;
      return {
        description: firstDefined(
          it?.description,
          it?.skuName,
          it?.sku?.displayName,
          it?.name,
          "—"
        ),
        code: firstDefined(it?.skuName, it?.sku?.code, it?.code, ""),
        qty,
        unit,
        total,
      };
    }),
  };
}

// ── Fetch: payment + its invoices ────────────────────────────────────────────
async function getPaymentBundle(paymentId) {
  const payment = await getPayment(paymentId);
  if (!payment) {
    const err = new Error(`Payment ${paymentId} was not found in ServiceTitan.`);
    err.code = "PAYMENT_NOT_FOUND";
    throw err;
  }

  const appliedMap = extractAppliedInvoices(payment);
  const invoiceIds = [...appliedMap.keys()];
  const invoicesRaw = invoiceIds.length ? await getInvoicesByIds(invoiceIds) : [];

  // Preserve the applied amount alongside each invoice; keep the payment's
  // order where possible.
  const byInvId = new Map(invoicesRaw.map((i) => [String(i.id), i]));
  const invoices = invoiceIds
    .map((id) => {
      const raw = byInvId.get(String(id));
      return raw ? invoiceView(raw, appliedMap.get(String(id))) : null;
    })
    .filter(Boolean);

  return {
    payment: paymentSummary(payment),
    invoices,
    requestedInvoiceIds: invoiceIds,
    missingInvoiceIds: invoiceIds.filter((id) => !byInvId.has(String(id))),
  };
}

// Lightweight preview for the on-screen table.
async function getPaymentPreview(paymentId) {
  const bundle = await getPaymentBundle(paymentId);
  return {
    payment: bundle.payment,
    invoices: bundle.invoices.map((inv) => ({
      id: inv.id,
      number: inv.number,
      date: inv.date,
      customerName: inv.customerName,
      jobNumber: inv.jobNumber,
      total: inv.total,
      balance: inv.balance,
      appliedAmount: inv.appliedAmount,
      itemCount: inv.items.length,
    })),
    invoiceCount: bundle.invoices.length,
    missingInvoiceIds: bundle.missingInvoiceIds,
  };
}

// ── PDF rendering ────────────────────────────────────────────────────────────
// Colors kept simple/print-friendly (dark ink on white).
const INK = "#1a1a1a";
const MUTED = "#6b7280";
const LINE = "#d1d5db";
const ACCENT = "#0f3d6b";

function renderInvoicesPdf(payment, invoices, opts = {}) {
  const cover = opts.cover !== false; // default: include the cover/summary page
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 50 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageLeft = doc.page.margins.left;
    const pageRight = doc.page.width - doc.page.margins.right;
    const contentW = pageRight - pageLeft;

    if (cover) {
    // ── Cover / summary page ──────────────────────────────────────────────
    doc
      .fillColor(ACCENT)
      .font("Helvetica-Bold")
      .fontSize(22)
      .text("Payment Invoice Packet", pageLeft, doc.y);
    doc.moveDown(0.3);
    doc
      .fillColor(MUTED)
      .font("Helvetica")
      .fontSize(10)
      .text(
        "Generated from ServiceTitan data · " +
          new Date().toLocaleString("en-US"),
        { width: contentW }
      );

    doc.moveDown(1);

    // Payment summary box
    const boxTop = doc.y;
    doc
      .roundedRect(pageLeft, boxTop, contentW, 92, 6)
      .strokeColor(LINE)
      .lineWidth(1)
      .stroke();

    const col1 = pageLeft + 16;
    const col2 = pageLeft + contentW / 2 + 8;
    let ry = boxTop + 14;
    const kv = (label, value, x) => {
      doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(label.toUpperCase(), x, ry);
      doc
        .fillColor(INK)
        .font("Helvetica-Bold")
        .fontSize(11)
        .text(value == null || value === "" ? "—" : String(value), x, ry + 10, {
          width: contentW / 2 - 24,
        });
    };
    kv("Payment ID", payment.id, col1);
    kv("Payment Date", fmtDate(payment.date), col2);
    ry += 40;
    kv("Customer", payment.customerName, col1);
    kv("Payment Total", money(payment.total), col2);
    ry += 40;

    doc.y = boxTop + 92 + 16;

    // Reference / type / memo line (only if present)
    const bits = [];
    if (payment.referenceNumber) bits.push(`Ref: ${payment.referenceNumber}`);
    if (payment.typeName) bits.push(`Type: ${payment.typeName}`);
    if (payment.status) bits.push(`Status: ${payment.status}`);
    if (bits.length) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(bits.join("   ·   "), pageLeft, doc.y);
      doc.moveDown(0.6);
    }
    if (payment.memo) {
      doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(9).text(`Memo: ${payment.memo}`, pageLeft, doc.y, { width: contentW });
      doc.moveDown(0.6);
    }

    doc.moveDown(0.4);
    doc
      .fillColor(INK)
      .font("Helvetica-Bold")
      .fontSize(12)
      .text(
        `Invoices in this payment (${invoices.length})`,
        pageLeft,
        doc.y
      );
    doc.moveDown(0.4);

    // Summary table header
    const sCols = {
      inv: pageLeft,
      date: pageLeft + 110,
      job: pageLeft + 200,
      applied: pageRight - 190,
      total: pageRight - 95,
    };
    const summaryHeader = () => {
      doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8);
      doc.text("INVOICE", sCols.inv, doc.y, { continued: false });
      const hy = doc.y - doc.currentLineHeight();
      doc.text("DATE", sCols.date, hy);
      doc.text("JOB", sCols.job, hy);
      doc.text("APPLIED", sCols.applied, hy, { width: 85, align: "right" });
      doc.text("INV TOTAL", sCols.total, hy, { width: 85, align: "right" });
      doc.moveTo(pageLeft, doc.y + 2).lineTo(pageRight, doc.y + 2).strokeColor(LINE).lineWidth(1).stroke();
      doc.moveDown(0.5);
    };
    summaryHeader();

    doc.font("Helvetica").fontSize(9).fillColor(INK);
    for (const inv of invoices) {
      if (doc.y > doc.page.height - doc.page.margins.bottom - 30) {
        doc.addPage();
        summaryHeader();
        doc.font("Helvetica").fontSize(9).fillColor(INK);
      }
      const rowY = doc.y;
      doc.fillColor(INK).text(`#${inv.number}`, sCols.inv, rowY, { width: 105 });
      doc.fillColor(INK).text(fmtDate(inv.date), sCols.date, rowY, { width: 85 });
      doc.fillColor(INK).text(inv.jobNumber ? String(inv.jobNumber) : "—", sCols.job, rowY, { width: 120 });
      doc.fillColor(INK).text(money(inv.appliedAmount), sCols.applied, rowY, { width: 85, align: "right" });
      doc.fillColor(INK).text(money(inv.total), sCols.total, rowY, { width: 85, align: "right" });
      doc.moveDown(0.4);
    }
    } // end if (cover)

    // ── One full-detail section per invoice ───────────────────────────────
    // When there's a cover page, each invoice starts on its own new page. When
    // there's no cover (single-invoice files), the first invoice renders on the
    // initial page.
    let started = cover;
    for (const inv of invoices) {
      if (started) doc.addPage();
      renderInvoiceDetail(doc, payment, inv, { pageLeft, pageRight, contentW });
      started = true;
    }

    doc.end();
  });
}

function renderInvoiceDetail(doc, payment, inv, geo) {
  const { pageLeft, pageRight, contentW } = geo;

  // Header
  doc
    .fillColor(ACCENT)
    .font("Helvetica-Bold")
    .fontSize(18)
    .text(`Invoice #${inv.number}`, pageLeft, doc.y);
  const headerY = doc.y - doc.currentLineHeight();
  doc
    .fillColor(MUTED)
    .font("Helvetica")
    .fontSize(10)
    .text(fmtDate(inv.date), pageLeft, headerY, { width: contentW, align: "right" });

  doc.moveDown(0.6);
  doc.moveTo(pageLeft, doc.y).lineTo(pageRight, doc.y).strokeColor(LINE).lineWidth(1).stroke();
  doc.moveDown(0.6);

  // Meta grid
  const metaY = doc.y;
  const colX = pageLeft;
  const colX2 = pageLeft + contentW / 2 + 8;
  const metaKv = (label, value, x, y) => {
    doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(label.toUpperCase(), x, y);
    doc
      .fillColor(INK)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text(value == null || value === "" ? "—" : String(value), x, y + 10, {
        width: contentW / 2 - 16,
      });
  };
  metaKv("Customer", inv.customerName, colX, metaY);
  metaKv("Job", inv.jobNumber ? `#${inv.jobNumber}` : "—", colX2, metaY);
  let y2 = metaY + 34;
  metaKv("Location", inv.locationName, colX, y2);
  metaKv("Business Unit", inv.businessUnit, colX2, y2);
  doc.y = y2 + 34;

  if (inv.summary) {
    doc.moveDown(0.2);
    doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(9).text(inv.summary, pageLeft, doc.y, { width: contentW });
  }
  doc.moveDown(0.6);

  // Line-item table
  const cDesc = pageLeft;
  const cQty = pageRight - 200;
  const cUnit = pageRight - 140;
  const cTot = pageRight - 70;

  const itemHeader = () => {
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8);
    const hy = doc.y;
    doc.text("DESCRIPTION", cDesc, hy, { width: cQty - cDesc - 8 });
    doc.text("QTY", cQty, hy, { width: 45, align: "right" });
    doc.text("UNIT", cUnit, hy, { width: 60, align: "right" });
    doc.text("TOTAL", cTot, hy, { width: 60, align: "right" });
    doc.moveDown(0.3);
    doc.moveTo(pageLeft, doc.y).lineTo(pageRight, doc.y).strokeColor(LINE).lineWidth(1).stroke();
    doc.moveDown(0.35);
  };
  itemHeader();

  doc.font("Helvetica").fontSize(9);
  if (inv.items.length === 0) {
    doc.fillColor(MUTED).font("Helvetica-Oblique").text("No line items on this invoice.", cDesc, doc.y);
    doc.moveDown(0.4);
  }
  for (const it of inv.items) {
    // Page-break guard, re-draw header on the continued page.
    if (doc.y > doc.page.height - doc.page.margins.bottom - 60) {
      doc.addPage();
      doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(11).text(`Invoice #${inv.number} (cont.)`, pageLeft, doc.y);
      doc.moveDown(0.5);
      itemHeader();
      doc.font("Helvetica").fontSize(9);
    }
    const rowY = doc.y;
    const label = it.code ? `${it.description}  (${it.code})` : it.description;
    doc.fillColor(INK).text(label, cDesc, rowY, { width: cQty - cDesc - 8 });
    const rowH = doc.y - rowY; // height consumed by (possibly wrapped) description
    doc.fillColor(INK).text(String(it.qty), cQty, rowY, { width: 45, align: "right" });
    doc.fillColor(INK).text(money(it.unit), cUnit, rowY, { width: 60, align: "right" });
    doc.fillColor(INK).text(money(it.total), cTot, rowY, { width: 60, align: "right" });
    doc.y = rowY + Math.max(rowH, doc.currentLineHeight());
    doc.moveDown(0.25);
  }

  // Totals block (right-aligned)
  doc.moveDown(0.3);
  doc.moveTo(cUnit - 20, doc.y).lineTo(pageRight, doc.y).strokeColor(LINE).lineWidth(1).stroke();
  doc.moveDown(0.4);
  const totalRow = (label, value, bold) => {
    const y = doc.y;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9).fillColor(bold ? INK : MUTED);
    doc.text(label, cUnit - 60, y, { width: 100, align: "right" });
    doc.fillColor(INK).font(bold ? "Helvetica-Bold" : "Helvetica").text(money(value), cTot, y, { width: 60, align: "right" });
    doc.moveDown(0.35);
  };
  totalRow("Subtotal", inv.subTotal, false);
  totalRow("Tax", inv.tax, false);
  totalRow("Total", inv.total, true);
  if (inv.balance) totalRow("Balance", inv.balance, false);
  doc.moveDown(0.2);
  totalRow("Applied from this payment", inv.appliedAmount, false);
}

// ── Debug: reveal the real ST response shape ──────────────────────────────────
// Returns the raw payment (so we can see the true appliedTo field names), a
// probe of fetching invoices by the IDs we currently extract, and one raw
// sample invoice for the payment's customer (to confirm invoice field names).
async function getPaymentDebug(paymentId) {
  const payment = await getPayment(paymentId);
  if (!payment) return { found: false, paymentId };

  const applied =
    payment.appliedTo || payment.splits || payment.invoices || [];
  const extracted = [...extractAppliedInvoices(payment).keys()];

  let probeInvoices = [];
  try {
    probeInvoices = extracted.length ? await getInvoicesByIds(extracted) : [];
  } catch (e) {
    probeInvoices = [{ probeError: e.message }];
  }

  let sampleInvoice = null;
  try {
    const custId = payment.customer?.id;
    if (custId) {
      const rows = await getInvoicesByCustomer(custId, 1);
      sampleInvoice = rows[0] || null;
    }
  } catch (e) {
    sampleInvoice = { sampleError: e.message };
  }

  return {
    found: true,
    paymentTopLevelKeys: Object.keys(payment),
    appliedToCount: applied.length,
    appliedToRaw: applied.slice(0, 3),
    currentlyExtractedIds: extracted,
    probeInvoiceCount: probeInvoices.length,
    probeInvoiceSampleKeys: probeInvoices[0] ? Object.keys(probeInvoices[0]) : [],
    sampleInvoiceKeys: sampleInvoice ? Object.keys(sampleInvoice) : [],
    sampleInvoice,
  };
}

// Convenience: fetch + render the combined packet in one call.
async function buildPaymentInvoicesPdf(paymentId) {
  const bundle = await getPaymentBundle(paymentId);
  const buffer = await renderInvoicesPdf(bundle.payment, bundle.invoices);
  return {
    buffer,
    invoiceCount: bundle.invoices.length,
    payment: bundle.payment,
    missingInvoiceIds: bundle.missingInvoiceIds,
  };
}

// A filesystem-safe name for one invoice's PDF, e.g. invoice-2603497.pdf
function invoiceFileName(inv) {
  const num = String(inv.number ?? inv.id ?? "invoice").replace(/[^\w.-]+/g, "_");
  return `invoice-${num}.pdf`;
}

// Render a single invoice as its own PDF (no cover/summary page).
async function buildSingleInvoicePdf(paymentId, invoiceId) {
  const bundle = await getPaymentBundle(paymentId);
  const inv = bundle.invoices.find((i) => String(i.id) === String(invoiceId));
  if (!inv) {
    const e = new Error(`Invoice ${invoiceId} is not part of payment ${paymentId}.`);
    e.code = "INVOICE_NOT_FOUND";
    throw e;
  }
  const buffer = await renderInvoicesPdf(bundle.payment, [inv], { cover: false });
  return { buffer, invoice: inv, fileName: invoiceFileName(inv), payment: bundle.payment };
}

// Build a ZIP containing one PDF per invoice tied to the payment.
async function buildInvoicesZip(paymentId) {
  const bundle = await getPaymentBundle(paymentId);
  if (bundle.invoices.length === 0) {
    return {
      buffer: null,
      invoiceCount: 0,
      payment: bundle.payment,
      missingInvoiceIds: bundle.missingInvoiceIds,
    };
  }

  const zip = new JSZip();
  const used = new Set();
  for (const inv of bundle.invoices) {
    const pdf = await renderInvoicesPdf(bundle.payment, [inv], { cover: false });
    let name = invoiceFileName(inv);
    if (used.has(name)) name = `invoice-${inv.number}-${inv.id}.pdf`; // dedupe
    used.add(name);
    zip.file(name, pdf);
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return {
    buffer,
    invoiceCount: bundle.invoices.length,
    payment: bundle.payment,
    missingInvoiceIds: bundle.missingInvoiceIds,
  };
}

module.exports = {
  getPaymentBundle,
  getPaymentPreview,
  getPaymentDebug,
  buildPaymentInvoicesPdf,
  buildSingleInvoicePdf,
  buildInvoicesZip,
  renderInvoicesPdf,
  extractAppliedInvoices,
};
