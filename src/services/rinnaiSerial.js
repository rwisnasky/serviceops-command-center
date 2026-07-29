/**
 * src/services/rinnaiSerial.js
 *
 * Decode a Rinnai water-heater serial number into its manufacture date.
 *
 * Rinnai encodes the manufacture date in the FIRST TWO characters of the serial:
 *   char[0] = YEAR   (letter)
 *   char[1] = MONTH  (letter)
 * ...followed by a plant/sequence portion we don't need (e.g. "AB.CA-123456"
 * → A=2009, B=Feb, rest ignored).
 *
 * The alphabets skip letters that look like digits (I/O/Q) and a couple of
 * others, so they are NOT a simple A=1..Z=26. Maps below are transcribed from
 * Rinnai's published serial-number chart.
 *
 * NOTE: the serial does NOT encode the model — model is captured separately on
 * the form. This module is date-only.
 */

// Year letter → calendar year (per Rinnai chart, 2009–2029 cycle)
const YEAR_MAP = {
  A: 2009, B: 2010, C: 2011, D: 2012, E: 2013, F: 2014, G: 2015, H: 2016,
  J: 2017, K: 2018, L: 2019, M: 2020, N: 2021, P: 2022, R: 2023, S: 2024,
  T: 2025, W: 2026, X: 2027, Y: 2028, Z: 2029,
};

// Month letter → month number (1–12). Note: Sept = J (I is skipped).
const MONTH_MAP = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 9, K: 10, L: 11, M: 12,
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Decode a Rinnai serial number.
 * @param {string} serial
 * @returns {{
 *   ok: boolean,
 *   raw: string,
 *   cleaned: string,
 *   yearLetter?: string,
 *   monthLetter?: string,
 *   manufactureYear?: number,
 *   manufactureMonth?: number,
 *   manufactureMonthName?: string,
 *   manufactureDate?: string,   // ISO date, first of the month "YYYY-MM-01"
 *   label?: string,             // e.g. "February 2009"
 *   error?: string
 * }}
 */
function decodeRinnaiSerial(serial) {
  const raw = String(serial == null ? "" : serial);
  // Keep only alphanumerics, uppercase — tolerant of "AB.CA-123456", "AB CA 123456", etc.
  const cleaned = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

  if (cleaned.length < 2) {
    return { ok: false, raw, cleaned, error: "Serial is too short to decode a date." };
  }

  const yearLetter = cleaned[0];
  const monthLetter = cleaned[1];
  const manufactureYear = YEAR_MAP[yearLetter];
  const manufactureMonth = MONTH_MAP[monthLetter];

  if (!manufactureYear) {
    return {
      ok: false, raw, cleaned, yearLetter,
      error: `Unrecognized year code "${yearLetter}" — check the first character.`,
    };
  }
  if (!manufactureMonth) {
    return {
      ok: false, raw, cleaned, yearLetter, monthLetter, manufactureYear,
      error: `Unrecognized month code "${monthLetter}" — check the second character.`,
    };
  }

  const mm = String(manufactureMonth).padStart(2, "0");
  const manufactureMonthName = MONTH_NAMES[manufactureMonth - 1];

  return {
    ok: true,
    raw,
    cleaned,
    yearLetter,
    monthLetter,
    manufactureYear,
    manufactureMonth,
    manufactureMonthName,
    manufactureDate: `${manufactureYear}-${mm}-01`,
    label: `${manufactureMonthName} ${manufactureYear}`,
  };
}

/**
 * Sanity-check a decoded manufacture date against a proposed install date.
 * A unit cannot be installed before it was manufactured. Returns a warning
 * string when the install date is earlier than the manufacture month, else null.
 *
 * @param {string} manufactureDateISO  "YYYY-MM-01" from decodeRinnaiSerial
 * @param {string} installDateISO      "YYYY-MM-DD" from the form
 */
function warnIfInstallBeforeManufacture(manufactureDateISO, installDateISO) {
  if (!manufactureDateISO || !installDateISO) return null;
  const mfg = Date.parse(manufactureDateISO);
  const inst = Date.parse(installDateISO);
  if (Number.isNaN(mfg) || Number.isNaN(inst)) return null;
  // Allow same-month installs; only warn if install is before the manufacture month starts.
  if (inst < mfg) {
    return "Install date is earlier than the unit's manufacture date — double-check the serial or install date.";
  }
  return null;
}

module.exports = {
  decodeRinnaiSerial,
  warnIfInstallBeforeManufacture,
  YEAR_MAP,
  MONTH_MAP,
};

// ── Manual self-test: `node src/services/rinnaiSerial.js` ─────────────────────
if (require.main === module) {
  const cases = ["AB.CA-123456", "ME 004321", "T A 999", "QZ-1", "A", "Wl-500001"];
  for (const c of cases) {
    console.log(JSON.stringify({ input: c, ...decodeRinnaiSerial(c) }));
  }
  // Expect: AB → February 2009; ME → May 2020; TA → January 2025; WL → November 2026.
}
