/**
 * src/demo/axiosAdapter.js
 *
 * The demo-mode network seam for everything that *doesn't* go through
 * `src/api/servicetitan.js`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `src/api/servicetitan.js` is the clean seam: it dispatches to the live client
 * or to `servicetitan.mock.js`, and roughly forty routes and services never
 * know the difference. But this codebase grew the way real codebases grow, and
 * eight or nine call sites reach past that seam and hit ServiceTitan (and
 * Google, and GoHighLevel) with raw `axios` — usually because they needed one
 * query parameter the shared client didn't expose:
 *
 *   src/services/installTrackerService.js   GET  /jpm/v2/.../jobs  (completedOnOrAfter)
 *   src/services/backflowReportService.js   GET  /jpm/v2/.../job-types, /jobs
 *   src/services/happyReviewService.js      GET  /forms/v2/.../submissions
 *                                           POST GHL inbound webhook
 *   src/services/callPollService.js         GET  /telecom/v2/.../calls
 *   src/services/fanClubService.js          GET  /memberships/v2/.../memberships[/{id}]
 *   src/routes/fanclubs.js                  GET  /memberships/v2/.../recurring-services,
 *                                                /membership-types
 *                                           POST GHL inbound webhook
 *   src/services/addressAuditService.js     GET  /crm/v2/.../locations[/{id}], /customers/{id}
 *                                           PATCH/PUT the same
 *                                           GET  maps.googleapis.com geocode
 *
 * Those call sites are part of the codebase's character — the retry/backoff in
 * backflowReportService and the cursor handling in happyReviewService are worth
 * reading. Rewriting nine services to route through a mock would erase them and
 * would be a much larger, riskier diff than intercepting one HTTP client.
 *
 * So instead of editing the services, demo mode swaps axios' *adapter*: the
 * bottom-most layer, below interceptors, where axios turns a config into a
 * response. Every call site keeps its URL, its params, its retry logic and its
 * error handling; the bytes just come from `world.js` instead of a socket.
 *
 * DESIGN RULES
 * ------------
 * 1. Shapes are ServiceTitan's, not ours. Collection endpoints return the list
 *    envelope `{ page, pageSize, totalCount, hasMore, data: [...] }`, because
 *    every one of these callers page-walks on `res.data.hasMore` and reads
 *    `res.data.data`. A bare array here shows up as an empty page, not an error.
 * 2. Query parameters are honoured. Date ranges, jobTypeIds, jobStatus,
 *    statuses, formIds, modifiedOnOrAfter and pagination all filter, so a
 *    date-bounded report returns a date-bounded subset.
 * 3. Deterministic. Everything derives from ./rng.js — no Math.random().
 * 4. Anything unmatched throws by URL. A missed path must be loud.
 *
 * The outbound network guard in ./runtime.js stays installed underneath this:
 * it catches anything that isn't axios at all (a stray `https.get`, a vendor
 * SDK), and it is the backstop if this adapter is ever bypassed.
 */

const axios = require("axios");
const { getWorld } = require("./world");
const { Rng, ROOT_SEED, hashString } = require("./rng");
const C = require("./catalog");

const HAPPY_REVIEW_FORM_ID = 1406;

// ---------------------------------------------------------------------------
// Demo credentials
// ---------------------------------------------------------------------------

/**
 * Several of the raw-axios call sites interpolate credentials straight into
 * their URLs (`/tenant/${process.env.ST_TENANT_ID}/jobs`) or refuse to run at
 * all without one (`addressAuditService.geocode` throws `NO_KEY`, and
 * `/api/address/audit` returns 503 before it ever calls the service). With no
 * .env present those pages render an error that has nothing to do with the
 * demo.
 *
 * So demo mode fills in obviously-fake placeholders. They are never sent
 * anywhere: this adapter answers every request that would use them. Real values
 * already in the environment are left alone.
 */
const DEMO_ENV_DEFAULTS = {
  ST_TENANT_ID: "999999",
  ST_APP_KEY: "demo-app-key-not-a-real-credential",
  ST_CLIENT_ID: "demo-client-id",
  ST_CLIENT_SECRET: "demo-client-secret",
  GOOGLE_MAPS_API_KEY: "demo-maps-key-not-a-real-credential",
  GHL_HAPPY_REVIEW_WEBHOOK_URL: "https://services.leadconnectorhq.com/hooks/demo/happy-review",
  GHL_MEMBERSHIP_WEBHOOK_URL: "https://services.leadconnectorhq.com/hooks/demo/membership",
};

function applyDemoEnvDefaults() {
  const filled = [];
  for (const [key, value] of Object.entries(DEMO_ENV_DEFAULTS)) {
    if (!process.env[key]) {
      process.env[key] = value;
      filled.push(key);
    }
  }
  return filled;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** ServiceTitan's standard list envelope. Identical to servicetitan.mock's. */
function envelope(rows, { page = 1, pageSize = 50 } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Number(pageSize) || 50);
  const start = (p - 1) * size;
  return {
    page: p,
    pageSize: size,
    totalCount: rows.length,
    hasMore: start + size < rows.length,
    data: rows.slice(start, start + size),
  };
}

/** Strip the world generator's private `_`-prefixed bookkeeping fields. */
function clean(obj) {
  if (obj == null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(clean);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("_")) continue;
    out[k] = v;
  }
  return out;
}

const cleanAll = (rows) => (rows || []).map(clean);

const ms = (v) => {
  if (!v) return NaN;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? NaN : t;
};

/**
 * ServiceTitan's range convention: `...OnOrAfter` is inclusive, `...Before` is
 * exclusive. Both filters are skipped when the parameter is absent, which is
 * what lets a caller pass only one end of a range.
 */
function withinRange(value, onOrAfter, before) {
  const t = ms(value);
  if (Number.isNaN(t)) return !onOrAfter && !before;
  if (onOrAfter && t < ms(onOrAfter)) return false;
  if (before && t >= ms(before)) return false;
  return true;
}

/** Comma-separated ST list params ("1232,1227") -> Set of trimmed strings. */
function idSet(param) {
  if (param == null || param === "") return null;
  const list = Array.isArray(param) ? param : String(param).split(",");
  const set = new Set(list.map((s) => String(s).trim()).filter(Boolean));
  return set.size ? set : null;
}

function lowerSet(param) {
  const set = idSet(param);
  if (!set) return null;
  return new Set([...set].map((s) => s.toLowerCase()));
}

const truthy = (v) => v === true || /^(true|1|yes)$/i.test(String(v ?? ""));

/** Seconds -> "HH:MM:SS", the shape ST's telecom API returns durations in. */
function hhmmss(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

// ---------------------------------------------------------------------------
// Derived data — built once per world, rebuilt after POST /api/demo/reset
// ---------------------------------------------------------------------------

let _derived = null;

function derived() {
  const world = getWorld();
  if (_derived && _derived.world === world) return _derived;
  _derived = buildDerived(world);
  return _derived;
}

function buildDerived(world) {
  return {
    world,
    submissions: buildFormSubmissions(world),
    memberships: buildMembershipViews(world),
    geo: buildGeoIndex(world),
  };
}

// ── Membership types ────────────────────────────────────────────────────────
// The world only issues one plan (7001, written by world.js), but the office
// picks from the full catalogue when granting a complimentary membership, so
// /membership-types has to return the whole list. 7001 is first and matches the
// world's `membershipTypeName` exactly.
const MEMBERSHIP_TYPES = [
  { id: 7001, name: "Ground Club - Annual", duration: 12, durationUnit: "Month", price: 228, active: true },
  { id: 7002, name: "Ground Club - Two System", duration: 12, durationUnit: "Month", price: 348, active: true },
  { id: 7003, name: "Ground Club - Three System", duration: 12, durationUnit: "Month", price: 468, active: true },
  { id: 7004, name: "Ground Club - Monthly", duration: 1, durationUnit: "Month", price: 21, active: true },
  { id: 7005, name: "Plumbing Protection Plan", duration: 12, durationUnit: "Month", price: 149, active: true },
  { id: 7006, name: "Water Heater Flush Plan", duration: 12, durationUnit: "Month", price: 89, active: true },
  { id: 7007, name: "Ground Club - Commercial", duration: 12, durationUnit: "Month", price: 640, active: true },
  { id: 7008, name: "Legacy PSM - Do Not Renew", duration: 12, durationUnit: "Month", price: 179, active: false },
];

const MEMBERSHIP_TYPE_BY_ID = new Map(MEMBERSHIP_TYPES.map((t) => [String(t.id), t]));

/**
 * Memberships as the *REST* endpoint returns them, which is richer than the
 * bare world record: fanClubService reads `customerName` / `customer.name`,
 * `membershipType.name` and `duration` off the list response and only falls
 * back to a per-customer lookup when they're missing.
 */
function buildMembershipViews(world) {
  return world.memberships.map((m) => {
    const cust = world.index.customerById.get(String(m.customerId)) || null;
    const type = MEMBERSHIP_TYPE_BY_ID.get(String(m.membershipTypeId)) || MEMBERSHIP_TYPES[0];
    return {
      id: m.id,
      active: String(m.status).toLowerCase() === "active",
      customerId: m.customerId,
      customerName: cust ? cust.name : null,
      customer: cust ? { id: cust.id, name: cust.name } : null,
      locationIds: m.locationIds || [],
      status: m.status,
      from: m.from,
      to: m.to,
      duration: type.duration,
      durationUnit: type.durationUnit,
      billingFrequency: "OneTime",
      membershipTypeId: m.membershipTypeId,
      membershipTypeName: m.membershipTypeName || type.name,
      membershipType: { id: type.id, name: type.name },
      type: { id: type.id, name: type.name },
      businessUnitId: m.businessUnitId,
      createdOn: m.from,
      modifiedOn: m.from,
    };
  });
}

// ── Happy Review form submissions ───────────────────────────────────────────
/**
 * ServiceTitan form 1406 is the "Happy Review" survey a technician fills out on
 * the way out of a job that went well. happyReviewService reads it positionally
 * — `units[0..4]` are Customer Name / Job ID / Email / Phone / Technician — and
 * then re-resolves everything off the job number, so these have to point at
 * real jobs in the world or the enrichment step comes back empty.
 *
 * The tech types the name and their own name by hand, so a slice of them arrive
 * in ALL CAPS; that's exactly the input `toTitleCase` exists to fix, and it is
 * worth exercising in the demo.
 */
function buildFormSubmissions(world) {
  const rng = new Rng(ROOT_SEED).fork("form-submissions");
  const now = world.now instanceof Date ? world.now : new Date(world.builtAt);
  const windowStart = now.getTime() - 120 * 86400000;

  const eligible = world.jobs.filter((j) => {
    if (j.jobStatus !== "Completed" || !j.completedOn) return false;
    const t = ms(j.completedOn);
    return t >= windowStart && t <= now.getTime();
  });

  const submissions = [];
  let id = 1400000;

  for (const job of eligible) {
    // Roughly one job in six gets a survey — techs are good about it, not perfect.
    if (!rng.chance(0.17)) continue;
    const cust = world.index.customerById.get(String(job.customerId));
    if (!cust) continue;
    const tech = world.index.technicianById.get(String(job.leadTechnicianId));
    if (!tech) continue;

    const submittedOn = new Date(ms(job.completedOn) + rng.int(20, 340) * 60000).toISOString();
    const shouty = rng.chance(0.28);
    const contacts = world.index.contactsByCustomer.get(String(cust.id)) || [];
    const phone = (contacts.find((c) => /phone/i.test(c.type)) || {}).value || cust._primaryPhone || "";

    submissions.push({
      id: id++,
      formId: HAPPY_REVIEW_FORM_ID,
      formName: "Happy Review",
      name: "Happy Review",
      status: "Completed",
      createdOn: submittedOn,
      submittedOn,
      modifiedOn: submittedOn,
      submittedBy: { id: tech.id, name: tech.name },
      customerName: cust.name,
      customer: { id: cust.id, name: cust.name },
      // ST attaches a submission to whatever it was filled out from. The job
      // owner is what matters; the customer owner is what happyReviewService
      // falls back to when the job lookup misses.
      owners: [
        { type: "Customer", id: cust.id },
        { type: "Job", id: job.id },
        { type: "Location", id: job.locationId },
      ],
      units: [
        { id: id * 10 + 0, name: "Customer Name", type: "Text", value: shouty ? cust.name.toUpperCase() : cust.name },
        { id: id * 10 + 1, name: "Job ID", type: "Text", value: String(job.jobNumber) },
        { id: id * 10 + 2, name: "Email", type: "Text", value: cust.email || "" },
        { id: id * 10 + 3, name: "Phone", type: "Text", value: phone },
        { id: id * 10 + 4, name: "Technician", type: "Text", value: shouty ? tech.name.toUpperCase() : tech.name },
      ],
    });
  }

  // Ascending by time: previewLatestSubmission takes the LAST element as "most
  // recent", and the poll cursor walks forward.
  submissions.sort((a, b) => ms(a.submittedOn) - ms(b.submittedOn));
  return submissions;
}

// ---------------------------------------------------------------------------
// Google Geocoding
// ---------------------------------------------------------------------------

/**
 * The Address Audit page exists to find bad addresses, so a geocoder that says
 * "looks great" to everything makes the page pointless — and one that says
 * "looks broken" to everything makes it noise. The world plants the defects on
 * purpose (`world.customers[]._messyAddress`, ~9%, plus the same odds on
 * secondary locations), and this mock has to agree with them.
 *
 * `makeAddress(rng, { messy: true })` in world.js corrupts an address in one of
 * four ways, and each one deserves a different verdict from Google:
 *
 *   kind 0  suffix spelled out ("Maple Street")   -> OK + partial_match   -> "partial"
 *   kind 1  bogus directional inserted            -> ZERO_RESULTS         -> "no-match"
 *   kind 2  ZIP off by 1-3 from the real one      -> OK, ZIP corrected    -> "standardized"
 *   kind 3  street SHOUTED IN ALL CAPS            -> OK, GEOMETRIC_CENTER -> "undeliverable"
 *
 * Clean addresses come back ROOFTOP, no partial match, components identical to
 * ST's — which `classify()` scores as "ok".
 *
 * One wrinkle: kind 0 only rewrites the suffixes St/Rd/Dr, so on a "Pl" or
 * "Ave" address it corrupts nothing and the record is flagged messy while
 * looking pristine. `_messyAddress` is still the gate (it is what the world
 * says is wrong, and it is what keeps the issue rate near the documented ~9%),
 * so those fall through to the kind-0 branch and come back as a soft
 * partial_match — which is exactly what Google's partial_match means: matched
 * something, not confident it's what you asked for.
 */

const CITY_ZIP = new Map(C.CITIES.map((c) => [c.name.toLowerCase(), c.zip]));

// Long form -> USPS abbreviation, for handing back the standardized street.
const SUFFIX_ABBR = {
  street: "St", avenue: "Ave", road: "Rd", drive: "Dr", lane: "Ln",
  court: "Ct", boulevard: "Blvd", place: "Pl", terrace: "Ter", trail: "Trl",
};

/** Mirror of addressAuditService.fmtAddr — the exact string `geocode()` sends. */
function fmtAddrLike(a = {}) {
  return [
    [a.street, a.unit].filter(Boolean).join(" "),
    a.city,
    [a.state, a.zip].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");
}

const normKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Which of the four corruptions (if any) is present, judged from the address
 * itself. Used directly for secondary locations — world.js records the messy
 * flag on the customer, not on every location it generated — and to pick the
 * flavour of failure for addresses the flag already marked as messy.
 */
function detectMessyKind(addr = {}) {
  const street = String(addr.street || "");
  const canonicalZip = CITY_ZIP.get(String(addr.city || "").toLowerCase());
  if (canonicalZip && String(addr.zip || "") !== canonicalZip) return 2;
  if (/^\d+\s+[NSEW]\s+/.test(street)) return 1;
  if (/[A-Z]{2,}/.test(street) && street === street.toUpperCase()) return 3;
  if (/\b(Street|Road|Drive|Avenue|Boulevard)\b/i.test(street)) return 0;
  return null;
}

function buildGeoIndex(world) {
  const byQuery = new Map();

  const record = (address, messyFlag) => {
    if (!address) return;
    const key = normKey(fmtAddrLike(address));
    if (byQuery.has(key)) return;
    const kind = detectMessyKind(address);
    const messy = messyFlag == null ? kind !== null : !!messyFlag;
    byQuery.set(key, { address, messy, kind: messy ? (kind == null ? 0 : kind) : null });
  };

  // The customer record is the one that carries the planted-defect flag.
  for (const cust of world.customers) record(cust.address, cust._messyAddress);
  // Secondary locations were generated with the same odds but no flag, so they
  // are classified structurally.
  for (const loc of world.locations) record(loc.address, null);

  return { byQuery };
}

/** Parse the "street unit, city, ST zip" string back into address fields. */
function parseFormattedQuery(query) {
  const parts = String(query || "").split(",").map((s) => s.trim()).filter(Boolean);
  const tail = parts.length ? parts[parts.length - 1] : "";
  const m = tail.match(/^([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/);
  return {
    street: parts[0] || "",
    city: parts.length >= 3 ? parts[parts.length - 2] : "",
    state: m ? m[1].toUpperCase() : "",
    zip: m ? m[2] : "",
  };
}

/** Deterministic city centre in the central-Ohio band the world is set in. */
function cityCenter(cityName) {
  const r = new Rng(hashString(`geo-city:${String(cityName || "").toLowerCase()}`));
  return { lat: 39.96 + r.money(-0.42, 0.42, 6), lng: -82.99 + r.money(-0.52, 0.52, 6) };
}

function coordsFor(addr) {
  const centre = cityCenter(addr.city);
  const r = new Rng(hashString(`geo-point:${normKey(fmtAddrLike(addr))}`));
  return {
    lat: Math.round((centre.lat + r.money(-0.035, 0.035, 6)) * 1e7) / 1e7,
    lng: Math.round((centre.lng + r.money(-0.045, 0.045, 6)) * 1e7) / 1e7,
  };
}

function placeIdFor(addr) {
  const h = hashString(`place:${normKey(fmtAddrLike(addr))}`);
  return `ChIJ${h.toString(36).padStart(7, "0")}Demo${(h >>> 3).toString(36)}`;
}

function titleCaseWords(s) {
  return String(s || "").replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

/** "1234 Maple Street" -> "1234 Maple St" */
function abbreviateSuffix(street) {
  return String(street || "").replace(/\s(\w+)$/, (whole, last) => {
    const abbr = SUFFIX_ABBR[last.toLowerCase()];
    return abbr ? ` ${abbr}` : whole;
  });
}

function splitStreet(street) {
  const m = String(street || "").trim().match(/^(\d+[A-Za-z]?)\s+(.*)$/);
  return m ? { number: m[1], route: m[2] } : { number: "", route: String(street || "").trim() };
}

function addressComponents(addr) {
  const { number, route } = splitStreet(addr.street);
  const out = [];
  if (number) out.push({ long_name: number, short_name: number, types: ["street_number"] });
  if (route) out.push({ long_name: route, short_name: route, types: ["route"] });
  if (addr.unit) {
    const bare = String(addr.unit).replace(/^(apt|unit|ste|suite|#)\s*/i, "");
    out.push({ long_name: bare, short_name: bare, types: ["subpremise"] });
  }
  out.push({ long_name: addr.city, short_name: addr.city, types: ["locality", "political"] });
  out.push({ long_name: "Franklin County", short_name: "Franklin County", types: ["administrative_area_level_2", "political"] });
  out.push({ long_name: "Ohio", short_name: addr.state || "OH", types: ["administrative_area_level_1", "political"] });
  out.push({ long_name: "United States", short_name: "US", types: ["country", "political"] });
  out.push({ long_name: addr.zip, short_name: addr.zip, types: ["postal_code"] });
  return out;
}

function geocodeResult(addr, { locationType = "ROOFTOP", partialMatch = false } = {}) {
  const { lat, lng } = coordsFor(addr);
  const formatted =
    `${[addr.street, addr.unit].filter(Boolean).join(" ")}, ${addr.city}, ${addr.state} ${addr.zip}, USA`;
  const result = {
    address_components: addressComponents(addr),
    formatted_address: formatted,
    geometry: {
      location: { lat, lng },
      location_type: locationType,
      viewport: {
        northeast: { lat: lat + 0.0007, lng: lng + 0.0009 },
        southwest: { lat: lat - 0.0007, lng: lng - 0.0009 },
      },
    },
    place_id: placeIdFor(addr),
    types: addr.unit ? ["subpremise"] : ["street_address"],
  };
  // Google only emits partial_match when it is true.
  if (partialMatch) result.partial_match = true;
  return { results: [result], status: "OK" };
}

function handleGeocode(query) {
  const parsed = parseFormattedQuery(query.address);
  if (!parsed.street || !parsed.city) {
    return { results: [], status: "ZERO_RESULTS" };
  }

  const { byQuery } = derived().geo;
  const hit = byQuery.get(normKey(String(query.address || "")));
  const kind = hit ? hit.kind : detectMessyKind(parsed);
  const messy = hit ? hit.messy : kind !== null;

  // Prefer the world's *structured* address over the re-parsed query string:
  // fmtAddr() glues the unit onto the street ("294 Orchard Pl Unit 19B"), and
  // splitting that back apart by guesswork is how you end up handing Google's
  // answer back with the unit in it twice — which classify() then reads as a
  // street mismatch and reports as a bogus "standardized" correction.
  // No hit means an ad-hoc address from POST /api/address/verify; there the
  // parsed street is the best we have.
  const base = hit ? { ...hit.address } : { ...parsed, unit: "" };

  if (!messy) return geocodeResult(base, { locationType: "ROOFTOP" });

  switch (kind) {
    case 1:
      // The directional makes the address nonexistent — Google finds nothing.
      return { results: [], status: "ZERO_RESULTS" };
    case 2: {
      // ZIP is wrong. Google resolves the street and hands back the real ZIP,
      // which classify() scores as "standardized" — an actionable correction.
      const corrected = CITY_ZIP.get(base.city.toLowerCase()) || base.zip;
      return geocodeResult({ ...base, zip: corrected }, { locationType: "ROOFTOP" });
    }
    case 3:
      // ALL CAPS usually rides along with sloppier data entry; Google can place
      // the street but not the building.
      return geocodeResult(
        { ...base, street: titleCaseWords(base.street), city: titleCaseWords(base.city) },
        { locationType: "GEOMETRIC_CENTER" }
      );
    case 0:
    default:
      // Spelled-out suffix: Google matches, but flags it as approximate.
      return geocodeResult(
        { ...base, street: abbreviateSuffix(base.street) },
        { locationType: "RANGE_INTERPOLATED", partialMatch: true }
      );
  }
}

// ---------------------------------------------------------------------------
// ServiceTitan handlers
// ---------------------------------------------------------------------------

/** Shared mutation counter, so the demo banner counts writeback edits too. */
function recordMutation(kind, detail) {
  try {
    const st = require("./servicetitan.mock");
    if (st.__demo && st.__demo.mutations) {
      st.__demo.mutations.count++;
      st.__demo.mutations.log.push({ at: new Date().toISOString(), kind, detail });
      if (st.__demo.mutations.log.length > 500) st.__demo.mutations.log.shift();
    }
  } catch (_) {
    /* counting is cosmetic — never fail a request over it */
  }
}

function stJobs(q) {
  const w = getWorld();
  let rows = w.jobs;

  const types = idSet(q.jobTypeIds);
  if (types) rows = rows.filter((j) => types.has(String(j.jobTypeId)));

  const statuses = lowerSet(q.jobStatus || q.jobStatuses);
  if (statuses) rows = rows.filter((j) => statuses.has(String(j.jobStatus).toLowerCase()));

  const ids = idSet(q.ids);
  if (ids) rows = rows.filter((j) => ids.has(String(j.id)));

  if (q.customerId) rows = rows.filter((j) => String(j.customerId) === String(q.customerId));
  if (q.locationId) rows = rows.filter((j) => String(j.locationId) === String(q.locationId));

  if (q.completedOnOrAfter || q.completedBefore) {
    rows = rows.filter((j) => j.completedOn && withinRange(j.completedOn, q.completedOnOrAfter, q.completedBefore));
  }
  if (q.createdOnOrAfter || q.createdBefore) {
    rows = rows.filter((j) => withinRange(j.createdOn, q.createdOnOrAfter, q.createdBefore));
  }
  if (q.modifiedOnOrAfter || q.modifiedBefore) {
    rows = rows.filter((j) => withinRange(j.modifiedOn, q.modifiedOnOrAfter, q.modifiedBefore));
  }

  return envelope(cleanAll(rows).map(stJobShape), q);
}

/** The job fields these callers read, in ST's own naming. */
function stJobShape(j) {
  return {
    ...j,
    type: { id: j.jobTypeId, name: j.jobTypeName },
    jobType: { id: j.jobTypeId, name: j.jobTypeName },
    businessUnit: { id: j.businessUnitId, name: j.businessUnitName },
  };
}

function stJobTypes(q) {
  const w = getWorld();
  let rows = w.jobTypes;
  if (q.active !== undefined && q.active !== "Any") {
    const want = truthy(q.active);
    rows = rows.filter((t) => !!t.active === want);
  }
  const rowsOut = rows.map((t) => ({
    id: t.id,
    name: t.name,
    businessUnitIds: [t.bu],
    skillsRequired: [],
    tagTypeIds: [],
    priority: "Normal",
    duration: Math.round((t.hours || 1) * 3600),
    class: t.category === "Install" ? "Installation" : "Service",
    summary: null,
    noCharge: !!t.noCharge,
    active: t.active !== false,
    externalData: null,
  }));
  return envelope(rowsOut, q);
}

function stLocations(q) {
  const w = getWorld();
  let rows = w.locations;

  if (q.active !== undefined && q.active !== "Any") {
    const want = truthy(q.active);
    rows = rows.filter((l) => (l.active !== false) === want);
  }
  const ids = idSet(q.ids);
  if (ids) rows = rows.filter((l) => ids.has(String(l.id)));
  if (q.customerId) rows = rows.filter((l) => String(l.customerId) === String(q.customerId));
  if (q.modifiedOnOrAfter || q.modifiedBefore) {
    rows = rows.filter((l) => withinRange(l.modifiedOn || l.createdOn, q.modifiedOnOrAfter, q.modifiedBefore));
  }

  return envelope(
    cleanAll(rows).map((l) => ({ ...l, modifiedOn: l.modifiedOn || l.createdOn })),
    q
  );
}

function stCalls(q) {
  const w = getWorld();
  let rows = w.calls;

  if (q.createdOnOrAfter || q.createdBefore) {
    rows = rows.filter((c) => withinRange(c.receivedOn, q.createdOnOrAfter, q.createdBefore));
  }
  if (q.active !== undefined && q.active !== "Any") {
    // Every generated call has already ended, so `active: false` matches all of
    // them and `active: true` matches none — which is what the poller expects.
    if (truthy(q.active)) rows = [];
  }

  const rowsOut = rows.map((c) => ({
    id: c.id,
    receivedOn: c.receivedOn,
    createdOn: c.createdOn,
    active: false,
    duration: hhmmss(c.duration),
    from: c.from,
    to: c.to,
    direction: c.direction,
    callType: c.callType,
    reason: c.reason,
    agent: c.agent,
    customer: c.customerId ? { id: c.customerId, name: c.customerName } : null,
    recordingUrl: c.recordingUrl,
  }));

  return envelope(rowsOut, { page: q.page, pageSize: q.pageSize || 100 });
}

function stFormSubmissions(q) {
  let rows = derived().submissions;

  const forms = idSet(q.formIds || q.formId);
  if (forms) rows = rows.filter((s) => forms.has(String(s.formId)));
  const statuses = lowerSet(q.status);
  if (statuses) rows = rows.filter((s) => statuses.has(String(s.status).toLowerCase()));
  if (q.submittedOnOrAfter || q.submittedBefore) {
    rows = rows.filter((s) => withinRange(s.submittedOn, q.submittedOnOrAfter, q.submittedBefore));
  }
  if (q.createdOnOrAfter || q.createdBefore) {
    rows = rows.filter((s) => withinRange(s.createdOn, q.createdOnOrAfter, q.createdBefore));
  }

  return envelope(rows, q);
}

function stMemberships(q) {
  let rows = derived().memberships;

  const statuses = lowerSet(q.statuses || q.status);
  if (statuses) rows = rows.filter((m) => statuses.has(String(m.status).toLowerCase()));
  const ids = idSet(q.ids);
  if (ids) rows = rows.filter((m) => ids.has(String(m.id)));
  const custIds = idSet(q.customerIds || q.customerId);
  if (custIds) rows = rows.filter((m) => custIds.has(String(m.customerId)));

  return envelope(rows, q);
}

function stRecurringServices(q, membershipId) {
  const w = getWorld();
  const wanted = membershipId != null ? String(membershipId) : q.membershipId != null ? String(q.membershipId) : null;
  let rows = w.recurringServices;
  if (wanted) rows = rows.filter((r) => String(r.membershipId) === wanted);

  const rowsOut = cleanAll(rows).map((r) => ({
    ...r,
    active: true,
    importId: null,
    membershipName: "Ground Club - Annual",
    recurrenceType: "Monthly",
    recurrenceIntervalType: "Month",
    durationType: "Month",
  }));
  return envelope(rowsOut, q);
}

function stMembershipTypes(q) {
  let rows = MEMBERSHIP_TYPES;
  if (q.active !== undefined && q.active !== "Any") {
    const want = truthy(q.active);
    rows = rows.filter((t) => t.active === want);
  }
  return envelope(
    rows.map((t) => ({ ...t, status: t.active ? "Active" : "Inactive", billingTemplateId: null, discountMode: "Percentage" })),
    { page: q.page, pageSize: q.pageSize || 100 }
  );
}

// ── Writebacks (Address Audit "Apply") ──────────────────────────────────────

function patchLocation(locationId, body) {
  const w = getWorld();
  const loc = w.index.locationById.get(String(locationId));
  if (!loc) return notFound(`Location ${locationId} not found`);
  if (body && body.address) loc.address = { ...loc.address, ...body.address };
  if (body && typeof body.name === "string" && body.name.trim()) loc.name = body.name.trim();
  loc.modifiedOn = new Date().toISOString();
  recordMutation("location.update", { locationId, fields: Object.keys(body || {}) });
  return clean(loc);
}

function patchCustomer(customerId, body) {
  const w = getWorld();
  const cust = w.index.customerById.get(String(customerId));
  if (!cust) return notFound(`Customer ${customerId} not found`);
  if (body && body.type) cust.type = body.type;
  recordMutation("customer.update", { customerId, fields: Object.keys(body || {}) });
  return clean(cust);
}

/** Sentinel returned by handlers that want a 404 instead of a body. */
function notFound(message) {
  const marker = { __demoStatus: 404, data: { type: "not-found", title: "Not Found", status: 404, detail: message } };
  return marker;
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------
//
// Matched in order. `path` is a RegExp against the URL pathname; the tenant
// segment is deliberately `[^/]+` because in demo mode ST_TENANT_ID is a
// placeholder (and if it were ever unset the URL would read ".../tenant/undefined").

const TENANT = "[^/]+";

const ROUTES = [
  // ── Auth ────────────────────────────────────────────────────────────────
  {
    host: /^auth\.servicetitan\.io$/,
    method: "POST",
    path: /^\/connect\/token$/,
    handler: () => ({
      access_token: "demo-access-token-not-a-real-credential",
      expires_in: 900,
      token_type: "Bearer",
      scope: "tn.jpm:r tn.crm:r tn.crm:w tn.memberships:r tn.forms:r tn.telecom:r",
    }),
  },

  // ── JPM: jobs + job types ───────────────────────────────────────────────
  // installTrackerService, backflowReportService
  {
    method: "GET",
    path: new RegExp(`^/jpm/v2/tenant/${TENANT}/jobs/(\\d+)$`),
    handler: (ctx) => {
      const job = getWorld().index.jobById.get(ctx.params[0]);
      return job ? stJobShape(clean(job)) : notFound(`Job ${ctx.params[0]} not found`);
    },
  },
  { method: "GET", path: new RegExp(`^/jpm/v2/tenant/${TENANT}/jobs/?$`), handler: (ctx) => stJobs(ctx.query) },
  { method: "GET", path: new RegExp(`^/jpm/v2/tenant/${TENANT}/job-types/?$`), handler: (ctx) => stJobTypes(ctx.query) },
  { method: "GET", path: new RegExp(`^/settings/v2/tenant/${TENANT}/job-types/?$`), handler: (ctx) => stJobTypes(ctx.query) },

  // ── CRM: locations + customers ──────────────────────────────────────────
  // addressAuditService (read + writeback)
  {
    method: "GET",
    path: new RegExp(`^/crm/v2/tenant/${TENANT}/locations/(\\d+)$`),
    handler: (ctx) => {
      const loc = getWorld().index.locationById.get(ctx.params[0]);
      return loc ? clean(loc) : notFound(`Location ${ctx.params[0]} not found`);
    },
  },
  {
    method: /^(PATCH|PUT)$/,
    path: new RegExp(`^/crm/v2/tenant/${TENANT}/locations/(\\d+)$`),
    handler: (ctx) => patchLocation(ctx.params[0], ctx.body),
  },
  { method: "GET", path: new RegExp(`^/crm/v2/tenant/${TENANT}/locations/?$`), handler: (ctx) => stLocations(ctx.query) },
  {
    method: "GET",
    path: new RegExp(`^/crm/v2/tenant/${TENANT}/customers/(\\d+)$`),
    handler: (ctx) => {
      const cust = getWorld().index.customerById.get(ctx.params[0]);
      return cust ? clean(cust) : notFound(`Customer ${ctx.params[0]} not found`);
    },
  },
  {
    method: /^(PATCH|PUT)$/,
    path: new RegExp(`^/crm/v2/tenant/${TENANT}/customers/(\\d+)$`),
    handler: (ctx) => patchCustomer(ctx.params[0], ctx.body),
  },

  // ── Forms ───────────────────────────────────────────────────────────────
  // happyReviewService + formsPollService
  { method: "GET", path: new RegExp(`^/forms/v2/tenant/${TENANT}/submissions/?$`), handler: (ctx) => stFormSubmissions(ctx.query) },

  // ── Telecom ─────────────────────────────────────────────────────────────
  // callPollService (idle in demo mode, but the path has to exist)
  { method: "GET", path: new RegExp(`^/telecom/v2/tenant/${TENANT}/calls/?$`), handler: (ctx) => stCalls(ctx.query) },

  // ── Memberships ─────────────────────────────────────────────────────────
  // fanClubService + routes/fanclubs. The nested recurring-services path must
  // come before the bare /memberships/{id} rule.
  {
    method: "GET",
    path: new RegExp(`^/memberships/v2/tenant/${TENANT}/memberships/(\\d+)/recurring-services/?$`),
    handler: (ctx) => stRecurringServices(ctx.query, ctx.params[0]),
  },
  {
    method: "GET",
    path: new RegExp(`^/memberships/v2/tenant/${TENANT}/memberships/(\\d+)$`),
    handler: (ctx) => {
      const found = derived().memberships.find((m) => String(m.id) === ctx.params[0]);
      return found || notFound(`Membership ${ctx.params[0]} not found`);
    },
  },
  { method: "GET", path: new RegExp(`^/memberships/v2/tenant/${TENANT}/memberships/?$`), handler: (ctx) => stMemberships(ctx.query) },
  { method: "GET", path: new RegExp(`^/memberships/v2/tenant/${TENANT}/recurring-services/?$`), handler: (ctx) => stRecurringServices(ctx.query, null) },
  { method: "GET", path: new RegExp(`^/memberships/v2/tenant/${TENANT}/membership-types/?$`), handler: (ctx) => stMembershipTypes(ctx.query) },

  // ── Pricebook images ────────────────────────────────────────────────────
  // pricebookImageService and routes/pricebook build absolute image URLs. The
  // fetch normally goes through the mocked client, but if one is ever loaded
  // directly, hand back the same 1x1 PNG rather than reaching for the network.
  {
    method: "GET",
    host: /^api\.servicetitan\.io$/,
    path: /\.(png|jpe?g|gif|webp)$/i,
    handler: () => ({
      __demoRaw: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64"
      ),
      __demoContentType: "image/png",
    }),
  },

  // ── Google Geocoding ────────────────────────────────────────────────────
  {
    host: /^maps\.googleapis\.com$/,
    method: "GET",
    path: /^\/maps\/api\/geocode\/json$/,
    handler: (ctx) => handleGeocode(ctx.query),
  },

  // ── GoHighLevel inbound webhooks ────────────────────────────────────────
  // happyReviewService.processSubmission and /api/fanclubs/send-webhook POST a
  // flat payload to an inbound-webhook URL. GHL answers 200 with a tiny body;
  // the demo CRM in gohighlevel.mock.js is where the contact actually lands.
  {
    host: /(^|\.)leadconnectorhq\.com$|(^|\.)gohighlevel\.com$|(^|\.)msgsndr\.com$/,
    method: /^(POST|PUT)$/,
    path: /.*/,
    handler: (ctx) => {
      recordMutation("ghl.webhook", { path: ctx.pathname });
      return { status: "Success", id: `demo-webhook-${hashString(ctx.pathname).toString(36)}` };
    },
  },
];

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

function fullUrl(config) {
  const url = String(config.url || "");
  if (/^https?:\/\//i.test(url)) return url;
  const base = String(config.baseURL || "").replace(/\/+$/, "");
  if (!base) return url;
  return `${base}/${url.replace(/^\/+/, "")}`;
}

/** Merge the URL's own query string with axios' `params` object. */
function mergedQuery(parsed, config) {
  const query = {};
  for (const [k, v] of parsed.searchParams.entries()) query[k] = v;
  const p = config.params;
  if (p && typeof p === "object" && !(p instanceof URLSearchParams)) {
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined || v === null) continue;
      query[k] = v;
    }
  } else if (p instanceof URLSearchParams) {
    for (const [k, v] of p.entries()) query[k] = v;
  }
  return query;
}

function parseBody(config) {
  const d = config.data;
  if (d == null) return null;
  if (typeof d === "string") {
    try {
      return JSON.parse(d);
    } catch {
      return d;
    }
  }
  return d;
}

function matches(route, method, host, pathname) {
  if (route.host && !route.host.test(host)) return null;
  if (route.method) {
    const ok = route.method instanceof RegExp ? route.method.test(method) : route.method === method;
    if (!ok) return null;
  }
  const m = route.path.exec(pathname);
  return m ? m.slice(1) : null;
}

function buildResponse(config, { status = 200, data, headers = {} }) {
  return {
    data,
    status,
    statusText: status === 200 ? "OK" : String(status),
    headers: { "content-type": "application/json", ...headers },
    config,
    request: { __demo: true },
  };
}

function installAxiosAdapter() {
  // Must use the SAME mode resolution as everything else. This previously read
  // process.env.DEMO_MODE directly and required an exact "true", while
  // src/demo/mode.js treats demo as the default and only opts out on an
  // explicit "false". Any disagreement — DEMO_MODE unset, a stray space, odd
  // casing — turned demo mode on everywhere except here, so the nine services
  // that call vendors with raw axios sailed past the adapter and straight into
  // the outbound network guard. That surfaced as "blocked outbound https
  // request to api.servicetitan.io" on Install Tracker, Backflow and Reviews.
  // One source of truth, no divergence.
  if (!require("./mode").IS_DEMO) return;
  if (axios.defaults.adapter && axios.defaults.adapter.__isDemoAdapter) return;

  const filled = applyDemoEnvDefaults();
  const passthrough = axios.getAdapter(["http", "xhr", "fetch"]);

  const adapter = async function demoAdapter(config) {
    const method = String(config.method || "get").toUpperCase();
    const raw = fullUrl(config);

    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      // Relative URL with no baseURL — nothing external about it. Let axios do
      // whatever it would normally do (and fail the same way).
      return passthrough(config);
    }

    const host = parsed.hostname.toLowerCase();
    // The app talks to itself in a couple of places; those are not vendor calls.
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost")) {
      return passthrough(config);
    }

    const ctx = {
      method,
      url: raw,
      host,
      pathname: parsed.pathname,
      query: mergedQuery(parsed, config),
      body: parseBody(config),
      params: [],
    };

    for (const route of ROUTES) {
      const params = matches(route, method, host, parsed.pathname);
      if (!params) continue;
      ctx.params = params;

      const result = await route.handler(ctx);

      // A handler asking for a 404 (missing job/customer/location). Callers
      // branch on err.response.status, so this has to arrive as a rejection.
      if (result && result.__demoStatus) {
        throw new axios.AxiosError(
          `Request failed with status code ${result.__demoStatus}`,
          axios.AxiosError.ERR_BAD_REQUEST,
          config,
          { __demo: true },
          buildResponse(config, { status: result.__demoStatus, data: result.data })
        );
      }

      if (result && result.__demoRaw) {
        return buildResponse(config, {
          data: result.__demoRaw,
          headers: { "content-type": result.__demoContentType || "application/octet-stream" },
        });
      }

      return buildResponse(config, { data: result });
    }

    // Requirement: a missed path must be loud and specific, not a silent empty
    // page or a mysterious timeout against a real vendor.
    throw new Error(
      `[demo] no mock for ${method} ${raw} — src/demo/axiosAdapter.js intercepts vendor HTTP in demo mode, ` +
        `and this URL matched none of its ${ROUTES.length} routes. Add a route there (or route the call ` +
        `through src/api/servicetitan.js, which is already mocked).`
    );
  };

  adapter.__isDemoAdapter = true;
  axios.defaults.adapter = adapter;

  console.log(
    `[demo] axios adapter active — vendor HTTP served from the generated world (${ROUTES.length} routes)` +
      (filled.length ? `; placeholder credentials set for ${filled.join(", ")}` : "")
  );
}

module.exports = {
  installAxiosAdapter,
  applyDemoEnvDefaults,
  // exported for tests / inspection
  __routes: ROUTES,
  __handleGeocode: handleGeocode,
  __buildFormSubmissions: buildFormSubmissions,
};
