const axios = require("axios");

const GHL_BASE = "https://services.leadconnectorhq.com";

function ghlHeaders() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    "Content-Type": "application/json",
    Version: "2021-07-28",
  };
}

// ── Custom Field Definitions (cached) ────────────────────────────────────────
// GHL radio button fields require the option's ID value, not the display label.
// We fetch the field definitions once and cache them for the lifetime of the process.

let _customFieldCache = null;

async function getLocationCustomFields({ bust = false } = {}) {
  if (_customFieldCache && !bust) return _customFieldCache;

  // GHL scopes custom fields by model — fetch contact and opportunity separately
  const [contactRes, oppRes] = await Promise.all([
    axios.get(`${GHL_BASE}/locations/${process.env.GHL_LOCATION_ID}/customFields`, {
      headers: ghlHeaders(),
      params: { model: "contact" },
    }).catch(() => ({ data: { customFields: [] } })),
    axios.get(`${GHL_BASE}/locations/${process.env.GHL_LOCATION_ID}/customFields`, {
      headers: ghlHeaders(),
      params: { model: "opportunity" },
    }).catch(() => ({ data: { customFields: [] } })),
  ]);

  _customFieldCache = [
    ...(contactRes.data.customFields || []),
    ...(oppRes.data.customFields || []),
  ];
  return _customFieldCache;
}

/**
 * For a radio-button custom field, resolve the display label ("March") to its
 * GHL option ID so the contact/opportunity update is accepted.
 *
 * fieldKey  — the bare field key, e.g. "cooling_check_month"
 * label     — the human-readable option text, e.g. "March"
 * fields    — the array returned by getLocationCustomFields()
 *
 * Checks contact., opportunity., and bare key variants.
 * Returns the option ID string if found, or the original label as fallback.
 */
function resolveRadioOptionId(fieldKey, label, fields) {
  if (!label) return label;

  const field = fields.find(
    (f) =>
      f.fieldKey === `contact.${fieldKey}` ||
      f.fieldKey === `opportunity.${fieldKey}` ||
      f.fieldKey === fieldKey
  );
  if (!field || !Array.isArray(field.options)) return label;

  const match = field.options.find(
    (o) => (o.key || o.label || "").toLowerCase() === label.toLowerCase()
  );
  return match ? (match.value || match.id || label) : label;
}

// ── Contacts ──────────────────────────────────────────────────────────────────
async function findContactByPhone(phone) {
  const res = await axios.get(`${GHL_BASE}/contacts/search`, {
    headers: ghlHeaders(),
    params: { locationId: process.env.GHL_LOCATION_ID, query: phone },
  });
  return res.data.contacts?.[0] || null;
}

async function findContactByEmail(email) {
  const res = await axios.get(`${GHL_BASE}/contacts/search`, {
    headers: ghlHeaders(),
    params: { locationId: process.env.GHL_LOCATION_ID, query: email },
  });
  return res.data.contacts?.[0] || null;
}

async function createOrUpdateContact({ firstName, lastName, phone, email, address1, city, state, postalCode, customFields = {} }) {
  // Try to find existing contact
  let existing = null;
  if (phone) existing = await findContactByPhone(phone);
  if (!existing && email) existing = await findContactByEmail(email);

  // Resolve radio-button option IDs (GHL ignores plain text for radio fields)
  const fieldDefs = await getLocationCustomFields().catch(() => []);
  const resolvedFields = Object.entries(customFields).map(([key, value]) => ({
    key,
    field_value: resolveRadioOptionId(key, value, fieldDefs),
  }));

  const payload = {
    locationId: process.env.GHL_LOCATION_ID,
    firstName,
    lastName,
    phone,
    email,
    ...(address1 && { address1 }),
    ...(city && { city }),
    ...(state && { state }),
    ...(postalCode && { postalCode }),
    customFields: resolvedFields,
  };

  if (existing) {
    const res = await axios.put(`${GHL_BASE}/contacts/${existing.id}`, payload, { headers: ghlHeaders() });
    return { contact: res.data.contact, created: false };
  } else {
    const res = await axios.post(`${GHL_BASE}/contacts/`, payload, { headers: ghlHeaders() });
    return { contact: res.data.contact, created: true };
  }
}

// Update specific custom fields on an existing contact (targeted patch — does not overwrite other fields)
async function updateContactFields(contactId, customFields = {}) {
  // Resolve radio-button option IDs before sending
  const fieldDefs = await getLocationCustomFields().catch(() => []);
  const resolvedFields = Object.entries(customFields).map(([key, value]) => ({
    key,
    field_value: resolveRadioOptionId(key, value, fieldDefs),
  }));

  const payload = { customFields: resolvedFields };
  const res = await axios.put(`${GHL_BASE}/contacts/${contactId}`, payload, { headers: ghlHeaders() });
  return res.data.contact;
}

async function addTagToContact(contactId, tags) {
  const res = await axios.post(
    `${GHL_BASE}/contacts/${contactId}/tags`,
    { tags: Array.isArray(tags) ? tags : [tags] },
    { headers: ghlHeaders() }
  );
  return res.data;
}

// ── Workflows ─────────────────────────────────────────────────────────────────
async function triggerWorkflow(contactId, workflowId) {
  if (!workflowId) {
    console.warn("No GHL_RETURN_VISIT_WORKFLOW_ID set — skipping workflow trigger");
    return null;
  }
  const res = await axios.post(
    `${GHL_BASE}/contacts/${contactId}/workflow/${workflowId}`,
    {},
    { headers: ghlHeaders() }
  );
  return res.data;
}

// ── Opportunities / Pipeline ──────────────────────────────────────────────────

// Find all opportunities for a given contact
async function searchOpportunitiesByContact(contactId) {
  const res = await axios.get(`${GHL_BASE}/opportunities/search`, {
    headers: ghlHeaders(),
    params: { location_id: process.env.GHL_LOCATION_ID, contact_id: contactId },
  });
  return res.data.opportunities || [];
}

// Update custom fields on an existing opportunity
async function updateOpportunityFields(opportunityId, customFields = {}) {
  const fieldDefs = await getLocationCustomFields().catch(() => []);
  const resolvedFields = Object.entries(customFields).map(([key, value]) => ({
    key,
    field_value: resolveRadioOptionId(key, value, fieldDefs),
  }));

  const payload = { customFields: resolvedFields };
  const res = await axios.put(`${GHL_BASE}/opportunities/${opportunityId}`, payload, { headers: ghlHeaders() });
  return res.data.opportunity;
}

async function createOrUpdateOpportunity({ contactId, name, pipelineId, stageId, status = "open", monetaryValue }) {
  if (!pipelineId) {
    console.warn("No GHL_PIPELINE_ID set — skipping opportunity creation");
    return null;
  }

  const payload = {
    pipelineId,
    locationId: process.env.GHL_LOCATION_ID,
    name,
    contactId,
    status,
    pipelineStageId: stageId,
    monetaryValue,
  };

  // This runs on every re-poll / backfill of the same job. Previously it always
  // POSTed, creating a DUPLICATE opportunity each time. Look for an existing
  // opportunity for this contact in the same pipeline and update it in place.
  let existing = null;
  if (contactId) {
    try {
      const opps = await searchOpportunitiesByContact(contactId);
      existing = opps.find(
        (o) => o.pipelineId === pipelineId || o.pipeline_id === pipelineId
      ) || null;
    } catch (e) {
      console.warn(`[GHL] opportunity lookup failed, creating a new one: ${e.message}`);
    }
  }

  if (existing) {
    const res = await axios.put(`${GHL_BASE}/opportunities/${existing.id}`, payload, { headers: ghlHeaders() });
    return res.data.opportunity;
  }

  const res = await axios.post(`${GHL_BASE}/opportunities/`, payload, { headers: ghlHeaders() });
  return res.data.opportunity;
}

// ── Notes ─────────────────────────────────────────────────────────────────────
async function addNoteToContact(contactId, body) {
  const res = await axios.post(
    `${GHL_BASE}/contacts/${contactId}/notes`,
    { body, userId: "system" },
    { headers: ghlHeaders() }
  );
  return res.data;
}

module.exports = {
  findContactByPhone,
  findContactByEmail,
  createOrUpdateContact,
  updateContactFields,
  addTagToContact,
  triggerWorkflow,
  searchOpportunitiesByContact,
  updateOpportunityFields,
  createOrUpdateOpportunity,
  addNoteToContact,
  getLocationCustomFields,
  resolveRadioOptionId,
};
