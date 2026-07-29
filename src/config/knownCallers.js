/**
 * knownCallers.js
 *
 * Fixed classification rules for recurring, known phone numbers — supply houses,
 * vendors, and other non-lead callers whose calls should never sit "unlabeled"
 * in ServiceTitan and skew the office's call metrics.
 *
 * When a call comes in from one of these numbers, the pipeline bypasses the AI
 * category → callType guess and writes the exact classification below straight
 * to the ST call record (callType + reason + answering agent). It's applied in:
 *   - services/callProcessingService.js  (every polled/processed call)
 *   - services/callClassificationSync.js (applyKnownCallerRule — the ST writer)
 *   - routes/calls.js                    (annotates the API so the card shows a badge)
 *
 * To add another number: copy an entry, key it by the 10-digit phone number
 * (digits only — normalizePhone handles any formatting), and fill in the fields.
 *
 * Field reference:
 *   label     — human description shown on the call card badge (why it's auto-labeled)
 *   callType  — ST call classification enum: Excused | Unbooked | NotLead | Booked | Abandoned
 *   reason    — ST call reason display name (must exist in your ST call-reasons list)
 *   agentId   — ST employee ID to set as the answering agent (optional)
 *   agentName — display name for logs / the card badge (optional, cosmetic)
 */

const KNOWN_CALLERS = {
  // Meridian Supply Co. — calls in for permission to run our card for purchases.
  // Renata Vasilenko handles these ~98% of the time.
  "6145550177": {
    label: "Supply house — card authorization",
    callType: "Excused",
    reason: "Vendor/marketing",
    agentId: 9203, // Renata Vasilenko (renata.vasilenko@groundedhs.example)
    agentName: "Renata Vasilenko",
  },

  // Ferris Industrial Distributors — order-status callbacks on open POs. These
  // land on accounts payable, not the CSR queue, so they never count as leads.
  "3305550164": {
    label: "Parts distributor — order status",
    callType: "Excused",
    reason: "Vendor/marketing",
    agentId: 9206, // Harold Kittridge (harold.kittridge@groundedhs.example)
    agentName: "Harold Kittridge",
  },
};

/**
 * Normalize a phone number to bare digits, dropping a leading US country code.
 * Handles "(614) 555-0177", "+16145550177", "614-555-0177", etc. → "6145550177".
 */
function normalizePhone(phone) {
  let d = String(phone == null ? "" : phone).replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d;
}

/**
 * Return the known-caller rule for a phone number, or null if none is configured.
 * @param {string|number|null} phone
 * @returns {{label:string, callType:string, reason:string|null, agentId:number|null, agentName:string|null}|null}
 */
function getKnownCaller(phone) {
  const d = normalizePhone(phone);
  if (!d) return null;
  return KNOWN_CALLERS[d] || null;
}

module.exports = { KNOWN_CALLERS, getKnownCaller, normalizePhone };
