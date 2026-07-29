#!/usr/bin/env node
/**
 * fetch-monthly-appointments.js
 * ────────────────────────────────────────────────────────────────────────────
 * Pulls every ServiceTitan appointment scheduled to start in a given month
 * and caches it as data/monthly-cache/{year}-{month}/appointments.json.
 *
 * This is the source of truth for on-time analysis: each appointment has a
 * real scheduled `start` time and an `arrivalWindowStart` / `arrivalWindowEnd`
 * for the customer-promised window. Far more accurate than parsing dispatch
 * notes from job summaries.
 *
 * Usage:
 *   node scripts/fetch-monthly-appointments.js --year 2026 --month 3
 *
 * Requires the same .env vars the dashboard uses (ST_CLIENT_ID,
 * ST_CLIENT_SECRET, ST_APP_KEY, ST_TENANT_ID).
 * ────────────────────────────────────────────────────────────────────────────
 */

require("dotenv").config();
const path = require("path");
const { loadLiveAppointmentsForMonth, writeAppointmentsCache, cacheDir } =
  require(path.join(__dirname, "..", "src", "services", "monthlyDataLoader"));

function parseArgs() {
  const out = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const k = process.argv[i].replace(/^--/, "");
    out[k] = process.argv[i + 1];
  }
  return out;
}

(async () => {
  const args = parseArgs();
  const year  = parseInt(args.year, 10);
  const month = parseInt(args.month, 10);
  if (!year || !month || month < 1 || month > 12) {
    console.error("Usage: node scripts/fetch-monthly-appointments.js --year YYYY --month M");
    process.exit(1);
  }

  console.log(`Fetching ServiceTitan appointments for ${year}-${String(month).padStart(2, "0")}…`);
  try {
    const appts = await loadLiveAppointmentsForMonth(year, month);
    console.log(`  ✓ ${appts.length} appointments fetched`);
    writeAppointmentsCache(year, month, appts);
    console.log(`  ✓ written to ${cacheDir(year, month)}/appointments.json`);

    // Quick summary by hour-of-day
    const byHour = {};
    for (const a of appts) {
      const start = a.scheduledStart;
      if (!start) continue;
      const hour = parseInt(start.slice(11, 13), 10); // UTC hour from ISO string
      byHour[hour] = (byHour[hour] || 0) + 1;
    }
    console.log("\n  Distribution (UTC hour, will shift in app to local):");
    for (const h of Object.keys(byHour).sort((a, b) => parseInt(a) - parseInt(b))) {
      console.log(`    ${String(h).padStart(2, "0")}:00  ${byHour[h]} appointments`);
    }
  } catch (e) {
    console.error("✗ Fetch failed:", e.message);
    if (e.response?.data) {
      console.error("  ST response:", JSON.stringify(e.response.data).slice(0, 300));
    }
    process.exit(1);
  }
})();
