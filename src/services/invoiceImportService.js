/**
 * src/services/invoiceImportService.js
 *
 * Orchestration layer for the dashboard Invoice → PO flow. The two phases
 * (parse & preview, then create PO) live here so the HTTP route stays thin.
 *
 *   1) parseAndPreview(filePath, { jobNumberOverride })
 *        → runs the LLM parser
 *        → resolves job (parser's jobNumber, or override)
 *        → resolves vendor
 *        → returns a "preview" object the UI renders for user confirmation
 *          (NO purchase order is created here)
 *
 *   2) createPoFromPreview(preview, { fileName })
 *        → creates the PO on the matched job
 *        → logs a row to `invoice_uploads`
 *
 * Logging:
 *   One row is written to `invoice_uploads` for every create-PO attempt,
 *   including failures — so the Recent Imports log on the dashboard is a
 *   complete audit trail.
 */

const { parseInvoice } = require("./invoiceParserService");
const st = require("../api/servicetitan");
const { getDb } = require("../db/index");
const { matchBatch: matchInvoiceLinesToPricebook } =
  require("./poPricebookMatchService");
const { autoSyncIfStale } = require("./pricebookIndexService");

// ── Public: parse + look up (no mutation) ─────────────────────────────────────

/**
 * Parse the invoice file, then resolve job + vendor in ServiceTitan.
 * Returns a plain object for the UI to render; nothing is mutated in ST.
 */
async function parseAndPreview(filePath, { jobNumberOverride = null } = {}) {
  // Make sure the local pricebook index is warm enough for line matching.
  // No-op on a fresh cache; swallow errors so a sync blip doesn't block parse.
  try {
    await autoSyncIfStale(30);
  } catch (err) {
    console.warn(`[Invoice] Pricebook auto-sync warning: ${err.message}`);
  }

  const parsed = await parseInvoice(filePath);

  // Prefer the user-entered job# if they provided one; otherwise use the
  // number the parser found on the invoice.
  const jobNumber =
    (jobNumberOverride && String(jobNumberOverride).trim()) ||
    parsed.jobNumber ||
    null;

  // ── Job lookup ──────────────────────────────────────────────────────────────
  let jobMatch = { jobId: null, jobNumber: null, error: null };
  if (jobNumber) {
    try {
      const { jobId, jobNumber: confirmed } = await st.findJobByNumber(jobNumber);
      jobMatch = { jobId, jobNumber: confirmed || jobNumber, error: null };
    } catch (err) {
      jobMatch.error = err.message;
    }
  } else {
    jobMatch.error =
      "No job number found on the invoice. Enter one in the Job # field.";
  }

  // ── Vendor lookup ───────────────────────────────────────────────────────────
  let vendorMatch = { id: null, name: null, error: null };
  if (parsed.vendor) {
    try {
      const vendor = await st.findVendorByName(parsed.vendor);
      if (vendor) {
        vendorMatch = { id: vendor.id, name: vendor.name, error: null };
      } else {
        vendorMatch.error =
          `No ServiceTitan vendor found for "${parsed.vendor}". ` +
          `Create the vendor in ServiceTitan, then click Re-check.`;
      }
    } catch (err) {
      vendorMatch.error = err.message;
    }
  } else {
    vendorMatch.error = "Parser returned no vendor name.";
  }

  // ── Pricebook match per line ───────────────────────────────────────────────
  // Attach pricebookMatch to each line item so the UI can show "already in
  // pricebook" vs. "new SKU" and let the user pick which to push into ST.
  const lineItemsWithMatches = matchInvoiceLinesToPricebook(
    parsed.lineItems || []
  );
  const matchCounts = lineItemsWithMatches.reduce(
    (acc, li) => {
      const s = li.pricebookMatch?.status || "unmatched";
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    },
    { matched: 0, unmatched: 0 }
  );

  const ready = Boolean(
    jobMatch.jobId &&
      vendorMatch.id &&
      parsed.lineItems?.length
  );

  return {
    parsed: {
      vendor: parsed.vendor,
      invoiceNumber: parsed.invoiceNumber,
      invoiceDate: parsed.invoiceDate,
      subtotal: parsed.subtotal,
      tax: parsed.tax,
      total: parsed.total,
      lineItems: lineItemsWithMatches,
      pricebookMatchCounts: matchCounts,
      // echo back both so the UI can show what the parser found vs. what the
      // user overrode:
      parsedJobNumber: parsed.jobNumber,
      parsedJobNumberLabel: parsed.jobNumberLabel || null,
      usedJobNumber: jobNumber,
    },
    jobMatch,
    vendorMatch,
    ready,
  };
}

// ── Public: create PO from the preview we just returned ───────────────────────

/**
 * Accepts the preview payload (optionally edited by the user) and pushes the
 * PO to ServiceTitan. Writes one row to `invoice_uploads` either way.
 *
 * The PDF itself is NOT attached to the PO here — ServiceTitan's public API
 * doesn't support programmatic attachment creation. Attaching the invoice
 * PDF to the PO remains a manual step the user does in the ST UI at the
 * same time they flip the PO to Sent.
 */
async function createPoFromPreview(preview, { fileName = null } = {}) {
  if (!preview || !preview.parsed) {
    throw new Error("createPoFromPreview: preview payload missing");
  }
  const { parsed, jobMatch, vendorMatch } = preview;

  // Defensive server-side validation (UI should have blocked bad previews,
  // but trust-no-one for the code path that actually hits ST).
  if (!jobMatch?.jobId) throw new Error("Cannot create PO — no job match.");
  if (!vendorMatch?.id) throw new Error("Cannot create PO — no vendor match.");
  if (!parsed.lineItems?.length)
    throw new Error("Cannot create PO — no line items.");

  let po = null;
  let err = null;
  try {
    const invoiceDateIso = parsed.invoiceDate
      ? new Date(parsed.invoiceDate).toISOString()
      : new Date().toISOString();

    // Roll tax into the line items so the PO total matches the invoice total
    // exactly, with a single "Tax" field of 0 on the PO. We scale each line's
    // unit cost by (subtotal + tax) / subtotal so the per-line detail is
    // preserved and the totals add up correctly.
    const rawItems = parsed.lineItems.map((it) => {
      const qty = Number(it.quantity || 1);
      const unit =
        Number(it.unitCost) ||
        (qty ? Number(it.lineTotal) / qty : 0);
      return { raw: it, qty, unit };
    });
    const subtotal = rawItems.reduce((s, r) => s + r.unit * r.qty, 0);
    const taxAmt = Number(parsed.tax) || 0;
    const scale = subtotal > 0 ? (subtotal + taxAmt) / subtotal : 1;

    po = await st.createPurchaseOrder({
      jobId: jobMatch.jobId,
      vendorId: vendorMatch.id,
      items: rawItems.map(({ raw, qty, unit }) => ({
        skuName: raw.sku || (raw.description || "Item").slice(0, 60),
        description: raw.description,
        quantity: qty,
        // Round to 4 decimals — ST tolerates fractional cents and this keeps
        // the per-line total within a penny of (unit × qty × scale).
        cost: Math.round(unit * scale * 10000) / 10000,
      })),
      summary: `Auto-imported from supplier invoice ${parsed.invoiceNumber || ""} (${parsed.vendor || ""})`.trim(),
      date: invoiceDateIso,
      requiredOn: invoiceDateIso, // invoice is for goods already received — same as invoice date
      tax: 0, // tax is rolled into line item costs above
      shipping: 0, // supplier invoices rarely break out shipping separately
      vendorDocumentNumber: parsed.invoiceNumber || undefined,
    });
  } catch (e) {
    err = e;
  }

  // NOTE: ServiceTitan's public API does NOT support programmatic PO status
  // updates or attachment creation. The PO stays in "Pending" and has to be
  // flipped to Sent + have the PDF attached manually in the ST UI. The
  // attach/sent DB columns are left in place for future use (default 0).
  const attached = false;
  const attachError = null;
  const sent = false;
  const sentError = null;

  // ── Log (success OR failure) ───────────────────────────────────────────────
  recordUpload({
    vendor: parsed.vendor,
    invoiceNumber: parsed.invoiceNumber,
    invoiceDate: parsed.invoiceDate,
    jobNumber: jobMatch.jobNumber || parsed.usedJobNumber,
    jobId: jobMatch.jobId,
    vendorId: vendorMatch.id,
    total: parsed.total,
    poId: po?.id || null,
    poNumber: po?.number || null,
    status: err ? "failed" : "created",
    error: err ? err.message : null,
    fileName,
    attached,
    attachError,
    sent,
    sentError,
  });

  if (err) throw err;

  return {
    poId: po.id,
    poNumber: po.number || null,
    jobNumber: jobMatch.jobNumber || parsed.usedJobNumber,
    jobId: jobMatch.jobId,
    vendor: vendorMatch.name,
    total: parsed.total,
  };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function recordUpload({
  vendor,
  invoiceNumber,
  invoiceDate,
  jobNumber,
  jobId,
  vendorId,
  total,
  poId,
  poNumber,
  status,
  error,
  fileName,
  attached = false,
  attachError = null,
  sent = false,
  sentError = null,
}) {
  const db = getDb();
  db.prepare(
    `
    INSERT INTO invoice_uploads
      (vendor, invoice_number, invoice_date, job_number, job_id, vendor_id,
       total, po_id, po_number, status, error, file_name,
       attached, attach_error, sent, sent_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    vendor || null,
    invoiceNumber || null,
    invoiceDate || null,
    jobNumber ? String(jobNumber) : null,
    jobId ? String(jobId) : null,
    vendorId ? String(vendorId) : null,
    total != null ? Number(total) : null,
    poId ? String(poId) : null,
    poNumber ? String(poNumber) : null,
    status,
    error || null,
    fileName || null,
    attached ? 1 : 0,
    attachError || null,
    sent ? 1 : 0,
    sentError || null
  );
}

function listRecentImports(limit = 25) {
  const db = getDb();
  return db
    .prepare(
      `
    SELECT id, vendor, invoice_number, invoice_date, job_number, job_id,
           vendor_id, total, po_id, po_number, status, error, file_name,
           attached, attach_error, sent, sent_error, created_at
    FROM invoice_uploads
    ORDER BY datetime(created_at) DESC
    LIMIT ?
  `
    )
    .all(Math.min(Number(limit) || 25, 200));
}

/**
 * Clear rows from the invoice_uploads log.
 *   clearRecentImports('failed') — only failed attempts (safe default)
 *   clearRecentImports('all')    — everything, including successful POs
 * Returns the number of rows deleted.
 */
function clearRecentImports(scope = "failed") {
  const db = getDb();
  let info;
  if (scope === "all") {
    info = db.prepare(`DELETE FROM invoice_uploads`).run();
  } else {
    info = db.prepare(`DELETE FROM invoice_uploads WHERE status = ?`).run("failed");
  }
  return info.changes;
}

module.exports = {
  parseAndPreview,
  createPoFromPreview,
  listRecentImports,
  clearRecentImports,
};
