const express = require("express");
const router = express.Router();
const { previewFanClubs, syncFanClubs, syncOneMembership, patchCheckMonthsForMembership } = require("../services/fanClubService");
const { getAccessToken } = require("../api/servicetitan");
const axios = require("axios");

// GET /api/fanclubs/preview?activeOnly=true
// Returns count of memberships without syncing anything
router.get("/preview", async (req, res) => {
  try {
    const activeOnly = req.query.activeOnly !== "false";
    const result = await previewFanClubs({ activeOnly });
    res.json(result);
  } catch (err) {
    console.error("[API] /fanclubs/preview error:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fanclubs/sync
// Body: { activeOnly: true }
// Sync all (active) memberships from ServiceTitan to GHL
router.post("/sync", async (req, res) => {
  try {
    const activeOnly = req.body?.activeOnly !== false;

    // Respond immediately; process async
    res.json({ started: true, message: `Syncing ${activeOnly ? "active" : "all"} Ground Club memberships to GHL` });

    syncFanClubs({ activeOnly })
      .then((results) => console.log(`[FanClub] Done — ${results.length} membership(s) synced`))
      .catch((err) => console.error("[FanClub] Background sync error:", err.message));
  } catch (err) {
    console.error("[API] /fanclubs/sync error:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fanclubs/test-sync
// Syncs exactly ONE membership and returns the full result — use this to verify the fix before running a full sync
router.post("/test-sync", async (req, res) => {
  try {
    const activeOnly = req.body?.activeOnly !== false;
    const membershipId = req.body?.membershipId || null;
    // dryRun defaults to true — GHL will NOT be updated unless you explicitly pass dryRun: false
    const dryRun = req.body?.dryRun !== false;
    const result = await syncOneMembership({ membershipId, activeOnly, dryRun });
    res.json(result);
  } catch (err) {
    console.error("[API] /fanclubs/test-sync error:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fanclubs/lookup?type=customer|location&id=12345
// Searches active memberships by customerId or locationId
router.get("/lookup", async (req, res) => {
  try {
    const { type, id } = req.query;
    if (!type || !id) {
      return res.status(400).json({ error: "type and id are required query params" });
    }
    if (!["customer", "location"].includes(type)) {
      return res.status(400).json({ error: "type must be 'customer' or 'location'" });
    }

    const { getAllMemberships } = require("../services/fanClubService");
    const allActive = await getAllMemberships({ activeOnly: true });

    let matches = [];

    if (type === "customer") {
      // Direct match on customerId field
      matches = allActive.filter(m => String(m.customerId) === String(id));
    } else if (type === "location") {
      // Need to find which customers are at this location, then match memberships
      // First, check each membership's customer to see if they have this location
      const st = require("../api/servicetitan");
      const customerIds = [...new Set(allActive.map(m => m.customerId).filter(Boolean))];

      // Build a set of customerIds that own this locationId
      const matchingCustomerIds = new Set();
      // Check in batches to avoid hammering the API
      for (const custId of customerIds) {
        try {
          const locations = await st.getLocationsByCustomer(custId);
          if (locations.some(loc => String(loc.id) === String(id))) {
            matchingCustomerIds.add(custId);
          }
        } catch (_) {
          // Skip customers we can't look up
        }
      }
      matches = allActive.filter(m => matchingCustomerIds.has(m.customerId));
    }

    // Enrich with type names
    const MEMBERSHIP_TYPE_NAMES = require("../services/fanClubService").MEMBERSHIP_TYPE_NAMES || {};
    const memberships = matches.map(m => ({
      id: m.id,
      customerId: m.customerId,
      customerName: m.customerName || m.customer?.name || null,
      status: m.status,
      membershipTypeName: MEMBERSHIP_TYPE_NAMES[m.membershipTypeId] || m.membershipType?.name || `Type ${m.membershipTypeId}`,
      from: m.from,
      to: m.to,
    }));

    console.log(`[FanClub] Lookup by ${type}=${id} — found ${memberships.length} active membership(s)`);
    res.json({ type, id, memberships });
  } catch (err) {
    console.error("[API] /fanclubs/lookup error:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fanclubs/debug-recurring/:membershipId
// Returns the raw ST recurring-services response so we can see exactly what's coming back
router.get("/debug-recurring/:membershipId", async (req, res) => {
  try {
    const token = await getAccessToken();
    const tenantId = process.env.ST_TENANT_ID;
    const { membershipId } = req.params;

    // Try 1: filter by membershipId
    const byMembership = await axios.get(
      `https://api.servicetitan.io/memberships/v2/tenant/${tenantId}/recurring-services`,
      {
        headers: { Authorization: `Bearer ${token}`, "ST-App-Key": process.env.ST_APP_KEY },
        params: { membershipId, pageSize: 50 },
      }
    ).catch(e => ({ data: { error: e.message } }));

    // Try 2: nested path /memberships/{id}/recurring-services
    const byPath = await axios.get(
      `https://api.servicetitan.io/memberships/v2/tenant/${tenantId}/memberships/${membershipId}/recurring-services`,
      {
        headers: { Authorization: `Bearer ${token}`, "ST-App-Key": process.env.ST_APP_KEY },
        params: { pageSize: 50 },
      }
    ).catch(e => ({ data: { error: e.response?.data || e.message } }));

    res.json({
      membershipId,
      byQueryParam: { count: byMembership.data?.data?.length ?? "error", sample: byMembership.data?.data?.slice(0,3) ?? byMembership.data },
      byNestedPath: { count: byPath.data?.data?.length ?? "error", sample: byPath.data?.data?.slice(0,3) ?? byPath.data },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fanclubs/membership-types
// Returns all membership types from ServiceTitan so you can see IDs and names
router.get("/membership-types", async (req, res) => {
  try {
    const token = await getAccessToken();
    const tenantId = process.env.ST_TENANT_ID;
    const result = await axios.get(
      `https://api.servicetitan.io/memberships/v2/tenant/${tenantId}/membership-types`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "ST-App-Key": process.env.ST_APP_KEY,
        },
        params: { pageSize: 100, active: true },
      }
    );
    const types = (result.data?.data || []).map((t) => ({
      id: t.id,
      name: t.name,
      active: t.active,
      duration: t.duration,
      durationUnit: t.durationUnit,
      price: t.price,
      status: t.status,
    }));
    res.json({ total: types.length, membershipTypes: types });
  } catch (err) {
    console.error("[API] /fanclubs/membership-types error:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fanclubs/send-webhook
// Sends the dry-run result payload to GHL_MEMBERSHIP_WEBHOOK_URL
router.post("/send-webhook", async (req, res) => {
  try {
    const webhookUrl = process.env.GHL_MEMBERSHIP_WEBHOOK_URL;
    if (!webhookUrl) {
      return res.status(500).json({ error: "GHL_MEMBERSHIP_WEBHOOK_URL is not set" });
    }

    const payload = req.body;
    if (!payload || !payload.membershipId) {
      return res.status(400).json({ error: "Missing payload — include the dry-run result" });
    }

    const webhookRes = await axios.post(webhookUrl, payload, {
      headers: { "Content-Type": "application/json" },
    });

    console.log(`[FanClub] Webhook sent for membership ${payload.membershipId} — status ${webhookRes.status}`);
    res.json({ sent: true, membershipId: payload.membershipId, webhookStatus: webhookRes.status });
  } catch (err) {
    console.error("[API] /fanclubs/send-webhook error:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fanclubs/ghl-field-options
// Returns all opportunity-scoped custom fields so we can find the correct
// cooling/heating field keys. Also flags any RADIO fields with their options.
router.get("/ghl-field-options", async (req, res) => {
  try {
    const ghl = require("../api/gohighlevel");
    const fields = await ghl.getLocationCustomFields();

    // All fields, grouped by model (contact vs opportunity)
    const all = fields.map((f) => ({
      name: f.name,
      fieldKey: f.fieldKey,
      dataType: f.dataType,
      model: f.model || (f.fieldKey || "").split(".")[0],
      options: (f.options || []).map((o) => ({ label: o.key || o.label, id: o.value || o.id })),
    }));

    const opportunityFields = all.filter((f) => f.model === "opportunity");
    const contactFields = all.filter((f) => f.model === "contact");

    // Best-guess matches for cooling/heating
    const keywords = ["cool", "heat", "check", "month", "season"];
    const likelyMatches = all.filter((f) =>
      keywords.some((k) => (f.name || "").toLowerCase().includes(k) || (f.fieldKey || "").toLowerCase().includes(k))
    );

    res.json({
      total: fields.length,
      opportunityFieldCount: opportunityFields.length,
      contactFieldCount: contactFields.length,
      likelyMatches,
      opportunityFields,
    });
  } catch (err) {
    console.error("[API] /fanclubs/ghl-field-options error:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fanclubs/patch-check-months
// Body: { membershipId: "12345" }
// Finds the matching GHL contact by phone/email and updates ONLY the two check month
// custom fields via the direct GHL API (bypasses the webhook mapping entirely).
router.post("/patch-check-months", async (req, res) => {
  try {
    const { membershipId } = req.body;
    if (!membershipId) return res.status(400).json({ error: "membershipId is required" });
    const result = await patchCheckMonthsForMembership(membershipId);
    res.json(result);
  } catch (err) {
    console.error("[API] /fanclubs/patch-check-months error:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Add Complimentary Membership ──────────────────────────────────────────────

function _formatAddress(addr = {}) {
  const line1 = [addr.street, addr.unit].filter(Boolean).join(" ");
  const cityStateZip = [addr.city, [addr.state, addr.zip].filter(Boolean).join(" ")]
    .filter(Boolean).join(", ");
  return [line1, cityStateZip].filter(Boolean).join(", ");
}

// GET /api/fanclubs/customer-locations?customerId=12345
// Loads a customer + their locations so the office can pick where a
// complimentary membership goes.
router.get("/customer-locations", async (req, res) => {
  try {
    const st = require("../api/servicetitan");
    const customerId = req.query.customerId;
    if (!customerId || !/^\d+$/.test(String(customerId))) {
      return res.status(400).json({ error: "A numeric customerId is required." });
    }
    const [customer, locations] = await Promise.all([
      st.getCustomer(Number(customerId)).catch(() => null),
      st.getLocationsByCustomer(Number(customerId)).catch(() => []),
    ]);
    if (!customer) return res.status(404).json({ error: `No customer found for ID ${customerId}.` });
    res.json({
      customer: { id: customer.id, name: customer.name || `Customer ${customer.id}`, type: customer.type || "" },
      locations: (locations || []).map((l) => ({
        id: l.id,
        name: l.name || "",
        address: _formatAddress(l.address || {}),
      })),
    });
  } catch (err) {
    console.error("[API] /fanclubs/customer-locations error:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fanclubs/add-membership
// Body: { customerId, locationId, membershipTypeId, from?, durationMonths? }
// Creates a membership in ServiceTitan. Returns ST's result (or its error detail
// verbatim) so the office can see exactly what happened.
router.post("/add-membership", async (req, res) => {
  try {
    const st = require("../api/servicetitan");
    const { customerId, locationId, membershipTypeId, from, durationMonths, businessUnitId } = req.body || {};
    if (!customerId || !membershipTypeId) {
      return res.status(400).json({ ok: false, error: "customerId and membershipTypeId are required." });
    }
    const start = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : new Date().toISOString().slice(0, 10);
    const months = Number(durationMonths) || 12;
    const endDate = (() => {
      const d = new Date(`${start}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + months);
      return d.toISOString().slice(0, 10);
    })();

    const body = {
      customerId: Number(customerId),
      membershipTypeId: Number(membershipTypeId),
      from: `${start}T00:00:00Z`,
      to: `${endDate}T00:00:00Z`,
      status: "Active",
    };
    if (locationId) body.locationIds = [Number(locationId)];
    const bu = businessUnitId || process.env.ST_FREE_MEMBERSHIP_BU_ID;
    if (bu) body.businessUnitId = Number(bu);

    const created = await st.createMembership(body);
    console.log(`[FanClub] Complimentary membership created for customer ${customerId} — id ${created?.id}`);
    res.json({ ok: true, membershipId: created?.id ?? null, from: start, to: endDate, sent: body });
  } catch (err) {
    console.error("[API] /fanclubs/add-membership error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
