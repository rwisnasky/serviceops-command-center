const axios = require("axios");
const { getAccessToken } = require("../api/servicetitan");
const ghl = require("../api/gohighlevel");
const st = require("../api/servicetitan");

// ── Membership Type Lookup ─────────────────────────────────────────────────────
// Maps ServiceTitan membershipTypeId → human-readable name
const MEMBERSHIP_TYPE_NAMES = {
  7001: "Ground Club - Annual",
  7002: "Ground Club - Two System",
  7003: "Ground Club - Three System",
  7004: "Ground Club - Monthly",
  7005: "Plumbing Protection Plan",
  7006: "Water Heater Flush Plan",
  7007: "Ground Club - Commercial",
  7008: "Legacy PSM - Do Not Renew - Use Ground Club",
};

// ── ServiceTitan Memberships API ───────────────────────────────────────────────

async function getMemberships({ activeOnly, page = 1, pageSize = 50 } = {}) {
  const token = await getAccessToken();
  const tenantId = process.env.ST_TENANT_ID;

  const params = { page, pageSize };
  // ServiceTitan uses 'statuses' (plural) to filter by membership status
  if (activeOnly) params.statuses = "Active";

  const res = await axios.get(
    `https://api.servicetitan.io/memberships/v2/tenant/${tenantId}/memberships`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "ST-App-Key": process.env.ST_APP_KEY,
      },
      params,
    }
  );
  return res.data;
}

async function getAllMemberships({ activeOnly = true } = {}) {
  let all = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const data = await getMemberships({ activeOnly, page, pageSize: 50 });
    let records = data.data || [];

    // Post-fetch safety filter — skip anything that isn't Active
    if (activeOnly) {
      records = records.filter((m) => (m.status || "").toLowerCase() === "active");
    }

    all = all.concat(records);
    hasMore = data.hasMore || false;
    page++;
  }

  return all;
}

// ── Fetch a single membership by ID ───────────────────────────────────────────

async function getMembershipById(membershipId) {
  const token = await getAccessToken();
  const tenantId = process.env.ST_TENANT_ID;
  const res = await axios.get(
    `https://api.servicetitan.io/memberships/v2/tenant/${tenantId}/memberships/${membershipId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "ST-App-Key": process.env.ST_APP_KEY,
      },
    }
  );
  return res.data;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Derive proactive check months from the membership start date.
 *
 * Ground Club memberships include two visits per year, roughly 6 months apart,
 * starting around the membership start month.
 *
 * Rules (proactive = 1 month before the visit is due):
 *   - Check 1 month = month before the start month  (e.g. starts May → check April)
 *   - Check 2 month = 5 months after the start month (e.g. starts May → check October)
 *
 * If recurring service data is available, use its actual schedule instead.
 */
function calculateCheckMonthsFromStartDate(startDate) {
  if (!startDate) return { coolingCheckMonth: null, heatingCheckMonth: null };

  const start = new Date(startDate);

  const check1 = new Date(start);
  check1.setMonth(check1.getMonth() - 1);

  const check2 = new Date(start);
  check2.setMonth(check2.getMonth() + 5);

  return assignCheckMonthsBySeason(
    MONTH_NAMES[check1.getMonth()],
    MONTH_NAMES[check2.getMonth()]
  );
}

function calculateCheckMonthsFromServices(recurringServices) {
  if (!recurringServices || recurringServices.length === 0) return null;

  const service = recurringServices[0];
  if (!service.from) return null;

  const visit1 = new Date(service.from);
  const interval = service.recurrenceInterval || 6;
  const visit2 = new Date(visit1);
  visit2.setMonth(visit2.getMonth() + interval);

  const check1 = new Date(visit1);
  check1.setMonth(check1.getMonth() - 1);
  const check2 = new Date(visit2);
  check2.setMonth(check2.getMonth() - 1);

  return assignCheckMonthsBySeason(
    MONTH_NAMES[check1.getMonth()],
    MONTH_NAMES[check2.getMonth()]
  );
}

// Proper title case: "JOHN DOE" → "John Doe", handles mixed case and all-caps input
function toTitleCase(str) {
  if (!str) return str;
  return str.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// Title case for addresses — preserves known abbreviations like "NW", "SE", "PO", state codes
function toAddressTitleCase(str) {
  if (!str) return str;
  const abbreviations = new Set(["po", "nw", "ne", "sw", "se", "n", "s", "e", "w"]);
  return str.replace(/\w\S*/g, (w) => {
    const lower = w.toLowerCase();
    return abbreviations.has(lower) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  });
}

// Converts a date string like "2025-04-01" to a calendar month name like "April"
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// Cooling season = March–September (months 3–9)
// Heating season = October–February (months 10–12, 1–2)
function isCoolingMonth(monthIndex) {
  return monthIndex >= 2 && monthIndex <= 8; // 0-indexed: March=2, September=8
}

// Given two month names, assign cooling/heating labels by season
function assignCheckMonthsBySeason(monthA, monthB) {
  const idxA = MONTH_NAMES.indexOf(monthA);
  const idxB = MONTH_NAMES.indexOf(monthB);
  if (isCoolingMonth(idxA)) {
    return { coolingCheckMonth: monthA, heatingCheckMonth: monthB };
  } else {
    return { coolingCheckMonth: monthB, heatingCheckMonth: monthA };
  }
}
function dateToMonthName(dateStr) {
  if (!dateStr) return null;
  const month = parseInt(dateStr.split("-")[1], 10) - 1;
  return MONTH_NAMES[month] || null;
}

// ── Sync a single membership → GHL ────────────────────────────────────────────

async function syncMembership(membership, { dryRun = false } = {}) {
  const customerId = membership.customerId || membership.customer?.id;
  let customerName = membership.customerName || membership.customer?.name || "Unknown Customer";
  const membershipType =
    MEMBERSHIP_TYPE_NAMES[membership.membershipTypeId] ||
    membership.membershipType?.name ||
    membership.type?.name ||
    "Ground Club";
  const status = membership.status || "Active";
  const startDate = membership.from || membership.startDate || "";
  const endDate = membership.to || membership.endDate || "";

  // Skip cancelled/inactive memberships
  if (status && status.toLowerCase() !== "active") {
    console.warn(`[FanClub] Skipping membership ${membership.id} — status is "${status}", not Active`);
    return { membershipId: membership.id, skipped: true, reason: `Status is "${status}"` };
  }

  console.log(`[FanClub] Syncing membership ${membership.id} — ${customerName}`);

  // Try to get full customer details for name, phone, and email
  let phone, email;
  if (customerId) {
    try {
      const customer = await st.getCustomer(customerId);
      if (customer?.name) customerName = customer.name;
    } catch (err) {
      console.warn(`[FanClub] Could not fetch customer ${customerId}:`, err.message);
    }
    try {
      const contacts = await st.getCustomerContacts(customerId);
      const phoneContact = contacts.find((c) =>
        ["Phone", "MobilePhone", "HomePhone", "WorkPhone", "Cell", "Mobile"].includes(c.type)
      );
      const emailContact = contacts.find((c) =>
        ["Email", "email"].includes(c.type)
      );
      phone = phoneContact?.value;
      email = emailContact?.value;
    } catch (err) {
      console.warn(`[FanClub] Could not fetch contacts for customer ${customerId}:`, err.message);
    }
  }

  // Safety guard: skip if we still can't resolve a real name
  if (!customerName || customerName === "Unknown Customer") {
    console.warn(`[FanClub] Skipping membership ${membership.id} — could not resolve customer name (customerId: ${customerId})`);
    return { membershipId: membership.id, skipped: true, reason: "Could not resolve customer name" };
  }

  // Apply proper title case to name (fixes ALL CAPS or inconsistent input)
  customerName = toTitleCase(customerName);

  // Look up the customer's primary service location for address and location ID
  let address1, city, state, postalCode, stLocationId;
  if (customerId) {
    try {
      const locations = await st.getLocationsByCustomer(customerId);
      const primaryLocation = locations[0];
      if (primaryLocation) {
        stLocationId = String(primaryLocation.id || "");
        const addr = primaryLocation.address;
        if (addr) {
          address1 = toAddressTitleCase(addr.street || addr.streetAddress || "");
          city = toTitleCase(addr.city || "");
          state = (addr.state || addr.stateCode || "").toUpperCase();
          postalCode = addr.zip || addr.postalCode || "";
        }
      }
    } catch (err) {
      console.warn(`[FanClub] Could not fetch location for customer ${customerId}:`, err.message);
    }
  }

  // Fetch recurring services — used for visit counts, memo, and check months
  // Check months derived from start date — always available, evenly distributes across the year
  let { coolingCheckMonth, heatingCheckMonth } = calculateCheckMonthsFromStartDate(startDate);

  let totalVisits = null;
  let completedVisits = null;
  let remainingVisits = null;
  let recurringMemo = null;
  let _rawRecurringServices = [];

  try {
    // getRecurringServicesForMembership pages descending until it finds matching records
    const recurringServices = await st.getRecurringServicesForMembership(membership.id);
    _rawRecurringServices = recurringServices;
    if (recurringServices.length > 0) {
      totalVisits = recurringServices.reduce((sum, s) => sum + (s.durationLength || 0), 0);
      completedVisits = recurringServices.filter((s) => s.firstVisitComplete === true).length;
      remainingVisits = totalVisits - completedVisits;
      recurringMemo = recurringServices.find((s) => s.memo)?.memo || null;
      // If recurring service schedule is available, use it for more precise check months
      const serviceMonths = calculateCheckMonthsFromServices(recurringServices);
      if (serviceMonths) {
        coolingCheckMonth = serviceMonths.coolingCheckMonth;
        heatingCheckMonth = serviceMonths.heatingCheckMonth;
      }
    } else {
      // Recurring services not available — estimate from membership duration.
      // Ground Club visits are bi-annual (every 6 months), so duration / 6 = total visits.
      const duration = membership.duration ?? null;
      if (duration) {
        totalVisits = Math.round(duration / 6);
        completedVisits = 0;
        remainingVisits = totalVisits;
      }
    }
  } catch (err) {
    console.warn(`[FanClub] Could not fetch visit data for membership ${membership.id}:`, err.message);
  }

  // Split on the LAST word as lastName so "Anthony & Bobby Ambrosino" →
  // firstName: "Anthony & Bobby", lastName: "Ambrosino"
  const nameParts = customerName.split(" ");
  const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : "";
  const firstName = nameParts.length > 1 ? nameParts.slice(0, -1).join(" ") : customerName;

  const contactPayload = {
    firstName,
    lastName,
    phone: phone || undefined,
    email: email || undefined,
    address1: address1 || undefined,
    city: city || undefined,
    state: state || undefined,
    postalCode: postalCode || undefined,
    customFields: {
      membership_id: String(membership.id || ""),
      membership_fan_club: membershipType,
      fan_club_start_date: startDate ? startDate.split("T")[0] : "",
      membership_start_date: startDate ? startDate.split("T")[0] : "",
      expiration_date: endDate ? endDate.split("T")[0] : "",
      customerid: String(customerId || ""),
      ...(stLocationId && { servicetitan_location_id: stLocationId }),
      ...(coolingCheckMonth && { cooling_check_month: coolingCheckMonth }),
      ...(heatingCheckMonth && { heating_check_month: heatingCheckMonth }),
      ...(totalVisits !== null && { membership_visits_total: String(totalVisits) }),
      ...(remainingVisits !== null && { membership_visits_remaining: String(remainingVisits) }),
      ...(recurringMemo && { notes: recurringMemo }),
    },
  };

  const noteBody = `
🔄 GROUND CLUB MEMBERSHIP SYNC — ServiceTitan

Membership ID: ${membership.id}
Customer: ${customerName}
Type: ${membershipType}
Status: ${status}
Start: ${startDate ? startDate.split("T")[0] : "N/A"}
End: ${endDate ? endDate.split("T")[0] : "N/A"}
Address: ${[address1, city, state, postalCode].filter(Boolean).join(", ") || "N/A"}
ST Location ID: ${stLocationId || "N/A"}

❄️ Cooling Check Month: ${coolingCheckMonth || "N/A"}
🔥 Heating Check Month: ${heatingCheckMonth || "N/A"}

Visits Total: ${totalVisits ?? "N/A"}
Visits Completed: ${completedVisits ?? "N/A"}
Visits Remaining: ${remainingVisits ?? "N/A"}

Automatically synced from ServiceTitan Ground Club memberships.
  `.trim();

  // Dry run — return preview without touching GHL
  if (dryRun) {
    console.log(`[FanClub] DRY RUN — skipping GHL writes for membership ${membership.id}`);
    return {
      dryRun: true,
      membershipId: membership.id,
      name: customerName,
      address: { address1, city, state, postalCode },
      stLocationId,
      coolingCheckMonth,
      heatingCheckMonth,
      visits: { total: totalVisits, completed: completedVisits, remaining: remainingVisits },
      debug: {
        recurringServicesCount: _rawRecurringServices.length,
        recurringServicesSample: _rawRecurringServices.slice(0, 3),
      },
      wouldSendToGHL: {
        contactPayload,
        tags: ["Ground Club Member", membershipType],
        workflowId: process.env.GHL_GROUND_CLUB_WORKFLOW_ID || "(not set)",
        note: noteBody,
      },
    };
  }

  const { contact, created } = await ghl.createOrUpdateContact(contactPayload);

  console.log(`[FanClub] Contact ${created ? "created" : "updated"}: ${contact.id}`);

  // Tag the contact
  await ghl.addTagToContact(contact.id, ["Ground Club Member", membershipType]);

  // Trigger Ground Club workflow if set
  if (process.env.GHL_GROUND_CLUB_WORKFLOW_ID) {
    await ghl.triggerWorkflow(contact.id, process.env.GHL_GROUND_CLUB_WORKFLOW_ID);
  } else {
    console.warn("[FanClub] GHL_GROUND_CLUB_WORKFLOW_ID not set — skipping workflow trigger");
  }

  await ghl.addNoteToContact(contact.id, noteBody);

  return {
    membershipId: membership.id,
    contactId: contact.id,
    name: customerName,
    address: { address1, city, state, postalCode },
    stLocationId,
    coolingCheckMonth,
    heatingCheckMonth,
    visits: { total: totalVisits, completed: completedVisits, remaining: remainingVisits },
    created,
  };
}

// ── Patch check months on an existing GHL contact ─────────────────────────────
// Uses the direct GHL API (not the webhook) to update just the two check month
// fields on a contact that was already imported. Useful when the initial webhook
// import didn't map those fields.

async function patchCheckMonthsForMembership(membershipId) {
  let membership;
  try {
    membership = await getMembershipById(membershipId);
  } catch (err) {
    return { membershipId, skipped: true, reason: `Could not fetch membership: ${err.response?.data?.title || err.message}` };
  }

  const startDate = membership.from || membership.startDate || "";
  const customerId = membership.customerId || membership.customer?.id;

  // Calculate check months from start date (always available)
  let { coolingCheckMonth, heatingCheckMonth } = calculateCheckMonthsFromStartDate(startDate);

  // Try to get more precise months from recurring services
  try {
    const recurringServices = await st.getRecurringServicesForMembership(membership.id);
    if (recurringServices.length > 0) {
      const serviceMonths = calculateCheckMonthsFromServices(recurringServices);
      if (serviceMonths) {
        coolingCheckMonth = serviceMonths.coolingCheckMonth;
        heatingCheckMonth = serviceMonths.heatingCheckMonth;
      }
    }
  } catch (_) {
    // fall back to start-date calculation — already set above
  }

  if (!coolingCheckMonth || !heatingCheckMonth) {
    return { membershipId, skipped: true, reason: "Could not calculate check months (no start date?)" };
  }

  // Find the GHL contact by phone, then email
  let phone, email;
  if (customerId) {
    try {
      const contacts = await st.getCustomerContacts(customerId);
      const phoneContact = contacts.find((c) =>
        ["Phone", "MobilePhone", "HomePhone", "WorkPhone", "Cell", "Mobile"].includes(c.type)
      );
      const emailContact = contacts.find((c) => ["Email", "email"].includes(c.type));
      phone = phoneContact?.value;
      email = emailContact?.value;
    } catch (_) {}
  }

  let ghlContact = null;
  if (phone)  ghlContact = await ghl.findContactByPhone(phone).catch(() => null);
  if (!ghlContact && email) ghlContact = await ghl.findContactByEmail(email).catch(() => null);

  if (!ghlContact) {
    return { membershipId, skipped: true, reason: "No matching GHL contact found (phone/email not in GHL)" };
  }

  // Find the opportunity attached to this contact and update its fields
  const opportunities = await ghl.searchOpportunitiesByContact(ghlContact.id).catch(() => []);

  if (opportunities.length === 0) {
    return { membershipId, contactId: ghlContact.id, skipped: true, reason: "No opportunity found for this contact in GHL" };
  }

  // Update all opportunities on the contact (usually just one for Ground Club)
  let updatedCount = 0;
  for (const opp of opportunities) {
    await ghl.updateOpportunityFields(opp.id, {
      cooling_check_month: coolingCheckMonth,
      heating_check_month: heatingCheckMonth,
    });
    updatedCount++;
  }

  console.log(`[FanClub] Patched check months for membership ${membershipId} → ${updatedCount} opportunity(s) on contact ${ghlContact.id} — ❄️ ${coolingCheckMonth} 🔥 ${heatingCheckMonth}`);

  return {
    membershipId,
    contactId: ghlContact.id,
    opportunitiesUpdated: updatedCount,
    coolingCheckMonth,
    heatingCheckMonth,
    updated: true,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

async function previewFanClubs({ activeOnly = true } = {}) {
  const memberships = await getAllMemberships({ activeOnly });
  return {
    total: memberships.length,
    memberships: memberships.map((m) => ({
      id: m.id,
      customer: m.customerName || m.customer?.name,
      type: m.membershipType?.name || m.type?.name || "Ground Club",
      status: m.status,
      from: m.from || m.startDate,
      to: m.to || m.endDate,
    })),
  };
}

async function syncFanClubs({ activeOnly = true } = {}) {
  const memberships = await getAllMemberships({ activeOnly });
  console.log(`[FanClub] Syncing ${memberships.length} membership(s) to GHL`);

  const results = [];
  for (const membership of memberships) {
    try {
      const result = await syncMembership(membership);
      results.push(result);
    } catch (err) {
      console.error(`[FanClub] Error syncing membership ${membership.id}:`, err.response?.data || err.message);
      results.push({ membershipId: membership.id, error: err.message });
    }
  }

  return results;
}

/**
 * Sync just one membership (the first active one) for testing purposes.
 * Runs synchronously and returns full result detail.
 */
async function syncOneMembership({ membershipId, activeOnly = true, dryRun = true } = {}) {
  let membership;

  if (membershipId) {
    // Fetch a specific membership by ID
    try {
      membership = await getMembershipById(membershipId);
    } catch (err) {
      return { error: `Could not find membership ID ${membershipId}: ${err.response?.data?.title || err.message}` };
    }
  } else {
    // Fall back to first active membership
    const data = await getMemberships({ activeOnly, page: 1, pageSize: 1 });
    const memberships = data.data || [];
    if (memberships.length === 0) {
      return { error: "No memberships found to test with" };
    }
    membership = memberships[0];
  }

  console.log(`[FanClub] TEST SYNC — running single membership ${membership.id}${dryRun ? " (DRY RUN)" : ""}`);

  try {
    const result = await syncMembership(membership, { dryRun });
    return { tested: true, dryRun, membership: { id: membership.id, raw: membership }, result };
  } catch (err) {
    return { tested: false, dryRun, membership: { id: membership.id, raw: membership }, error: err.response?.data || err.message };
  }
}

module.exports = { previewFanClubs, syncFanClubs, syncOneMembership, patchCheckMonthsForMembership, getAllMemberships, MEMBERSHIP_TYPE_NAMES };
