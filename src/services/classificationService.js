/**
 * classificationService.js
 *
 * Classifies a call transcript using OpenAI GPT.
 * Returns structured JSON that's ready to store and act on.
 *
 * Designed for a home services / HVAC / plumbing / electrical company context —
 * adjust the system prompt for your specific trade.
 *
 * Env vars:
 *   OPENAI_API_KEY           — required
 *   CLASSIFICATION_MODEL     — GPT model to use (default: gpt-4o-mini)
 */

// ── Category definitions ───────────────────────────────────────────────────────

const CATEGORIES = [
  "job_callback",
  "job_status_question",
  "new_service_request",
  "existing_customer_new_issue",
  "estimate_followup",
  "billing_question",
  "membership_question",
  "warranty_concern",
  "reschedule_cancel",
  "emergency_request",
  "vendor_call",
  "recruiting_call",
  "internal_call",
  "wrong_number",
  "spam_robocall",
  "unknown_review_needed",
];

// ── Staff roster ───────────────────────────────────────────────────────────────
// Pull the company employee/CSR names so the model never mistakes our own staff
// for the customer. Names in the roster are stored "Last, First" — we expose both
// the full name and the first name so the model can match either form.

function buildStaffRoster() {
  // Returns { full, first }:
  //   full  — authoritative full names ("Danielle Cormier"). A transcript match here
  //           is strong evidence the speaker is staff, not the customer.
  //   first — first names only ("Danielle"). A hint, NOT proof: a customer can
  //           share a first name with one of our people, so the model must use
  //           context before deciding. Kept separate so the prompt can weight
  //           the two differently and avoid tagging a customer named "Ryan" or
  //           "Kim" as staff.
  try {
    const { listEmployeePhones } = require("../db/employeeRepository");
    const { OFFICE_TEAM_NAMES } = require("../config/officeTeam");
    const rows = listEmployeePhones({ includeInactive: false }) || [];
    const full = new Set();
    const first = new Set();

    for (const row of rows) {
      const raw = (row.employeeName || "").trim();
      if (!raw) continue;
      // Only keep person-style names ("Last, First"); skip facilities/supply houses.
      if (!raw.includes(",")) continue;

      const [last, firstName] = raw.split(",").map((s) => s.trim());
      if (firstName) {
        full.add(`${firstName} ${last}`.trim()); // "Danielle Cormier"
        first.add(firstName);                     // "Danielle"
      } else if (last) {
        full.add(last);
      }
    }

    // Always include the office/CSR team, even if they have no phone-roster
    // entry. Names here are "First Last".
    for (const name of OFFICE_TEAM_NAMES) {
      const trimmed = (name || "").trim();
      if (!trimmed) continue;
      full.add(trimmed);
      const f = trimmed.split(/\s+/)[0];
      if (f) first.add(f);
    }

    // A first name that is also a standalone full-name entry stays in both; that
    // is fine. Drop first names that duplicate nothing meaningful is unnecessary.
    return {
      full: Array.from(full).sort((a, b) => a.localeCompare(b)),
      first: Array.from(first).sort((a, b) => a.localeCompare(b)),
    };
  } catch (err) {
    console.warn("[Classification] Could not load staff roster:", err.message);
    return { full: [], first: [] };
  }
}

// ── Caller identity ─────────────────────────────────────────────────────────────
// Deterministic signal: if the call's own phone number belongs to a known
// employee, the person on this line IS that employee — no guessing needed.
// This is far more reliable than matching names in a noisy transcript.

function lookupCallerEmployee(callerPhone) {
  if (!callerPhone) return null;
  try {
    const { lookupEmployeeByPhone } = require("../db/employeeRepository");
    return lookupEmployeeByPhone(callerPhone) || null;
  } catch (err) {
    console.warn("[Classification] Caller-employee lookup failed:", err.message);
    return null;
  }
}

// ── System prompt ──────────────────────────────────────────────────────────────
//
// The system prompt has two parts:
//   1. INSTRUCTIONS  — the editable "guidance" (role, categories, rules, who-is-
//      the-customer). This is what the AI Instructions popup edits. It can be
//      overridden per-tenant via the `classification_instructions` app setting.
//   2. OUTPUT_CONTRACT — the machine-readable JSON schema the rest of the
//      pipeline parses. This is LOCKED and always appended by the code, so an
//      edit to the guidance can never break call processing.
//
// Effective system prompt = (saved instructions OR DEFAULT_INSTRUCTIONS) + OUTPUT_CONTRACT.

const DEFAULT_INSTRUCTIONS = `You are a call intelligence assistant for a home services company (HVAC, plumbing, electrical, or similar trade).

Your job is to read a phone call transcript and return structured JSON that office staff can use to triage, route, and act on calls.

CATEGORIES:
${CATEGORIES.map((c) => `- ${c}`).join("\n")}

SENTIMENT: positive | neutral | negative

RULES:
- summaryBullets: 3–4 short bullets a dispatcher can scan in 5 seconds.
  • Each bullet ≤ 15 words, plain English, no jargon.
  • Preferred order: reason for call → key details (what, where, when) → outcome/commitments made on the call → follow-up needed.
  • Include caller name, address, and job type if mentioned. Skip a bullet rather than pad — 3 strong bullets beat 4 weak ones.
  • Do NOT prefix with "•" or dashes — just the text of the bullet.
- isSpam = true for robocalls, spam, recruiting pitches, random solicitors
- isJobRelated = true for anything touching an active or potential job (new booking, callback, status, warranty, billing, etc.)
- confidence = how certain you are of the category (1.0 = very sure, 0.5 = ambiguous)
- recommendedAction should be immediately actionable — max 15 words
- sentiment reflects the CUSTOMER'S mood on the call: positive = clearly happy/satisfied, negative = frustrated/upset/complaining, neutral = everything in between
- If the transcript is very short or garbled, set category = "unknown_review_needed" and confidence < 0.5

WHO IS THE CUSTOMER — read this carefully, it is the most common mistake:
- The metadata may include a "CALLER IDENTITY" line. If present, it is AUTHORITATIVE: that person is our employee and is NEVER the customer. The customer is the OTHER party on the call (or there is no customer, e.g. an internal/employee-to-employee call → category "internal_call").
- The metadata may include "STAFF — full names": our employees / CSRs / technicians. A full-name match in the transcript is strong evidence that person is staff, NOT the customer.
- The metadata may include "STAFF — first names": these first names belong to our staff, but a CUSTOMER could share one. Treat a first-name-only match as a HINT, not proof — decide from context (who is asking for service vs. who is helping/dispatching).
- Staff routinely introduce themselves ("Hi, this is Danielle from Grounded") — that does NOT make them the customer.
- When you put a caller name in the summary, use the CUSTOMER's name, never a staff member's.
- If, after using context, the only named person is a staff member and no customer is identifiable, prefer category "internal_call" or "unknown_review_needed" over guessing.`;

// LOCKED — the parser depends on this exact JSON shape. Not user-editable.
const OUTPUT_CONTRACT = `OUTPUT FORMAT — respond with ONLY valid JSON, no markdown, no explanation:
{
  "category": "<one of the categories listed above>",
  "summaryBullets": ["<bullet 1>", "<bullet 2>", "<bullet 3>", "<bullet 4 optional>"],
  "sentiment": "positive|neutral|negative",
  "isSpam": <true|false>,
  "isJobRelated": <true|false>,
  "confidence": <0.0–1.0>,
  "recommendedAction": "<short action the office should take next, e.g. 'Call back — customer asking about job status for Job #12345'>"
}`;

/**
 * The guidance portion currently in effect: the saved override from the AI
 * Instructions popup, or the built-in default when nothing is saved.
 */
function getEffectiveInstructions() {
  try {
    const { getSetting } = require("../db");
    return getSetting("classification_instructions", DEFAULT_INSTRUCTIONS);
  } catch (err) {
    console.warn("[Classification] Could not read saved instructions, using default:", err.message);
    return DEFAULT_INSTRUCTIONS;
  }
}

/** Build the full system prompt: effective guidance + the locked JSON contract. */
function buildSystemPrompt() {
  return `${getEffectiveInstructions()}\n\n${OUTPUT_CONTRACT}`;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Classify a call from its transcript and optional metadata.
 *
 * @param {string} transcript - Full call transcript text
 * @param {object} [meta]     - Optional context: { callerPhone, callDuration, direction }
 * @returns {Promise<ClassificationResult>}
 *
 * @typedef {object} ClassificationResult
 * @property {string}   category
 * @property {string[]} summaryBullets  - 3–4 short bullets (preferred format)
 * @property {string}   summary         - bullets joined with " • " for legacy/free-text use
 * @property {string}   sentiment
 * @property {boolean}  isSpam
 * @property {boolean}  isJobRelated
 * @property {number}   confidence
 * @property {string}   recommendedAction
 * @property {string}   rawModel
 */
async function classifyCall(transcript, meta = {}) {
  if (!transcript || transcript.trim().length === 0) {
    console.warn("[Classification] Empty transcript — returning unknown_review_needed");
    return emptyResult("No transcript available");
  }

  // Real SDK client, or the canned demo shim under DEMO_MODE — see
  // src/api/openaiClient.js.
  const { getClient } = require("../api/openaiClient");
  const client = getClient();
  const model = process.env.CLASSIFICATION_MODEL || "gpt-4o-mini";

  // Build the user message with context
  const contextParts = [];
  if (meta.callerPhone) contextParts.push(`Caller phone: ${meta.callerPhone}`);
  if (meta.callDuration) contextParts.push(`Duration: ${meta.callDuration}s`);
  if (meta.direction) contextParts.push(`Direction: ${meta.direction}`);

  // Deterministic signal first: is the call's phone number a known employee?
  // If so, the person on this line IS that employee — state it plainly.
  const callerEmployee = lookupCallerEmployee(meta.callerPhone);
  const callerIdentityBlock = callerEmployee
    ? `CALLER IDENTITY (authoritative — from phone number): This call's number belongs to our employee ` +
      `${callerEmployee.employeeName}` +
      `${callerEmployee.trade ? ` (${callerEmployee.trade}` : ""}` +
      `${callerEmployee.truckNumber ? `${callerEmployee.trade ? ", " : " ("}truck ${callerEmployee.truckNumber}` : ""}` +
      `${callerEmployee.trade || callerEmployee.truckNumber ? ")" : ""}. ` +
      `This is an internal/outbound call from our side — they are NOT the customer.\n\n`
    : "";

  // Staff roster: full names (strong) vs first-name hints (weak — see prompt).
  const { full: staffFull, first: staffFirst } = buildStaffRoster();
  let staffBlock = "";
  if (staffFull.length) {
    staffBlock += `STAFF — full names (employees / CSRs / techs — NEVER the customer):\n${staffFull.join(", ")}\n\n`;
  }
  if (staffFirst.length) {
    staffBlock += `STAFF — first names (likely staff, but a customer could share one — use context):\n${staffFirst.join(", ")}\n\n`;
  }

  const userMessage =
    (contextParts.length ? `[Call metadata: ${contextParts.join(" | ")}]\n\n` : "") +
    callerIdentityBlock +
    staffBlock +
    `TRANSCRIPT:\n${transcript.slice(0, 8000)}`; // cap at 8k chars to control cost

  console.log(`[Classification] Classifying with ${model} (${transcript.length} chars)`);

  const systemPrompt = buildSystemPrompt();

  let raw;
  try {
    const response = await client.chat.completions.create({
      model,
      temperature: 0.1, // low temp for deterministic classification
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    });

    raw = response.choices[0]?.message?.content || "";
  } catch (err) {
    console.error("[Classification] OpenAI API error:", err.message);
    throw new Error(`Classification failed: ${err.message}`);
  }

  // Parse JSON response
  let parsed;
  try {
    // Strip markdown code fences if GPT wraps the response anyway
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error("[Classification] Failed to parse GPT response as JSON:", raw.slice(0, 300));
    return emptyResult("Parse error — review manually");
  }

  // Normalise bullets — accept an array from the model, or split legacy summary text as a fallback
  let summaryBullets = [];
  if (Array.isArray(parsed.summaryBullets)) {
    summaryBullets = parsed.summaryBullets;
  } else if (typeof parsed.summary === "string" && parsed.summary.trim().length > 0) {
    summaryBullets = splitToBullets(parsed.summary);
  }

  // Clean each bullet: strip leading bullet chars/dashes, trim whitespace, cap length,
  // drop empties. Cap at 5 so the UI doesn't get overwhelmed.
  summaryBullets = summaryBullets
    .map((b) => String(b || "").replace(/^[\s•\-–—*·]+/, "").trim().slice(0, 200))
    .filter((b) => b.length > 0)
    .slice(0, 5);

  // Keep a flat summary field so downstream code (ST notes, search, legacy consumers)
  // still works. Bullets joined with " • " reads naturally inline too.
  const flatSummary = summaryBullets.length
    ? summaryBullets.join(" • ")
    : String(parsed.summary || "").slice(0, 500);

  // Validate and normalise
  const result = {
    category: CATEGORIES.includes(parsed.category) ? parsed.category : "unknown_review_needed",
    summaryBullets,
    summary: flatSummary.slice(0, 1000),
    sentiment: ["positive", "neutral", "negative"].includes(parsed.sentiment)
      ? parsed.sentiment
      : "neutral",
    isSpam: Boolean(parsed.isSpam),
    isJobRelated: Boolean(parsed.isJobRelated),
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
    recommendedAction: String(parsed.recommendedAction || "").slice(0, 200),
    rawModel: model,
  };

  console.log(
    `[Classification] Result: ${result.category} | sentiment=${result.sentiment} | bullets=${result.summaryBullets.length} | confidence=${result.confidence} | spam=${result.isSpam}`
  );

  return result;
}

/**
 * Split a prose summary into 3–4 bullets on sentence boundaries.
 * Used only when the model returns legacy `summary` text instead of `summaryBullets`
 * (or when a record from the old format is being re-rendered).
 */
function splitToBullets(text) {
  if (!text) return [];
  return String(text)
    .split(/(?<=[.!?])\s+|\s•\s|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function emptyResult(reason) {
  return {
    category: "unknown_review_needed",
    summaryBullets: [reason],
    summary: reason,
    sentiment: "neutral",
    isSpam: false,
    isJobRelated: false,
    confidence: 0,
    recommendedAction: "Review call manually",
    rawModel: null,
  };
}

module.exports = {
  classifyCall,
  CATEGORIES,
  splitToBullets,
  DEFAULT_INSTRUCTIONS,
  getEffectiveInstructions,
  buildSystemPrompt,
};
