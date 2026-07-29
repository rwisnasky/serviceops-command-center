/**
 * src/services/poPricebookMatchService.js
 *
 * Takes the line items from a parsed supplier invoice/PO and, for each line,
 * looks up whether the item already exists in our local pricebook index.
 * This powers the "Add to Pricebook" column on the invoice preview.
 *
 * Strategy (per line):
 *   1. If the supplier gave us a SKU/code, try an EXACT-code match against
 *      pricebook_index (Material, active=1). That's the signal we trust most
 *      — supplier part numbers rarely change.
 *   2. Otherwise (or as a fallback), do a description-based fuzzy search.
 *      Threshold for "matched" is intentionally higher than the scope-parse
 *      threshold (0.65 vs. 0.55) because a false-positive here means the
 *      user doesn't add a SKU they actually need, which is worse than being
 *      asked to confirm an obvious match.
 *
 * We only search Material types — supplier POs don't bring in Services or
 * Equipment, so keeping the search narrow cuts noise.
 *
 * Output shape appended to each line item:
 *   pricebookMatch: {
 *     status:      'matched' | 'unmatched',
 *     method:      'exact-code' | 'fuzzy' | 'none',
 *     confidence:  number,               // 0..1 (1.0 for exact-code hits)
 *     bestMatch:   { skuId, skuType, name, code, price } | null,
 *     alternatives: [ ...top-3 runners-up ] // only on fuzzy, for swap UX
 *   }
 */

const { getDb } = require("../db/index");
const { searchIndex } = require("./pricebookIndexService");

const FUZZY_ACCEPT_THRESHOLD = 0.65;
const MAX_ALTERNATIVES = 3;

// ── Normalize a supplier code so we can compare apples-to-apples ─────────────
// ST pricebook codes rarely have leading zeros or dashes consistently typed,
// so strip non-alphanumerics and lowercase. We keep the raw string too for
// display but match on the normalized form.
function normalizeCode(code) {
  if (!code) return "";
  return String(code).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

// ── Exact code lookup in pricebook_index ─────────────────────────────────────
// Pulls all active Material codes once, normalizes, and checks for an exact
// match. (Number of materials is small enough to keep in memory; if it ever
// balloons, we'd add a normalized-code column with an index.)
let _codeIndexCache = null;
let _codeIndexCachedAt = 0;
const CODE_INDEX_TTL_MS = 5 * 60 * 1000;

function buildCodeIndex() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT st_id, sku_type, name, code, description, price
         FROM pricebook_index
        WHERE sku_type = 'Material' AND active = 1 AND code IS NOT NULL AND code != ''`
    )
    .all();
  const byCode = new Map();
  for (const r of rows) {
    const key = normalizeCode(r.code);
    if (!key) continue;
    // First writer wins — if two actives share a normalized code (shouldn't
    // happen in a clean ST), we pick whatever came first.
    if (!byCode.has(key)) byCode.set(key, r);
  }
  return byCode;
}

function getCodeIndex() {
  const now = Date.now();
  if (_codeIndexCache && now - _codeIndexCachedAt < CODE_INDEX_TTL_MS) {
    return _codeIndexCache;
  }
  _codeIndexCache = buildCodeIndex();
  _codeIndexCachedAt = now;
  return _codeIndexCache;
}

// Forcibly invalidate the cache — called after we create new materials so
// subsequent POs recognize them right away.
function invalidateCodeCache() {
  _codeIndexCache = null;
  _codeIndexCachedAt = 0;
}

// ── Public: match a single line item ─────────────────────────────────────────
function matchLine(line) {
  const code = (line.sku || line.code || "").toString().trim();
  const desc = (line.description || "").toString().trim();

  // Pass 1 — exact code
  if (code) {
    const idx = getCodeIndex();
    const hit = idx.get(normalizeCode(code));
    if (hit) {
      return {
        status: "matched",
        method: "exact-code",
        confidence: 1.0,
        bestMatch: {
          skuId: hit.st_id,
          skuType: hit.sku_type,
          name: hit.name,
          code: hit.code,
          price: hit.price,
        },
        alternatives: [],
      };
    }
  }

  // Pass 2 — fuzzy on description (Material only)
  if (desc) {
    const query = code ? `${code} ${desc}` : desc;
    const candidates = searchIndex(query, {
      types: ["Material"],
      limit: MAX_ALTERNATIVES + 1,
    });
    if (candidates.length > 0) {
      const top = candidates[0];
      const matched = top.score >= FUZZY_ACCEPT_THRESHOLD;
      return {
        status: matched ? "matched" : "unmatched",
        method: matched ? "fuzzy" : "none",
        confidence: top.score,
        bestMatch: matched
          ? {
              skuId: top.skuId,
              skuType: top.skuType,
              name: top.name,
              code: top.code,
              price: top.price,
            }
          : null,
        alternatives: candidates.slice(1, MAX_ALTERNATIVES + 1),
      };
    }
  }

  return {
    status: "unmatched",
    method: "none",
    confidence: 0,
    bestMatch: null,
    alternatives: [],
  };
}

// ── Public: match a whole array of line items ────────────────────────────────
function matchBatch(lineItems) {
  if (!Array.isArray(lineItems)) return [];
  return lineItems.map(li => ({ ...li, pricebookMatch: matchLine(li) }));
}

module.exports = {
  matchLine,
  matchBatch,
  invalidateCodeCache,
};
