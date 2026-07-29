/**
 * src/demo/gohighlevel.mock.js
 *
 * Drop-in replacement for src/api/gohighlevel.js.
 *
 * GoHighLevel is the marketing/CRM side of the integration: when a job is
 * completed or a Happy Review comes in, the app pushes a contact, tags it,
 * moves an opportunity through a pipeline, and enrolls it in a workflow. All of
 * that is outbound — it *writes to a live marketing automation platform*, which
 * is precisely the thing a public demo must never do.
 *
 * So this mock keeps a small in-memory CRM: contacts keyed by phone/email,
 * opportunities keyed by contact + pipeline, tags, notes, and a log of every
 * workflow enrollment. The behaviour that matters for the demo is the
 * upsert semantics — `createOrUpdateContact` and `createOrUpdateOpportunity`
 * must return `created: false` / update in place on a repeat call, because the
 * duplicate-opportunity bug that guard exists to prevent is one of the more
 * interesting things about this integration.
 */

const { getWorld } = require("./world");

const LATENCY = Number(process.env.DEMO_LATENCY_MS) || 0;
const tick = () => (LATENCY ? new Promise((r) => setTimeout(r, LATENCY)) : Promise.resolve());

const digits = (s) => String(s == null ? "" : s).replace(/\D/g, "");

// ---------------------------------------------------------------------------
// In-memory CRM
// ---------------------------------------------------------------------------

const crm = {
  contacts: new Map(), // id -> contact
  byPhone: new Map(), // digits -> id
  byEmail: new Map(), // lowercased email -> id
  opportunities: new Map(), // id -> opportunity
  notes: [],
  workflowEnrollments: [],
  seeded: false,
};

let _seq = 1;
const nextId = (prefix) => `${prefix}_demo_${String(_seq++).padStart(6, "0")}`;

/**
 * Pre-populate the CRM from the demo world so lookups aren't all misses on a
 * fresh boot. Roughly two thirds of customers already exist in the CRM, which
 * is about right for a company a couple of years into using both systems.
 */
function ensureSeeded() {
  if (crm.seeded) return;
  crm.seeded = true;
  const w = getWorld();
  w.customers.forEach((cust, i) => {
    if (i % 3 === 0) return; // a third are not in the CRM yet
    const [firstName, ...rest] = String(cust.name).split(" ");
    const contact = {
      id: nextId("cont"),
      locationId: process.env.GHL_LOCATION_ID || "demo-location",
      firstName,
      lastName: rest.join(" "),
      name: cust.name,
      phone: cust._primaryPhone,
      email: cust.email,
      address1: cust.address.street,
      city: cust.address.city,
      state: cust.address.state,
      postalCode: cust.address.zip,
      tags: [],
      customFields: [],
      dateAdded: cust.createdOn,
    };
    crm.contacts.set(contact.id, contact);
    if (contact.phone) crm.byPhone.set(digits(contact.phone), contact.id);
    if (contact.email) crm.byEmail.set(String(contact.email).toLowerCase(), contact.id);
  });
}

// ---------------------------------------------------------------------------
// Custom field definitions
// ---------------------------------------------------------------------------

/**
 * Mirrors the shape GHL returns from /locations/:id/customFields. The radio
 * fields matter: the real client has to resolve a human label to an option id
 * because GHL silently drops plain text on radio fields, and
 * `resolveRadioOptionId` below is the code that does it.
 */
const CUSTOM_FIELDS = [
  { id: "cf_job_number",     fieldKey: "contact.job_number",     name: "Job Number",        dataType: "TEXT" },
  { id: "cf_job_type",       fieldKey: "contact.job_type",       name: "Job Type",          dataType: "TEXT" },
  { id: "cf_technician",     fieldKey: "contact.technician",     name: "Technician",        dataType: "TEXT" },
  { id: "cf_invoice_total",  fieldKey: "contact.invoice_total",  name: "Invoice Total",     dataType: "MONETARY" },
  { id: "cf_completed_on",   fieldKey: "contact.completed_on",   name: "Completed On",      dataType: "DATE" },
  { id: "cf_membership",     fieldKey: "contact.membership",     name: "Membership Status", dataType: "TEXT" },
  { id: "cf_visits_total",   fieldKey: "contact.visits_total",   name: "Visits Total",      dataType: "NUMERICAL" },
  { id: "cf_visits_used",    fieldKey: "contact.visits_used",    name: "Visits Used",       dataType: "NUMERICAL" },
  {
    id: "cf_review_rating",
    fieldKey: "contact.review_rating",
    name: "Review Rating",
    dataType: "RADIO",
    options: [
      { id: "opt_r5", key: "5 - Very Satisfied", label: "5 - Very Satisfied", value: "opt_r5" },
      { id: "opt_r4", key: "4 - Satisfied",      label: "4 - Satisfied",      value: "opt_r4" },
      { id: "opt_r3", key: "3 - Neutral",        label: "3 - Neutral",        value: "opt_r3" },
      { id: "opt_r2", key: "2 - Dissatisfied",   label: "2 - Dissatisfied",   value: "opt_r2" },
      { id: "opt_r1", key: "1 - Very Dissatisfied", label: "1 - Very Dissatisfied", value: "opt_r1" },
    ],
  },
  {
    id: "cf_would_recommend",
    fieldKey: "contact.would_recommend",
    name: "Would Recommend",
    dataType: "RADIO",
    options: [
      { id: "opt_yes",   key: "Yes",   label: "Yes",   value: "opt_yes" },
      { id: "opt_no",    key: "No",    label: "No",    value: "opt_no" },
      { id: "opt_maybe", key: "Maybe", label: "Maybe", value: "opt_maybe" },
    ],
  },
];

async function getLocationCustomFields({ bust = false } = {}) {
  await tick();
  return CUSTOM_FIELDS.map((f) => ({ ...f }));
}

/** Same resolution logic as the live client — label in, option id out. */
function resolveRadioOptionId(fieldKey, label, fields) {
  const field = (fields || []).find(
    (f) => f.fieldKey === fieldKey || f.id === fieldKey || f.name === fieldKey
  );
  if (!field || !Array.isArray(field.options)) return label;
  const match = field.options.find(
    (o) => (o.key || o.label || "").toLowerCase() === String(label).toLowerCase()
  );
  return match ? match.value || match.id || label : label;
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

async function findContactByPhone(phone) {
  await tick();
  ensureSeeded();
  const id = crm.byPhone.get(digits(phone));
  return id ? { ...crm.contacts.get(id) } : null;
}

async function findContactByEmail(email) {
  await tick();
  ensureSeeded();
  const id = crm.byEmail.get(String(email || "").toLowerCase());
  return id ? { ...crm.contacts.get(id) } : null;
}

async function createOrUpdateContact({
  firstName,
  lastName,
  phone,
  email,
  address1,
  city,
  state,
  postalCode,
  customFields = {},
} = {}) {
  await tick();
  ensureSeeded();

  let existing = null;
  if (phone) existing = crm.contacts.get(crm.byPhone.get(digits(phone))) || null;
  if (!existing && email) existing = crm.contacts.get(crm.byEmail.get(String(email).toLowerCase())) || null;

  const fieldDefs = await getLocationCustomFields();
  const resolvedFields = Object.entries(customFields).map(([key, value]) => ({
    key,
    field_value: resolveRadioOptionId(key, value, fieldDefs),
  }));

  if (existing) {
    Object.assign(existing, {
      firstName: firstName ?? existing.firstName,
      lastName: lastName ?? existing.lastName,
      phone: phone ?? existing.phone,
      email: email ?? existing.email,
      address1: address1 ?? existing.address1,
      city: city ?? existing.city,
      state: state ?? existing.state,
      postalCode: postalCode ?? existing.postalCode,
      customFields: mergeFields(existing.customFields, resolvedFields),
      dateUpdated: new Date().toISOString(),
    });
    return { contact: { ...existing }, created: false };
  }

  const contact = {
    id: nextId("cont"),
    locationId: process.env.GHL_LOCATION_ID || "demo-location",
    firstName: firstName || null,
    lastName: lastName || null,
    name: [firstName, lastName].filter(Boolean).join(" ") || null,
    phone: phone || null,
    email: email || null,
    address1: address1 || null,
    city: city || null,
    state: state || null,
    postalCode: postalCode || null,
    tags: [],
    customFields: resolvedFields,
    dateAdded: new Date().toISOString(),
  };
  crm.contacts.set(contact.id, contact);
  if (contact.phone) crm.byPhone.set(digits(contact.phone), contact.id);
  if (contact.email) crm.byEmail.set(String(contact.email).toLowerCase(), contact.id);
  return { contact: { ...contact }, created: true };
}

function mergeFields(existing = [], incoming = []) {
  const out = new Map((existing || []).map((f) => [f.key, f]));
  (incoming || []).forEach((f) => out.set(f.key, f));
  return Array.from(out.values());
}

async function updateContactFields(contactId, customFields = {}) {
  await tick();
  const contact = crm.contacts.get(contactId);
  if (!contact) {
    const err = new Error(`GHL contact ${contactId} not found`);
    err.response = { status: 404 };
    throw err;
  }
  const fieldDefs = await getLocationCustomFields();
  const resolvedFields = Object.entries(customFields).map(([key, value]) => ({
    key,
    field_value: resolveRadioOptionId(key, value, fieldDefs),
  }));
  contact.customFields = mergeFields(contact.customFields, resolvedFields);
  contact.dateUpdated = new Date().toISOString();
  return { ...contact };
}

async function addTagToContact(contactId, tags) {
  await tick();
  const contact = crm.contacts.get(contactId);
  if (!contact) {
    const err = new Error(`GHL contact ${contactId} not found`);
    err.response = { status: 404 };
    throw err;
  }
  const incoming = Array.isArray(tags) ? tags : [tags];
  contact.tags = Array.from(new Set([...(contact.tags || []), ...incoming]));
  return { tags: contact.tags };
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

async function triggerWorkflow(contactId, workflowId) {
  await tick();
  if (!workflowId) {
    console.warn("No workflow id set — skipping workflow trigger");
    return null;
  }
  const enrollment = {
    id: nextId("enroll"),
    contactId,
    workflowId,
    status: "active",
    enrolledAt: new Date().toISOString(),
  };
  crm.workflowEnrollments.push(enrollment);
  return enrollment;
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

async function searchOpportunitiesByContact(contactId) {
  await tick();
  return Array.from(crm.opportunities.values())
    .filter((o) => o.contactId === contactId)
    .map((o) => ({ ...o }));
}

async function updateOpportunityFields(opportunityId, customFields = {}) {
  await tick();
  const opp = crm.opportunities.get(opportunityId);
  if (!opp) {
    const err = new Error(`GHL opportunity ${opportunityId} not found`);
    err.response = { status: 404 };
    throw err;
  }
  const fieldDefs = await getLocationCustomFields();
  const resolvedFields = Object.entries(customFields).map(([key, value]) => ({
    key,
    field_value: resolveRadioOptionId(key, value, fieldDefs),
  }));
  opp.customFields = mergeFields(opp.customFields, resolvedFields);
  opp.dateUpdated = new Date().toISOString();
  return { ...opp };
}

/**
 * Upsert, not insert. The live version of this function used to POST
 * unconditionally, which created a fresh opportunity on every re-poll and
 * backfill of the same job. Preserving the update-in-place path here keeps that
 * story demonstrable.
 */
async function createOrUpdateOpportunity({
  contactId,
  name,
  pipelineId,
  stageId,
  status = "open",
  monetaryValue,
} = {}) {
  await tick();
  if (!pipelineId) {
    console.warn("No pipeline id set — skipping opportunity creation");
    return null;
  }

  let existing = null;
  if (contactId) {
    existing =
      Array.from(crm.opportunities.values()).find(
        (o) => o.contactId === contactId && (o.pipelineId === pipelineId || o.pipeline_id === pipelineId)
      ) || null;
  }

  if (existing) {
    Object.assign(existing, {
      name: name ?? existing.name,
      pipelineStageId: stageId ?? existing.pipelineStageId,
      status: status ?? existing.status,
      monetaryValue: monetaryValue ?? existing.monetaryValue,
      dateUpdated: new Date().toISOString(),
    });
    return { ...existing };
  }

  const opp = {
    id: nextId("opp"),
    locationId: process.env.GHL_LOCATION_ID || "demo-location",
    contactId: contactId || null,
    name: name || "Opportunity",
    pipelineId,
    pipeline_id: pipelineId,
    pipelineStageId: stageId || null,
    status,
    monetaryValue: monetaryValue || 0,
    customFields: [],
    dateAdded: new Date().toISOString(),
  };
  crm.opportunities.set(opp.id, opp);
  return { ...opp };
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

async function addNoteToContact(contactId, body) {
  await tick();
  const note = {
    id: nextId("note"),
    contactId,
    body,
    userId: "system",
    dateAdded: new Date().toISOString(),
  };
  crm.notes.push(note);
  return { note };
}

// ---------------------------------------------------------------------------

const __demo = {
  crm,
  stats: () => ({
    contacts: crm.contacts.size,
    opportunities: crm.opportunities.size,
    notes: crm.notes.length,
    workflowEnrollments: crm.workflowEnrollments.length,
  }),
};

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
  __demo,
};
