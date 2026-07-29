/**
 * src/services/materialRenameService.js
 *
 * Material Rename tool — walks the local pricebook_index and surfaces materials
 * whose display names read like supplier/manufacturer codes ("SRSVTX4816B1824",
 * "3/4 BRS MIP TEE"), asks an LLM for a cleaner tech/CSR-friendly name, and —
 * after the user approves — pushes the rename to ServiceTitan and logs it.
 *
 *   listCandidates({ limit, includeReviewed })
 *     → Return up to `limit` Material rows, scored by how "cryptic" the name
 *       looks. Skips items already renamed or marked-reviewed unless the
 *       caller explicitly asks for them.
 *
 *   suggestName(stId)
 *     → Runs the LLM on a single material (by local st_id) and returns
 *       { suggestedName, reason, confidence } without mutating anything.
 *
 *   applyRename({ stId, newName })
 *     → Pushes displayName update to ST. Writes a 'applied' log row. Refreshes
 *       the local index. Returns { ok, stId, oldName, newName }.
 *
 *   skipRename(stId, reason?)
 *     → Stamps rename_reviewed_at on the local row so it won't resurface,
 *       and writes a 'skipped' log row.
 *
 *   listRecent(limit)
 *     → Recent rename_log rows for the audit panel.
 *
 * Why a separate service from pricebookIndexService?
 *   Rename is narrow in scope (Material only, name-only field) and benefits
 *   from its own scoring heuristic. Keeping it separate avoids bloating the
 *   general index service with rename-specific code paths.
 */

const { getDb } = require("../db/index");
const { updateMaterial, getPricebookItem } = require("../api/servicetitan");
// NOTE: image creation has been intentionally removed from the rename flow.
// The ST PATCH-shape we tried for image attachment never made the upload
// appear on the SKU, so we walked away rather than hold up name cleanups.

// Lazy OpenAI client — don't crash at module load when the env var is missing.
// Same pattern used by scopeParserService and pricebookMatcher so the server
// can still boot and serve routes that don't need the LLM. In DEMO_MODE this
// hands back the canned shim instead of a real client.
const { getClient } = require("../api/openaiClient");

// ── Cryptic-name scorer ─────────────────────────────────────────────────────
// Higher score = more likely this material has a tech-unfriendly display name
// that would benefit from a rename. The exact numbers are tuned by eye —
// they're a ranking signal, not a threshold.
function crypticScore(name) {
  if (!name) return 0;
  const s = String(name).trim();
  const len = s.length;
  if (len === 0) return 0;

  let score = 0;

  // (1) All-caps + has digits → classic manufacturer part number
  const letters = s.replace(/[^A-Za-z]/g, "");
  const digits = s.replace(/\D/g, "");
  const upperLetters = s.replace(/[^A-Z]/g, "");
  if (letters.length > 0 && upperLetters.length === letters.length) score += 2;
  if (digits.length >= 4) score += 2;

  // (2) Looks like a model number: 6+ char run of mixed letters+digits, no space
  if (/[A-Z0-9]{6,}/.test(s) && /[A-Z]/.test(s) && /\d/.test(s)) score += 3;

  // (3) Heavy abbreviations — lots of consonant clusters, few vowels
  const vowels = (s.match(/[AEIOUaeiou]/g) || []).length;
  const alphaLen = letters.length;
  if (alphaLen >= 6 && vowels / alphaLen < 0.22) score += 2;

  // (4) Very short names (< 5 chars) usually a code
  if (len < 5 && digits.length > 0) score += 1;

  // (5) Contains "/" + abbreviations like "3/4 BRS MIP TEE" (plumbing supply)
  if (/\d+\/\d+/.test(s) && /[A-Z]{3,}/.test(s)) score += 1;

  // (6) Tokens that are just 2-4 uppercase letters → "VLV", "ASM", "CMPRSR"
  const tokens = s.split(/[\s\-_/]+/).filter(Boolean);
  const abbrevTokens = tokens.filter(
    t => t.length >= 2 && t.length <= 4 && /^[A-Z]+$/.test(t)
  );
  if (abbrevTokens.length >= 2) score += 2;

  return score;
}

// ── Candidate listing ────────────────────────────────────────────────────────
/**
 * Return up to `limit` Materials scored by how cryptic their names look. By
 * default we exclude items already renamed or reviewed, so a reviewer can
 * just keep clicking Approve/Skip without seeing the same thing twice.
 */
function listCandidates({ limit = 50, includeReviewed = false } = {}) {
  const db = getDb();
  const rows = db
    .prepare(
      `
      SELECT st_id, sku_type, name, code, description, price,
             renamed_at, rename_reviewed_at
        FROM pricebook_index
       WHERE sku_type = 'Material' AND active = 1
         AND name IS NOT NULL AND name != ''
         ${includeReviewed ? "" : "AND renamed_at IS NULL AND rename_reviewed_at IS NULL"}
      `
    )
    .all();

  const scored = rows
    .map(r => ({ ...r, crypticScore: crypticScore(r.name) }))
    .filter(r => r.crypticScore > 0)
    // Highest score first; tie-break by longest name (usually more cryptic)
    .sort(
      (a, b) =>
        b.crypticScore - a.crypticScore ||
        (b.name || "").length - (a.name || "").length
    )
    .slice(0, Math.min(Number(limit) || 50, 500));

  return scored;
}

/**
 * Count total candidates (respects the same filter rules as listCandidates)
 * — used by the UI to show "3/42 reviewed".
 */
function countCandidates({ includeReviewed = false } = {}) {
  const db = getDb();
  const rows = db
    .prepare(
      `
      SELECT name FROM pricebook_index
       WHERE sku_type = 'Material' AND active = 1
         AND name IS NOT NULL AND name != ''
         ${includeReviewed ? "" : "AND renamed_at IS NULL AND rename_reviewed_at IS NULL"}
      `
    )
    .all();
  return rows.filter(r => crypticScore(r.name) > 0).length;
}

// ── Primary vendor lookup ───────────────────────────────────────────────────
// Pull the material's primary vendor from ST. Showing it in the current-name
// card helps the reviewer recognize the SKU ("oh, that's the Ferguson part")
// before they accept the rename.
//
// ST's PricebookMaterial schema for this tenant (confirmed via the response
// keys we logged) is:
//   {
//     ...
//     primaryVendor: {
//       id, vendorId, vendorName, vendorPartNumber, memo, cost,
//       primarySubAccount, active, ...
//     },
//     otherVendors: [ ...same shape ],
//     ...
//   }
//
// We previously assumed a generic `vendors[]` array (from older ST docs);
// that field doesn't exist on this tenant. We now read `primaryVendor`
// directly and only fall back to `otherVendors[0]` / `vendors[0]` if the
// primary slot is empty (defensive — should be rare given ST requires a
// primary vendor).
function extractPrimaryVendor(material) {
  if (!material || typeof material !== "object") return null;

  // Modern shape: a single object at material.primaryVendor
  let pv = material.primaryVendor;

  // Defensive fallbacks: older/alternate shapes
  if (!pv || typeof pv !== "object") {
    if (Array.isArray(material.otherVendors) && material.otherVendors.length > 0) {
      pv = material.otherVendors[0];
    } else if (Array.isArray(material.vendors) && material.vendors.length > 0) {
      pv = material.vendors.find(v => v?.primary === true || v?.isPrimary === true) || material.vendors[0];
    }
  }
  if (!pv || typeof pv !== "object") return null;

  const others = Array.isArray(material.otherVendors) ? material.otherVendors.length : 0;
  const isFromPrimarySlot = pv === material.primaryVendor;

  return {
    vendorId: pv.vendorId ?? pv.id ?? null,
    vendorName:
      pv.vendorName ||
      pv.name ||
      (pv.vendor && pv.vendor.name) ||
      null,
    vendorPartNumber:
      pv.vendorPartNumber ||
      pv.partNumber ||
      pv.partNo ||
      null,
    cost: typeof pv.cost === "number" ? pv.cost : null,
    isPrimary: isFromPrimarySlot,
    // Total count = the primary (if present) + however many "other" vendors
    vendorCount: (material.primaryVendor ? 1 : 0) + others,
  };
}

// ── LLM suggestion ──────────────────────────────────────────────────────────
// Keep the prompt small and the completion cheap — we'll run this once per
// item the reviewer actually lands on, not in batch. gpt-4o-mini is plenty.
const RENAME_MODEL = process.env.OPENAI_RENAME_MODEL || "gpt-4o-mini";

async function suggestName(stId) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT st_id, sku_type, name, code, description, price
         FROM pricebook_index
        WHERE st_id = ? AND sku_type = 'Material'`
    )
    .get(Number(stId));
  if (!row) throw new Error(`Material ${stId} not found in local index`);

  const client = getClient();
  const system = [
    "You rename ServiceTitan pricebook materials so field technicians and CSRs",
    "can find them quickly. The current name is often a cryptic manufacturer",
    "model number or a heavily-abbreviated supplier description.",
    "",
    "Rules:",
    "- Write the new name in Title Case, 35–60 characters when possible.",
    "- Lead with what the item IS (e.g. 'Copper Elbow', 'Condenser Fan Motor').",
    "- Then add size/spec that matter in the field (e.g. '3/4 in', '1/2 HP').",
    "- Keep the manufacturer model only if it actually differentiates (rare).",
    "- Don't invent specs you can't see — if the source name is truly opaque,",
    "  say so in the reason and return a low confidence.",
    "- Never output 'unknown', 'N/A', or invent a brand.",
    "",
    "Return JSON only, shape:",
    '{ "suggestedName": "...", "reason": "one short sentence", "confidence": "high|med|low" }',
  ].join("\n");

  const user = [
    `Current name: ${row.name}`,
    row.code ? `Supplier code: ${row.code}` : null,
    row.description ? `Description: ${row.description}` : null,
    typeof row.price === "number" ? `Retail price: $${row.price}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const res = await client.chat.completions.create({
    model: RENAME_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    temperature: 0.2,
    max_tokens: 180,
  });

  let parsed;
  try {
    parsed = JSON.parse(res.choices[0].message.content);
  } catch (err) {
    throw new Error(`LLM returned non-JSON: ${err.message}`);
  }

  const suggestedName = String(parsed.suggestedName || "").trim();
  if (!suggestedName) {
    throw new Error("LLM returned empty suggestedName");
  }
  const confidence = ["high", "med", "low"].includes(parsed.confidence)
    ? parsed.confidence
    : "med";

  // Best-effort primary-vendor lookup — non-fatal. If ST is slow or returns
  // an unexpected shape, the rename card simply won't display vendor info
  // (instead of failing the whole suggest call). When the extractor truly
  // can't find a vendor we just log a warning; ST requires a primary vendor
  // on materials, so this should be rare.
  let primaryVendor = null;
  try {
    const material = await getPricebookItem("material", row.st_id);
    primaryVendor = extractPrimaryVendor(material);
    if (!primaryVendor) {
      console.warn(
        `[Rename] No primary vendor for material ${row.st_id} ("${row.name}") — ` +
          `primaryVendor=${JSON.stringify(material?.primaryVendor)} ` +
          `otherVendors=${Array.isArray(material?.otherVendors) ? `[${material.otherVendors.length}]` : typeof material?.otherVendors}`
      );
    }
  } catch (err) {
    console.warn(`[Rename] primary-vendor lookup failed for ${row.st_id}: ${err.message}`);
  }

  return {
    stId: row.st_id,
    currentName: row.name,
    code: row.code,
    description: row.description,
    suggestedName,
    reason: String(parsed.reason || "").slice(0, 300),
    confidence,
    primaryVendor,
  };
}

// ── Apply / skip / log ──────────────────────────────────────────────────────
/**
 * Push the approved displayName to ServiceTitan, then update our local index
 * and write an 'applied' row to pricebook_rename_log. If the ST call fails we
 * log 'failed' and throw, so the UI can show the specific error to the user.
 */
async function applyRename({ stId, newName }) {
  const id = Number(stId);
  const name = String(newName || "").trim();
  if (!id) throw new Error("applyRename: stId required");
  if (!name) throw new Error("applyRename: newName required");

  const db = getDb();
  const row = db
    .prepare(
      `SELECT st_id, name FROM pricebook_index WHERE st_id = ? AND sku_type = 'Material'`
    )
    .get(id);
  if (!row) throw new Error(`Material ${id} not found in local index`);
  const oldName = row.name;

  if (name === oldName) {
    // No-op — still record as 'skipped' so the reviewer doesn't see it again.
    return skipRename(id, "new name identical to current");
  }

  try {
    // ST's material model uses displayName as the human label. Name is the
    // internal field; tenants generally display displayName in the app.
    // Update both to keep them in sync for tenants that surface either.
    await updateMaterial(id, { displayName: name, description: name });
  } catch (err) {
    db.prepare(
      `INSERT INTO pricebook_rename_log
         (st_id, sku_type, old_name, new_name, status, error)
       VALUES (?, 'Material', ?, ?, 'failed', ?)`
    ).run(id, oldName, name, err.message);
    throw err;
  }

  db.prepare(
    `UPDATE pricebook_index
        SET name = ?, renamed_at = datetime('now'), rename_reviewed_at = datetime('now')
      WHERE st_id = ? AND sku_type = 'Material'`
  ).run(name, id);

  db.prepare(
    `INSERT INTO pricebook_rename_log
       (st_id, sku_type, old_name, new_name, status)
     VALUES (?, 'Material', ?, ?, 'applied')`
  ).run(id, oldName, name);

  console.log(
    `[Rename] ✅ Material ${id}: "${oldName}" → "${name}"`
  );

  return { ok: true, stId: id, oldName, newName: name };
}

function skipRename(stId, reason = null) {
  const id = Number(stId);
  if (!id) throw new Error("skipRename: stId required");
  const db = getDb();
  const row = db
    .prepare(
      `SELECT name FROM pricebook_index WHERE st_id = ? AND sku_type = 'Material'`
    )
    .get(id);
  const oldName = row ? row.name : null;

  db.prepare(
    `UPDATE pricebook_index
        SET rename_reviewed_at = datetime('now')
      WHERE st_id = ? AND sku_type = 'Material'`
  ).run(id);

  db.prepare(
    `INSERT INTO pricebook_rename_log
       (st_id, sku_type, old_name, new_name, status, error)
     VALUES (?, 'Material', ?, NULL, 'skipped', ?)`
  ).run(id, oldName, reason || null);

  console.log(`[Rename] ⏭  Material ${id}: skipped ("${oldName || "—"}")`);
  return { ok: true, stId: id, status: "skipped", reason };
}

function listRecent(limit = 50) {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, st_id, sku_type, old_name, new_name, status, error, created_at
         FROM pricebook_rename_log
        ORDER BY datetime(created_at) DESC
        LIMIT ?`
    )
    .all(Math.min(Number(limit) || 50, 500));
}

module.exports = {
  listCandidates,
  countCandidates,
  suggestName,
  applyRename,
  skipRename,
  listRecent,
  // exposed for unit/integration testing only
  _crypticScore: crypticScore,
};
