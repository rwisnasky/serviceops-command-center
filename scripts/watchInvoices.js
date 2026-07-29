#!/usr/bin/env node
/**
 * watchInvoices.js
 *
 * Watches a folder for new supplier-invoice PDFs. For each one:
 *   1. Parses the PDF with the OpenAI vision API.
 *   2. Looks up the matching ServiceTitan job (by job # printed on the invoice).
 *   3. Looks up / creates the vendor.
 *   4. Creates a Purchase Order on the job with the invoice line items.
 *   5. Moves the file to ./inbox/processed/  (or ./inbox/failed/ on error).
 *
 * Usage:
 *   node scripts/watchInvoices.js
 *   node scripts/watchInvoices.js path/to/invoice.pdf   # one-shot mode
 *
 * Env vars required:
 *   OPENAI_API_KEY
 *   ST_CLIENT_ID, ST_CLIENT_SECRET, ST_APP_KEY, ST_TENANT_ID
 *
 * Optional:
 *   INVOICE_INBOX_DIR   (default: ./inbox/invoices)
 *   INVOICE_POLL_MS     (default: 5000)
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const { parseInvoice } = require("../src/services/invoiceParserService");
const st = require("../src/api/servicetitan");

const ROOT = path.resolve(
  process.env.INVOICE_INBOX_DIR || path.join(__dirname, "..", "inbox", "invoices")
);
const PROCESSED = path.join(ROOT, "..", "processed");
const FAILED = path.join(ROOT, "..", "failed");
const POLL_MS = Number(process.env.INVOICE_POLL_MS || 5000);

for (const dir of [ROOT, PROCESSED, FAILED]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── Core processing pipeline ──────────────────────────────────────────────────

async function processOne(filePath) {
  const fileName = path.basename(filePath);
  console.log(`\n[invoice] Processing ${fileName}`);

  // 1. Parse
  const parsed = await parseInvoice(filePath);
  console.log(
    `[invoice]   vendor=${parsed.vendor}  invoice#=${parsed.invoiceNumber}  ` +
      `total=${parsed.total}  jobNumber=${parsed.jobNumber || "(none)"}`
  );

  if (!parsed.jobNumber) {
    throw new Error(
      "No job number found on invoice. Add a job # to the invoice or update " +
        "this script to support manual job assignment."
    );
  }
  if (!parsed.lineItems?.length) {
    throw new Error("Parser returned no line items.");
  }

  // 2. Find the ServiceTitan job
  const { jobId } = await st.findJobByNumber(parsed.jobNumber);
  if (!jobId) {
    throw new Error(`No ServiceTitan job found for number ${parsed.jobNumber}`);
  }
  console.log(`[invoice]   resolved job ${parsed.jobNumber} → internal ID ${jobId}`);

  // 3. Find the vendor
  const vendor = await st.findVendorByName(parsed.vendor);
  if (!vendor) {
    throw new Error(
      `No ServiceTitan vendor found for "${parsed.vendor}". Create the vendor ` +
        `in ServiceTitan first, then re-drop this invoice.`
    );
  }
  console.log(`[invoice]   vendor "${vendor.name}" → id ${vendor.id}`);

  // 4. Create the Purchase Order
  const po = await st.createPurchaseOrder({
    jobId,
    vendorId: vendor.id,
    items: parsed.lineItems.map((it) => ({
      skuName: it.sku || it.description?.slice(0, 60) || "Item",
      description: it.description,
      quantity: it.quantity,
      cost: it.unitCost || (it.quantity ? it.lineTotal / it.quantity : 0),
    })),
    summary: `Auto-imported from supplier invoice ${parsed.invoiceNumber} (${parsed.vendor})`,
    date: parsed.invoiceDate
      ? new Date(parsed.invoiceDate).toISOString()
      : new Date().toISOString(),
    vendorDocumentNumber: parsed.invoiceNumber,
  });

  console.log(
    `[invoice]   ✅ created PO id=${po.id} number=${po.number || "(n/a)"} on job ${jobId}`
  );
  return po;
}

async function handleFile(filePath) {
  const fileName = path.basename(filePath);
  try {
    await processOne(filePath);
    fs.renameSync(filePath, path.join(PROCESSED, fileName));
  } catch (err) {
    console.error(`[invoice] ❌ ${fileName}: ${err.message}`);
    const dest = path.join(FAILED, fileName);
    try {
      fs.renameSync(filePath, dest);
    } catch (_) {}
    fs.writeFileSync(
      `${dest}.error.txt`,
      `${err.stack || err.message}\n`,
      "utf8"
    );
  }
}

// ── Watch loop ────────────────────────────────────────────────────────────────

const inFlight = new Set();

async function tick() {
  let entries;
  try {
    entries = fs.readdirSync(ROOT);
  } catch (err) {
    console.error(`[invoice] cannot read ${ROOT}: ${err.message}`);
    return;
  }

  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = path.join(ROOT, name);
    if (inFlight.has(full)) continue;
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (_) {
      continue;
    }
    if (!stat.isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    if (![".pdf", ".png", ".jpg", ".jpeg"].includes(ext)) continue;

    inFlight.add(full);
    handleFile(full).finally(() => inFlight.delete(full));
  }
}

async function main() {
  // One-shot mode: `node scripts/watchInvoices.js path/to/file.pdf`
  if (process.argv[2]) {
    const target = path.resolve(process.argv[2]);
    if (!fs.existsSync(target)) {
      console.error(`File not found: ${target}`);
      process.exit(1);
    }
    await handleFile(target);
    return;
  }

  console.log(`[invoice] Watching ${ROOT} (poll every ${POLL_MS}ms)`);
  console.log(`[invoice]   processed → ${PROCESSED}`);
  console.log(`[invoice]   failed    → ${FAILED}`);
  await tick();
  setInterval(tick, POLL_MS);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
