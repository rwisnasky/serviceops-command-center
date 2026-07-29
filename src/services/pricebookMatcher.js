/**
 * src/services/pricebookMatcher.js
 *
 * Hybrid line-item → pricebook SKU matcher.
 *
 * Strategy:
 *   1. Run fuzzy search against the local pricebook_index (see
 *      pricebookIndexService.searchIndex).
 *   2. If the top candidate's score ≥ CONFIDENCE_THRESHOLD, we're done —
 *      return it with method="fuzzy".
 *   3. Otherwise, send the top-N candidates to OpenAI and ask it to pick
 *      the best match (or return null if nothing fits). This catches
 *      cases like "Install 50gal gas WH" → "Water Heater – 50 Gallon Gas"
 *      that token overlap alone misses.
 *
 * Public:
 *   matchLineItem(description, { types, threshold, topN })
 *     → { bestMatch, alternatives, method, reason? }
 *
 *   matchBatch(lineItems, opts)
 *     → lineItems with .match attached
 *
 * `bestMatch` is null when nothing meets the bar — the UI shows an
 * "unmatched" row that the user can pin manually.
 */

const { searchIndex } = require("./pricebookIndexService");

// Lazy OpenAI client — eager init throws at module load time if the key
// isn't set, which would take the whole pricebook router down. Under
// DEMO_MODE this resolves to the canned shim.
const { getClient } = require("../api/openaiClient");

const MODEL = process.env.PRICEBOOK_MATCH_MODEL || "gpt-4o-mini";
const CONFIDENCE_THRESHOLD = 0.55; // above this, skip the LLM
const MINIMUM_FLOOR        = 0.15; // below this, don't even bother asking the LLM
const TOP_N_CANDIDATES     = 10;

// ── Public: single-item match ─────────────────────────────────────────────────
async function matchLineItem(description, opts = {}) {
  const {
    types = ["Service", "Material", "Equipment"],
    threshold = CONFIDENCE_THRESHOLD,
    topN = TOP_N_CANDIDATES,
  } = opts;

  const desc = String(description || "").trim();
  if (!desc) return { bestMatch: null, alternatives: [], method: "none", reason: "empty description" };

  const candidates = searchIndex(desc, { types, limit: topN });

  if (candidates.length === 0) {
    return { bestMatch: null, alternatives: [], method: "none", reason: "no candidates in local index" };
  }

  const top = candidates[0];

  // Strong fuzzy match → accept, skip LLM
  if (top.score >= threshold) {
    return {
      bestMatch: { ...top, confidence: top.score, method: "fuzzy" },
      alternatives: candidates.slice(1),
      method: "fuzzy",
    };
  }

  // Very weak → LLM unlikely to help (nothing plausibly matches)
  if (top.score < MINIMUM_FLOOR) {
    return {
      bestMatch: null,
      alternatives: candidates,
      method: "none",
      reason: `no candidate scored above floor ${MINIMUM_FLOOR}`,
    };
  }

  // Ambiguous zone — ask the LLM to pick
  try {
    const llmChoice = await askLLM(desc, candidates);
    if (llmChoice && llmChoice.skuId) {
      const picked = candidates.find(c => c.skuId === llmChoice.skuId);
      if (picked) {
        return {
          bestMatch: { ...picked, confidence: llmChoice.confidence || 0.7, method: "llm", reasoning: llmChoice.reasoning || null },
          alternatives: candidates.filter(c => c.skuId !== llmChoice.skuId),
          method: "llm",
        };
      }
    }
    // LLM said "no good match"
    return {
      bestMatch: null,
      alternatives: candidates,
      method: "llm",
      reason: llmChoice?.reasoning || "LLM declined all candidates",
    };
  } catch (err) {
    console.warn(`[PricebookMatcher] LLM fallback failed: ${err.message}`);
    // Fall through to returning the weak fuzzy match — tagged low confidence so
    // the UI can show a warning pill.
    return {
      bestMatch: { ...top, confidence: top.score, method: "fuzzy-weak" },
      alternatives: candidates.slice(1),
      method: "fuzzy-weak",
      reason: `LLM fallback errored: ${err.message}`,
    };
  }
}

// ── Public: batch convenience ─────────────────────────────────────────────────
async function matchBatch(lineItems, opts = {}) {
  // Cap concurrency so we don't hammer OpenAI or slow down the DB
  const CONCURRENCY = 4;
  const results = [];
  for (let i = 0; i < lineItems.length; i += CONCURRENCY) {
    const slice = lineItems.slice(i, i + CONCURRENCY);
    const matches = await Promise.all(
      slice.map(li => matchLineItem(li.description, opts))
    );
    slice.forEach((li, idx) => results.push({ ...li, match: matches[idx] }));
  }
  return results;
}

// ── LLM prompt ────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a dispatcher at a home-services contracting company.
Given a short description of work or a part (from a customer scope or competitor quote),
you will see a shortlist of candidate pricebook SKUs from our ServiceTitan catalog.
Your job is to pick the one SKU that best fits the described work.

Return STRICT JSON only — no prose, no markdown.

Response shape:
{
  "skuId": number | null,          // picked SKU's id, or null if none is a good fit
  "confidence": number,            // 0.0 to 1.0 — how sure you are
  "reasoning": string              // one short sentence
}

Rules:
- Prefer the match that most closely describes the SAME work/part. Don't upsell.
- If the description mentions a specific size, brand, or capacity, try to honor it.
- If NONE of the candidates reasonably matches, return skuId:null with a short reason.
- Never invent a skuId that isn't in the candidate list.`;

async function askLLM(description, candidates) {
  const catalog = candidates.map(c =>
    `- id:${c.skuId} [${c.skuType}] "${c.name}"${c.code ? ' ('+c.code+')' : ''}${c.description ? ' — ' + (c.description.length > 140 ? c.description.slice(0,140)+'…' : c.description) : ''} — $${(c.price||0).toFixed(2)}`
  ).join("\n");

  const userMsg =
    `Scope line: "${description}"\n\nCandidate SKUs:\n${catalog}\n\nPick the best match or null.`;

  const res = await getClient().chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: userMsg },
    ],
    response_format: { type: "json_object" },
  });

  const content = res.choices?.[0]?.message?.content || "{}";
  try {
    const parsed = JSON.parse(content);
    return {
      skuId: typeof parsed.skuId === "number" ? parsed.skuId : null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      reasoning: parsed.reasoning || null,
    };
  } catch (_) {
    return null;
  }
}

module.exports = {
  matchLineItem,
  matchBatch,
  CONFIDENCE_THRESHOLD,
};
