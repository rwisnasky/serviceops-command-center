#!/usr/bin/env node
/**
 * scripts/set-misc-nonchargeable.js
 *
 * Flips the Misc Material (id 4021784) in ST pricebook to
 * chargeableByDefault: false. After this runs, items routed through that
 * SKU won't auto-populate customer invoices.
 *
 * ⚠ TENANT-WIDE — affects every use of Misc Material going forward, not
 * just the auto-invoice-import tool. Past POs / invoices are unaffected.
 *
 *   cd serviceops-command-center
 *   node scripts/set-misc-nonchargeable.js
 *
 * If you'd rather not change the global default and want a dedicated SKU
 * for just auto-imports, use scripts/create-default-sku.js instead.
 */

require("dotenv").config();
const axios = require("axios");
const { getAccessToken } = require("../src/api/servicetitan");

const TENANT_ID = process.env.ST_TENANT_ID;
const APP_KEY = process.env.ST_APP_KEY;
const MATERIAL_ID = 4021784; // "Miscellaneous Material"

if (!TENANT_ID || !APP_KEY || !process.env.ST_CLIENT_ID || !process.env.ST_CLIENT_SECRET) {
  console.error("✗ Missing ST credentials in .env (need ST_CLIENT_ID, ST_CLIENT_SECRET, ST_APP_KEY, ST_TENANT_ID)");
  process.exit(1);
}

async function main() {
  console.log("→ Fetching ST access token…");
  const token = await getAccessToken();

  const url = `https://api.servicetitan.io/pricebook/v2/tenant/${TENANT_ID}/materials/${MATERIAL_ID}`;
  console.log(`→ PATCH ${url}`);
  console.log(`→ Setting chargeableByDefault=false on Misc Material (id ${MATERIAL_ID})`);

  const headers = {
    Authorization: `Bearer ${token}`,
    "ST-App-Key": APP_KEY,
    "Content-Type": "application/json",
  };
  const body = { chargeableByDefault: false };

  try {
    // Try PATCH first (ST's pricebook API typically uses PATCH for updates).
    const res = await axios.patch(url, body, { headers });
    printResult(res.data);
  } catch (err) {
    const status = err.response?.status;
    // Some ST endpoints only accept PUT — fall back.
    if (status === 405 || status === 404) {
      console.log(`→ PATCH returned ${status}, trying PUT instead…`);
      try {
        const res = await axios.put(url, body, { headers });
        printResult(res.data);
        return;
      } catch (err2) {
        surfaceError(err2);
      }
    } else {
      surfaceError(err);
    }
  }
}

function printResult(mat) {
  mat = mat || {};
  console.log("\n✓ Update applied:");
  console.log(`   id                  = ${mat.id ?? MATERIAL_ID}`);
  console.log(`   code                = ${mat.code ?? "(not in response)"}`);
  console.log(`   displayName         = ${mat.displayName ?? "(not in response)"}`);
  console.log(`   chargeableByDefault = ${mat.chargeableByDefault ?? "(not in response — verify with a GET)"}`);
  console.log(`\n→ Next step: create a test PO through the invoice tool and confirm items do NOT land on the customer invoice.\n`);
}

function surfaceError(err) {
  const status = err.response?.status;
  const data = err.response?.data;
  console.error(`\n✗ ST rejected the request (${status || "?"}):`);
  console.error(data ? JSON.stringify(data, null, 2) : err.message);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
