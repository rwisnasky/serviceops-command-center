/**
 * services/addressAuditService.js
 * ────────────────────────────────────────────────────────────────────────────
 * Address verification & bulk audit for ServiceTitan locations.
 *
 *  - listSTLocations({ page, pageSize, modifiedOnOrAfter })
 *      Walks /crm/v2/tenant/{tenant}/locations and returns ST locations as-is
 *      (no enrichment). Pagination is exposed through the ST `page`/`pageSize`
 *      params; ST returns hasMore so the caller can drive the next page.
 *
 *  - geocode(addressLike)
 *      Single Google Geocoding API lookup. Returns a normalized result
 *      regardless of provider so a future swap to Smarty/USPS stays local
 *      to this file.
 *
 *  - auditLocations({ page, pageSize, modifiedOnOrAfter })
 *      Pulls one page of ST locations and runs each through geocode().
 *      Classifies every row with a status the UI can sort and color on:
 *
 *          'ok'             original matches verified, ROOFTOP-precision
 *          'standardized'   verified differs from ST (capitalization, suffix,
 *                           zip+4, etc.) — usually a clean win
 *          'partial'        Google flagged partial_match=true — the geocoder
 *                           had to guess; review before applying
 *          'undeliverable'  geocoder returned a low-precision location_type
 *                           (GEOMETRIC_CENTER / APPROXIMATE) — likely not a
 *                           real deliverable address
 *          'no-match'       ZERO_RESULTS — nothing came back
 *          'incomplete'     ST address is missing street/city/state/zip
 *          'error'          provider call threw (rate-limit, key invalid, etc.)
 *
 *  - applyCorrection({ locationId, address })
 *      PATCHes the ST location with the verified address. Falls back to PUT
 *      if PATCH 405s (same pattern as deactivateMaterial in api/servicetitan.js).
 *
 * Provider: Google Geocoding API. Single env var GOOGLE_MAPS_API_KEY.
 * Switch the GEO_PROVIDER block below to add Smarty/USPS later.
 * ────────────────────────────────────────────────────────────────────────────
 */

const axios = require("axios");
const { getAccessToken } = require("../api/servicetitan");
const {
  fingerprintAddress,
  getCachedMany,
  getCachedByLocationId,
  upsertCacheRow,
  markApplied,
} = require("../db/addressCacheRepository");
const { suggestName, titleCase, detectType } = require("./nameNormalizer");

// Apply the same title-case logic the name normalizer uses to each part of
// an address object. Google returns its `formatted_address` already nicely
// cased, but when we have to fall back to the auto-repaired ST data, the
// pieces are usually still ALL CAPS — this gives the CSR a clean preview.
function titleCaseAddress(a = {}) {
  if (!a) return a;
  return {
    street:  a.street  ? titleCase(a.street)  : "",
    unit:    a.unit    ? titleCase(a.unit)    : "",
    city:    a.city    ? titleCase(a.city)    : "",
    state:   String(a.state || "").toUpperCase(), // states stay upper
    zip:     a.zip || "",
    country: a.country || "USA",
  };
}

const ST_BASE = "https://api.servicetitan.io";
const GOOGLE_GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json";

// ── ST helpers ────────────────────────────────────────────────────────────────
async function stHeaders() {
  const token = await getAccessToken();
  return {
    Authorization: `Bearer ${token}`,
    "ST-App-Key": process.env.ST_APP_KEY,
  };
}

/**
 * List ST locations, one ST-page at a time. ST pageSize maxes at 200 for
 * /crm/v2 endpoints; we default to 50 to keep each round trip snappy and
 * leave headroom for the per-location geocode fan-out.
 */
async function listSTLocations({ page = 1, pageSize = 50, modifiedOnOrAfter, active = true } = {}) {
  const headers = await stHeaders();
  const params = {
    tenant: process.env.ST_TENANT_ID,
    page,
    pageSize,
    active,
  };
  if (modifiedOnOrAfter) params.modifiedOnOrAfter = modifiedOnOrAfter;
  const res = await axios.get(
    `${ST_BASE}/crm/v2/tenant/${process.env.ST_TENANT_ID}/locations`,
    { headers, params }
  );
  const data = res.data || {};
  return {
    rows: data.data || [],
    hasMore: !!data.hasMore,
    totalCount: data.totalCount ?? null,
    page,
    pageSize,
  };
}

// ── Address normalization helpers ─────────────────────────────────────────────
function fmtAddr(a = {}) {
  if (!a) return "";
  const parts = [
    [a.street, a.unit].filter(Boolean).join(" "),
    a.city,
    [a.state, a.zip].filter(Boolean).join(" "),
  ].filter(Boolean);
  return parts.join(", ");
}

// Common USPS abbreviations for street suffixes and directionals. The "same
// address?" comparison maps both sides through this table so we don't flag
// "North Oak Street" vs "N Oak St" as a real difference. Keys are the
// long forms (lowercased); values are the canonical short form we'll
// reduce both sides to before comparing.
const STREET_TOKEN_CANONICAL = {
  // Directionals
  north: "n", south: "s", east: "e", west: "w",
  northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
  // Common suffixes — USPS publication 28 abbreviations
  street: "st", str: "st",
  avenue: "ave", av: "ave",
  road: "rd",
  drive: "dr", driv: "dr",
  lane: "ln",
  boulevard: "blvd", boul: "blvd", boulv: "blvd",
  place: "pl",
  court: "ct", crt: "ct",
  circle: "cir", circ: "cir", crcle: "cir",
  highway: "hwy", hiway: "hwy", hway: "hwy",
  parkway: "pkwy", parkwy: "pkwy",
  trail: "trl", trails: "trl",
  terrace: "ter", terr: "ter",
  way: "way",
  plaza: "plz",
  square: "sq",
  expressway: "expy",
  freeway: "fwy",
  alley: "aly",
  bridge: "brg",
  crossing: "xing",
  junction: "jct",
  ridge: "rdg",
  // Apartment / unit qualifiers — strip into nothing so "apt 2" vs "#2" tie
  apartment: "apt",
  suite: "ste",
  building: "bldg",
  floor: "fl",
  unit: "unit",
  number: "#",
};

// Reduce a single token to its canonical short form (or itself if no match).
function canonicalToken(t) {
  const k = t.toLowerCase();
  return STREET_TOKEN_CANONICAL[k] || k;
}

// Loose normalization for fingerprinting and rough comparison only.
function normalizeForCompare(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Aggressive normalization used by the "same vs standardized" classifier.
// Lowercases, strips punctuation, collapses whitespace, then canonicalizes
// every token through STREET_TOKEN_CANONICAL so directionals and suffix
// abbreviations end up identical regardless of which side wrote them out.
function canonicalAddressString(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(canonicalToken)
    .join(" ");
}

function isIncomplete(a = {}) {
  return !a || !a.street || !a.city || !a.state || !a.zip;
}

// ── Address auto-repair ──────────────────────────────────────────────────────
// Fix obvious malformations BEFORE we hit Google. Common ST data-entry sins:
//
//   - "CEDAR HOLLOW OH" in the city field, state empty
//   - State field contains "OH 43065" (state + zip jammed together)
//   - Zip field is blank but the state field ends in 5 digits
//   - Street field has "UNIT 18", "APT 5", "Suite B", "#4" — designator
//     belongs in the dedicated Unit field
//
// The repaired version is what we send to Google. The cache still stores the
// ORIGINAL (unrepaired) address so the table shows what's actually in ST,
// and the user can decide whether to push the cleaned-up version back.
//
// Returns: { repaired, didRepair, repairs[] } — list of human-readable
// strings describing what was fixed, so the UI can show a hint.
function tryRepairAddress(addr = {}) {
  if (!addr) return { repaired: {}, didRepair: false, repairs: [] };
  const r = { ...addr };
  const repairs = [];

  // 1. City contains trailing 2-letter state code (no state set, or state
  //    obviously not a real US state). Examples: "CEDAR HOLLOW OH",
  //    "Northgate, OH", "FAIRVIEW CROSSING OH".
  if ((!r.state || r.state.length !== 2) && /[\s,]+[A-Z]{2}\s*$/i.test(String(r.city || ""))) {
    const m = String(r.city).match(/^(.+?)[\s,]+([A-Z]{2})\s*$/i);
    if (m) {
      r.city = m[1].trim().replace(/,\s*$/, "");
      r.state = m[2].toUpperCase();
      repairs.push("split state code out of city field");
    }
  }

  // 2. State field has zip stuck on the end ("OH 43065", "OH,43065").
  if (r.state && /\d{5}/.test(r.state)) {
    const m = String(r.state).match(/^([A-Z]{2})?[\s,]*(\d{5}(-\d{4})?)/i);
    if (m && m[2]) {
      if (m[1]) r.state = m[1].toUpperCase();
      if (!r.zip) r.zip = m[2];
      repairs.push("split zip out of state field");
    }
  }

  // 3. Zip is blank but city field ends with a 5-digit number. Rare but
  //    happens when someone types the whole address into the city.
  if (!r.zip && /\b\d{5}(-\d{4})?\s*$/.test(String(r.city || ""))) {
    const m = String(r.city).match(/^(.+?)[\s,]+(\d{5}(-\d{4})?)\s*$/);
    if (m) {
      r.city = m[1].trim().replace(/,\s*$/, "");
      r.zip = m[2];
      repairs.push("split zip out of city field");
    }
  }

  // 4. Unit designator in the street field. Handles the common patterns:
  //      "UNIT 18", "UNIT #1704", "APT 5", "APT #5",
  //      "SUITE B", "STE #B", "#4", "# 4"
  //    Two alternation arms inside the non-capturing group: a named
  //    designator optionally followed by "#", OR a bare "#". Either way the
  //    value is captured as the final group.
  if (!r.unit) {
    const m = String(r.street || "").match(
      /^(.+?)\s+(?:(?:unit|apt|apartment|suite|ste|bldg|building|fl|floor)\s*#?|#)\s*([\w-]+)\s*$/i
    );
    if (m) {
      r.street = m[1].trim();
      r.unit = m[2].trim();
      repairs.push("pulled unit designator out of street into Unit field");
    }
  }

  // 5. Collapse any leftover trailing commas / extra whitespace.
  for (const k of ["street", "unit", "city", "state", "zip"]) {
    if (typeof r[k] === "string") r[k] = r[k].replace(/\s+/g, " ").replace(/,\s*$/, "").trim();
  }

  return {
    repaired: r,
    didRepair: repairs.length > 0,
    repairs,
  };
}

// ── Multi-unit / data-quality hints ───────────────────────────────────────────
// Sniff the street field for patterns that suggest unit info is jammed into
// the address line rather than living in the dedicated Unit field. These hints
// are independent of Google — they fire even when the geocoder succeeds, so
// BRAMBLEWOOD-style rows (where Google could find SOMETHING but ST's data is
// structurally wrong) still get flagged for cleanup.
//
// Returns null if nothing suspicious, otherwise a short human-readable hint.
function detectStreetIssue(addr = {}) {
  const street = String(addr.street || "");
  if (!street) return null;

  // "601 & 601A" — two units glued with an ampersand
  if (/&/.test(street)) {
    return "multi-unit: street contains '&' — split into separate Locations or move designator to Unit field";
  }
  // "601 / 601A", "601 or 601A"
  if (/\s\/\s|\bor\b/i.test(street)) {
    return "multi-unit: street contains '/' or 'or' — split into separate Locations";
  }
  // "601-605 S Illinois" — range of buildings
  if (/^\d+\s*-\s*\d+\b/.test(street.trim())) {
    return "multi-unit: street contains a number range — split into separate Locations";
  }
  // Explicit unit tokens in the street field (Apt / Unit / Ste / Suite / #N)
  // — ST has a dedicated Unit field for exactly this.
  if (/\b(apt|apartment|unit|ste|suite|bldg|building|floor|fl)\b/i.test(street) || /#\s*\w/.test(street)) {
    return "unit designator in street — move to the dedicated Unit field for cleaner geocoding";
  }
  // Comma followed by alphanumeric continuation — "123 N Main, Suite 4"
  if (/,\s*\S/.test(street)) {
    return "street has a comma — second half likely belongs in Unit field";
  }
  return null;
}

// ── Provider: Google Geocoding ────────────────────────────────────────────────
// Pulls Google's structured address_components into the same shape ST uses
// (street/unit/city/state/zip/country) so the diff and the writeback both
// operate on the same vocabulary.
function googleComponentsToAddress(components = []) {
  const find = (type) =>
    components.find((c) => Array.isArray(c.types) && c.types.includes(type));

  const streetNum = find("street_number")?.short_name || "";
  const route     = find("route")?.short_name || "";
  const subpremise = find("subpremise")?.short_name || "";
  const city      = find("locality")?.long_name
                   || find("sublocality")?.long_name
                   || find("postal_town")?.long_name
                   || find("administrative_area_level_3")?.long_name
                   || "";
  const state     = find("administrative_area_level_1")?.short_name || "";
  const zip       = find("postal_code")?.short_name || "";
  const zipSuffix = find("postal_code_suffix")?.short_name || "";
  const country   = find("country")?.short_name || "USA";

  return {
    street: [streetNum, route].filter(Boolean).join(" ").trim(),
    unit:   subpremise || "",
    city:   city || "",
    state:  state || "",
    zip:    zipSuffix ? `${zip}-${zipSuffix}` : zip,
    country: country === "US" ? "USA" : country,
  };
}

async function geocode(addressLike) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    const err = new Error("GOOGLE_MAPS_API_KEY is not set on the server");
    err.code = "NO_KEY";
    throw err;
  }
  if (isIncomplete(addressLike)) {
    return { status: "incomplete", reason: "missing required address fields" };
  }

  const query = fmtAddr(addressLike);
  const params = {
    address: query,
    key: apiKey,
    components: "country:US",
  };

  const res = await axios.get(GOOGLE_GEOCODE, { params, timeout: 8000 });
  const data = res.data || {};
  if (data.status === "OVER_QUERY_LIMIT" || data.status === "REQUEST_DENIED") {
    const err = new Error(`Google geocode rejected: ${data.status} — ${data.error_message || "no detail"}`);
    err.code = data.status;
    throw err;
  }
  if (data.status === "ZERO_RESULTS") {
    return { status: "no-match" };
  }
  if (data.status !== "OK" || !data.results?.length) {
    return { status: "no-match", reason: data.status };
  }

  const top = data.results[0];
  const verified = googleComponentsToAddress(top.address_components || []);
  const locType  = top.geometry?.location_type || "APPROXIMATE";
  const partial  = !!top.partial_match;
  const formatted = top.formatted_address || fmtAddr(verified);
  const loc = top.geometry?.location || {};

  return {
    status: "ok",
    verified,
    formatted,
    partialMatch: partial,
    locationType: locType,
    lat: loc.lat ?? null,
    lng: loc.lng ?? null,
    placeId: top.place_id || null,
  };
}

// ── Classifier ────────────────────────────────────────────────────────────────
// Decides the row's status pill. The "is this the same address" comparison
// uses a loose normalization (lowercase, periods stripped, whitespace collapsed)
// since ST users type "St" / "St." / "Street" interchangeably and we don't want
// to flag those as standardization wins.
function classify(original, geoResult) {
  if (isIncomplete(original)) return "incomplete";
  if (!geoResult || geoResult.status === "no-match") return "no-match";
  if (geoResult.status === "incomplete") return "incomplete";
  if (geoResult.partialMatch) return "partial";

  const lowPrecision = geoResult.locationType === "APPROXIMATE"
                    || geoResult.locationType === "GEOMETRIC_CENTER";
  if (lowPrecision) return "undeliverable";

  // Aggressive canonical-form comparison: directionals + suffixes abbreviated
  // to their USPS short form on both sides. This is the difference between
  // "North Oak Street" vs "N Oak St" tying (same address) and being flagged
  // as a "standardized" win (false positive).
  const sameStreet = canonicalAddressString(original.street) === canonicalAddressString(geoResult.verified.street);
  const sameCity   = canonicalAddressString(original.city)   === canonicalAddressString(geoResult.verified.city);
  const sameState  = canonicalAddressString(original.state)  === canonicalAddressString(geoResult.verified.state);
  // Compare ZIP on the 5-digit prefix only — ST stores 5, Google often returns ZIP+4.
  const sameZip = String(original.zip || "").slice(0, 5) === String(geoResult.verified.zip || "").slice(0, 5);

  // Unit comparison is a softer signal — Google often omits the unit even
  // when ST has one, so we DON'T downgrade to "standardized" purely because
  // of a unit mismatch. The other four fields are the substantive check.
  if (sameStreet && sameCity && sameState && sameZip) return "ok";
  return "standardized";
}

// ── Verify a page of ST locations (cache-first) ───────────────────────────────
// Shared by both auditLocations and findIssues. For each ST row:
//   1. Compute the address fingerprint from the current ST state.
//   2. Look up the cache by location_id (single SELECT for the whole batch).
//   3. If the cached fingerprint matches the current one, return the cached
//      result — no Google call.
//   4. Otherwise geocode + upsert the cache row.
//
// Returns:
//   { results, cacheHits, geocodeCalls }
//      results       — same row shape the routes already return
//      cacheHits     — count of rows served from cache (no Google call)
//      geocodeCalls  — count of rows that actually hit Google
async function verifyPageOfLocations(locs) {
  const CONCURRENCY = 5;
  if (!locs.length) return { results: [], cacheHits: 0, geocodeCalls: 0 };

  // One DB call to pull every cached row in this batch at once.
  const cache = getCachedMany(locs.map((l) => l.id));

  const results = new Array(locs.length);
  let cacheHits = 0;
  let geocodeCalls = 0;

  let cursor = 0;
  async function worker() {
    while (cursor < locs.length) {
      const i = cursor++;
      const loc = locs[i];
      const original = loc.address || {};
      const fingerprint = fingerprintAddress(original);
      const cached = cache.get(loc.id);

      // Cache hit — fingerprint matches, the prior verification is still valid.
      if (cached && cached.fingerprint === fingerprint) {
        cacheHits++;
        // Name suggestion + repair info are recomputed live (not cached)
        // because both are pure-logic. Lets us improve them without
        // requiring a fresh Google call.
        const currentName = loc.name || "";
        const repairInfo = tryRepairAddress(original);
        // Suggested correction priority:
        //   1. Google's verified version (already title-cased, with USPS abbrevs)
        //   2. Auto-repaired ST data, run through title-case for the CSR
        //   3. Title-cased original ST data
        const suggestedAddr = cached.verified
          || (repairInfo.didRepair ? titleCaseAddress(repairInfo.repaired) : null)
          || titleCaseAddress(original);
        results[i] = {
          locationId: loc.id,
          customerId: loc.customerId,
          name: currentName,
          original,
          originalFormatted: fmtAddr(original),
          repaired: repairInfo.didRepair ? repairInfo.repaired : null,
          repairs: repairInfo.didRepair ? repairInfo.repairs : null,
          suggestedAddr,
          suggestedFormatted: cached.verifiedFormatted || fmtAddr(suggestedAddr),
          verified: cached.verified || null,
          verifiedFormatted: cached.verifiedFormatted || null,
          partialMatch: cached.partialMatch,
          locationType: cached.locationType,
          lat: cached.lat,
          lng: cached.lng,
          placeId: cached.placeId,
          status: cached.status,
          error: cached.error,
          checkedAt: cached.checkedAt,
          appliedAt: cached.appliedAt,
          dismissedAt: cached.dismissedAt,
          streetIssue: detectStreetIssue(original),
          nameSuggestion: suggestName(currentName),
          detectedType: detectType(currentName),
          cached: true,
        };
        continue;
      }

      // Cache miss or fingerprint drift — call Google, then upsert.
      // Run repair pass first so malformed-but-recoverable ST records still
      // get geocoded. We send the REPAIRED address to Google but classify
      // against the ORIGINAL so the table shows the as-typed ST data and
      // any "standardized" diff still surfaces.
      const { repaired, didRepair, repairs } = tryRepairAddress(original);

      geocodeCalls++;
      let geoResult = null;
      let error = null;
      try {
        // Only call Google with the repaired version if it's actually
        // complete now. If repair didn't help, fall through to a normal
        // incomplete result.
        geoResult = await geocode(isIncomplete(repaired) ? original : repaired);
      } catch (err) {
        error = err.code || err.message;
      }
      // Use the repaired address for the "same vs standardized" comparison —
      // otherwise rows that needed a repair will always flag as "standardized"
      // since Google's verified form (clean) won't match the ST garbled form.
      const status = error ? "error" : classify(didRepair ? repaired : original, geoResult);

      const currentName = loc.name || "";
      const nameSugg = suggestName(currentName);

      upsertCacheRow({
        locationId: loc.id,
        customerId: loc.customerId,
        fingerprint,
        status,
        original,
        originalName: currentName,
        suggestedName: nameSugg,
        verified: geoResult?.verified || null,
        verifiedFormatted: geoResult?.formatted || null,
        partialMatch: !!geoResult?.partialMatch,
        locationType: geoResult?.locationType || null,
        lat: geoResult?.lat ?? null,
        lng: geoResult?.lng ?? null,
        placeId: geoResult?.placeId || null,
        error,
      });

      // Compute the suggestion same way as the cache-hit branch.
      const suggestedAddr = geoResult?.verified
        || (didRepair ? titleCaseAddress(repaired) : null)
        || titleCaseAddress(original);
      results[i] = {
        locationId: loc.id,
        customerId: loc.customerId,
        name: currentName,
        original,
        originalFormatted: fmtAddr(original),
        repaired: didRepair ? repaired : null,
        repairs: didRepair ? repairs : null,
        suggestedAddr,
        suggestedFormatted: geoResult?.formatted || fmtAddr(suggestedAddr),
        verified: geoResult?.verified || null,
        verifiedFormatted: geoResult?.formatted || null,
        partialMatch: !!geoResult?.partialMatch,
        locationType: geoResult?.locationType || null,
        lat: geoResult?.lat ?? null,
        lng: geoResult?.lng ?? null,
        placeId: geoResult?.placeId || null,
        status,
        error,
        checkedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
        appliedAt: null,
        dismissedAt: null,
        streetIssue: detectStreetIssue(original),
        nameSuggestion: nameSugg,
        detectedType: detectType(currentName),
        cached: false,
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, locs.length) }, worker));

  return { results, cacheHits, geocodeCalls };
}

// ── Bulk audit ────────────────────────────────────────────────────────────────
async function auditLocations({ page = 1, pageSize = 50, modifiedOnOrAfter } = {}) {
  const t0 = Date.now();
  const { rows, hasMore, totalCount } = await listSTLocations({ page, pageSize, modifiedOnOrAfter });
  const { results, cacheHits, geocodeCalls } = await verifyPageOfLocations(rows);

  // Summary counts — drives the KPI strip at the top of the page.
  const summary = {
    ok: 0, standardized: 0, partial: 0, undeliverable: 0,
    "no-match": 0, incomplete: 0, error: 0,
  };
  for (const r of results) summary[r.status] = (summary[r.status] || 0) + 1;

  return {
    rows: results,
    page,
    pageSize,
    hasMore,
    totalCount,
    summary,
    cacheHits,
    geocodeCalls,
    elapsedMs: Date.now() - t0,
  };
}

// ── Writeback ─────────────────────────────────────────────────────────────────
async function applyCorrection({ locationId, address, name, customerType, customerId }) {
  if (!locationId) throw new Error("applyCorrection: locationId required");
  if (!address || isIncomplete(address)) {
    throw new Error("applyCorrection: address is incomplete");
  }

  const headers = await stHeaders();
  const url = `${ST_BASE}/crm/v2/tenant/${process.env.ST_TENANT_ID}/locations/${locationId}`;

  // If the CSR flipped the Residential/Commercial toggle, push the new type
  // to the customer record. ST's customer.type enum accepts "Residential"
  // or "Commercial" (no other values). We PATCH the customer separately
  // because the location endpoint doesn't carry the type field.
  let customerPatchResult = null;
  if (customerType && customerId) {
    const normalizedType = String(customerType).trim();
    if (normalizedType !== "Residential" && normalizedType !== "Commercial") {
      throw new Error(`Invalid customerType "${customerType}". Must be "Residential" or "Commercial".`);
    }
    const customerUrl = `${ST_BASE}/crm/v2/tenant/${process.env.ST_TENANT_ID}/customers/${customerId}`;
    try {
      const res = await axios.patch(customerUrl, { type: normalizedType }, {
        headers: { ...headers, "Content-Type": "application/json" },
      });
      customerPatchResult = { method: "PATCH", status: res.status };
    } catch (err) {
      const status = err.response?.status;
      if (status === 404 || status === 405) {
        const res = await axios.put(customerUrl, { type: normalizedType }, {
          headers: { ...headers, "Content-Type": "application/json" },
        });
        customerPatchResult = { method: "PUT", status: res.status };
      } else {
        const d = err.response?.data;
        const detail = d ? (typeof d === "string" ? d : JSON.stringify(d).slice(0, 400)) : err.message;
        throw new Error(`customer type update failed (${status || "?"}): ${detail}`);
      }
    }
  }

  // ST PATCH payload — only send the fields we're changing so we don't risk
  // clobbering customFields/etc. ST accepts `street, unit, city, state, zip, country`
  // inside `address`, and `name` at the top level for the Location Name.
  const body = {
    address: {
      street:  address.street || "",
      unit:    address.unit   || "",
      city:    address.city   || "",
      state:   address.state  || "",
      zip:     address.zip    || "",
      country: address.country || "USA",
    },
  };
  // Only include `name` when explicitly provided — sending an empty string
  // would blank out the existing Location Name in ST.
  if (typeof name === "string" && name.trim()) {
    body.name = name.trim();
  }

  // Helper: after a successful write, mark the cache row applied AND refresh
  // its fingerprint to match the new address. That way the very next audit
  // pass sees a fingerprint match and skips Google entirely on this location.
  const refreshCacheAfterApply = () => {
    try {
      // Read the existing cache row first so we preserve fields that aren't
      // being explicitly overwritten (customerId, originalName when the user
      // didn't rename the Location, etc.). Without this, upsert would clobber
      // them with null.
      const existing = getCachedByLocationId(locationId);
      const newName = typeof name === "string" && name.trim() ? name.trim() : null;
      upsertCacheRow({
        locationId,
        customerId: existing?.customerId ?? null,
        fingerprint: fingerprintAddress(address),
        status: "ok", // we just wrote the verified version, so it's clean now
        original: address,
        // If the user pushed a new Location Name, store it. Otherwise keep
        // whatever the cache already had on file.
        originalName: newName || existing?.originalName || null,
        // We just acted on the suggestion (or chose to ignore it) — either
        // way it's no longer pending, so clear it.
        suggestedName: null,
        verified: address,
        verifiedFormatted: fmtAddr(address),
        partialMatch: false,
        locationType: "ROOFTOP",
        lat: null,
        lng: null,
        placeId: null,
        error: null,
      });
      markApplied(locationId); // re-stamp applied_at after upsert overwrites it
    } catch (err) {
      // Cache hygiene is best-effort — never fail the user's ST write because
      // the cache table couldn't be updated.
      console.warn("[Address] cache update after apply failed:", err.message);
    }
  };

  try {
    const res = await axios.patch(url, body, {
      headers: { ...headers, "Content-Type": "application/json" },
    });
    refreshCacheAfterApply();
    return { method: "PATCH", status: res.status, customerPatch: customerPatchResult, data: res.data ?? null };
  } catch (err) {
    const status = err.response?.status;
    // Some ST tenants reject PATCH on this endpoint — fall back to PUT.
    if (status === 404 || status === 405) {
      const res = await axios.put(url, body, {
        headers: { ...headers, "Content-Type": "application/json" },
      });
      refreshCacheAfterApply();
      return { method: "PUT", status: res.status, customerPatch: customerPatchResult, data: res.data ?? null };
    }
    const d = err.response?.data;
    const detail = d ? (typeof d === "string" ? d : JSON.stringify(d).slice(0, 400)) : err.message;
    throw new Error(`applyCorrection failed (${status || "?"}): ${detail}`);
  }
}

// ── Scan-until-N-issues ───────────────────────────────────────────────────────
// Walks ST page by page, geocoding as it goes, and stops as soon as we've
// collected `targetCount` rows whose status isn't "ok" (or "incomplete", which
// the office can't fix from this page anyway). The maxScan cap is a safety
// belt — without it, a clean tenant could quietly walk every location and
// burn through quota looking for problems that don't exist.
//
// Returns:
//   { issues, scanned, pagesWalked, summary, hitTarget, hitMaxScan, elapsedMs }
//   - issues:     the rows that need attention (status !== ok && !== incomplete)
//   - scanned:    total ST locations geocoded
//   - summary:    full count of every status seen during the scan
async function findIssues({
  targetCount = 10,
  maxScan = 500,
  pageSize = 50,
  modifiedOnOrAfter,
  startPage = 1,
} = {}) {
  const t0 = Date.now();

  const issues = [];
  const summary = {
    ok: 0, standardized: 0, partial: 0, undeliverable: 0,
    "no-match": 0, incomplete: 0, error: 0,
  };
  let scanned = 0;
  let pagesWalked = 0;
  let cacheHits = 0;
  let geocodeCalls = 0;
  let page = startPage;
  let lastSeenHasMore = true;

  // We consider these statuses "issues" — anything actionable from the page.
  // - "incomplete" is excluded because there's no Google answer to apply.
  // - Already-applied rows are skipped so we don't keep surfacing fixes the
  //   user already pushed to ST.
  // - Dismissed rows are skipped — the CSR explicitly said "ignore this."
  // - Rows whose street has a multi-unit pattern get surfaced even if Google
  //   thinks the address is fine; ST's structured fields still need a fix.
  const isIssue = (r) => {
    if (r.appliedAt || r.dismissedAt) return false;
    if (r.streetIssue) return true;
    return r.status !== "ok" && r.status !== "incomplete";
  };

  while (
    issues.length < targetCount &&
    scanned < maxScan &&
    lastSeenHasMore
  ) {
    const { rows, hasMore } = await listSTLocations({ page, pageSize, modifiedOnOrAfter });
    lastSeenHasMore = !!hasMore;
    pagesWalked++;

    if (rows.length === 0) break;

    const { results, cacheHits: h, geocodeCalls: g } = await verifyPageOfLocations(rows);
    cacheHits += h;
    geocodeCalls += g;

    // Tally everything, then bank the issues until we hit the target.
    for (const r of results) {
      scanned++;
      summary[r.status] = (summary[r.status] || 0) + 1;
      if (isIssue(r) && issues.length < targetCount) {
        issues.push(r);
      }
      if (scanned >= maxScan) break;
    }

    page++;
  }

  return {
    issues,
    scanned,
    pagesWalked,
    summary,
    cacheHits,
    geocodeCalls,
    hitTarget: issues.length >= targetCount,
    hitMaxScan: scanned >= maxScan,
    nextStartPage: page, // so the UI can keep walking from where we stopped
    targetCount,
    maxScan,
    elapsedMs: Date.now() - t0,
  };
}

module.exports = {
  geocode,
  classify,
  auditLocations,
  findIssues,
  applyCorrection,
  listSTLocations,
  fmtAddr,
  detectStreetIssue,
  tryRepairAddress,
};
