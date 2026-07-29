/**
 * services/nameNormalizer.js
 * ────────────────────────────────────────────────────────────────────────────
 * Suggests a properly-cased / properly-ordered version of a ServiceTitan
 * customer or location name. Pure logic — no DB or API calls.
 *
 *   suggestName("HOLLINGSWORTH-REYES, DIANE")        → "Diane Hollingsworth-Reyes"
 *   suggestName("SMITH, JOHN & MARY")           → "John & Mary Smith"
 *   suggestName("BRAMBLEWOOD LLC -SITE-204 & 204B") → "Bramblewood LLC -Site-204 & 204B"
 *   suggestName("O'BRIEN, PATRICK JR.")         → "Patrick O'Brien Jr."
 *   suggestName("Diane Hollingsworth-Reyes")         → null   (already clean)
 *
 * The function returns NULL when the input is already in good shape, so
 * callers can treat truthy = "needs work" and surface a hint badge.
 *
 * Conventions baked in (per the office's preferences, captured 2026-05-13):
 *   - Individuals format as "First Last".
 *   - Joint customers format as "First1 & First2 Last".
 *   - Business names get title-cased uniformly, BUT common business acronyms
 *     (LLC, Inc, Corp, Co, Ltd, LLP, LP, PC, PLC, etc.) and roman numerals
 *     stay uppercase so we don't get "Bramblewood Llc."
 *   - The detector ONLY suggests when there's a real difference — case,
 *     ordering, whitespace, separator weirdness. A clean input gets null.
 * ────────────────────────────────────────────────────────────────────────────
 */

// Acronyms and tokens that must NOT be title-cased — kept uppercase.
// Mostly business entity suffixes and academic / medical credentials.
const KEEP_UPPER = new Set([
  "LLC", "LLP", "INC", "CORP", "CO", "LTD", "LP", "PC", "PLC", "PLLC",
  "DBA", "AKA", "PA", "PS", "USA", "US",
  "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
  "MD", "DDS", "DVM", "DO", "PHD", "DPM",
  "HVAC", "POA", "LLC.", "INC.",
]);

// Common business-entity tokens — if the name contains any of these, we treat
// it as a business and don't try to reorder Last/First.
const BUSINESS_TOKENS = new Set([
  "LLC", "LLP", "INC", "CORP", "CO", "LTD", "LP", "PC", "PLC", "PLLC",
  "COMPANY", "ENTERPRISES", "PROPERTIES", "MANAGEMENT", "GROUP", "REALTY",
  "BANK", "CHURCH", "ASSOCIATES", "SERVICES", "RENTALS", "HOLDINGS",
  "PARTNERS", "TRUST", "FUND", "FOUNDATION", "HOSPITAL", "CLINIC",
]);

// Suffixes that follow the LAST name in "Smith, John Jr." style records.
// We strip these off before reordering so they don't get glued to the front.
const NAME_SUFFIXES = new Set([
  "JR", "JR.", "SR", "SR.", "II", "III", "IV", "V",
  "MD", "DDS", "DVM", "DO", "PHD", "ESQ", "ESQ.",
]);

// Words inside a name that should stay lowercase even when title-casing —
// common "particle" tokens in surnames and connectors. "Mary van der Berg"
// stays mixed-case rather than being forced to "Mary Van Der Berg."
const LOWER_PARTICLES = new Set([
  "van", "von", "de", "del", "della", "di", "da", "le", "la", "du",
  "des", "der", "den", "ten", "ter", "y", "el",
]);

// Small connector words that title-case style typically lowercases mid-string
// ("Grounded Heating and Cooling", "Joe's Bar and Grill"). First and last
// positions are exempt — they always capitalize.
const SMALL_WORDS = new Set([
  "and", "or", "the", "of", "for", "a", "an", "but",
  "at", "by", "in", "on", "to", "as", "vs", "via", "per",
]);

// Title-case a single token, with smart handling of:
//   - Acronyms (LLC stays LLC)
//   - Roman numerals (III stays III)
//   - Hyphens (Hollingsworth-Reyes → Hollingsworth-Reyes)
//   - Apostrophes (O'Brien → O'Brien, Mc'Donald → Mc'Donald)
//   - Particles that stay lowercase mid-name (van/de/del/etc.)
function titleCaseToken(tok, isFirstOrLast) {
  if (!tok) return tok;
  const upper = tok.toUpperCase();
  if (KEEP_UPPER.has(upper)) return upper;

  // Tokens that contain digits ("601A", "401K") get uppercased wholesale —
  // letters mixed with numbers are almost always meant to be uppercase
  // (apartment letters, suite codes, etc.). Without this, "601A" would
  // become "601a" via the default capFirst path.
  if (/\d/.test(tok)) return upper;

  // Small connector words stay lowercase mid-string. First/last position
  // always capitalizes ("And Sons" at the start vs "Joe's Bar and Grill" mid).
  if (!isFirstOrLast && SMALL_WORDS.has(tok.toLowerCase())) {
    return tok.toLowerCase();
  }

  // Particles stay lowercase unless they're at the very front of the name
  // (e.g., "Van Halen" the band — but "Linda van der Berg").
  if (!isFirstOrLast && LOWER_PARTICLES.has(tok.toLowerCase())) {
    return tok.toLowerCase();
  }

  // Split on hyphens — each segment gets its own title-case treatment.
  if (tok.includes("-")) {
    return tok.split("-").map((s) => titleCaseToken(s, true)).join("-");
  }

  // Apostrophes are tricky:
  //   - Name-style (O'Brien, D'Angelo): both sides capitalize.
  //   - Possessive (Joe's, Smith's): only the left side capitalizes, the "s"
  //     stays lowercase.
  // Heuristic: if the trailing segment is exactly "s" or "S", it's possessive.
  if (/['’]/.test(tok)) {
    const segments = tok.split(/(['’])/);
    return segments.map((s, i) => {
      if (i % 2 === 1) return s; // the apostrophe itself
      // Trailing "s" after apostrophe = possessive — keep lowercase.
      if (i > 0 && s.toLowerCase() === "s") return "s";
      return capFirst(s.toLowerCase());
    }).join("");
  }

  // "Mc" + capital prefix (McDonald) — keep the cap after Mc.
  // "Mac" is ambiguous — we don't auto-cap MacDonald because some real names
  // are "Macaulay" etc. Conservative: just title-case normally.
  const lower = tok.toLowerCase();
  if (/^mc[a-z]/.test(lower)) {
    return "Mc" + capFirst(lower.slice(2));
  }

  return capFirst(lower);
}

function capFirst(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Title-case an entire name string. Tokens are space-separated; the first
// and last get titleCaseToken with isFirstOrLast=true so particle handling
// kicks in only for inner tokens.
function titleCase(s) {
  if (!s) return s;
  const toks = String(s).split(/\s+/).filter(Boolean);
  return toks.map((t, i) => titleCaseToken(t, i === 0 || i === toks.length - 1)).join(" ");
}

// True if the name contains any business-indicator token. Run on the
// pre-normalization upper-cased version so casing doesn't matter.
function isBusiness(rawName) {
  const upper = String(rawName || "").toUpperCase();
  const toks = upper.split(/[\s,&\-/]+/).filter(Boolean);
  for (const t of toks) {
    if (BUSINESS_TOKENS.has(t)) return true;
  }
  // Also treat names with digits as businesses (apartment complex site
  // numbers, store numbers, etc.). Reordering "Site 5, Apt B" makes no sense.
  if (/\d/.test(upper)) return true;
  return false;
}

// Detect the "LAST, FIRST" pattern. Returns the parts if present, else null.
// Handles "SMITH, JOHN", "SMITH, JOHN & MARY", "SMITH-JONES, JOHN JR."
function splitLastFirst(name) {
  const m = String(name || "").match(/^([^,]+),\s*(.+)$/);
  if (!m) return null;
  const last = m[1].trim();
  let firstPart = m[2].trim();

  // Pull any trailing suffix off the FIRST portion. ("John Jr.", "John III")
  // Suffixes apply to the individual, not the family, so they belong AFTER
  // the last name in the reordered form.
  const tokens = firstPart.split(/\s+/);
  let suffix = "";
  while (tokens.length > 1) {
    const tail = tokens[tokens.length - 1];
    if (NAME_SUFFIXES.has(tail.toUpperCase())) {
      suffix = (tail + " " + suffix).trim();
      tokens.pop();
    } else break;
  }
  firstPart = tokens.join(" ");

  return { last, firstPart, suffix };
}

// Main entry point. Returns the suggested rewrite, or null if the input is
// already in good shape.
function suggestName(raw) {
  const original = String(raw || "").trim().replace(/\s+/g, " ");
  if (!original) return null;

  let suggested;

  if (isBusiness(original)) {
    // Title-case but leave acronyms alone. No reordering.
    suggested = titleCase(original);
  } else {
    // Individual or joint. Look for "LAST, FIRST" pattern.
    const parts = splitLastFirst(original);
    if (parts) {
      const titledLast  = titleCase(parts.last);
      const titledFirst = titleCase(parts.firstPart);
      const sfx         = parts.suffix ? " " + titleCase(parts.suffix) : "";
      // "John & Mary Smith Jr." — suffix glues to the end.
      suggested = `${titledFirst} ${titledLast}${sfx}`;
    } else {
      // Already "First Last" (or some unusual form). Just normalize casing.
      suggested = titleCase(original);
    }
  }

  // Collapse multiple spaces a final time after assembly.
  suggested = suggested.replace(/\s+/g, " ").trim();

  // Return null if the suggestion is identical to the input — no point
  // surfacing a "fix" that doesn't change anything.
  return suggested === original ? null : suggested;
}

// Broader keyword list used by detectType. isBusiness() (above) is tuned for
// the "should I reorder Last, First?" decision and is more conservative —
// detectType wants to be more aggressive about flagging commercial because
// the CSR can always flip the toggle in Adjust mode. Keep these uppercase.
const COMMERCIAL_KEYWORDS = new Set([
  // Entity suffixes — same as BUSINESS_TOKENS
  "LLC", "LLP", "INC", "CORP", "CO", "LTD", "LP", "PC", "PLC", "PLLC",
  // Generic business descriptors
  "COMPANY", "ENTERPRISES", "PROPERTIES", "MANAGEMENT", "GROUP",
  "REALTY", "BANK", "CHURCH", "ASSOCIATES", "SERVICES", "RENTALS",
  "HOLDINGS", "PARTNERS", "TRUST", "FUND", "FOUNDATION",
  // Healthcare / emergency
  "HOSPITAL", "CLINIC", "AMBULANCE", "MEDICAL", "DENTAL", "VETERINARY",
  "PHARMACY", "DOCTORS", "PHYSICIANS",
  // Trade businesses (very relevant for a home-services customer list)
  "PLUMBING", "HEATING", "COOLING", "HVAC", "ELECTRIC", "ELECTRICAL",
  "CONSTRUCTION", "REMODELING", "ROOFING", "LANDSCAPING", "FLOORING",
  "PAINTING", "MASONRY",
  // Hospitality / retail
  "RESTAURANT", "CAFE", "STORE", "SHOP", "MARKET", "GROCERY", "BAKERY",
  "HOTEL", "MOTEL", "INN", "RESORT", "LOUNGE", "BAR", "GRILL",
  // Education / civic
  "SCHOOL", "COLLEGE", "UNIVERSITY", "ACADEMY", "DAYCARE",
  "LIBRARY", "MUSEUM", "GYM", "FITNESS",
  // Real estate / commercial buildings
  "BUILDING", "OFFICE", "PLAZA", "CENTER", "CENTRE", "MALL", "TOWER",
  "SUITE", "WAREHOUSE", "FACILITY", "PROPERTY", "ESTATES",
  // Specialty
  "STUDIO", "GALLERY", "SALON", "SPA", "BARBER",
  "LAW", "FIRM", "ACCOUNTING", "INSURANCE",
  "AUTO", "MOTORS", "TIRE", "GARAGE",
  "STATION", "REPAIR",
  // Religious / community
  "PARISH", "TEMPLE", "MOSQUE", "SYNAGOGUE", "MINISTRIES", "MINISTRY",
]);

// Cheap heuristic for ServiceTitan's customer type enum. Splits the name on
// non-alpha boundaries and checks each token against COMMERCIAL_KEYWORDS.
// Returns 'Commercial' on a match, 'Residential' otherwise. Wrong on a
// minority of cases but always overridable by the CSR before applying.
function detectType(name) {
  const tokens = String(name || "").toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  for (const t of tokens) {
    if (COMMERCIAL_KEYWORDS.has(t)) return "Commercial";
  }
  return "Residential";
}

module.exports = {
  suggestName,
  titleCase,
  isBusiness,
  splitLastFirst,
  detectType,
};
