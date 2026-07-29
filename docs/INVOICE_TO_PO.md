# Invoice → Purchase Order Automation

Drop a supplier-invoice PDF into a folder. The script reads it, extracts the
vendor, line items, and job number, and creates a Purchase Order on the
matching ServiceTitan job.

## How it works

```
inbox/invoices/*.pdf
        │
        ▼
 parseInvoice()  ──► OpenAI gpt-4o vision
        │            returns JSON:
        │            { vendor, invoiceNumber, jobNumber, lineItems, total, ... }
        ▼
 st.findJobByNumber(jobNumber)   → internal job ID
 st.findVendorByName(vendor)     → vendor ID
        ▼
 st.createPurchaseOrder({ jobId, vendorId, items, ... })
        ▼
 inbox/processed/   (success)
 inbox/failed/      (error + .error.txt sidecar)
```

## Setup

1. Make sure your `.env` already has the ServiceTitan credentials used by the
   rest of this project:
   ```
   ST_CLIENT_ID=...
   ST_CLIENT_SECRET=...
   ST_APP_KEY=...
   ST_TENANT_ID=...
   OPENAI_API_KEY=...
   ```
2. Install `poppler-utils` so the script can rasterize PDF page 1 to an image
   for the vision model:
   - macOS: `brew install poppler`
   - Ubuntu/Debian: `sudo apt-get install poppler-utils`
3. (Optional) Override the inbox path:
   ```
   INVOICE_INBOX_DIR=/Users/you/Dropbox/supplier-invoices
   ```

## Run

**Watch mode** (polls every 5 s):
```bash
node scripts/watchInvoices.js
```

**One-shot mode** (process a single file):
```bash
node scripts/watchInvoices.js ./some-invoice.pdf
```

On first run the script creates:
```
inbox/
  invoices/   ← drop PDFs here
  processed/  ← moved here on success
  failed/     ← moved here on error, with a .error.txt sidecar
```

## Requirements for the invoice itself

The parser looks for a **job number / PO reference printed on the invoice**
(labels like "Job#", "PO#", "Reference", "Customer Job", "Project"). If the
invoice has no job reference, the file is moved to `inbox/failed/`.

If you want to support "no job number on invoice" cases, two options:

1. **Rename the file to include the job #** — e.g. `JOB-9876_ferguson.pdf` —
   and extend `processOne()` in `scripts/watchInvoices.js` to fall back to
   extracting the job # from the filename.
2. **Interactive picker** — import the invoice, show a list of recent open
   jobs, and prompt the user to pick.

## Vendor matching

`findVendorByName()` searches ServiceTitan's vendor list for an exact (or first)
match. If the vendor doesn't exist in ServiceTitan yet, the run fails with a
clear error — create the vendor in ServiceTitan, then re-drop the invoice.

## Swapping the parser model

The parser module (`src/services/invoiceParserService.js`) is intentionally
isolated. To swap OpenAI for Claude vision, AWS Textract, or a local OCR
pipeline, only that one file needs to change — the return shape is the
contract the rest of the script depends on.
