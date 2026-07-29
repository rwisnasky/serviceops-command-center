#!/usr/bin/env node
/**
 * scripts/create-default-sku.js
 *
 * One-time setup: creates the "Auto-Imported Supplier Item" material in
 * ServiceTitan's pricebook with chargeableByDefault = false, so invoice
 * line items routed through it don't land on customer invoices.
 *
 * Run once, grab the printed ID, set it as ST_DEFAULT_SKU_ID in Railway.
 *
 *   cd serviceops-command-center
 *   node scripts/create-default-sku.js
 *
 * Uses the same ST auth flow as the rest of the app (reads ST_CLIENT_ID,
 * ST_CLIENT_SECRET, ST_APP_KEY, ST_TENANT_ID from .env).
 */

require("dotenv").config();
const axios = require("axios");
const { getAccessToken } = require("../src/api/servicetitan");

const TENANT_ID = process.env.ST_TENANT_ID;
const APP_KEY = process.env.ST_APP_KEY;

if (!TENANT_ID || !APP_KEY || !process.env.ST_CLIENT_ID || !process.env.ST_CLIENT_SECRET) {
  console.error("✗ Missing ST credentials in .env (need ST_CLIENT_ID, ST_CLIENT_SECRET, ST_APP_KEY, ST_TENANT_ID)");
  process.exit(1);
}

// Body mirrors the settings on your existing Misc Material (id 4021784) but
// with chargeableByDefault flipped to false. If you want different GL account
// values, edit `account` / `costOfSaleAccount` below before running.
const BODY = {
  code: "AutoImport",
  displayName: "Auto-Imported Supplier Item",
  description:
    "Non-chargeable placeholder used by the auto-invoice-import tool. " +
    "Cost flows through to job COGS; items should NOT appear on customer invoices.",
  active: true,
  isInventory: false,
  chargeableByDefault: false, // ← the whole point of this script
  taxable: false,
  cost: 0,
  price: 0,
  memberPrice: 0,
  addOnPrice: 0,
  addOnMemberPrice: 0,
  hours: 0,
  bonus: 0,
  commissionBonus: 0,
  paysCommission: false,
  deductAsJobCost: false,
  unitOfMeasure: "0",
  isConfigurableMaterial: false,
  isOtherDirectCost: false,
  account: "Sales - Service",
  costOfSaleAccount: "Purchases - Service Related",
};

async function main() {
  console.log("→ Fetching ST access token…");
  const token = await getAccessToken();

  const url = `https://api.servicetitan.io/pricebook/v2/tenant/${TENANT_ID}/materials`;
  console.log(`→ POST ${url}`);
  console.log(`→ Body: chargeableByDefault=${BODY.chargeableByDefault}, code="${BODY.code}", displayName="${BODY.displayName}"`);

  try {
    const res = await axios.post(url, BODY, {
      headers: {
        Authorization: `Bearer ${token}`,
        "ST-App-Key": APP_KEY,
        "Content-Type": "application/json",
      },
    });
    const mat = res.data || {};
    console.log("\n✓ Material created:");
    console.log(`   id                  = ${mat.id}`);
    console.log(`   code                = ${mat.code}`);
    console.log(`   displayName         = ${mat.displayName}`);
    console.log(`   chargeableByDefault = ${mat.chargeableByDefault}`);
    console.log(`   active              = ${mat.active}`);
    console.log(`\n→ Next step: set this in Railway env vars:`);
    console.log(`   ST_DEFAULT_SKU_ID=${mat.id}\n`);
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    console.error(`\n✗ ST rejected the request (${status || "?"}):`);
    console.error(data ? JSON.stringify(data, null, 2) : err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
