/**
 * src/demo/servicetitan.mock.js
 *
 * A drop-in replacement for src/api/servicetitan.js that serves the in-memory
 * demo world instead of calling ServiceTitan.
 *
 * The contract is exact: same 68 exported function names, same parameters, same
 * return shapes — including the awkward ones. ServiceTitan's real client is not
 * uniform, and neither is this. Specifically:
 *
 *   - `getJobs`, `getAppointments` and the four `searchPricebook*` functions
 *     return the raw ST list envelope `{ page, pageSize, totalCount, hasMore, data }`.
 *     Every other list function returns a bare array.
 *   - `getTechniciansMap` and `getJobTypeNamesById` return real JS `Map`s.
 *   - `findJobByNumber` never returns null; it returns `{ jobId, jobNumber }`
 *     with a **string** jobId.
 *   - `getTechnicianByName` returns `undefined`, not null.
 *   - `updateJobStatus`, `updateJobType`, `appendJobSummary` and
 *     `updateCallReasonOnST` never throw — they return a result envelope.
 *   - Eleven reads swallow their own errors and return `[]` / `null`.
 *
 * Reproducing those quirks matters more than it looks. Callers branch on them.
 * A "cleaner" mock that normalized everything to arrays would break roughly a
 * third of the pages, and the failures would be silent — empty tables, not
 * stack traces.
 *
 * Writes mutate the in-memory world so the app feels live: register a piece of
 * equipment and it shows up on the next read. Nothing is persisted, so a
 * restart (or POST /api/demo/reset) returns the world to pristine.
 */

const { getWorld } = require("./world");
const { Rng, ROOT_SEED } = require("./rng");

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/**
 * Optional artificial latency. Off by default — a portfolio demo should feel
 * fast. Set DEMO_LATENCY_MS to make loading states visible when recording a
 * walkthrough.
 */
const LATENCY = Number(process.env.DEMO_LATENCY_MS) || 0;
const tick = () => (LATENCY ? new Promise((r) => setTimeout(r, LATENCY)) : Promise.resolve());

/** ServiceTitan's standard list envelope. */
function envelope(rows, { page = 1, pageSize = 50 } = {}) {
  const start = (page - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);
  return {
    page,
    pageSize,
    totalCount: rows.length,
    hasMore: start + pageSize < rows.length,
    data: slice,
  };
}

/** Strip the generator's private `_`-prefixed bookkeeping fields. */
function clean(obj) {
  if (obj == null) return obj;
  if (Array.isArray(obj)) return obj.map(clean);
  if (typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("_")) continue;
    out[k] = v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) ? v : v;
  }
  return out;
}

const cleanAll = (arr) => (arr || []).map(clean);

const digits = (s) => String(s == null ? "" : s).replace(/\D/g, "");

function inRange(dateStr, fromStr, toStr) {
  if (!dateStr) return false;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return false;
  if (fromStr && t < new Date(fromStr).getTime()) return false;
  if (toStr && t > new Date(toStr).getTime()) return false;
  return true;
}

/** Mutation counter so the demo banner can show "you've changed N records". */
const mutations = { count: 0, log: [] };
function recordMutation(kind, detail) {
  mutations.count++;
  mutations.log.push({ at: new Date().toISOString(), kind, detail });
  if (mutations.log.length > 500) mutations.log.shift();
}

let _newIdSeq = 990000;
const newId = () => _newIdSeq++;

// ---------------------------------------------------------------------------
// 3. Auth
// ---------------------------------------------------------------------------

async function getAccessToken() {
  await tick();
  return "demo-access-token-not-a-real-credential";
}

// ---------------------------------------------------------------------------
// 4. Calls / telecom
// ---------------------------------------------------------------------------

async function getCall(callId) {
  await tick();
  const w = getWorld();
  const call = w.index.callById.get(String(callId));
  if (!call) {
    const err = new Error(`Call ${callId} not found`);
    err.response = { status: 404 };
    throw err;
  }
  return clean(call);
}

/** WRITE. Never throws — returns the updated call, or null on a no-op. */
async function updateCallReasonOnST(stCallId, { reasonName, callType, agentId } = {}) {
  await tick();
  const w = getWorld();
  const call = w.index.callById.get(String(stCallId));
  if (!call) return null;
  if (reasonName) {
    const reason = w.callReasons.find((r) => r.name === reasonName);
    call.reason = reason ? { id: reason.id, name: reason.name } : { id: null, name: reasonName };
  }
  if (callType) call.callType = callType;
  if (agentId) {
    const agent = w.index.employeeById.get(String(agentId));
    call.agent = agent ? { id: agent.id, name: agent.name } : { id: agentId, name: null };
  }
  recordMutation("call.reason", { callId: stCallId, reasonName, callType, agentId });
  return clean(call);
}

/**
 * The real client returns an axios response whose `.data` is an audio stream.
 * There is no audio in the demo, so this returns a short silent WAV — enough
 * for the player to load and for the transcription path to run end to end.
 */
async function getCallRecordingStream(callId) {
  await tick();
  const { Readable } = require("stream");
  const wav = silentWav(2);
  return {
    status: 200,
    headers: { "content-type": "audio/wav", "content-length": String(wav.length) },
    data: Readable.from(wav),
  };
}

/** Minimal valid 8kHz mono PCM WAV of N seconds of silence. */
function silentWav(seconds = 1) {
  const rate = 8000;
  const samples = rate * seconds;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

// ---------------------------------------------------------------------------
// 5. Customers / contacts / locations
// ---------------------------------------------------------------------------

/** READ. Never throws. Note the real API param is `phone`, not `phoneNumber`. */
async function searchCustomersByPhone(phoneNumber) {
  await tick();
  const w = getWorld();
  const target = digits(phoneNumber);
  if (!target) return [];
  const matchIds = new Set(
    w.contacts.filter((c) => digits(c.value) === target).map((c) => c.customerId)
  );
  return cleanAll(w.customers.filter((c) => matchIds.has(c.id)));
}

async function searchCustomersByName(name, { pageSize = 15 } = {}) {
  await tick();
  const w = getWorld();
  const q = String(name || "").trim().toLowerCase();
  if (!q) return [];
  return cleanAll(
    w.customers.filter((c) => c.name.toLowerCase().includes(q)).slice(0, pageSize)
  );
}

async function searchContactsByPhone(phoneNumber) {
  await tick();
  const w = getWorld();
  const target = digits(phoneNumber);
  if (!target) return [];
  return cleanAll(w.contacts.filter((c) => digits(c.value) === target));
}

/** READ. Throws a 404-shaped error so callers' `isCustomerNotFound` still works. */
async function getCustomer(customerId) {
  await tick();
  const w = getWorld();
  const cust = w.index.customerById.get(String(customerId));
  if (!cust) {
    const err = new Error(`Customer ${customerId} not found`);
    err.response = { status: 404, data: { title: "Not Found" } };
    throw err;
  }
  return clean(cust);
}

async function getCustomerContacts(customerId) {
  await tick();
  const w = getWorld();
  return cleanAll(w.index.contactsByCustomer.get(String(customerId)) || []);
}

async function getLocationById(locationId) {
  await tick();
  const w = getWorld();
  return clean(w.index.locationById.get(String(locationId))) || null;
}

async function getLocationsByCustomer(customerId, { pageSize = 5 } = {}) {
  await tick();
  const w = getWorld();
  return cleanAll((w.index.locationsByCustomer.get(String(customerId)) || []).slice(0, pageSize));
}

async function searchLocationsByAddress(query, { pageSize = 20 } = {}) {
  await tick();
  const w = getWorld();
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  return cleanAll(
    w.locations
      .filter((l) => {
        const a = l.address || {};
        return (
          String(a.street || "").toLowerCase().includes(q) ||
          String(a.city || "").toLowerCase().includes(q) ||
          String(a.zip || "").includes(q) ||
          String(l.name || "").toLowerCase().includes(q)
        );
      })
      .slice(0, pageSize)
  );
}

/** WRITE. */
async function addCustomerNote(customerId, text) {
  await tick();
  const w = getWorld();
  if (!w.index.customerById.has(String(customerId))) {
    const err = new Error(`Customer ${customerId} not found`);
    err.response = { status: 404 };
    throw err;
  }
  const note = { id: newId(), customerId: Number(customerId), text, createdOn: new Date().toISOString() };
  w.customerNotes.push(note);
  recordMutation("customer.note", { customerId, chars: String(text || "").length });
  return note;
}

/** WRITE. */
async function applyTagToCustomer(customerId, tagTypeId) {
  await tick();
  const w = getWorld();
  const cust = w.index.customerById.get(String(customerId));
  if (!cust) {
    const err = new Error(`Customer ${customerId} not found`);
    err.response = { status: 404 };
    throw err;
  }
  cust.tagTypeIds = Array.from(new Set([...(cust.tagTypeIds || []), Number(tagTypeId)]));
  recordMutation("customer.tag", { customerId, tagTypeId });
  return { id: newId(), customerId: Number(customerId), tagTypeId: Number(tagTypeId) };
}

// ---------------------------------------------------------------------------
// 6. Jobs / appointments
// ---------------------------------------------------------------------------

async function getJob(jobId) {
  await tick();
  const w = getWorld();
  const job = w.index.jobById.get(String(jobId));
  if (!job) {
    const err = new Error(`Job ${jobId} not found`);
    err.response = { status: 404 };
    err.isJobNotFound = true;
    throw err;
  }
  return clean(job);
}

/** READ. Returns the raw ST envelope. */
async function getJobs({
  modifiedOnOrAfter,
  modifiedBefore,
  modifiedOnOrBefore,
  technicianId,
  jobTypeIds,
  jobStatus,
  page = 1,
  pageSize = 50,
} = {}) {
  await tick();
  const w = getWorld();
  let rows = w.jobs;

  if (modifiedOnOrAfter || modifiedBefore || modifiedOnOrBefore) {
    rows = rows.filter((j) => inRange(j.modifiedOn, modifiedOnOrAfter, modifiedBefore || modifiedOnOrBefore));
  }
  if (technicianId) {
    const tid = String(technicianId);
    const jobIds = new Set(
      w.appointments.filter((a) => String(a.technicianId) === tid).map((a) => a.jobId)
    );
    rows = rows.filter((j) => jobIds.has(j.id) || String(j.leadTechnicianId) === tid);
  }
  if (jobTypeIds) {
    const wanted = new Set(String(jobTypeIds).split(",").map((s) => s.trim()));
    rows = rows.filter((j) => wanted.has(String(j.jobTypeId)));
  }
  if (jobStatus) {
    const wanted = new Set(String(jobStatus).split(",").map((s) => s.trim().toLowerCase()));
    rows = rows.filter((j) => wanted.has(String(j.jobStatus).toLowerCase()));
  }

  return envelope(cleanAll(rows), { page, pageSize });
}

/**
 * READ. Returns null when the number doesn't match — deliberately. The real
 * client added this guard after ST's search returned a near-miss job for a
 * mistyped number and the app silently attached notes to the wrong customer.
 */
async function getJobByNumber(jobNumber) {
  await tick();
  const w = getWorld();
  const job = w.index.jobByNumber.get(String(jobNumber).trim());
  if (!job) return null;
  if (String(job.jobNumber) !== String(jobNumber).trim()) return null;
  return clean(job);
}

/** READ. Never returns null — always `{ jobId, jobNumber }`, jobId as a string. */
async function findJobByNumber(jobNumberOrId) {
  await tick();
  const w = getWorld();
  const raw = String(jobNumberOrId == null ? "" : jobNumberOrId).trim();
  if (!raw) return { jobId: null, jobNumber: null };

  let job = w.index.jobByNumber.get(raw);
  if (!job) job = w.index.jobById.get(raw);
  if (!job) return { jobId: null, jobNumber: null };
  return { jobId: String(job.id), jobNumber: String(job.jobNumber) };
}

/** READ. Returns the raw ST envelope. */
async function getAppointments({
  startsOnOrAfter,
  startsOnOrBefore,
  technicianId,
  jobId,
  page = 1,
  pageSize = 50,
} = {}) {
  await tick();
  const w = getWorld();
  let rows = w.appointments;
  if (jobId) rows = rows.filter((a) => String(a.jobId) === String(jobId));
  if (technicianId) rows = rows.filter((a) => String(a.technicianId) === String(technicianId));
  if (startsOnOrAfter || startsOnOrBefore) {
    rows = rows.filter((a) => inRange(a.start, startsOnOrAfter, startsOnOrBefore));
  }
  return envelope(cleanAll(rows), { page, pageSize });
}

/** READ. Bare array, fully paginated. */
async function getAllAppointmentsForDateRange(startDate, endDate, technicianId = null) {
  await tick();
  const w = getWorld();
  let rows = w.appointments.filter((a) => inRange(a.start, startDate, endDate));
  if (technicianId) rows = rows.filter((a) => String(a.technicianId) === String(technicianId));
  return cleanAll(rows);
}

/** READ. Bare array. */
async function getJobAppointments(jobId) {
  await tick();
  const w = getWorld();
  return cleanAll(w.index.appointmentsByJob.get(String(jobId)) || []);
}

/** READ. Never throws. Sorted newest first. */
async function getRecentJobsForCustomer(customerId, opts = {}) {
  await tick();
  const w = getWorld();
  const limit = opts.limit || opts.pageSize || 20;
  const rows = (w.index.jobsByCustomer.get(String(customerId)) || [])
    .slice()
    .sort((a, b) => new Date(b.createdOn) - new Date(a.createdOn))
    .slice(0, limit);
  return cleanAll(rows);
}

/** READ. Never throws. */
async function getJobsForCustomerInRange(customerId, startISO, endISO, { dateField = "modified" } = {}) {
  await tick();
  const w = getWorld();
  const field = dateField === "created" ? "createdOn" : dateField === "completed" ? "completedOn" : "modifiedOn";
  const rows = (w.index.jobsByCustomer.get(String(customerId)) || [])
    .filter((j) => inRange(j[field], startISO, endISO))
    .sort((a, b) => new Date(b[field]) - new Date(a[field]));
  return cleanAll(rows);
}

/** WRITE. Throws with `isJobNotFound` on a missing job. */
async function addJobNote(jobId, text) {
  await tick();
  const w = getWorld();
  if (!w.index.jobById.has(String(jobId))) {
    const err = new Error(`Job ${jobId} not found`);
    err.response = { status: 404 };
    err.isJobNotFound = true;
    throw err;
  }
  const note = { id: newId(), jobId: Number(jobId), text, createdOn: new Date().toISOString() };
  w.jobNotes.push(note);
  recordMutation("job.note", { jobId, chars: String(text || "").length });
  return note;
}

/** WRITE. Never throws — returns a result envelope. */
async function updateJobStatus(jobId, statusName) {
  await tick();
  const w = getWorld();
  const job = w.index.jobById.get(String(jobId));
  if (!job) return { ok: false, status: 404, error: `Job ${jobId} not found` };

  const canonical = canonicalJobStatus(statusName);
  if (!canonical) return { ok: false, status: 400, error: `Unknown job status "${statusName}"` };

  job.jobStatus = canonical;
  job.status = canonical;
  job.modifiedOn = new Date().toISOString();
  if (canonical === "Completed" && !job.completedOn) job.completedOn = job.modifiedOn;
  recordMutation("job.status", { jobId, status: canonical });
  return { ok: true, status: 200, value: canonical, data: clean(job) };
}

const ST_JOB_STATUSES = ["Scheduled", "Dispatched", "InProgress", "Hold", "Completed", "Canceled"];

function canonicalJobStatus(s) {
  const norm = String(s || "").replace(/[\s_-]/g, "").toLowerCase();
  return ST_JOB_STATUSES.find((v) => v.toLowerCase() === norm) || null;
}

/** WRITE. Never throws. */
async function updateJobType(jobId, jobTypeName) {
  await tick();
  const w = getWorld();
  const job = w.index.jobById.get(String(jobId));
  if (!job) return { ok: false, status: 404, error: `Job ${jobId} not found` };

  const jt = w.index.jobTypeByName.get(String(jobTypeName || "").toLowerCase());
  if (!jt) return { ok: false, status: 404, error: `Job type "${jobTypeName}" not found` };

  // A slice of jobs are locked by the tenant's own workflow rules. Callers have
  // a dedicated branch for this, so the demo needs to exercise it.
  if (job.jobStatus === "Completed" && String(job.id).slice(-1) === "7") {
    return { ok: false, status: 422, reason: "locked-by-tenant", error: "Job type cannot be changed after invoicing." };
  }

  job.jobTypeId = jt.id;
  job.jobTypeName = jt.name;
  job.modifiedOn = new Date().toISOString();
  recordMutation("job.type", { jobId, jobType: jt.name });
  return { ok: true, status: 200, value: jt.name, jobTypeId: jt.id, data: clean(job) };
}

/** WRITE. Never throws. */
async function appendJobSummary(jobId, addition) {
  await tick();
  const w = getWorld();
  const job = w.index.jobById.get(String(jobId));
  if (!job) return { ok: false, status: 404, error: `Job ${jobId} not found` };
  const next = `${job.summary || ""}\n\n${addition || ""}`.trim();
  job.summary = next;
  job.modifiedOn = new Date().toISOString();
  recordMutation("job.summary", { jobId, chars: String(addition || "").length });
  return { ok: true, status: 200, summaryLength: next.length, data: clean(job) };
}

// ---------------------------------------------------------------------------
// 7. Invoices / payments / purchase orders
// ---------------------------------------------------------------------------

async function getInvoicesForJob(jobNumber, jobId = null) {
  await tick();
  const w = getWorld();
  let rows = [];
  if (jobId) rows = w.index.invoicesByJob.get(String(jobId)) || [];
  if (!rows.length && jobNumber) {
    const job = w.index.jobByNumber.get(String(jobNumber));
    if (job) rows = w.index.invoicesByJob.get(String(job.id)) || [];
  }
  return cleanAll(rows);
}

async function getInvoicesByIds(ids = []) {
  await tick();
  const w = getWorld();
  const wanted = new Set((ids || []).map(String));
  if (!wanted.size) return [];
  return cleanAll(w.invoices.filter((i) => wanted.has(String(i.id))));
}

async function getInvoicesByCustomer(customerId, pageSize = 1) {
  await tick();
  const w = getWorld();
  const rows = (w.index.invoicesByCustomer.get(String(customerId)) || [])
    .slice()
    .sort((a, b) => new Date(b.invoicedOn) - new Date(a.invoicedOn))
    .slice(0, pageSize);
  return cleanAll(rows);
}

async function getPayment(paymentId) {
  await tick();
  const w = getWorld();
  return clean(w.index.paymentById.get(String(paymentId))) || null;
}

/** READ. Never throws. */
async function getPurchaseOrdersForJob(jobId) {
  await tick();
  const w = getWorld();
  return cleanAll(w.index.posByJob.get(String(jobId)) || []);
}

/** READ. Never throws — returns null when no confident match. */
async function findVendorByName(name) {
  await tick();
  const w = getWorld();
  const q = String(name || "").trim().toLowerCase();
  if (!q) return null;

  const exact = w.vendors.find((v) => v.name.toLowerCase() === q);
  if (exact) return clean(exact);

  // Same Jaccard-over-tokens approach the real client uses, including its
  // refusal to guess when the top two candidates are within 0.01 of each other.
  const scored = w.vendors
    .map((v) => ({ vendor: v, score: jaccard(tokens(v.name), tokens(q)) }))
    .sort((a, b) => b.score - a.score);

  if (!scored.length || scored[0].score < 0.6) return null;
  if (scored[1] && Math.abs(scored[0].score - scored[1].score) < 0.01) return null;
  return clean(scored[0].vendor);
}

const CORPORATE_SUFFIXES = new Set(["inc", "llc", "co", "corp", "company", "ltd", "the", "and", "of", "supply"]);

function tokens(s) {
  return new Set(
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t && !CORPORATE_SUFFIXES.has(t))
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function invalidateVendorCache() {
  return undefined;
}

/** WRITE. */
async function createPurchaseOrder({
  jobId,
  vendorId,
  items = [],
  summary,
  date,
  vendorDocumentNumber,
  shipToDescription,
  tax = 0,
  shipping = 0,
  requiredOn,
  shipToOverride,
} = {}) {
  await tick();
  const w = getWorld();
  if (!process.env.ST_DEFAULT_SKU_ID && !items.length) {
    throw new Error("createPurchaseOrder: ST_DEFAULT_SKU_ID is not set and no items were provided");
  }
  const vendor = w.index.vendorById.get(String(vendorId));
  const normalized = items.map((it) => ({
    skuName: it.skuName || it.name || "Line item",
    skuId: it.skuId || Number(process.env.ST_DEFAULT_SKU_ID) || 0,
    quantity: Number(it.quantity) || 1,
    cost: Number(it.cost) || 0,
    total: Math.round((Number(it.cost) || 0) * (Number(it.quantity) || 1) * 100) / 100,
  }));
  const subTotal = Math.round(normalized.reduce((s, i) => s + i.total, 0) * 100) / 100;
  const po = {
    id: newId(),
    number: `PO-${newId()}`,
    jobId: Number(jobId) || null,
    vendorId: Number(vendorId) || null,
    vendor: vendor ? { id: vendor.id, name: vendor.name } : null,
    total: Math.round((subTotal + Number(tax) + Number(shipping)) * 100) / 100,
    subTotal,
    tax: Number(tax) || 0,
    shipping: Number(shipping) || 0,
    status: { name: "Pending", value: 1 },
    summary: summary || null,
    vendorDocumentNumber: vendorDocumentNumber || null,
    shipToDescription: shipToDescription || shipToOverride || null,
    sentOn: date || new Date().toISOString(),
    requiredOn: requiredOn || null,
    items: normalized,
  };
  w.purchaseOrders.push(po);
  if (po.jobId) {
    const key = String(po.jobId);
    if (!w.index.posByJob.has(key)) w.index.posByJob.set(key, []);
    w.index.posByJob.get(key).push(po);
  }
  recordMutation("po.create", { jobId, vendorId, lines: normalized.length, total: po.total });
  return po;
}

// ---------------------------------------------------------------------------
// 8. Pricebook
// ---------------------------------------------------------------------------

/** All four search functions return the raw ST envelope. */
function makePricebookSearch(bucket) {
  return async function search(opts = {}) {
    await tick();
    const w = getWorld();
    const { page = 1, pageSize = 50, active, ids, codes } = opts;
    // The real client accepts several aliases for the free-text term.
    const term = String(opts.searchTerm ?? opts.search ?? opts.name ?? opts.code ?? "").trim().toLowerCase();

    let rows = w.pricebook[bucket] || [];
    if (term) {
      rows = rows.filter(
        (i) =>
          String(i.displayName || "").toLowerCase().includes(term) ||
          String(i.code || "").toLowerCase().includes(term) ||
          String(i.description || "").toLowerCase().includes(term)
      );
    }
    if (ids) {
      const wanted = new Set(String(ids).split(",").map((s) => s.trim()));
      rows = rows.filter((i) => wanted.has(String(i.id)));
    }
    if (codes) {
      const wanted = new Set(String(codes).split(",").map((s) => s.trim().toLowerCase()));
      rows = rows.filter((i) => wanted.has(String(i.code).toLowerCase()));
    }
    if (active === true || active === "True" || active === "true") {
      rows = rows.filter((i) => i.active !== false);
    }
    return envelope(cleanAll(rows), { page, pageSize });
  };
}

const searchPricebookServices = makePricebookSearch("services");
const searchPricebookMaterials = makePricebookSearch("materials");
const searchPricebookEquipment = makePricebookSearch("equipment");
const searchPricebookDiscountsAndFees = makePricebookSearch("discountsAndFees");

const SKU_BUCKETS = {
  service: "services",
  services: "services",
  material: "materials",
  materials: "materials",
  equipment: "equipment",
  discount: "discountsAndFees",
  discounts: "discountsAndFees",
  discountandfees: "discountsAndFees",
  discountsandfees: "discountsAndFees",
  fee: "discountsAndFees",
};

function bucketFor(skuType) {
  return SKU_BUCKETS[String(skuType || "").toLowerCase().replace(/[^a-z]/g, "")] || null;
}

async function getPricebookItem(skuType, itemId) {
  await tick();
  const w = getWorld();
  const item = w.index.pricebookById.get(String(itemId));
  if (!item) {
    const err = new Error(`Pricebook item ${itemId} not found`);
    err.response = { status: 404 };
    throw err;
  }
  const vendor = w.index.vendorById.get(String((item.primaryVendor || {}).vendorId));
  return {
    ...clean(item),
    manufacturer: item.manufacturer || null,
    model: item.model || null,
    modelNumber: item.modelNumber || item.model || null,
    primaryVendor: vendor ? { vendorId: vendor.id, id: vendor.id, vendorName: vendor.name, name: vendor.name, vendor: { name: vendor.name }, primary: true, isPrimary: true } : null,
    otherVendors: [],
    vendors: vendor ? [{ vendorId: vendor.id, id: vendor.id, vendorName: vendor.name, name: vendor.name, vendor: { name: vendor.name }, primary: true, isPrimary: true }] : [],
  };
}

const MATERIAL_SAFE_LIST = new Set([Number(process.env.DEMO_PROTECTED_SKU) || 600100]);

function findPricebookItem(itemId) {
  const w = getWorld();
  const item = w.index.pricebookById.get(String(itemId));
  if (!item) {
    const err = new Error(`Pricebook item ${itemId} not found`);
    err.response = { status: 404 };
    throw err;
  }
  return item;
}

/** WRITE. */
async function createMaterial(body = {}) {
  await tick();
  const w = getWorld();
  const item = {
    id: newId(),
    code: body.code || `MAT-NEW-${newId()}`,
    sku: body.code || null,
    displayName: body.displayName || body.name || "New material",
    name: body.displayName || body.name || "New material",
    description: body.description || "",
    active: body.active !== false,
    price: Number(body.price) || 0,
    memberPrice: Number(body.memberPrice) || Number(body.price) || 0,
    addOnPrice: Number(body.price) || 0,
    amount: Number(body.price) || 0,
    unitPrice: Number(body.price) || 0,
    cost: Number(body.cost) || 0,
    skuType: "Material",
    image: null,
    images: [],
  };
  w.pricebook.materials.push(item);
  w.pricebookAll.push(item);
  w.index.pricebookById.set(String(item.id), item);
  recordMutation("pricebook.createMaterial", { id: item.id, code: item.code });
  return item;
}

function makeUpdater(label) {
  return async function update(itemId, updates = {}) {
    await tick();
    const item = findPricebookItem(itemId);
    Object.assign(item, updates);
    if (updates.price != null) {
      item.unitPrice = updates.price;
      item.amount = updates.price;
    }
    recordMutation(`pricebook.${label}`, { id: item.id, fields: Object.keys(updates) });
    return clean(item);
  };
}

const updateMaterial = makeUpdater("updateMaterial");
const updateEquipment = makeUpdater("updateEquipment");
const updateService = makeUpdater("updateService");

/** WRITE. Refuses to touch protected SKUs — same guard as the real client. */
async function deactivateMaterial(materialId) {
  await tick();
  if (MATERIAL_SAFE_LIST.has(Number(materialId))) {
    throw new Error(`deactivateMaterial: ${materialId} is on the safe list and cannot be deactivated`);
  }
  const item = findPricebookItem(materialId);
  item.active = false;
  recordMutation("pricebook.deactivate", { id: item.id });
  return { method: "delete", status: 200, data: clean(item) };
}

/** WRITE. Returns the shape the image pipeline expects. */
async function uploadPricebookImage(imageBytes, { contentType = "image/png", filename } = {}) {
  await tick();
  const name = filename || `demo-${newId()}.png`;
  const path = `demo-images/${name}`;
  recordMutation("pricebook.uploadImage", { filename: name, bytes: imageBytes ? imageBytes.length : 0 });
  return { path, raw: { path, uploadedAt: new Date().toISOString() }, contentType, filename: name };
}

/** READ. Returns a 1x1 transparent PNG — enough to round-trip the pipeline. */
async function fetchPricebookImageBytes(pathOrUrl) {
  await tick();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  return { bytes: png, contentType: "image/png" };
}

/** WRITE. */
async function attachPricebookImage(skuType, itemId, body = {}) {
  await tick();
  const item = findPricebookItem(itemId);
  const path = body.path || body.image || `demo-images/${itemId}.png`;
  item.image = path;
  item.images = [...(item.images || []), path];
  recordMutation("pricebook.attachImage", { id: item.id, path });
  return { ok: true, status: 200, data: { path } };
}

// ---------------------------------------------------------------------------
// 9. Estimates
// ---------------------------------------------------------------------------

/** WRITE. */
async function createEstimate({ jobId, name, summary, items = [] } = {}) {
  await tick();
  const w = getWorld();
  const total = items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.quantity) || 1), 0);
  const est = {
    id: newId(),
    jobId: Number(jobId) || null,
    name: name || "Estimate",
    summary: summary || null,
    status: { name: "Open", value: 1 },
    subtotal: Math.round(total * 100) / 100,
    total: Math.round(total * 1.0725 * 100) / 100,
    createdOn: new Date().toISOString(),
    items,
  };
  w.estimates.push(est);
  recordMutation("estimate.create", { jobId, lines: items.length, total: est.total });
  return est;
}

// ---------------------------------------------------------------------------
// 10. Technicians / employees / payroll
// ---------------------------------------------------------------------------

async function getTechnicians() {
  await tick();
  const w = getWorld();
  return cleanAll(w.technicians);
}

/** READ. Returns **undefined** (not null) when there's no match. */
async function getTechnicianByName(name) {
  await tick();
  const w = getWorld();
  const q = String(name || "").trim().toLowerCase();
  if (!q) return undefined;
  const found =
    w.technicians.find((t) => t.name.toLowerCase() === q) ||
    w.technicians.find((t) => t.name.toLowerCase().includes(q));
  return found ? clean(found) : undefined;
}

/** READ. Returns a real `Map` of id -> name. */
async function getTechniciansMap() {
  await tick();
  const w = getWorld();
  return new Map(w.technicians.map((t) => [String(t.id), t.name]));
}

async function listEmployees({ active = true, force = false } = {}) {
  await tick();
  const w = getWorld();
  const rows = active ? w.employees.filter((e) => e.active !== false) : w.employees;
  return cleanAll(rows);
}

/** WRITE. */
async function createEmployeeTask(body = {}) {
  await tick();
  recordMutation("employee.task", { assignedTo: body.assignedToId || body.employeeId || null });
  return { id: newId(), ...body, createdOn: new Date().toISOString(), status: "Open" };
}

/**
 * The three payroll readers below can throw 401/403 in production when the
 * Payroll v2 scope isn't granted — the scoreboard has a dedicated branch that
 * turns those into a visible "missing scope" warning rather than a wrong
 * number. Set DEMO_PAYROLL_SCOPE=denied to exercise that path.
 */
function assertPayrollScope() {
  if (process.env.DEMO_PAYROLL_SCOPE === "denied") {
    const err = new Error("Forbidden: the app is missing the Payroll (tn.payroll:r) scope.");
    err.response = { status: 403, data: { title: "Forbidden" } };
    throw err;
  }
}

async function getJobLaborSplits(jobId) {
  await tick();
  if (!jobId) return [];
  assertPayrollScope();
  const w = getWorld();
  return cleanAll(w.index.laborSplitsByJob.get(String(jobId)) || []);
}

async function getJobTimesheets(jobId) {
  await tick();
  if (!jobId) return [];
  assertPayrollScope();
  const w = getWorld();
  return cleanAll(w.index.timesheetsByJob.get(String(jobId)) || []);
}

async function getJobGrossPayItems(jobId) {
  await tick();
  if (!jobId) return [];
  assertPayrollScope();
  const w = getWorld();
  return cleanAll(w.index.grossPayByJob.get(String(jobId)) || []);
}

// ---------------------------------------------------------------------------
// 11. Analytics helpers
// ---------------------------------------------------------------------------

async function findReturnVisitJobs(startDate, endDate) {
  await tick();
  const w = getWorld();
  const jobs = w.jobs.filter((j) => inRange(j.modifiedOn, startDate, endDate));
  const out = [];
  for (const job of jobs) {
    const appointments = w.index.appointmentsByJob.get(String(job.id)) || [];
    if (appointments.length > 1) {
      out.push({
        job: clean(job),
        appointments: cleanAll(appointments),
        appointmentCount: appointments.length,
        isReturnVisit: true,
      });
    }
  }
  return out;
}

async function getReturnVisitStatsByTechnician(startDate, endDate) {
  const rows = await findReturnVisitJobs(startDate, endDate);
  const byTech = new Map();
  for (const row of rows) {
    const first = row.appointments
      .slice()
      .sort((a, b) => new Date(a.start) - new Date(b.start))[0];
    const techId = first && first.technician && first.technician.id != null ? String(first.technician.id) : "unknown";
    const techName = (first && first.technician && first.technician.name) || "Unknown";
    if (!byTech.has(techId)) byTech.set(techId, { techId, techName, returnVisitCount: 0, jobs: [] });
    const entry = byTech.get(techId);
    entry.returnVisitCount++;
    entry.jobs.push(row.job);
  }
  return Array.from(byTech.values()).sort((a, b) => b.returnVisitCount - a.returnVisitCount);
}

/** READ. Returns a plain object keyed `YYYY-MM-DD`. */
async function getDailyAppointmentCounts(startDate, endDate) {
  const appts = await getAllAppointmentsForDateRange(startDate, endDate);
  const counts = {};
  for (const a of appts) {
    if (!a.start) continue;
    const key = String(a.start).slice(0, 10);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// 12. Memberships / installed equipment
// ---------------------------------------------------------------------------

/** WRITE. */
async function createMembership(body = {}) {
  await tick();
  const w = getWorld();
  if (!body.customerId || !body.membershipTypeId) {
    throw new Error("createMembership: customerId and membershipTypeId required");
  }
  const mem = {
    id: newId(),
    customerId: Number(body.customerId),
    membershipTypeId: Number(body.membershipTypeId),
    membershipTypeName: body.membershipTypeName || "Ground Club - Annual",
    locationIds: body.locationIds || [],
    status: "Active",
    from: body.from || new Date().toISOString(),
    to: body.to || new Date(Date.now() + 365 * 86400000).toISOString(),
    businessUnitId: body.businessUnitId || 2005,
  };
  w.memberships.push(mem);
  w.index.membershipById.set(String(mem.id), mem);
  const key = String(mem.customerId);
  if (!w.index.membershipsByCustomer.has(key)) w.index.membershipsByCustomer.set(key, []);
  w.index.membershipsByCustomer.get(key).push(mem);
  recordMutation("membership.create", { customerId: mem.customerId, id: mem.id });
  return mem;
}

/** READ. Never throws. */
async function getRecurringServicesForMembership(membershipId) {
  await tick();
  const w = getWorld();
  return cleanAll(w.index.recurringByMembership.get(String(membershipId)) || []);
}

/** READ. Never throws. */
async function getInstalledEquipmentByLocation(locationId) {
  await tick();
  if (!locationId) return [];
  const w = getWorld();
  return cleanAll(w.index.equipmentByLocation.get(String(locationId)) || []);
}

/** WRITE. */
async function createInstalledEquipment(body = {}) {
  await tick();
  const w = getWorld();
  if (!body.locationId) throw new Error("createInstalledEquipment: body.locationId required");

  // Simulate the 403 the tenant hits when the equipment-systems write scope is
  // missing. Three services convert this into a persisted st_write_status
  // 'failed' row rather than surfacing it to the user, and that path is worth
  // being able to demo.
  if (process.env.DEMO_EQUIPMENT_WRITE === "denied") {
    const err = new Error(
      "createInstalledEquipment failed (403): Forbidden — the app/tenant is likely missing the equipment-systems WRITE scope."
    );
    err.response = { status: 403 };
    throw err;
  }

  const rec = {
    id: newId(),
    locationId: Number(body.locationId),
    customerId: body.customerId != null ? Number(body.customerId) : null,
    name: body.name || "Installed equipment",
    manufacturer: body.manufacturer || null,
    model: body.model || null,
    serialNumber: body.serialNumber || null,
    installedOn: body.installedOn || new Date().toISOString(),
    manufacturerWarrantyStart: body.manufacturerWarrantyStart || null,
    manufacturerWarrantyEnd: body.manufacturerWarrantyEnd || null,
    active: true,
  };
  w.installedEquipment.push(rec);
  const key = String(rec.locationId);
  if (!w.index.equipmentByLocation.has(key)) w.index.equipmentByLocation.set(key, []);
  w.index.equipmentByLocation.get(key).push(rec);
  recordMutation("equipment.create", { locationId: rec.locationId, serial: rec.serialNumber });
  return rec;
}

// ---------------------------------------------------------------------------
// 13. Job types
// ---------------------------------------------------------------------------

async function fetchAllJobTypes() {
  await tick();
  const w = getWorld();
  const byName = new Map();
  const byId = new Map();
  for (const t of w.jobTypes) {
    byName.set(t.name.toLowerCase(), { id: t.id, name: t.name });
    byId.set(String(t.id), t.name);
  }
  return { byName, byId, fetchedAt: Date.now() };
}

/** READ. Returns a real `Map` of id -> name. */
async function getJobTypeNamesById() {
  const { byId } = await fetchAllJobTypes();
  return byId;
}

/** READ. Returns `{ id, name }` or null. */
async function resolveJobTypeId(name) {
  const { byName } = await fetchAllJobTypes();
  return byName.get(String(name || "").toLowerCase()) || null;
}

// ---------------------------------------------------------------------------
// 14. Attachments
// ---------------------------------------------------------------------------

/** WRITE. */
async function createJobAttachment(jobId, fileBytes, { filename, contentType = "image/jpeg" } = {}) {
  await tick();
  const w = getWorld();
  if (!jobId) throw new Error("createJobAttachment: jobId required");
  if (!fileBytes) throw new Error("createJobAttachment: fileBytes required");

  const fileName = filename || `attachment-${newId()}.jpg`;
  const rec = {
    id: newId(),
    jobId: Number(jobId),
    fileName,
    contentType,
    size: fileBytes.length || 0,
    createdOn: new Date().toISOString(),
  };
  w.attachments.push(rec);
  recordMutation("job.attachment", { jobId, fileName, bytes: rec.size });
  return { fileName, raw: rec };
}

// ---------------------------------------------------------------------------
// Demo-only extras (not part of the real client's surface)
// ---------------------------------------------------------------------------

const __demo = {
  getWorld,
  mutations,
  stats: () => getWorld().stats,
};

module.exports = {
  getAccessToken,
  getCall,
  updateCallReasonOnST,
  getCallRecordingStream,
  searchCustomersByPhone,
  searchCustomersByName,
  searchContactsByPhone,
  getRecentJobsForCustomer,
  getJobsForCustomerInRange,
  searchLocationsByAddress,
  addJobNote,
  addCustomerNote,
  createMembership,
  applyTagToCustomer,
  findJobByNumber,
  getAppointments,
  getAllAppointmentsForDateRange,
  getJob,
  getJobs,
  getJobAppointments,
  getTechnicians,
  getTechnicianByName,
  listEmployees,
  createEmployeeTask,
  getCustomer,
  getCustomerContacts,
  getLocationById,
  getLocationsByCustomer,
  getInstalledEquipmentByLocation,
  createInstalledEquipment,
  getRecurringServicesForMembership,
  findReturnVisitJobs,
  getReturnVisitStatsByTechnician,
  getDailyAppointmentCounts,
  getInvoicesForJob,
  getPayment,
  getInvoicesByIds,
  getInvoicesByCustomer,
  getPurchaseOrdersForJob,
  getJobByNumber,
  findVendorByName,
  invalidateVendorCache,
  createPurchaseOrder,
  updateMaterial,
  updateEquipment,
  updateService,
  getPricebookItem,
  uploadPricebookImage,
  fetchPricebookImageBytes,
  attachPricebookImage,
  createMaterial,
  deactivateMaterial,
  searchPricebookServices,
  searchPricebookMaterials,
  searchPricebookEquipment,
  searchPricebookDiscountsAndFees,
  createEstimate,
  getJobLaborSplits,
  getJobTimesheets,
  getJobGrossPayItems,
  getTechniciansMap,
  updateJobStatus,
  updateJobType,
  resolveJobTypeId,
  fetchAllJobTypes,
  getJobTypeNamesById,
  createJobAttachment,
  appendJobSummary,
  __demo,
};
