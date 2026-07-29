/**
 * src/services/scopeImportService.js
 *
 * Orchestration layer for the Scope → Estimate flow. Mirrors the shape of
 * invoiceImportService.js so the HTTP route stays thin.
 *
 *   1) parseAndPreview(filePath, { jobNumberOverride })
 *        → runs the scope parser (OpenAI vision)
 *        → auto-syncs the pricebook index if it's stale (so fuzzy matching
 *          has something to chew on)
 *        → matches each parsed line item to a pricebook SKU (fuzzy + LLM)
 *        → resolves job # → internal ST jobId
 *        → returns a preview payload for the UI (NO estimate created)
 *
 *   2) createEstimateFromPreview(preview, { fileName })
 *        → builds a cart from the preview's matched lines
 *        → calls st.createEstimate(...)
 *        → writes a scope_estimate_uploads audit row either way
 */

const { parseScope } = require("./scopeParserService");
const { matchBatch } = require("./pricebookMatcher");
const { autoSyncIfStale } = require("./pricebookIndexService");
const st = require("../api/servicetitan");
const { getDb } = require("../db/index");

// ── Public: parse + match (no ST mutation) ────────────────────────────────────
async function parseAndPreview(filePath, { jobNumberOverride = null } = {}) {
  // Make sure the local pricebook index is warm enough for matching. If the
  // cache is under 30h old this is a no-op.
  try {
    await autoSyncIfStale(30);
  } catch (err) {
    // Don't block the parse on a sync failure — matching will just return fewer hits.
    console.warn(`[Scope] Pricebook auto-sync warning: ${err.message}`);
  }

  const parsed = await parseScope(filePath);

  // Match every line item
  const matchedLines = await matchBatch(parsed.lineItems, {});

  // Resolve job number → internal id (unless override)
  const jobNumber =
    (jobNumberOverride && String(jobNumberOverride).trim()) ||
    parsed.jobNumber ||
    null;

  let jobMatch = { jobId: null, jobNumber: null, error: null };
  if (jobNumber) {
    try {
      const { jobId, jobNumber: confirmed } = await st.findJobByNumber(jobNumber);
      jobMatch = { jobId, jobNumber: confirmed || jobNumber, error: null };
    } catch (err) {
      jobMatch.error = err.message;
    }
  } else {
    jobMatch.error = "No job number found on the scope. Enter one in the Job # field.";
  }

  const unmatched = matchedLines.filter(li => !li.match?.bestMatch).length;
  const ready = Boolean(
    jobMatch.jobId &&
    matchedLines.length > 0 &&
    unmatched === 0
  );

  return {
    parsed: {
      customerName: parsed.customerName,
      projectTitle: parsed.projectTitle,
      parsedJobNumber: parsed.jobNumber,
      usedJobNumber: jobNumber,
      lineItems: matchedLines, // each has .match populated
    },
    jobMatch,
    stats: {
      totalLines: matchedLines.length,
      matched: matchedLines.length - unmatched,
      unmatched,
      llmUsed: matchedLines.filter(li => li.match?.method === "llm").length,
    },
    ready,
  };
}

// ── Public: create estimate from a (possibly edited) preview ──────────────────
async function createEstimateFromPreview(preview, { fileName = null } = {}) {
  if (!preview || !preview.parsed) throw new Error("preview payload missing");
  if (!preview.jobMatch?.jobId) throw new Error("preview has no resolved jobId");

  const jobId = preview.jobMatch.jobId;
  const jobNumber = preview.jobMatch.jobNumber;
  const lines = preview.parsed.lineItems || [];

  // Convert matched lines → ST estimate item payloads. Only include lines
  // that have a bestMatch — the UI should have prompted the user to fix
  // unmatched lines before submitting.
  const items = lines
    .filter(li => li.match?.bestMatch)
    .map(li => {
      const m = li.match.bestMatch;
      return {
        skuId: m.skuId,
        skuType: m.skuType,
        quantity: Number(li.quantity) || 1,
        unitPrice: Number(m.price) || 0,
        description: li.description
          ? (li.notes ? `${li.description} (${li.notes})` : li.description)
          : m.name,
      };
    });

  if (items.length === 0) {
    throw new Error("No matched line items — nothing to push to ServiceTitan.");
  }

  const db = getDb();
  const total = items.reduce((s, it) => s + (it.unitPrice || 0) * (it.quantity || 1), 0);

  try {
    const estimate = await st.createEstimate({
      jobId,
      name: preview.parsed.projectTitle || `Scope Quote – ${new Date().toLocaleDateString()}`,
      summary:
        (preview.parsed.customerName ? `Customer: ${preview.parsed.customerName}\n` : "") +
        (fileName ? `Source: ${fileName}` : ""),
      items,
    });

    db.prepare(`
      INSERT INTO scope_estimate_uploads
        (file_name, job_number, job_id, estimate_id, line_item_count, total, status)
      VALUES (?, ?, ?, ?, ?, ?, 'created')
    `).run(
      fileName,
      jobNumber || null,
      jobId,
      estimate?.id || null,
      items.length,
      total
    );

    return {
      ok: true,
      estimateId: estimate?.id || null,
      jobId,
      jobNumber,
      lineItemCount: items.length,
      total,
    };
  } catch (err) {
    const stErr = err.response?.data;
    const msg = stErr?.title || stErr?.message || err.message;

    db.prepare(`
      INSERT INTO scope_estimate_uploads
        (file_name, job_number, job_id, line_item_count, total, status, error)
      VALUES (?, ?, ?, ?, ?, 'failed', ?)
    `).run(fileName, jobNumber || null, jobId, items.length, total, msg);

    throw new Error(msg);
  }
}

// ── Public: recent audit log for the UI ──────────────────────────────────────
function listRecentScopeEstimates(limit = 25) {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, file_name, job_number, job_id, estimate_id, line_item_count,
              total, status, error, created_at
         FROM scope_estimate_uploads
        ORDER BY created_at DESC
        LIMIT ?`
    )
    .all(Math.min(100, Number(limit) || 25));
}

module.exports = {
  parseAndPreview,
  createEstimateFromPreview,
  listRecentScopeEstimates,
};
