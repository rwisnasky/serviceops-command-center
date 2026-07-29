/**
 * src/demo/seed.js
 *
 * Populates the SQLite database with data consistent with the generated demo
 * world (src/demo/world.js) so every DB-backed page in the dashboard has
 * convincing content in DEMO_MODE.
 *
 * Design rules (all load-bearing — see docs/MOCK_SPEC_DATABASE.md):
 *
 *   1. **Deterministic.** Everything derives from the seeded RNG in ./rng.js.
 *      No Math.random(), ever. Re-seeding a fresh DB from the same DEMO_SEED
 *      produces byte-identical rows, so screenshots and deep links stay valid.
 *
 *   2. **Idempotent.** A marker row in kv_store (`demo_seeded_at`) guards the
 *      whole run. Second invocation is a no-op; `--force` wipes the seeded
 *      tables and rewrites them. `users` and `sessions` are never touched.
 *
 *   3. **Timestamp convention.** Columns that mirror SQLite's `datetime('now')`
 *      default (created_at / updated_at / checked_at / …) are written as
 *      `YYYY-MM-DD HH:MM:SS` in **UTC, space-separated, no trailing Z** —
 *      because several front-ends do `str.replace(" ","T") + "Z"` before
 *      `new Date()`. Columns the app itself writes as ISO-8601 (call
 *      `timestamp`, punch `clock_in`/`clock_out`, ST completion dates) stay
 *      full ISO with the Z. Mixing these up renders "Invalid Date" everywhere.
 *
 *   4. **Booleans are INTEGER 0/1**, and every JSON blob column holds real,
 *      parseable JSON in the exact shape the reading code expects.
 *
 *   5. **No real people.** Names come from the catalog's combinatorial pools;
 *      every phone number lives in the 555-01XX fiction block.
 *
 * Usage:
 *   npm run demo:seed            # seed once (no-op if already seeded)
 *   npm run demo:seed -- --force # wipe the seeded tables and rewrite
 *
 * Programmatic:
 *   const { seedDemoDatabase } = require("./demo/seed");
 *   seedDemoDatabase(getDb());
 */

const crypto = require("crypto");
const { Rng, ROOT_SEED } = require("./rng");
const C = require("./catalog");
const { getWorld } = require("./world");
const installCfg = require("../config/installTrackerJobTypes");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEED_MARKER_KEY = "demo_seeded_at";

/** Tables this seeder owns. `--force` clears exactly these, in this order. */
const SEEDED_TABLES = [
  "processed_calls",
  "employee_phones",
  "fleet_technicians",
  "known_addresses",
  "install_tracker",
  "job_review_status",
  "job_review_notes",
  "timesheets",
  "timesheet_balances",
  "time_punches",
  "pricebook_index",
  "pricebook_sync_log",
  "installed_equipment_registrations",
  "video_uploads",
  "invoice_uploads",
  "scope_estimate_uploads",
  "pricebook_merge_log",
  "pricebook_rename_log",
  "address_audit_cache",
  "app_settings",
];

/** kv_store keys the seeder owns (kv_store is shared with the pollers). */
const SEEDED_KV_KEYS = [
  SEED_MARKER_KEY,
  "call_poll_last_run",
  "forms_poll_last_run",
  "happy_review_paused",
  "calls_last_reviewed_at",
];

const DAY_MS = 86400000;
const CALL_WINDOW_DAYS = 60;

// ---------------------------------------------------------------------------
// Time / format helpers
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");

/** `YYYY-MM-DD HH:MM:SS` in UTC — the app's `datetime('now')` convention. */
function sqlTs(d) {
  const t = new Date(d);
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`
  );
}

/** Full ISO-8601 with the Z — for columns the app writes as ISO. */
function isoZ(d) {
  return new Date(d).toISOString();
}

/** `YYYY-MM-DD` (UTC). */
function ymd(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function addDays(d, n) {
  return new Date(new Date(d).getTime() + n * DAY_MS);
}

function addMinutes(d, n) {
  return new Date(new Date(d).getTime() + n * 60000);
}

/** Seconds → "HH:MM:SS" (the shape the calls UI parses out of leadCall.duration). */
function hms(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** "(614) 555-0123" → "6145550123" (10-digit, leading 1 stripped). */
function digits10(phone) {
  let s = String(phone || "").replace(/\D/g, "");
  if (s.length === 11 && s[0] === "1") s = s.slice(1);
  return s;
}

/** Mirrors normalizeAddr() in src/routes/fleet.js — trip tagging depends on it. */
function normalizeAddr(a) {
  return String(a || "")
    .toLowerCase()
    .replace(/[,.]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\busa\b/g, "")
    .trim();
}

/** Mirrors fingerprintAddress() in src/db/addressCacheRepository.js. */
function normalizePart(s) {
  return String(s || "").toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
}
function fingerprintAddress(addr = {}) {
  const joined = [
    normalizePart(addr.street),
    normalizePart(addr.unit),
    normalizePart(addr.city),
    normalizePart(addr.state),
    String(addr.zip || "").slice(0, 5),
  ].join("|");
  return crypto.createHash("sha1").update(joined).digest("hex").slice(0, 16);
}

/** Mirrors tokenize()/tokenString() in src/services/pricebookIndexService.js. */
function tokenString(...parts) {
  const seen = new Set();
  for (const p of parts) {
    if (!p) continue;
    String(p)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2)
      .forEach((t) => seen.add(t));
  }
  return [...seen].join(" ");
}

function formatAddress(a = {}) {
  const line1 = [a.street, a.unit].filter(Boolean).join(" ");
  return `${line1}, ${a.city}, ${a.state} ${a.zip}`;
}

function firstNameOf(name) {
  return String(name || "").split(" ")[0];
}

function lastNameOf(name) {
  return String(name || "").split(" ").slice(1).join(" ") || "";
}

/** The Wednesday on or before `d` (pay periods run Wed → Tue). */
function wednesdayOnOrBefore(d) {
  const t = new Date(Date.UTC(new Date(d).getUTCFullYear(), new Date(d).getUTCMonth(), new Date(d).getUTCDate()));
  const back = (t.getUTCDay() - 3 + 7) % 7;
  return addDays(t, -back);
}

// ---------------------------------------------------------------------------
// Call content — transcripts + AI recaps for Grounded Home Services
// ---------------------------------------------------------------------------

/**
 * The category vocabulary the /calls UI renders and callClassificationSync maps
 * to ServiceTitan call types. Staying inside this list keeps the category
 * dropdown, the ST sync badge, and the label renderer all in agreement.
 */
const CATEGORY_CALL_TYPE = {
  job_callback: "NotLead",
  unbooked_call: "Unbooked",
  scheduling_request: "Unbooked",
  new_service_request: "Unbooked",
  emergency_request: "Unbooked",
  estimate_followup: "Unbooked",
  warranty_concern: "NotLead",
  membership_question: "NotLead",
  payment_billing: "NotLead",
  complaint: "NotLead",
  compliment: "NotLead",
  spam_robocall: "Excused",
  wrong_number: "Excused",
  internal_call: "Excused",
  recruiting_call: "Excused",
  other: "Excused",
};

/** world.callReasons name → { kind, category } for the transcript generator. */
const REASON_SCENARIO = {
  "No Heat": { kind: "no_heat", category: "emergency_request" },
  "No Cool": { kind: "no_cool", category: "emergency_request" },
  "Service - Repair": { kind: "repair", category: "new_service_request" },
  "Maintenance Visit": { kind: "maintenance", category: "scheduling_request" },
  "Estimate Request": { kind: "estimate", category: "estimate_followup" },
  "Water Heater": { kind: "water_heater", category: "new_service_request" },
  "Drain / Sewer": { kind: "drain", category: "new_service_request" },
  "Membership Signup": { kind: "membership", category: "membership_question" },
  Reschedule: { kind: "reschedule", category: "scheduling_request" },
  "ETA Check": { kind: "eta", category: "job_callback" },
  "Billing Question": { kind: "billing", category: "payment_billing" },
  "Vendor/marketing": { kind: "vendor", category: "other" },
  "Employee - Internal": { kind: "internal", category: "internal_call" },
  "Warranty Question": { kind: "warranty", category: "warranty_concern" },
  "Price Too High": { kind: "price_shopper", category: "unbooked_call" },
  "Scheduling Conflict": { kind: "conflict", category: "unbooked_call" },
  "Out of Service Area": { kind: "out_of_area", category: "other" },
  "Wrong Number": { kind: "wrong_number", category: "wrong_number" },
  Solicitation: { kind: "solicitation", category: "spam_robocall" },
  "Hung Up": { kind: "hangup", category: "other" },
};

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const HEATING_UNITS = [
  "the furnace in the basement",
  "the heat pump out back",
  "the boiler in the utility room",
  "the upstairs unit",
];

const PLUMBING_ISSUES = [
  "the kitchen sink is backing up",
  "there's water pooling under the water heater",
  "the downstairs toilet keeps running",
  "the main line is draining slow",
  "the outside spigot is dripping bad",
];

/**
 * Build a transcript + AI recap for one call.
 * Returns { transcript, bullets, summary, sentiment, recommendedAction, isJobRelated }.
 */
function buildCallContent(kind, ctx) {
  const { rng, agent, caller, city, tech, day, jobNumber, amount, employee, company } = ctx;
  const A = (line) => `Agent: ${line}`;
  const K = (line) => `Caller: ${line}`;
  const open = A(`Thanks for calling ${company}, this is ${agent}. How can I help you today?`);
  const close = A(`You're all set — you'll get a text confirmation from ${company} shortly. Thanks for calling.`);
  const join = (...lines) => lines.filter(Boolean).join("\n");

  switch (kind) {
    case "no_heat": {
      const unit = rng.pick(HEATING_UNITS);
      return {
        transcript: join(
          open,
          K(`Hi, yeah — we've got no heat at all. ${unit.charAt(0).toUpperCase() + unit.slice(1)} is blowing cold air.`),
          A(`I'm sorry, that's no fun this time of year. Can I get the name and address on the account?`),
          K(`${caller}, over in ${city}.`),
          A(`Perfect, I've got you. Has the thermostat got a call for heat? Any lights blinking on the unit?`),
          K(`Thermostat's set to 70 and the house is at 61. There's a little light flashing three times.`),
          A(`That's usually a pressure switch or flame sensor code — nothing a tech can't sort out on site. I can get ${tech} to you ${day} between 8 and 10.`),
          K(`That works. How much is the visit?`),
          A(`The diagnostic is $129, and that gets applied toward the repair if you approve the work.`),
          K(`Okay, book it.`),
          close
        ),
        bullets: [
          `${caller} in ${city} has no heat — system blowing cold with a 3-flash fault code.`,
          `Diagnostic quoted at $129, applied toward the repair if approved.`,
          `Booked with ${tech} for ${day}, 8-10 AM arrival window.`,
        ],
        summary: `No-heat call from ${caller} in ${city}. System running but blowing cold with a 3-flash code. Booked a diagnostic with ${tech} for ${day} morning.`,
        sentiment: rng.chance(0.5) ? "negative" : "neutral",
        recommendedAction: "Confirm the arrival window and add the fault code to the job notes.",
        isJobRelated: true,
      };
    }
    case "no_cool": {
      return {
        transcript: join(
          open,
          K(`Our air conditioning quit sometime last night. It's already 79 in here.`),
          A(`Let's get somebody out. Is this ${caller} over in ${city}?`),
          K(`That's me.`),
          A(`Is the outdoor unit running at all — any humming, or is it completely quiet?`),
          K(`The fan on the outside isn't spinning. Inside is blowing but it's just warm air.`),
          A(`Sounds like it could be the capacitor — that's a common one and usually same-day. I have ${tech} finishing up nearby, I can put you on for ${day} afternoon.`),
          K(`Please. We've got a baby in the house.`),
          A(`Understood, I'll flag it as priority for dispatch. Diagnostic is $129 and applies to the repair.`),
          K(`That's fine.`),
          close
        ),
        bullets: [
          `${caller} lost cooling overnight — outdoor fan not spinning, indoor blowing warm.`,
          `Likely capacitor failure; CSR flagged the job as priority (infant in the home).`,
          `Booked with ${tech} for ${day} afternoon at the $129 diagnostic.`,
        ],
        summary: `No-cool call from ${caller}. Condenser fan is not running, indoor unit blowing warm. Booked ${tech} for ${day} afternoon and flagged priority.`,
        sentiment: "negative",
        recommendedAction: "Dispatch same-day if a slot opens; note the priority flag on the job.",
        isJobRelated: true,
      };
    }
    case "repair": {
      const issue = rng.pick([
        "the furnace is making a grinding noise when it starts up",
        "the AC is short cycling — kicks on for two minutes then shuts off",
        "there's water dripping from the ceiling under the attic unit",
        "the thermostat screen went blank",
      ]);
      return {
        transcript: join(
          open,
          K(`Hi, I need somebody to come look at a system — ${issue}.`),
          A(`Sure. Name and service address?`),
          K(`${caller}, ${city}.`),
          A(`Great, I see you in the system. When did it start?`),
          K(`Couple of days ago. It's not an emergency but I'd like it looked at this week.`),
          A(`I can do ${day}. ${tech} would be the tech — he's been out to you before.`),
          K(`Perfect.`),
          A(`Diagnostic is $129 and goes toward the repair. Anything else going on with the system I should note?`),
          K(`No, that's it.`),
          close
        ),
        bullets: [
          `${caller} reports ${issue}.`,
          `Non-emergency — customer asked for a visit this week.`,
          `Booked with ${tech} for ${day}; $129 diagnostic applied to the repair.`,
        ],
        summary: `Repair request from ${caller} — ${issue}. Booked ${tech} for ${day}.`,
        sentiment: "neutral",
        recommendedAction: "Add the symptom description to the job so the tech arrives stocked.",
        isJobRelated: true,
      };
    }
    case "maintenance": {
      return {
        transcript: join(
          open,
          K(`Hi, I'm on the Ground Club plan and I think I'm due for my tune-up.`),
          A(`Let me pull that up. ${caller}, correct?`),
          K(`Yes.`),
          A(`You are — your cooling visit is due. That's covered under your membership, no charge.`),
          K(`Great. Mornings are better for me.`),
          A(`I have ${day} at 8 AM with ${tech}.`),
          K(`Book it. And does that cover the filter?`),
          A(`One standard filter is included, yes.`),
          close
        ),
        bullets: [
          `${caller} called to schedule the Ground Club maintenance visit that's now due.`,
          `Visit is dues-covered — no charge, one standard filter included.`,
          `Scheduled ${day} at 8 AM with ${tech}.`,
        ],
        summary: `Membership maintenance visit scheduled for ${caller} on ${day} with ${tech}. Dues-covered, no invoice expected.`,
        sentiment: "positive",
        recommendedAction: "No follow-up needed — dues-covered visit, do not flag as a missed invoice.",
        isJobRelated: true,
      };
    }
    case "estimate": {
      return {
        transcript: join(
          open,
          K(`I'd like to get a quote on replacing our furnace and AC. The system's about twenty years old.`),
          A(`Happy to set that up. Is the home in ${city}?`),
          K(`Yes, ${caller} is the name.`),
          A(`Twenty years is right about the age where a replacement makes sense. Our comfort advisor does a free in-home assessment — takes about an hour, and you'll leave with options and financing numbers.`),
          K(`Is there a charge for the visit?`),
          A(`No charge for the estimate.`),
          K(`Then let's do it. ${day} works.`),
          A(`Booked. Do you know the square footage offhand?`),
          K(`About 1,900.`),
          close
        ),
        bullets: [
          `${caller} requested a replacement quote on a ~20 year old furnace and AC.`,
          `Free in-home assessment booked for ${day}; roughly 1,900 sq ft home.`,
          `Customer asked about financing — bring the buy-down sheet.`,
        ],
        summary: `Estimate request from ${caller} for a full system changeout. Free in-home consultation booked for ${day}.`,
        sentiment: "positive",
        recommendedAction: "Assign a comfort advisor and attach the financing options to the estimate.",
        isJobRelated: true,
      };
    }
    case "water_heater": {
      return {
        transcript: join(
          open,
          K(`Our water heater is leaking — there's water all around the base of it.`),
          A(`Have you shut the water off to it?`),
          K(`Not yet.`),
          A(`Let's do that first. There's a valve on the cold line coming into the top of the tank — turn it clockwise until it stops.`),
          K(`Okay... got it. It's off.`),
          A(`Good. If the tank itself is leaking it'll need replaced rather than repaired. How old is it?`),
          K(`Twelve years maybe?`),
          A(`That's about the end of the road for a tank. I'll send ${tech} out ${day} to confirm and quote a replacement.`),
          K(`Thank you, that was helpful.`),
          close
        ),
        bullets: [
          `${caller} has a leaking water heater — roughly 12 years old, tank likely failed.`,
          `CSR walked the customer through shutting off the cold inlet before the visit.`,
          `${tech} scheduled ${day} to confirm and quote a replacement.`,
        ],
        summary: `Leaking water heater at ${caller}'s home in ${city}. Water shut off over the phone; ${tech} out ${day} to quote a replacement.`,
        sentiment: "neutral",
        recommendedAction: "Have the tech bring replacement pricing — a quote is expected on this visit.",
        isJobRelated: true,
      };
    }
    case "drain": {
      const issue = rng.pick(PLUMBING_ISSUES);
      return {
        transcript: join(
          open,
          K(`Hi — ${issue}. I've tried a plunger and a bottle of drain cleaner, nothing.`),
          A(`We can get that cleared. Is this ${caller} in ${city}?`),
          K(`Yep.`),
          A(`Is it just the one fixture, or is more than one backing up?`),
          K(`Just the one so far.`),
          A(`Good — that usually means it's local to the branch line and not the main. Drain clearing starts at $295. I can have ${tech} there ${day}.`),
          K(`Let's do it.`),
          close
        ),
        bullets: [
          `${caller} reports ${issue}; home remedies already tried.`,
          `Single fixture affected — likely a branch line, not the main.`,
          `Drain clearing booked with ${tech} for ${day}, starting at $295.`,
        ],
        summary: `Drain call from ${caller} — ${issue}. Booked ${tech} for ${day}.`,
        sentiment: "neutral",
        recommendedAction: "If the branch clears but the main is suspect, offer the camera inspection.",
        isJobRelated: true,
      };
    }
    case "membership": {
      return {
        transcript: join(
          open,
          K(`Your tech mentioned a maintenance plan when he was out. Can you tell me what's in it?`),
          A(`Sure. The Ground Club is $219 a year. You get two tune-ups — one heating, one cooling — priority scheduling ahead of non-members, and 15% off repairs.`),
          K(`Does it cover the diagnostic fee?`),
          A(`It doesn't waive it, but the 15% applies to the repair total, and members skip the after-hours surcharge.`),
          K(`Okay, sign me up. Can you use the card you have on file?`),
          A(`I can. I'll get that set up and schedule your first visit.`),
          close
        ),
        bullets: [
          `${caller} signed up for the Ground Club membership at $219/year after a tech referral.`,
          `Plan includes two tune-ups, priority scheduling and 15% off repairs.`,
          `Charged to the card on file; first visit to be scheduled.`,
        ],
        summary: `Membership signup for ${caller}. Ground Club annual plan sold at $219, billed to the card on file.`,
        sentiment: "positive",
        recommendedAction: "Create the membership in ServiceTitan and schedule visit one.",
        isJobRelated: true,
      };
    }
    case "reschedule": {
      return {
        transcript: join(
          open,
          K(`I have somebody coming out ${day} and I need to move it — work blew up on me.`),
          A(`No problem at all. Can I get your name?`),
          K(`${caller}.`),
          A(`Got it, job ${jobNumber}. What day works better?`),
          K(`Anything late next week.`),
          A(`I can do Thursday afternoon, 1 to 3.`),
          K(`That's better, thanks.`),
          A(`Moved. You'll get a new confirmation text.`),
          close
        ),
        bullets: [
          `${caller} called to reschedule job ${jobNumber} — work conflict.`,
          `Moved to Thursday afternoon, 1-3 PM window.`,
          `No pricing or scope changes discussed.`,
        ],
        summary: `Reschedule request on job ${jobNumber} for ${caller}. Moved to Thursday afternoon.`,
        sentiment: "neutral",
        recommendedAction: "Confirm dispatch picked up the new window on job " + jobNumber + ".",
        isJobRelated: true,
      };
    }
    case "eta": {
      return {
        transcript: join(
          open,
          K(`Hi, I'm just checking on the technician — my window was 10 to 12 and it's about quarter after.`),
          A(`Let me look. ${caller}, job ${jobNumber}?`),
          K(`That's it.`),
          A(`${tech} is wrapping up a call ahead of you. He's about twenty-five minutes out. I'm sorry about the wait.`),
          K(`That's fine, I just needed to know whether to leave for lunch.`),
          A(`I'd stay put — he'll call when he's on the way.`),
          K(`Appreciate it.`),
          close
        ),
        bullets: [
          `${caller} called for an ETA on job ${jobNumber} after the window slipped.`,
          `${tech} is about 25 minutes out, finishing the prior call.`,
          `Customer was fine with the delay once informed.`,
        ],
        summary: `ETA check on job ${jobNumber}. Customer advised ${tech} is ~25 minutes out.`,
        sentiment: "neutral",
        recommendedAction: "No action — informational call about an existing job.",
        isJobRelated: true,
      };
    }
    case "billing": {
      return {
        transcript: join(
          open,
          K(`I got an invoice for $${amount} and I'm not clear what the second line item is.`),
          A(`Let me pull that up. ${caller}, job ${jobNumber} — that's the diagnostic plus the capacitor replacement.`),
          K(`I thought the diagnostic got waived if I did the repair.`),
          A(`It gets applied toward the repair, not waived — so the repair price already reflects it. Let me walk down the invoice with you.`),
          K(`Okay... alright, that makes sense now. I misread it.`),
          A(`Happy to clear it up. Would you like me to email a copy with the notes?`),
          K(`Yes please.`),
          close
        ),
        bullets: [
          `${caller} questioned a $${amount} invoice on job ${jobNumber}.`,
          `Confusion was over the diagnostic being applied rather than waived.`,
          `Resolved on the call; emailed a copy of the invoice with notes.`,
        ],
        summary: `Billing question on job ${jobNumber}. Explained how the diagnostic is applied toward the repair; customer satisfied.`,
        sentiment: "neutral",
        recommendedAction: "No action — billing question resolved on the call.",
        isJobRelated: true,
      };
    }
    case "vendor": {
      return {
        transcript: join(
          A(`${company}, this is ${agent}.`),
          K(`Hey ${agent}, it's the counter — I've got a will-call ready and I need a card authorization to release it.`),
          A(`Which PO is that on?`),
          K(`Should be a condenser fan motor and a couple of capacitors.`),
          A(`Got it. Let me get the card on file authorized and I'll call you right back with the approval number.`),
          K(`Perfect, thanks.`)
        ),
        bullets: [
          `Supply house called for a card authorization to release a will-call order.`,
          `Order is a condenser fan motor plus capacitors on an open PO.`,
          `${agent} is calling back with the authorization number.`,
        ],
        summary: `Vendor call — supply house requesting card authorization to release a will-call parts order.`,
        sentiment: "neutral",
        recommendedAction: "No action — vendor call, not a lead.",
        isJobRelated: false,
      };
    }
    case "internal": {
      const who = employee || "one of the techs";
      return {
        transcript: join(
          A(`${company}, this is ${agent}.`),
          K(`Hey, it's ${who}. I'm at the ${rng.pick(["Ridgemont", "Cedar Hollow", "Northgate"])} call and I need a part off truck ${rng.int(12, 35)}.`),
          A(`What are you looking for?`),
          K(`Inducer motor. Mine's the wrong flange.`),
          A(`Let me see who's close. ${tech} is fifteen minutes from you — I'll have him swing it by.`),
          K(`Appreciate it. Also, push my last call to tomorrow if you can, I'm going to run long here.`),
          A(`I'll let dispatch know.`)
        ),
        bullets: [
          `Internal call from ${who} — needs an inducer motor off another truck.`,
          `${tech} is nearby and will run the part over.`,
          `Asked dispatch to push the last call of the day to tomorrow.`,
        ],
        summary: `Employee call from ${who} requesting a part transfer and a schedule adjustment.`,
        sentiment: "neutral",
        recommendedAction: "No action — internal employee call, not a customer lead.",
        isJobRelated: false,
      };
    }
    case "warranty": {
      return {
        transcript: join(
          open,
          K(`You put my furnace in a couple of years ago and the ignitor already went out. Is that under warranty?`),
          A(`Let me check the registration. ${caller}, ${city} — yes, you're covered on parts through the manufacturer, and our labor warranty ran a year.`),
          K(`So the part is free but I pay labor?`),
          A(`That's right. The part comes at no charge, labor is billed at our standard rate.`),
          K(`I thought the whole thing was covered for five years.`),
          A(`I understand the confusion — the five year term is the parts warranty. Let me get ${tech} out ${day} and I'll have him go over the coverage with you in person.`),
          K(`Fine.`),
          close
        ),
        bullets: [
          `${caller} called about an ignitor failure on a furnace installed two years ago.`,
          `Parts are covered by the manufacturer; labor warranty expired at one year.`,
          `Customer expected full coverage — ${tech} booked ${day} to explain and replace.`,
        ],
        summary: `Warranty question from ${caller}. Part is covered, labor is not; customer mildly frustrated. Visit booked ${day}.`,
        sentiment: "negative",
        recommendedAction: "Verify the registration on file and note the coverage explanation on the job.",
        isJobRelated: true,
      };
    }
    case "price_shopper": {
      return {
        transcript: join(
          open,
          K(`Yeah, I'm calling around for a price on replacing a 3 ton AC unit. What do you charge?`),
          A(`It depends on the equipment and what the existing setup looks like — we'd do a free in-home assessment and give you exact numbers.`),
          K(`I don't want a sales visit, I just want a ballpark.`),
          A(`Understood. A straight condenser changeout typically lands between $5,800 and $7,200 installed depending on efficiency.`),
          K(`Okay. The other place quoted me $4,900 over the phone.`),
          A(`That may not include the permit or the line set — I'd want to see the scope before I said it was comparable.`),
          K(`I'll think about it.`),
          A(`If you'd like the free assessment, we can get you on the schedule this week.`),
          K(`Not right now. Thanks.`)
        ),
        bullets: [
          `Caller shopping phone quotes for a 3 ton condenser replacement.`,
          `Given a $5,800-$7,200 range; a competitor quoted $4,900 over the phone.`,
          `Declined the free in-home assessment — no appointment booked.`,
        ],
        summary: `Price shopper on a 3 ton AC changeout. Quoted a range, lost to a lower phone quote. No appointment booked.`,
        sentiment: "neutral",
        recommendedAction: "Add to the follow-up list — worth a call back with financing options.",
        isJobRelated: false,
      };
    }
    case "conflict": {
      return {
        transcript: join(
          open,
          K(`I need somebody today. Is that possible?`),
          A(`Let me look at the board... today is full. The earliest I have is ${day}.`),
          K(`That doesn't work, I'm out of town after tomorrow.`),
          A(`I can put you on the cancellation list — if something opens up this afternoon I'll call you first.`),
          K(`Okay, but if it doesn't I'll have to call someone else.`),
          A(`I understand. Let me take your number just in case.`),
          K(`Sure.`)
        ),
        bullets: [
          `Caller needed same-day service; the board was full.`,
          `Earliest available was ${day}, which didn't fit the customer's travel.`,
          `Added to the cancellation list — no appointment booked.`,
        ],
        summary: `Scheduling conflict — customer needed same-day, nothing available. Placed on the cancellation list.`,
        sentiment: "negative",
        recommendedAction: "Call back first if a slot opens today; this one is recoverable.",
        isJobRelated: false,
      };
    }
    case "out_of_area": {
      return {
        transcript: join(
          open,
          K(`Do you all service ${rng.pick(["Marysville", "Bellefontaine", "Newark", "Zanesville"])}?`),
          A(`We don't get out that far, unfortunately — our service area runs about a thirty mile radius of ${city}.`),
          K(`Figures. Know anybody out this way?`),
          A(`I can give you the name of a shop we trade parts with. They're good people.`),
          K(`That'd be great, thanks.`)
        ),
        bullets: [
          `Caller is outside the service area — beyond the 30 mile radius.`,
          `Referred to a partner shop that covers that territory.`,
          `Not a lead.`,
        ],
        summary: `Out of service area call. Referred the caller to a partner company.`,
        sentiment: "neutral",
        recommendedAction: "No action — outside the service area.",
        isJobRelated: false,
      };
    }
    case "wrong_number": {
      return {
        transcript: join(
          A(`${company}, this is ${agent}.`),
          K(`Is this the pharmacy?`),
          A(`No ma'am, this is ${company} — plumbing, heating and cooling.`),
          K(`Oh, I'm sorry.`),
          A(`No trouble at all. Have a good one.`)
        ),
        bullets: [
          `Wrong number — the caller was trying to reach a pharmacy.`,
          `Call lasted under a minute.`,
          `No customer record and no follow-up needed.`,
        ],
        summary: `Wrong number. Caller was trying to reach a pharmacy.`,
        sentiment: "neutral",
        recommendedAction: "No action — wrong number.",
        isJobRelated: false,
      };
    }
    case "solicitation": {
      return {
        transcript: join(
          A(`${company}, this is ${agent}.`),
          K(`Hi, am I speaking with the owner? I'm calling about your Google Business listing — our records show it's unverified and may be removed.`),
          A(`We manage our own listing, thanks.`),
          K(`I understand, but if I could take just two minutes to show you where you rank—`),
          A(`We're not interested. Please take us off the list.`),
          K(`Certainly, have a nice—`)
        ),
        bullets: [
          `Cold sales call about a supposedly unverified Google Business listing.`,
          `Classic listing-scam script; caller pushed after being declined.`,
          `Asked to be removed from the call list.`,
        ],
        summary: `Solicitation call — Google listing sales pitch. Declined and asked to be removed.`,
        sentiment: "negative",
        recommendedAction: "Mark as spam; no customer follow-up.",
        isJobRelated: false,
      };
    }
    case "hangup": {
      return {
        transcript: join(
          A(`Thanks for calling ${company}, this is ${agent}. How can I help you?`),
          K(`[no response]`),
          A(`Hello? This is ${company}, can you hear me?`),
          K(`[call ended]`)
        ),
        bullets: [
          `Caller hung up before speaking.`,
          `No customer or job information captured.`,
          `Number is worth a callback if it repeats.`,
        ],
        summary: `Abandoned call — the caller hung up before speaking.`,
        sentiment: "neutral",
        recommendedAction: "Call the number back once; hang-ups are often real leads.",
        isJobRelated: false,
      };
    }
    default: {
      return {
        transcript: join(open, K(`I had a question about my service.`), A(`Happy to help.`), close),
        bullets: [`${caller} called with a general question.`, `Handled by ${agent}.`, `No appointment created.`],
        summary: `General inquiry handled by ${agent}.`,
        sentiment: "neutral",
        recommendedAction: "No action required.",
        isJobRelated: false,
      };
    }
  }
}

/**
 * A handful of calls get an arguably-wrong AI label so the human review queue
 * has something real to correct. Keys are the *correct* category; values are
 * the categories the model plausibly confuses them with.
 */
const MISLABEL_CONFUSION = {
  emergency_request: "other",
  new_service_request: "job_callback",
  scheduling_request: "other",
  estimate_followup: "unbooked_call",
  unbooked_call: "new_service_request",
  membership_question: "payment_billing",
  warranty_concern: "complaint",
  payment_billing: "complaint",
  job_callback: "new_service_request",
  internal_call: "wrong_number",
  other: "recruiting_call",
  wrong_number: "spam_robocall",
  spam_robocall: "other",
};

// ---------------------------------------------------------------------------
// Seeders — one function per table group
// ---------------------------------------------------------------------------

function ensureKvTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT)`);
}

/** 2. employee_phones — the roster matchingService checks before customer lookup. */
function seedEmployeePhones(db, world, now) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO employee_phones
      (phone_number, employee_name, trade, extension, truck_number, phone_type,
       active, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const created = sqlTs(addDays(now, -210));
  let n = 0;

  world.technicians.forEach((t, i) => {
    const phone = digits10(t.phoneNumber);
    if (!phone) return;
    stmt.run(
      phone,
      t.name,
      t._trade,
      String(210 + i),
      String(t._truck),
      "company",
      1,
      "roster",
      created,
      created
    );
    n++;
  });

  world.office.forEach((o, i) => {
    const phone = digits10(o.phoneNumber);
    if (!phone) return;
    stmt.run(phone, o.name, "Office", String(101 + i), null, "mobile", 1, "roster", created, created);
    n++;
  });

  world.owners.forEach((o, i) => {
    const phone = digits10(o.phoneNumber);
    if (!phone) return;
    stmt.run(phone, o.name, "Management", String(150 + i), null, "personal", 1, "roster", created, created);
    n++;
  });

  // The shop's own main line — office staff call in from it constantly.
  stmt.run(digits10(C.COMPANY.phone), "Grounded Home Services - Shop", "Facility", "100", null, "facility", 1, "roster", created, created);
  n++;

  return n;
}

/** 3. fleet_technicians — truck number → tech, from the catalog's `_truck`. */
function seedFleetTechnicians(db, world, now) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO fleet_technicians
      (truck_number, tech_name, group_name, active, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
  `);
  const created = sqlTs(addDays(now, -200));
  const groupFor = (trade) =>
    trade === "Plumbing" ? "Plumbing Service" : trade === "Install" ? "Install Crew" : "HVAC Service";

  let n = 0;
  for (const t of world.technicians) {
    stmt.run(String(t._truck), t.name, groupFor(t._trade), created, created);
    n++;
  }
  return n;
}

/** 4. known_addresses — labeled stops the fleet trip report tags against. */
function seedKnownAddresses(db, world, rng, now) {
  const stmt = db.prepare(`
    INSERT INTO known_addresses
      (address, normalized, label, truck_number, sample_visit, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const created = sqlTs(addDays(now, -150));
  const rows = [];

  // The shop.
  rows.push({
    address: `${C.COMPANY.address.street}, ${C.COMPANY.address.city}, ${C.COMPANY.address.state} ${C.COMPANY.address.zip}, USA`,
    label: "Shop",
    truck: null,
  });

  // Supply houses — every vendor has a generated address in the world.
  for (const v of world.vendors) {
    rows.push({
      address: `${formatAddress(v.address)}, USA`,
      label: v.name,
      truck: null,
    });
  }

  // Technician homes. Drawn from real world locations so the coordinates and
  // city mix look like the rest of the tenant.
  const homePool = rng.sample(world.locations, world.technicians.length + 6);
  world.technicians.forEach((t, i) => {
    const loc = homePool[i];
    if (!loc) return;
    rows.push({
      address: `${formatAddress(loc.address)}, USA`,
      label: `${t.name} - home`,
      truck: String(t._truck),
    });
  });

  // A few frequent-but-unlabeled stops, so the "needs label" badge has work.
  const unlabeled = homePool.slice(world.technicians.length);
  unlabeled.forEach((loc, i) => {
    rows.push({
      address: `${formatAddress(loc.address)}, USA`,
      label: "",
      truck: String(rng.pick(world.technicians)._truck),
    });
  });

  let n = 0;
  const seen = new Set();
  for (const r of rows) {
    const norm = normalizeAddr(r.address);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    stmt.run(
      r.address,
      norm,
      r.label,
      r.truck,
      sqlTs(addDays(now, -rng.int(2, 60))),
      created,
      created
    );
    n++;
  }
  return n;
}

/** 1. processed_calls — the big one. */
function seedProcessedCalls(db, world, rng, now) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO processed_calls (
      service_titan_call_id, caller_phone_number, timestamp,
      raw_webhook_payload, transcript, transcript_metadata,
      summary, summary_bullets, source, category, sentiment,
      is_spam, is_job_related, confidence, recommended_action, classification_model,
      matched_customer_id, matched_customer_name, matched_job_id, matched_job_number,
      match_confidence, match_method, candidate_jobs, internal_employee,
      status, error_message, processing_attempts,
      created_at, updated_at,
      notes_applied_at, manual_category, call_reason, dismissed_at, call_type,
      applied_job_id, applied_job_number, applied_customer_id,
      classification_synced_at, classification_synced_type
    ) VALUES (
      @service_titan_call_id, @caller_phone_number, @timestamp,
      @raw_webhook_payload, @transcript, @transcript_metadata,
      @summary, @summary_bullets, @source, @category, @sentiment,
      @is_spam, @is_job_related, @confidence, @recommended_action, @classification_model,
      @matched_customer_id, @matched_customer_name, @matched_job_id, @matched_job_number,
      @match_confidence, @match_method, @candidate_jobs, @internal_employee,
      @status, @error_message, @processing_attempts,
      @created_at, @updated_at,
      @notes_applied_at, @manual_category, @call_reason, @dismissed_at, @call_type,
      @applied_job_id, @applied_job_number, @applied_customer_id,
      @classification_synced_at, @classification_synced_type
    )
  `);

  const cutoff = addDays(now, -CALL_WINDOW_DAYS);
  const calls = world.calls.filter((c) => new Date(c.receivedOn) >= cutoff);

  // Employee lookup by 10-digit phone, mirroring what matchingService does.
  const employeeByPhone = new Map();
  [...world.technicians, ...world.office, ...world.owners].forEach((e) => {
    employeeByPhone.set(digits10(e.phoneNumber), e);
  });

  const knownCallerByPhone = new Map(C.DEMO_KNOWN_CALLERS.map((k) => [digits10(k.phone), k]));

  let n = 0;
  const total = calls.length;

  calls.forEach((call, idx) => {
    const received = new Date(call.receivedOn);
    const ageDays = (now - received) / DAY_MS;
    const phoneDigits = digits10(call.from);
    const employee = employeeByPhone.get(phoneDigits) || null;
    const knownCaller = knownCallerByPhone.get(phoneDigits) || null;

    const scenario =
      REASON_SCENARIO[call._reasonName] || { kind: "other", category: "other" };
    const cust = call.customerId ? world.index.customerById.get(String(call.customerId)) : null;

    // ---- Job / customer matching -----------------------------------------
    let matchedJob = null;
    let candidateJobs = [];
    if (cust) {
      const custJobs = (world.index.jobsByCustomer.get(String(cust.id)) || []).slice();
      custJobs.sort((a, b) => new Date(b._start) - new Date(a._start));
      const inWindow = custJobs.filter(
        (j) => Math.abs(new Date(j._start) - received) <= 14 * DAY_MS
      );
      if (inWindow.length) {
        matchedJob = inWindow[0];
      } else {
        candidateJobs = custJobs.slice(0, 3).map((j) => ({
          jobId: j.id,
          jobNumber: j.jobNumber,
          status: j.status,
          summary: j.summary,
          relevanceDate: isoZ(j._start),
          ageDays: Math.round((received - new Date(j._start)) / DAY_MS),
        }));
      }
    }

    // ---- Content ----------------------------------------------------------
    // Trade-appropriate tech: a no-heat call shouldn't name a plumber.
    const plumbingKinds = new Set(["water_heater", "drain"]);
    const techPool = plumbingKinds.has(scenario.kind)
      ? world.technicians.filter((t) => t._trade === "Plumbing")
      : world.technicians.filter((t) => t._trade !== "Plumbing");
    const tech = matchedJob ? matchedJob._tech.name : rng.pick(techPool).name;
    // Callers with no customer record still need a name in the transcript —
    // built from the same combinatorial pools the world uses.
    const anonName = `${rng.chance(0.5) ? rng.pick(C.FIRST_NAMES_M) : rng.pick(C.FIRST_NAMES_F)} ${rng.pick(C.LAST_NAMES)}`;
    const custCity = cust
      ? ((world.index.locationsByCustomer.get(String(cust.id)) || [])[0] || { address: cust.address }).address.city
      : rng.weighted(C.CITIES.map((c) => [c.name, c.weight]));
    const content = buildCallContent(scenario.kind, {
      rng,
      company: C.COMPANY.name,
      agent: firstNameOf(call.agent.name),
      caller: cust ? cust.name : anonName,
      city: custCity,
      tech,
      day: WEEKDAY_NAMES[addDays(received, rng.int(1, 4)).getDay()],
      jobNumber: matchedJob ? matchedJob.jobNumber : String(41000 + rng.int(100, 900)),
      amount: rng.int(180, 1450),
      employee: employee ? employee.name : null,
    });

    // ---- Classification ---------------------------------------------------
    let category = scenario.category;
    let confidence = Math.round(rng.gaussianClamped(0.88, 0.06, 0.68, 0.98) * 100) / 100;

    // ~7% get an arguably-wrong label so the review UI has real corrections.
    const mislabeled = rng.chance(0.07) && MISLABEL_CONFUSION[category];
    if (mislabeled) {
      category = MISLABEL_CONFUSION[scenario.category];
      confidence = Math.round(rng.gaussianClamped(0.54, 0.07, 0.38, 0.66) * 100) / 100;
    }

    // A slice of those got caught and corrected by the office already.
    const manualCategory = mislabeled && rng.chance(0.45) ? scenario.category : null;

    const isSpam = scenario.kind === "solicitation" ? 1 : 0;
    const callType = knownCaller ? knownCaller.callType : call.callType;

    // ---- Processing state -------------------------------------------------
    // Almost everything has finished processing. The newest few show the queue
    // mid-flight, and one older call failed transcription outright.
    let status = "completed";
    let errorMessage = null;
    let attempts = 1;
    if (idx === total - 1) {
      status = "processing";
      attempts = 1;
    } else if (idx === total - 2) {
      status = "pending";
      attempts = 0;
    } else if (idx === total - 18) {
      status = "failed";
      errorMessage = "Recording download failed: 404 from ServiceTitan recording URL";
      attempts = 3;
    }

    const isCompleted = status === "completed";
    const source = rng.chance(0.04) ? "upload" : "polled";
    const stCallId = source === "upload" ? `upload-${call.id}` : String(call.id);

    // ---- Applied / dismissed state ---------------------------------------
    // Older, job-related, completed calls are the ones the office has worked.
    const posted = isCompleted && matchedJob && ageDays > 2 && rng.chance(0.42);
    const dismissed = isCompleted && !posted && ageDays > 5 && rng.chance(0.22);

    const createdAt = addMinutes(received, rng.int(2, 9));
    const updatedAt = addMinutes(createdAt, rng.int(1, 4));

    const durationSec = call.duration;

    stmt.run({
      service_titan_call_id: stCallId,
      caller_phone_number: call.from,
      timestamp: isoZ(received),
      raw_webhook_payload: JSON.stringify({
        leadCall: {
          id: call.id,
          duration: hms(durationSec),
          from: phoneDigits,
          to: digits10(C.COMPANY.phone),
          direction: "Inbound",
          receivedOn: isoZ(received),
          agent: { id: call.agent.id, name: call.agent.name },
          reason: { id: call.reason.id, name: call.reason.name },
          callType,
        },
      }),
      transcript: content.transcript,
      transcript_metadata: JSON.stringify(
        source === "upload"
          ? { provider: "openai-whisper-1", model: "whisper-1", promptLength: 0, companyNameFixupApplied: false, duration: durationSec }
          : {
              provider: "openai-whisper-1",
              model: "whisper-1",
              promptLength: 380 + rng.int(0, 90),
              companyNameFixupApplied: rng.chance(0.6),
              duration: durationSec,
            }
      ),
      summary: isCompleted ? content.summary : null,
      summary_bullets: isCompleted ? JSON.stringify(content.bullets) : null,
      source,
      category: isCompleted ? category : null,
      sentiment: isCompleted ? content.sentiment : null,
      is_spam: isCompleted ? isSpam : 0,
      is_job_related: isCompleted && content.isJobRelated ? 1 : 0,
      confidence: isCompleted ? confidence : 0,
      recommended_action: isCompleted ? content.recommendedAction : null,
      classification_model: isCompleted ? "gpt-4o" : null,
      matched_customer_id: cust ? cust.id : null,
      matched_customer_name: cust ? cust.name : null,
      matched_job_id: matchedJob ? matchedJob.id : null,
      matched_job_number: matchedJob ? matchedJob.jobNumber : null,
      match_confidence: employee ? 1 : matchedJob ? 0.95 : cust ? 0.8 : 0,
      match_method: employee ? "employee_call" : cust ? "phone_exact" : "none",
      candidate_jobs: candidateJobs.length ? JSON.stringify(candidateJobs) : null,
      internal_employee: employee
        ? JSON.stringify({
            name: employee.name,
            trade: employee._trade || (employee.role === "Owner" || employee.role === "Co-Owner" ? "Management" : "Office"),
            extension: String(employee._trade ? 210 + world.technicians.findIndex((t) => t.id === employee.id) : 101 + world.office.findIndex((o) => o.id === employee.id)),
            truckNumber: employee._truck ? String(employee._truck) : null,
            phoneType: employee._trade ? "company" : "mobile",
          })
        : null,
      status,
      error_message: errorMessage,
      processing_attempts: attempts,
      created_at: sqlTs(createdAt),
      updated_at: sqlTs(updatedAt),
      notes_applied_at: posted ? sqlTs(addMinutes(createdAt, rng.int(20, 600))) : null,
      manual_category: manualCategory,
      call_reason: isCompleted ? call.reason.name : null,
      dismissed_at: dismissed ? sqlTs(addMinutes(createdAt, rng.int(30, 900))) : null,
      call_type: isCompleted ? callType : null,
      applied_job_id: posted ? matchedJob.id : null,
      applied_job_number: posted ? matchedJob.jobNumber : null,
      applied_customer_id: posted ? cust.id : null,
      classification_synced_at:
        isCompleted && source !== "upload" && CATEGORY_CALL_TYPE[category]
          ? sqlTs(addMinutes(updatedAt, 1))
          : null,
      classification_synced_type:
        isCompleted && source !== "upload" && CATEGORY_CALL_TYPE[category]
          ? CATEGORY_CALL_TYPE[category]
          : null,
    });
    n++;
  });

  return n;
}

/** 5. install_tracker — office overlay on completed install jobs. */
function seedInstallTracker(db, world, rng, now) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO install_tracker (
      st_job_id, job_number, job_type_id, job_type_name, category,
      customer_id, customer_name, location_id, completed_on,
      equipment_listed, equipment_listed_at, equipment_listed_by,
      warranty_registered, warranty_registered_at, warranty_registered_by,
      notes, created_at, updated_at
    ) VALUES (
      @st_job_id, @job_number, @job_type_id, @job_type_name, @category,
      @customer_id, @customer_name, @location_id, @completed_on,
      @equipment_listed, @equipment_listed_at, @equipment_listed_by,
      @warranty_registered, @warranty_registered_at, @warranty_registered_by,
      @notes, @created_at, @updated_at
    )
  `);

  const office = world.office.map((o) => o.email);
  const installs = world.jobs.filter(
    (j) => j._jobType.category === "Install" && j.status === "Completed" && j.completedOn
  );

  const NOTES = [
    "Serial photo is on the job, still need to key it into ST.",
    "Registered on the manufacturer site, confirmation emailed to the customer.",
    "Second unit on this job — check the coil serial before closing this out.",
    "Customer wants the warranty paperwork mailed, not emailed.",
    "Waiting on the install crew to send the data plate photo.",
  ];

  let n = 0;
  for (const job of installs) {
    // Not every install has been touched by the office yet — an untouched job
    // has no overlay row at all, which is exactly what the queue is for.
    if (!rng.chance(0.74)) continue;

    const completedOn = ymd(job.completedOn);
    const equipmentListed = job._equipmentInSt ? 1 : 0;
    const warrantyRegistered = job._warrantyRegistered ? 1 : 0;

    // The office confirms an install a few days after it completes — but a job
    // finished last week can't have been confirmed next Tuesday. Since the
    // table sorts newest-first, future-dated rows land at the very top where
    // they're most visible. Clamp to now.
    const notFuture = (d) => (d > new Date() ? new Date() : d);
    const touchedAt = notFuture(addDays(job.completedOn, rng.int(1, 9)));
    const by = rng.pick(office);

    stmt.run({
      st_job_id: job.id,
      job_number: job.jobNumber,
      job_type_id: job.jobTypeId,
      job_type_name: installCfg.jobTypeName(job.jobTypeId) || job.jobTypeName,
      category: installCfg.jobTypeCategory(job.jobTypeId),
      customer_id: job.customerId,
      customer_name: job.customerName,
      location_id: job.locationId,
      completed_on: completedOn,
      equipment_listed: equipmentListed,
      equipment_listed_at: equipmentListed ? sqlTs(touchedAt) : null,
      equipment_listed_by: equipmentListed ? by : null,
      warranty_registered: warrantyRegistered,
      warranty_registered_at: warrantyRegistered ? sqlTs(notFuture(addDays(touchedAt, rng.int(0, 6)))) : null,
      warranty_registered_by: warrantyRegistered ? by : null,
      notes: rng.chance(0.22) ? rng.pick(NOTES) : null,
      created_at: sqlTs(touchedAt),
      updated_at: sqlTs(notFuture(addDays(touchedAt, rng.int(0, 6)))),
    });
    n++;
  }
  return n;
}

/** 6. job_review_status + job_review_notes — review state for flagged jobs. */
function seedJobReview(db, world, rng, now) {
  const statusStmt = db.prepare(`
    INSERT OR IGNORE INTO job_review_status (
      job_number, status, notes, reviewed_by, reviewed_at, updated_at,
      st_note_synced_at, st_note_synced_text, st_note_error,
      corrected_status, corrected_job_type,
      status_synced_at, status_synced_value, status_sync_error,
      job_type_synced_at, job_type_synced_value, job_type_sync_error
    ) VALUES (
      @job_number, @status, @notes, @reviewed_by, @reviewed_at, @updated_at,
      @st_note_synced_at, @st_note_synced_text, @st_note_error,
      @corrected_status, @corrected_job_type,
      @status_synced_at, @status_synced_value, @status_sync_error,
      @job_type_synced_at, @job_type_synced_value, @job_type_sync_error
    )
  `);
  const noteStmt = db.prepare(`
    INSERT INTO job_review_notes
      (job_number, text, author, added_at, st_note_synced_at, st_note_synced_text, st_note_error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const reviewers = world.office.filter((o) => !o._csr || o.role === "Office Manager").map((o) => o.email);
  const pool = reviewers.length ? reviewers : world.office.map((o) => o.email);

  const flagged = world.jobs
    .filter((j) => j._missedInvoice)
    .sort((a, b) => new Date(b._start) - new Date(a._start))
    .slice(0, 60);

  const NOTE_TEXTS = [
    "Tech confirmed the work was done — invoice was never generated in the field.",
    "Customer says they already paid the tech by check. Chasing the deposit slip.",
    "This was a callback on a prior repair, should have been no-charge. Job type is wrong.",
    "Left a voicemail for the homeowner to confirm what was completed.",
    "Parts were pulled on a PO but nothing was billed out. Needs an invoice built.",
    "Duplicate of the job the day before — closing this one out.",
    "Waiting on the install coordinator to confirm scope before we invoice.",
  ];

  let statusRows = 0;
  let noteRows = 0;

  flagged.forEach((job, i) => {
    if (!rng.chance(0.55)) return;

    const reviewedAt = addDays(job.completedOn || job._start, rng.int(2, 18));
    if (reviewedAt > now) return;

    const status = rng.weighted([
      ["reviewed", 6],
      ["escalated", 2],
      ["resolved", 3],
    ]);
    const by = rng.pick(pool);

    // A slice of resolved jobs carry non-destructive corrections that overlay
    // the cached jobs.json at read time.
    const corrected = status === "resolved" && rng.chance(0.5);
    const correctedStatus = corrected && rng.chance(0.6) ? "Canceled" : null;
    const correctedJobType =
      corrected && rng.chance(0.5) ? rng.pick(["Warranty Callback", "Return Visit - Parts"]) : null;
    const pushed = corrected && rng.chance(0.7);
    const pushFailed = pushed && rng.chance(0.2);

    const legacyNote = rng.chance(0.4) ? rng.pick(NOTE_TEXTS) : null;
    const syncedNote = legacyNote && rng.chance(0.6);

    statusStmt.run({
      job_number: job.jobNumber,
      status,
      notes: legacyNote,
      reviewed_by: by,
      reviewed_at: sqlTs(reviewedAt),
      updated_at: sqlTs(addDays(reviewedAt, rng.int(0, 4))),
      st_note_synced_at: syncedNote ? sqlTs(addMinutes(reviewedAt, 3)) : null,
      st_note_synced_text: syncedNote ? legacyNote : null,
      st_note_error: legacyNote && !syncedNote && rng.chance(0.3) ? "ServiceTitan returned 409 — job is locked for editing" : null,
      corrected_status: correctedStatus,
      corrected_job_type: correctedJobType,
      status_synced_at: correctedStatus && pushed && !pushFailed ? sqlTs(addDays(reviewedAt, 1)) : null,
      status_synced_value: correctedStatus && pushed && !pushFailed ? correctedStatus : null,
      status_sync_error: correctedStatus && pushFailed ? "ServiceTitan rejected the status change (job has a posted invoice)" : null,
      job_type_synced_at: correctedJobType && pushed ? sqlTs(addDays(reviewedAt, 1)) : null,
      job_type_synced_value: correctedJobType && pushed ? correctedJobType : null,
      job_type_sync_error: null,
    });
    statusRows++;

    // Append-only notes, each with its own sync state.
    const noteCount = rng.weighted([[1, 5], [2, 3], [3, 1]]);
    for (let k = 0; k < noteCount; k++) {
      const addedAt = addDays(reviewedAt, k);
      if (addedAt > now) break;
      const text = rng.pick(NOTE_TEXTS);
      const synced = rng.chance(0.65);
      const failed = !synced && rng.chance(0.35);
      noteStmt.run(
        job.jobNumber,
        text,
        rng.pick(pool),
        sqlTs(addedAt),
        synced ? sqlTs(addMinutes(addedAt, 2)) : null,
        synced ? text : null,
        failed ? "ServiceTitan note POST timed out after 30s" : null
      );
      noteRows++;
    }
  });

  return { statusRows, noteRows };
}

/**
 * 7. timesheets + timesheet_balances + time_punches.
 *
 * Sheets are per-employee and the page only ever shows the LOGGED-IN user's
 * rows, so we bind each technician to a real `users.id` where one exists
 * (matched on email, then on first+last name). Technicians without a login get
 * their ServiceTitan employee id as the user id — harmless, and it means the
 * table is populated even when this runs before any user is created.
 */
function resolveUserIds(db, world) {
  let users = [];
  try {
    users = db.prepare("SELECT id, email, display_name, first_name, last_name FROM users").all();
  } catch (_) {
    users = [];
  }
  const byEmail = new Map(users.map((u) => [String(u.email || "").toLowerCase(), u.id]));
  const byName = new Map(
    users.map((u) => [
      `${u.first_name || ""} ${u.last_name || ""}`.trim().toLowerCase() || String(u.display_name || "").toLowerCase(),
      u.id,
    ])
  );

  const staff = [...world.technicians, ...world.office];
  const out = staff.map((p) => ({
    person: p,
    userId: byEmail.get(String(p.email).toLowerCase()) || byName.get(p.name.toLowerCase()) || p.id,
  }));

  // Any user row that didn't match a world person still deserves a timesheet —
  // otherwise the demo login lands on an empty page.
  const claimed = new Set(out.map((o) => o.userId));
  for (const u of users) {
    if (claimed.has(u.id)) continue;
    out.push({
      person: {
        id: u.id,
        name:
          `${u.first_name || ""} ${u.last_name || ""}`.trim() ||
          u.display_name ||
          String(u.email).split("@")[0],
        _trade: "Office",
      },
      userId: u.id,
    });
  }
  return out;
}

function seedTimesheets(db, world, rng, now) {
  const tsStmt = db.prepare(`
    INSERT OR IGNORE INTO timesheets (
      user_id, employee_name, period_start, period_end, status, grid_json, notes,
      comp_used, banked_comp_input, plaw_start_input,
      applied_comp_delta, applied_plaw_delta, applied_init_comp, applied_init_plaw,
      processed_at, created_at, updated_at, pay_overtime, ot_banked
    ) VALUES (
      @user_id, @employee_name, @period_start, @period_end, @status, @grid_json, @notes,
      @comp_used, @banked_comp_input, @plaw_start_input,
      @applied_comp_delta, @applied_plaw_delta, @applied_init_comp, @applied_init_plaw,
      @processed_at, @created_at, @updated_at, @pay_overtime, @ot_banked
    )
  `);
  const balStmt = db.prepare(`
    INSERT OR REPLACE INTO timesheet_balances
      (user_id, comp_balance, plaw_balance, comp_initialized, plaw_initialized, updated_at)
    VALUES (?, ?, ?, 1, 1, ?)
  `);
  const punchStmt = db.prepare(`
    INSERT INTO time_punches (
      user_id, work_date, clock_in, clock_out, break_seconds, break_started_at,
      hours, status, applied_period_start, applied_day, note, source,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'closed', ?, ?, ?, ?, ?, ?)
  `);

  const DAY_KEYS = ["wed", "thu", "fri", "sat", "sun", "mon", "tue"];
  const ROW_KEYS = ["regular", "overtime", "pto", "plaw", "holiday", "comp"];
  const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

  const emptyGrid = () => {
    const g = {};
    for (const r of ROW_KEYS) {
      g[r] = {};
      for (const d of DAY_KEYS) g[r][d] = "";
    }
    return g;
  };

  const currentPeriodStart = wednesdayOnOrBefore(now);
  const PERIODS = 6;

  const staff = resolveUserIds(db, world);

  const NOTE_POOL = [
    "Ran the Fairview install two days, long ones.",
    "Took Friday off for a doctor appointment.",
    "On call over the weekend.",
    "Half day Tuesday — truck was in the shop.",
    "Covered a callback after hours on Monday.",
  ];

  let tsRows = 0;
  let balRows = 0;
  let punchRows = 0;

  for (const { person, userId } of staff) {
    let compBalance = 0;
    let plawBalance = 0;
    const startComp = rng.int(0, 6) * 2; // 0-12 banked hours to start
    const startPlaw = 40;
    let seededInit = false;

    for (let p = PERIODS - 1; p >= 0; p--) {
      const periodStart = addDays(currentPeriodStart, -7 * p);
      const periodEnd = addDays(periodStart, 6);
      const isCurrent = p === 0;

      // ---- Build the grid -------------------------------------------------
      const grid = emptyGrid();
      const workDays = ["wed", "thu", "fri", "mon", "tue"];
      let ptoDay = null;
      let plawDay = null;
      let holidayDay = null;
      let compDay = null;

      if (rng.chance(0.14)) ptoDay = rng.pick(workDays);
      if (!ptoDay && rng.chance(0.08)) plawDay = rng.pick(workDays);
      if (!ptoDay && !plawDay && rng.chance(0.06)) holidayDay = rng.pick(workDays);
      if (!ptoDay && !plawDay && !holidayDay && rng.chance(0.07)) compDay = rng.pick(workDays);

      for (const d of workDays) {
        if (d === ptoDay) {
          grid.pto[d] = "8";
          continue;
        }
        if (d === plawDay) {
          grid.plaw[d] = "8";
          continue;
        }
        if (d === holidayDay) {
          grid.holiday[d] = "8";
          continue;
        }
        if (d === compDay) {
          grid.comp[d] = "8";
          continue;
        }
        // Worked day: 8 regular, sometimes an hour or three of overtime.
        const worked = rng.weighted([
          [8, 10],
          [8.5, 2],
          [9, 3],
          [10, 2],
          [7.5, 1],
        ]);
        const reg = Math.min(8, worked);
        const ot = round2(Math.max(0, worked - 8));
        grid.regular[d] = String(round2(reg));
        if (ot > 0) grid.overtime[d] = String(ot);
      }

      // Occasional Saturday call-out — all overtime.
      if (rng.chance(0.18)) {
        const satHours = rng.pick([4, 5, 6]);
        grid.overtime.sat = String(satHours);
      }

      const rowTotal = (row) => round2(DAY_KEYS.reduce((s, d) => s + (parseFloat(grid[row][d]) || 0), 0));
      const totals = {};
      for (const r of ROW_KEYS) totals[r] = rowTotal(r);
      const grandTotal = round2(ROW_KEYS.reduce((s, r) => s + totals[r], 0));

      const payOvertime = rng.chance(0.25) ? 1 : 0;
      const otBanked = payOvertime === 0 ? round2(Math.max(0, grandTotal - 40)) : 0;

      const createdAt = addDays(periodStart, 1);
      const updatedAt = isCurrent ? addDays(now, -0.2) : addDays(periodEnd, 1);

      let appliedCompDelta = null;
      let appliedPlawDelta = null;
      let appliedInitComp = null;
      let appliedInitPlaw = null;
      let processedAt = null;
      const status = isCurrent ? "draft" : "processed";

      if (status === "processed") {
        appliedCompDelta = round2(otBanked - totals.comp);
        appliedPlawDelta = round2(-totals.plaw);
        if (!seededInit) {
          appliedInitComp = startComp;
          appliedInitPlaw = startPlaw;
          compBalance = round2(compBalance + startComp);
          plawBalance = round2(plawBalance + startPlaw);
          seededInit = true;
        }
        compBalance = round2(compBalance + appliedCompDelta);
        plawBalance = round2(Math.max(0, plawBalance + appliedPlawDelta));
        processedAt = sqlTs(addDays(periodEnd, 1));
      }

      tsStmt.run({
        user_id: userId,
        employee_name: person.name,
        period_start: ymd(periodStart),
        period_end: ymd(periodEnd),
        status,
        grid_json: JSON.stringify(grid),
        notes: rng.chance(0.2) ? rng.pick(NOTE_POOL) : null,
        comp_used: 0,
        banked_comp_input: appliedInitComp != null ? startComp : null,
        plaw_start_input: appliedInitPlaw != null ? startPlaw : null,
        applied_comp_delta: appliedCompDelta,
        applied_plaw_delta: appliedPlawDelta,
        applied_init_comp: appliedInitComp,
        applied_init_plaw: appliedInitPlaw,
        processed_at: processedAt,
        created_at: sqlTs(createdAt),
        updated_at: sqlTs(updatedAt),
        pay_overtime: payOvertime,
        ot_banked: otBanked,
      });
      tsRows++;

      // ---- Punches for the two most recent periods ------------------------
      if (p <= 1) {
        for (const d of workDays) {
          const dayIndex = DAY_KEYS.indexOf(d);
          const workDate = addDays(periodStart, dayIndex);
          if (workDate > now) continue;
          const regular = parseFloat(grid.regular[d]) || 0;
          const ot = parseFloat(grid.overtime[d]) || 0;
          const hours = round2(regular + ot);
          if (hours <= 0) continue;

          const inHour = rng.pick([6, 7, 7, 8]);
          const clockIn = new Date(
            Date.UTC(
              workDate.getUTCFullYear(),
              workDate.getUTCMonth(),
              workDate.getUTCDate(),
              inHour + 5, // stored as ISO; the shop is UTC-5
              rng.pick([0, 15, 30, 45]),
              0
            )
          );
          const breakSeconds = rng.pick([0, 1800, 2700]);
          const clockOut = new Date(clockIn.getTime() + (hours * 3600 + breakSeconds) * 1000);

          punchStmt.run(
            userId,
            ymd(workDate),
            isoZ(clockIn),
            isoZ(clockOut),
            breakSeconds,
            hours,
            ymd(periodStart),
            d,
            rng.chance(0.15) ? "Straight to the Cedar Hollow install, no shop stop." : null,
            "clock",
            sqlTs(clockIn),
            sqlTs(clockOut)
          );
          punchRows++;
        }
      }
    }

    balStmt.run(userId, compBalance, plawBalance, sqlTs(addDays(now, -1)));
    balRows++;
  }

  return { tsRows, balRows, punchRows };
}

/** 8. pricebook_index + pricebook_sync_log (+ merge / rename audit logs). */
function seedPricebook(db, world, rng, now) {
  const pbStmt = db.prepare(`
    INSERT OR IGNORE INTO pricebook_index
      (st_id, sku_type, name, code, description, price, active, tokens,
       synced_at, renamed_at, rename_reviewed_at, image_path, image_checked_at)
    VALUES (@st_id, @sku_type, @name, @code, @description, @price, @active, @tokens,
            @synced_at, @renamed_at, @rename_reviewed_at, @image_path, @image_checked_at)
  `);
  const syncStmt = db.prepare(`
    INSERT INTO pricebook_sync_log
      (started_at, finished_at, status, services, materials, equipment, error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const mergeStmt = db.prepare(`
    INSERT INTO pricebook_merge_log (
      merged_at, sku_type, canonical_st_id, canonical_code, canonical_name,
      duplicate_st_ids, duplicate_snapshot, field_copy, fields_copied,
      canonical_snapshot, status, error, user_note, undone_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const renameStmt = db.prepare(`
    INSERT INTO pricebook_rename_log (st_id, sku_type, old_name, new_name, status, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // The ST pricebook sync only mirrors Service / Material / Equipment. The
  // discountsAndFees pool has skuType "Discount" and is intentionally skipped —
  // seeding it would put a value in sku_type that no reader expects.
  const indexable = world.pricebookAll.filter((it) =>
    ["Service", "Material", "Equipment"].includes(it.skuType)
  );

  const syncedAt = sqlTs(addDays(now, -0.6));
  const counts = { Service: 0, Material: 0, Equipment: 0 };

  // Rows the office has already worked through in the rename queue.
  const materials = indexable.filter((i) => i.skuType === "Material");
  const renamedIds = new Set(rng.sample(materials, 5).map((m) => m.id));
  const reviewedIds = new Set(
    rng.sample(materials.filter((m) => !renamedIds.has(m.id)), 4).map((m) => m.id)
  );
  // Duplicates that were merged away are inactive in the mirror.
  const dupes = world.pricebookAll.filter((i) => i._duplicateOf);
  const mergedAway = new Set(rng.sample(dupes, 3).map((d) => d.id));

  for (const it of indexable) {
    const name = it.displayName || it.name;
    const code = it.code || it.sku;
    counts[it.skuType]++;
    const renamed = renamedIds.has(it.id);
    const reviewed = reviewedIds.has(it.id);
    const hasImage = rng.chance(0.35);
    pbStmt.run({
      st_id: it.id,
      sku_type: it.skuType,
      name,
      code,
      description: it.description || null,
      price: it.price,
      active: mergedAway.has(it.id) ? 0 : it.active === false ? 0 : 1,
      tokens: tokenString(name, code, it.description),
      synced_at: syncedAt,
      renamed_at: renamed ? sqlTs(addDays(now, -rng.int(3, 40))) : null,
      rename_reviewed_at: reviewed ? sqlTs(addDays(now, -rng.int(3, 40))) : null,
      image_path: hasImage ? `Images/pricebook/${String(code).toLowerCase()}.png` : null,
      image_checked_at: hasImage ? sqlTs(addDays(now, -rng.int(1, 30))) : null,
    });
  }

  // ── Sync log. The `ok` row with a fresh finished_at is MANDATORY: without it
  // autoSyncIfStale(30) fires a live ServiceTitan pricebook sync on the first
  // invoice/scope parse and markStaleInactive() flips active=0 on every row.
  for (let i = 6; i >= 1; i--) {
    const started = addDays(now, -i);
    syncStmt.run(
      sqlTs(started),
      sqlTs(addMinutes(started, 2)),
      "ok",
      counts.Service,
      counts.Material,
      counts.Equipment,
      null
    );
  }
  const failedStart = addDays(now, -4.2);
  syncStmt.run(
    sqlTs(failedStart),
    sqlTs(addMinutes(failedStart, 1)),
    "failed",
    0,
    0,
    0,
    "ServiceTitan returned 429 (rate limited) on pricebook/v2/materials"
  );
  const lastStart = addMinutes(now, -38);
  syncStmt.run(
    sqlTs(lastStart),
    sqlTs(addMinutes(lastStart, 2)),
    "ok",
    counts.Service,
    counts.Material,
    counts.Equipment,
    null
  );

  // ── Merge log — the three duplicates deactivated above, plus one undone.
  let mergeRows = 0;
  const mergedList = [...mergedAway];
  mergedList.forEach((dupId, i) => {
    const dup = world.pricebookAll.find((p) => p.id === dupId);
    const canonical = world.pricebookAll.find((p) => p.id === dup._duplicateOf);
    if (!canonical) return;
    const mergedAt = addDays(now, -rng.int(4, 45));
    const fieldCopy = rng.chance(0.5);
    mergeStmt.run(
      sqlTs(mergedAt),
      "Material",
      canonical.id,
      canonical.code,
      canonical.displayName,
      JSON.stringify([dup.id]),
      JSON.stringify([
        { st_id: dup.id, code: dup.code, name: dup.displayName, price: dup.price, active: 1 },
      ]),
      fieldCopy ? 1 : 0,
      fieldCopy ? JSON.stringify({ description: dup.description }) : null,
      JSON.stringify({
        code: canonical.code,
        name: canonical.displayName,
        price: canonical.price,
        description: canonical.description,
      }),
      "ok",
      null,
      i === 0 ? "Same part, the -OLD code came over in the 2019 import." : null,
      null
    );
    mergeRows++;
  });

  const undoneDup = dupes.find((d) => !mergedAway.has(d.id));
  if (undoneDup) {
    const canonical = world.pricebookAll.find((p) => p.id === undoneDup._duplicateOf);
    const mergedAt = addDays(now, -12);
    mergeStmt.run(
      sqlTs(mergedAt),
      "Material",
      canonical.id,
      canonical.code,
      canonical.displayName,
      JSON.stringify([undoneDup.id]),
      JSON.stringify([
        { st_id: undoneDup.id, code: undoneDup.code, name: undoneDup.displayName, price: undoneDup.price, active: 1 },
      ]),
      0,
      null,
      JSON.stringify({
        code: canonical.code,
        name: canonical.displayName,
        price: canonical.price,
        description: canonical.description,
      }),
      "undone",
      null,
      "Prices were different on purpose — these are two different pressure ratings.",
      sqlTs(addDays(mergedAt, 1))
    );
    mergeRows++;
  }

  // ── Rename log — applied renames match the renamed_at rows above.
  const RENAME_MAP = (name) =>
    name
      .replace(/\bUniv\.?\b/i, "Universal")
      .replace(/\bMFD\b/, "Microfarad")
      .replace(/\bXFMR\b/i, "Transformer")
      .replace(/\bper ft\b/i, "(per foot)");

  let renameRows = 0;
  for (const id of renamedIds) {
    const it = world.pricebookAll.find((p) => p.id === id);
    if (!it) continue;
    const oldName = it.displayName;
    renameStmt.run(
      it.id,
      "Material",
      oldName,
      RENAME_MAP(oldName),
      "applied",
      null,
      sqlTs(addDays(now, -rng.int(3, 40)))
    );
    renameRows++;
  }
  for (const id of reviewedIds) {
    const it = world.pricebookAll.find((p) => p.id === id);
    if (!it) continue;
    renameStmt.run(it.id, "Material", it.displayName, null, "skipped", null, sqlTs(addDays(now, -rng.int(3, 40))));
    renameRows++;
  }
  // One failed push, so the log isn't uniformly green.
  const failItem = rng.pick(materials);
  renameStmt.run(
    failItem.id,
    "Material",
    failItem.displayName,
    RENAME_MAP(failItem.displayName),
    "failed",
    "ServiceTitan rejected the update: name exceeds 100 characters",
    sqlTs(addDays(now, -9))
  );
  renameRows++;

  return { pricebookRows: indexable.length, mergeRows, renameRows };
}

/** 9. installed_equipment_registrations — past Equipment-page submissions. */
function seedEquipmentRegistrations(db, world, rng, now) {
  const stmt = db.prepare(`
    INSERT INTO installed_equipment_registrations (
      equipment_type_id, st_installed_equipment_id, st_customer_id, st_customer_name,
      st_location_id, location_address, model, serial_number, installed_on,
      manufacture_date, warranty_start, warranty_end, form_data, proportal_row,
      proportal_exported, proportal_exported_at, st_write_status, st_error,
      created_by, created_at
    ) VALUES (
      @equipment_type_id, @st_installed_equipment_id, @st_customer_id, @st_customer_name,
      @st_location_id, @location_address, @model, @serial_number, @installed_on,
      @manufacture_date, @warranty_start, @warranty_end, @form_data, @proportal_row,
      @proportal_exported, @proportal_exported_at, @st_write_status, @st_error,
      @created_by, @created_at
    )
  `);

  const office = world.office.map((o) => o.email);
  const addYears = (iso, y) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() + y);
    return d.toISOString().slice(0, 10);
  };
  const usDate = (iso) => {
    const [y, m, d] = iso.split("-");
    return `${m}/${d}/${y}`;
  };
  const prettyDate = (iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return `${["January","February","March","April","May","June","July","August","September","October","November","December"][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  };

  // Recent completed installs, newest first — the units the office would have
  // been registering over the last few months.
  const installs = world.jobs
    .filter((j) => j._jobType.category === "Install" && j.status === "Completed" && j.completedOn)
    .filter((j) => new Date(j.completedOn) >= addDays(now, -170))
    .sort((a, b) => new Date(b.completedOn) - new Date(a.completedOn));

  const hvacJobs = installs.filter((j) => j._jobType.bu === 2003);
  const whJobs = installs.filter((j) => j._jobType.id === 1216);
  const tanklessJobs = installs.filter((j) => j._jobType.id === 1208);

  const RINNAI_YEARS = { 2023: "R", 2024: "S", 2025: "T", 2026: "W", 2027: "X", 2028: "Y", 2029: "Z" };
  const RINNAI_MONTHS = "ABCDEFGHJKLM"; // I is skipped; index 0 = January

  let stEqId = 880000;
  let n = 0;

  const contactFor = (cust) => {
    const contacts = world.index.contactsByCustomer.get(String(cust.id)) || [];
    const phone = (contacts.find((c) => c.type === "Phone") || {}).value || "";
    return {
      firstName: cust._commercial ? "" : firstNameOf(cust.name),
      lastName: cust._commercial ? cust.name : lastNameOf(cust.name),
      companyName: cust._commercial ? cust.name : "",
      email: cust.email || "",
      phone: digits10(phone),
    };
  };

  // ── American Standard (PDF-driven, sometimes multiple units per job) ──────
  for (const job of rng.sample(hvacJobs, 9)) {
    const cust = world.index.customerById.get(String(job.customerId));
    const loc = world.index.locationById.get(String(job.locationId));
    if (!cust || !loc) continue;
    const installedOn = ymd(job.completedOn);
    const enteredAt = addDays(job.completedOn, rng.int(1, 12));
    const warrantyNumber = `AS-${rng.int(100000, 999999)}`;
    const unitCount = /hvac install/i.test(job.jobTypeName) ? 2 : 1;

    for (let u = 0; u < unitCount; u++) {
      const equipmentName = unitCount === 2 ? (u === 0 ? "Air Conditioner" : "Furnace") : rng.pick(["Air Conditioner", "Furnace", "Coil", "Air Handler"]);
      const model = rng.pick(C.EQUIPMENT_MANUFACTURERS.hvac[0].models);
      const serial = `${String(new Date(installedOn).getUTCFullYear()).slice(-1)}${String(rng.int(1, 52)).padStart(2, "0")}${rng.pick(["A", "B", "C", "D"])}${String(rng.int(10000, 99999))}`;
      const functionalEnd = addYears(installedOn, 10);
      const heatExchangerEnd = equipmentName === "Furnace" ? addYears(installedOn, 20) : null;
      const coverages = [
        { name: "Functional Parts", endDate: functionalEnd, endDateUS: usDate(functionalEnd), years: 10 },
      ];
      if (heatExchangerEnd) {
        coverages.push({ name: "Heat Exchanger", endDate: heatExchangerEnd, endDateUS: usDate(heatExchangerEnd), years: 20 });
      }
      const mfgDate = `${installedOn.slice(0, 4)}-${pad(rng.int(1, 12))}-01`;
      const failed = rng.chance(0.08);

      stmt.run({
        equipment_type_id: "american-standard-hvac",
        st_installed_equipment_id: failed ? null : stEqId++,
        st_customer_id: cust.id,
        st_customer_name: cust.name,
        st_location_id: loc.id,
        location_address: formatAddress(loc.address),
        model,
        serial_number: serial,
        installed_on: installedOn,
        manufacture_date: mfgDate,
        warranty_start: installedOn,
        warranty_end: functionalEnd,
        form_data: JSON.stringify({
          equipmentName,
          model,
          serialNumber: serial,
          tier: rng.pick(["Silver", "Gold", "Platinum"]),
          coverages,
          warrantyNumber,
          installedOn,
          warrantyStart: installedOn,
          warrantyEnd: functionalEnd,
          warrantyEndUS: usDate(functionalEnd),
          headlineCoverage: "Functional Parts",
          manufacture: { date: mfgDate, label: prettyDate(mfgDate) },
          memo: `Warranty (American Standard): Functional Parts 10 yr (through ${functionalEnd})${heatExchangerEnd ? `; Heat Exchanger 20 yr (through ${heatExchangerEnd})` : ""}. Registered under warranty ${warrantyNumber}.`,
          __normalized: true,
        }),
        proportal_row: null,
        proportal_exported: 0,
        proportal_exported_at: null,
        st_write_status: failed ? "failed" : "created",
        st_error: failed ? "ServiceTitan returned 400: serialNumber already exists on this location" : null,
        created_by: rng.pick(office),
        created_at: sqlTs(enteredAt),
      });
      n++;
    }
  }

  // ── Bradford White (screenshot/OCR, single unit) ──────────────────────────
  for (const job of rng.sample(whJobs, 7)) {
    const cust = world.index.customerById.get(String(job.customerId));
    const loc = world.index.locationById.get(String(job.locationId));
    if (!cust || !loc) continue;
    const installedOn = ymd(job.completedOn);
    const enteredAt = addDays(job.completedOn, rng.int(1, 10));
    const model = rng.pick(C.EQUIPMENT_MANUFACTURERS.waterHeater[0].models);
    const letters = "ABCDEFGHJKLMNPRSTUVWXYZ";
    const serial = `${letters[rng.int(0, letters.length - 1)]}${letters[rng.int(0, 11)]}${String(rng.int(100000, 999999))}`;
    const tankEnd = addYears(installedOn, 6);
    const partsEnd = addYears(installedOn, 6);
    const mfgDate = `${installedOn.slice(0, 4)}-${pad(rng.int(1, 12))}-01`;

    stmt.run({
      equipment_type_id: "bradford-white-water-heater",
      st_installed_equipment_id: stEqId++,
      st_customer_id: cust.id,
      st_customer_name: cust.name,
      st_location_id: loc.id,
      location_address: formatAddress(loc.address),
      model,
      serial_number: serial,
      installed_on: installedOn,
      manufacture_date: mfgDate,
      warranty_start: installedOn,
      warranty_end: tankEnd,
      form_data: JSON.stringify({
        equipmentName: rng.pick(["Water Heater", "Power Vent Water Heater"]),
        model,
        serialNumber: serial,
        waterHeaterType: rng.pick(["RES GAS", "RES PWR VENT", "RES ELEC"]),
        coverages: [
          { name: "Tank", endDate: tankEnd, endDateUS: usDate(tankEnd), years: 6 },
          { name: "Parts", endDate: partsEnd, endDateUS: usDate(partsEnd), years: 6 },
        ],
        registrationStatus: "Registered",
        registrationDate: ymd(enteredAt),
        installedOn,
        warrantyStart: installedOn,
        warrantyEnd: tankEnd,
        warrantyEndUS: usDate(tankEnd),
        headlineCoverage: "Tank",
        manufacture: { date: mfgDate, label: prettyDate(mfgDate) },
        memo: `Warranty (Bradford White): Tank 6 yr (through ${tankEnd}); Parts 6 yr (through ${partsEnd}).`,
        __normalized: true,
      }),
      proportal_row: null,
      proportal_exported: 0,
      proportal_exported_at: null,
      st_write_status: "created",
      st_error: null,
      created_by: rng.pick(office),
      created_at: sqlTs(enteredAt),
    });
    n++;
  }

  // ── Rinnai Sensei tankless (form-driven, ProPortal CSV export) ────────────
  // Collected first so the newest few can be left unexported — the Equipment
  // page's "queued for ProPortal" counter needs proportal_exported = 0 rows.
  const rinnaiRows = [];
  for (const job of rng.sample(tanklessJobs, 8)) {
    const cust = world.index.customerById.get(String(job.customerId));
    const loc = world.index.locationById.get(String(job.locationId));
    if (!cust || !loc) continue;
    const installedOn = ymd(job.completedOn);
    const enteredAt = addDays(job.completedOn, rng.int(1, 14));
    const model = rng.pick(["RU160iN", "RU199iN", "RUR199iN", "RSC199iN"]);

    // Serial must decode: first char = year letter, second = month letter.
    const mfgYear = Number(installedOn.slice(0, 4)) - rng.int(0, 1);
    const mfgMonth = rng.int(1, 12);
    const yearLetter = RINNAI_YEARS[mfgYear] || "T";
    const serial = `${yearLetter}${RINNAI_MONTHS[mfgMonth - 1]}.CA-${String(rng.int(100000, 999999))}`;
    const mfgDate = `${mfgYear}-${pad(mfgMonth)}-01`;
    const warrantyEnd = addYears(installedOn, 15);
    const registrationDate = ymd(enteredAt);
    const contact = contactFor(cust);

    const formData = {
      model,
      serialNumber: serial,
      installedOn,
      applicationType: rng.pick([
        "Residential Hot Water Only",
        "Residential Hot Water / Home Heating",
      ]),
      recirculationType: rng.pick([
        "No Recirculation System",
        "Recirculation System with Aquastat/Thermostat (Timer or Other Activation Device)",
      ]),
      fuelType: rng.pick(["Natural Gas", "Propane"]),
      registrationType: "Residential",
    };

    // Keys must be the literal ProPortal column headers — any mismatch is a
    // blank cell in the exported CSV.
    const proportalRow = {
      "First Name": contact.firstName,
      "Last Name": contact.lastName,
      Email: contact.email,
      "Company Name": contact.companyName,
      Phone: contact.phone,
      "Unit Address (Street)": loc.address.street,
      "Unit Address (City)": loc.address.city,
      "Unit Address (State/Province)": loc.address.state,
      "Unit Address (ZIP/Postal Code)": loc.address.zip,
      "Unit Address (Country/Territory)": "US",
      "Serial Number": serial,
      "Application Type": formData.applicationType,
      "Recirculation Type": formData.recirculationType,
      "Registration Type": formData.registrationType,
      "Fuel Type": formData.fuelType,
      "Registration Date": registrationDate,
      "Installation Date": installedOn,
    };

    rinnaiRows.push({
      _enteredAt: enteredAt,
      equipment_type_id: "rinnai-sensei-tankless",
      st_installed_equipment_id: stEqId++,
      st_customer_id: cust.id,
      st_customer_name: cust.name,
      st_location_id: loc.id,
      location_address: formatAddress(loc.address),
      model,
      serial_number: serial,
      installed_on: installedOn,
      manufacture_date: mfgDate,
      warranty_start: installedOn,
      warranty_end: warrantyEnd,
      form_data: JSON.stringify(formData),
      proportal_row: JSON.stringify(proportalRow),
      proportal_exported: 0,
      proportal_exported_at: null,
      st_write_status: "created",
      st_error: null,
      created_by: rng.pick(office),
      created_at: sqlTs(enteredAt),
    });
  }

  // Everything but the three most recent has already been through a ProPortal
  // export run; those three are the pending batch waiting on the next CSV.
  rinnaiRows.sort((a, b) => new Date(b._enteredAt) - new Date(a._enteredAt));
  rinnaiRows.forEach((row, i) => {
    if (i >= 3) {
      row.proportal_exported = 1;
      row.proportal_exported_at = sqlTs(addDays(row._enteredAt, rng.int(1, 6)));
    }
    delete row._enteredAt;
    stmt.run(row);
    n++;
  });

  return n;
}

/** 10. Audit / history panels — small but non-empty. */
function seedAuditTrails(db, world, rng, now) {
  const out = {};

  // ── video_uploads ────────────────────────────────────────────────────────
  const videoStmt = db.prepare(`
    INSERT INTO video_uploads (job_number, job_id, street_address, youtube_video_id, youtube_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const videoJobs = rng.sample(
    world.jobs.filter(
      (j) => j.status === "Completed" && j._jobType.category === "Install" && new Date(j._start) >= addDays(now, -120)
    ),
    14
  );
  const idChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
  let videoRows = 0;
  for (const job of videoJobs) {
    const loc = world.index.locationById.get(String(job.locationId));
    const vid = Array.from({ length: 11 }, () => idChars[rng.int(0, idChars.length - 1)]).join("");
    videoStmt.run(
      job.jobNumber,
      String(job.id),
      loc ? loc.address.street : null,
      vid,
      `https://www.youtube.com/watch?v=${vid}`,
      sqlTs(addDays(job.completedOn || job._start, rng.int(0, 3)))
    );
    videoRows++;
  }
  out.videoRows = videoRows;

  // ── invoice_uploads (supplier invoice → ST purchase order) ───────────────
  const invStmt = db.prepare(`
    INSERT INTO invoice_uploads (
      vendor, invoice_number, invoice_date, job_number, job_id, vendor_id,
      total, po_id, po_number, status, error, file_name, created_at,
      attached, attach_error, sent, sent_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, NULL)
  `);
  const recentPos = world.purchaseOrders
    .filter((p) => new Date(p.sentOn) >= addDays(now, -110))
    .slice(-24);
  let invoiceRows = 0;
  for (const po of recentPos) {
    const job = world.index.jobById.get(String(po.jobId));
    if (!job) continue;
    const failed = rng.chance(0.12);
    const invNo = `${String(po.vendor.name).replace(/[^A-Z]/g, "").slice(0, 3) || "SUP"}-${rng.int(100000, 999999)}`;
    const invDate = ymd(po.sentOn);
    invStmt.run(
      po.vendor.name,
      invNo,
      invDate,
      job.jobNumber,
      String(job.id),
      String(po.vendorId),
      po.total,
      failed ? null : String(po.id),
      failed ? null : po.number,
      failed ? "failed" : "created",
      failed ? "No matching job found for the job number printed on the invoice" : null,
      `${invNo}.pdf`,
      sqlTs(addDays(po.sentOn, rng.int(0, 4)))
    );
    invoiceRows++;
  }
  out.invoiceRows = invoiceRows;

  // ── scope_estimate_uploads ───────────────────────────────────────────────
  const scopeStmt = db.prepare(`
    INSERT INTO scope_estimate_uploads
      (file_name, job_number, job_id, estimate_id, line_item_count, total, status, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const scopeJobs = rng.sample(
    world.jobs.filter((j) => j._jobType.category === "Install" && new Date(j._start) >= addDays(now, -90)),
    10
  );
  let scopeRows = 0;
  scopeJobs.forEach((job, i) => {
    const failed = i === 2;
    scopeStmt.run(
      `Scope of Work - ${job.customerName.replace(/[^A-Za-z0-9 ]/g, "")}.docx`,
      job.jobNumber,
      job.id,
      failed ? null : 700000 + i,
      failed ? null : rng.int(4, 14),
      failed ? null : rng.money(2800, 14500),
      failed ? "failed" : "created",
      failed ? "Could not match 3 of 9 line items to the pricebook — estimate not created" : null,
      sqlTs(addDays(job._start, -rng.int(1, 5)))
    );
    scopeRows++;
  });
  out.scopeRows = scopeRows;

  // ── address_audit_cache ──────────────────────────────────────────────────
  const addrStmt = db.prepare(`
    INSERT OR REPLACE INTO address_audit_cache (
      location_id, customer_id, address_fingerprint, status,
      verified_json, verified_formatted, partial_match, location_type,
      lat, lng, place_id, error, checked_at, applied_at, dismissed_at, updated_at,
      original_json, original_name, suggested_name
    ) VALUES (
      @location_id, @customer_id, @address_fingerprint, @status,
      @verified_json, @verified_formatted, @partial_match, @location_type,
      @lat, @lng, @place_id, @error, @checked_at, @applied_at, @dismissed_at, @updated_at,
      @original_json, @original_name, @suggested_name
    )
  `);

  const messyLocations = world.locations.filter((l) => {
    const cust = world.index.customerById.get(String(l.customerId));
    return cust && cust._messyAddress;
  });
  const cleanLocations = world.locations.filter((l) => {
    const cust = world.index.customerById.get(String(l.customerId));
    return cust && !cust._messyAddress;
  });
  const auditSet = [...rng.sample(messyLocations, 26), ...rng.sample(cleanLocations, 34)];

  const tidyStreet = (s) =>
    String(s)
      .replace(/\bStreet\b/i, "St")
      .replace(/\bRoad\b/i, "Rd")
      .replace(/\bDrive\b/i, "Dr")
      .replace(/\bAvenue\b/i, "Ave")
      .split(" ")
      .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
      .join(" ");

  let addressRows = 0;
  for (const loc of auditSet) {
    const cust = world.index.customerById.get(String(loc.customerId));
    const messy = !!(cust && cust._messyAddress);
    const original = { ...loc.address };
    const verified = {
      street: tidyStreet(original.street),
      unit: original.unit || "",
      city: original.city,
      state: original.state,
      zip: (C.CITIES.find((c) => c.name === original.city) || {}).zip || original.zip,
      country: "USA",
    };
    const changed = messy && (verified.street !== original.street || verified.zip !== original.zip);
    const status = changed
      ? rng.weighted([["standardized", 7], ["partial", 2], ["no-match", 1]])
      : rng.weighted([["ok", 12], ["standardized", 1]]);

    const checkedAt = addDays(now, -rng.int(1, 25));
    const applied = status !== "ok" && rng.chance(0.28);
    const dismissed = status !== "ok" && !applied && rng.chance(0.15);
    const errored = status === "no-match";

    addrStmt.run({
      location_id: loc.id,
      customer_id: loc.customerId,
      address_fingerprint: fingerprintAddress(original),
      status,
      verified_json: errored ? null : JSON.stringify(verified),
      verified_formatted: errored
        ? null
        : `${verified.street}, ${verified.city}, ${verified.state} ${verified.zip}, USA`,
      partial_match: status === "partial" ? 1 : 0,
      location_type: errored
        ? null
        : rng.weighted([["ROOFTOP", 8], ["RANGE_INTERPOLATED", 3], ["GEOMETRIC_CENTER", 1], ["APPROXIMATE", 1]]),
      lat: errored ? null : Math.round((40.05 + rng.float() * 0.4) * 1e6) / 1e6,
      lng: errored ? null : Math.round((-83.35 + rng.float() * 0.5) * 1e6) / 1e6,
      place_id: errored ? null : `ChIJ${Array.from({ length: 17 }, () => idChars[rng.int(0, idChars.length - 1)]).join("")}`,
      error: errored ? "ZERO_RESULTS — Google could not match this address" : null,
      checked_at: sqlTs(checkedAt),
      applied_at: applied ? sqlTs(addDays(checkedAt, rng.int(0, 5))) : null,
      dismissed_at: dismissed ? sqlTs(addDays(checkedAt, rng.int(0, 5))) : null,
      updated_at: sqlTs(addDays(checkedAt, applied || dismissed ? 1 : 0)),
      original_json: JSON.stringify(original),
      original_name: loc.name,
      suggested_name:
        changed && rng.chance(0.5)
          ? `${cust.name}${loc.name.includes(" - ") ? ` - ${verified.street}` : ""}`
          : null,
    });
    addressRows++;
  }
  out.addressRows = addressRows;

  // ── app_settings — the two tunable AI prompts ────────────────────────────
  const settingStmt = db.prepare(`
    INSERT OR REPLACE INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
  `);
  const manager = world.office.find((o) => o.role === "Office Manager") || world.office[0];
  settingStmt.run(
    "classification_instructions",
    [
      `You are reviewing recorded phone calls for ${C.COMPANY.name}, a residential plumbing, heating and cooling company.`,
      "",
      "House rules:",
      "- Anyone on our staff roster is NEVER the customer. If the only named person is staff, use internal_call.",
      '- Maintenance visits under the Ground Club plan are dues-covered. Never describe them as unbilled work.',
      "- A caller who asks for a price and does not schedule is unbooked_call, not new_service_request.",
      "- Supply houses calling for a card authorization are vendor calls, not leads.",
      "- Write the recap bullets the way a dispatcher would — short, specific, no filler.",
    ].join("\n"),
    sqlTs(addDays(now, -19)),
    manager.email
  );
  settingStmt.run(
    "transcription_prompt",
    `This is a phone call for ${C.COMPANY.name} (say "Grounded Home Services", not "grounded home service"). Expect HVAC and plumbing vocabulary: capacitor, contactor, condenser, inducer motor, flame sensor, hydro jetting, T&P valve, ProPress, Ground Club membership. Technician names include ${world.technicians.slice(0, 4).map((t) => t.name).join(", ")}.`,
    sqlTs(addDays(now, -19)),
    manager.email
  );
  out.settingRows = 2;

  return out;
}

/** 24. kv_store — poller cursors, pause flags, the review watermark. */
function seedKvStore(db, world, now) {
  const stmt = db.prepare(`INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)`);
  stmt.run("call_poll_last_run", isoZ(addMinutes(now, -4)));
  stmt.run("forms_poll_last_run", isoZ(addMinutes(now, -11)));
  stmt.run("happy_review_paused", "false");
  // Three days back, so the dashboard hero has a real "new since last review"
  // backlog instead of a zero.
  stmt.run("calls_last_reviewed_at", sqlTs(addDays(now, -3)));
  return 4;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function countRows(db) {
  const counts = {};
  for (const t of SEEDED_TABLES) {
    try {
      counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    } catch (_) {
      counts[t] = null;
    }
  }
  try {
    counts.kv_store = db.prepare("SELECT COUNT(*) AS n FROM kv_store").get().n;
  } catch (_) {
    counts.kv_store = null;
  }
  return counts;
}

/** Delete everything this seeder owns. Never touches `users` or sessions. */
function clearDemoData(db) {
  ensureKvTable(db);
  for (const t of SEEDED_TABLES) {
    try {
      db.prepare(`DELETE FROM ${t}`).run();
    } catch (_) {
      /* table may not exist yet on an old schema */
    }
  }
  const del = db.prepare("DELETE FROM kv_store WHERE key = ?");
  for (const k of SEEDED_KV_KEYS) del.run(k);
}

/**
 * Seed the demo database.
 *
 * @param {import('better-sqlite3').Database} db  an open DB with initSchema() applied
 * @param {object} [opts]
 * @param {boolean} [opts.force=false]  wipe and rewrite even if already seeded
 * @param {object}  [opts.world]        pre-built world (defaults to getWorld())
 * @param {boolean} [opts.quiet=false]  suppress the console summary
 * @returns {{ seeded:boolean, skipped:boolean, seededAt:string, counts:object, ms:number }}
 */
function seedDemoDatabase(db, opts = {}) {
  if (!db) throw new Error("seedDemoDatabase: a better-sqlite3 database is required");
  const t0 = Date.now();
  const quiet = !!opts.quiet;

  ensureKvTable(db);
  const marker = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(SEED_MARKER_KEY);
  if (marker && !opts.force) {
    if (!quiet) console.log(`[demo:seed] already seeded at ${marker.value} — skipping (use --force to rewrite)`);
    return { seeded: false, skipped: true, seededAt: marker.value, counts: countRows(db), ms: Date.now() - t0 };
  }

  const world = opts.world || getWorld();
  const now = new Date(world.now || Date.now());
  const rng = new Rng(ROOT_SEED).fork("db-seed");
  const seededAt = sqlTs(now);

  const run = db.transaction(() => {
    if (marker) clearDemoData(db);

    seedEmployeePhones(db, world, now);
    seedFleetTechnicians(db, world, now);
    seedKnownAddresses(db, world, rng, now);
    seedProcessedCalls(db, world, rng, now);
    seedInstallTracker(db, world, rng, now);
    seedJobReview(db, world, rng, now);
    seedTimesheets(db, world, rng, now);
    seedPricebook(db, world, rng, now);
    seedEquipmentRegistrations(db, world, rng, now);
    seedAuditTrails(db, world, rng, now);
    seedKvStore(db, world, now);

    db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)").run(SEED_MARKER_KEY, seededAt);
  });

  run();

  const counts = countRows(db);
  const ms = Date.now() - t0;
  if (!quiet) {
    const total = Object.values(counts).reduce((s, v) => s + (v || 0), 0);
    console.log(`[demo:seed] seeded ${total} rows across ${Object.keys(counts).length} tables in ${ms}ms (seed ${ROOT_SEED})`);
  }
  return { seeded: true, skipped: false, seededAt, counts, ms };
}

module.exports = {
  seedDemoDatabase,
  clearDemoData,
  countRows,
  SEED_MARKER_KEY,
  SEEDED_TABLES,
  // exported for tests / verification scripts
  _internals: { sqlTs, isoZ, normalizeAddr, fingerprintAddress, tokenString, buildCallContent },
};

// ---------------------------------------------------------------------------
// CLI — `npm run demo:seed [-- --force]`
// ---------------------------------------------------------------------------

if (require.main === module) {
  // Required lazily: importing db/index opens/creates the SQLite file, and we
  // don't want that side effect for consumers who only want the functions.
  const { getDb, initSchema } = require("../db/index");
  const force = process.argv.includes("--force");

  initSchema();
  const db = getDb();
  const result = seedDemoDatabase(db, { force });

  if (result.skipped) {
    console.log("[demo:seed] nothing to do.");
  } else {
    const rows = Object.entries(result.counts)
      .sort((a, b) => b[1] - a[1])
      .map(([table, n]) => `  ${String(n).padStart(6)}  ${table}`);
    console.log(rows.join("\n"));
  }
}
