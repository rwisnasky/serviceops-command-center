/**
 * src/demo/openai.mock.js
 *
 * Canned stand-in for the OpenAI SDK, used when DEMO_MODE=true and no live key
 * is configured. Same idea as servicetitan.mock.js: implement the surface the
 * app actually calls, against generated data, so nothing upstream knows the
 * difference.
 *
 * Surface implemented (everything the app uses today):
 *   client.chat.completions.create(params)   -> chat.completion envelope
 *   client.audio.transcriptions.create(params) -> { text, ... }
 *   client.images.generate(params)           -> { data: [{ b64_json }] }
 *
 * How a request is routed
 * -----------------------
 * There is no model here, so the shim reads the request the way a human would:
 * it flattens the system + user messages, looks for the phrases each service's
 * prompt is built around (and the response_format json_schema name, if a caller
 * ever starts using one), and dispatches to a per-feature generator. Each
 * generator returns EXACTLY the JSON shape its caller parses — the callers do
 * real JSON.parse + key access, so a wrong shape shows up immediately as a
 * broken page, not as a subtly-off demo.
 *
 * Determinism
 * -----------
 * Same request in, same response out. Every generator runs off `new Rng(
 * hashString(prompt))`, so the invoice you parse twice is the same invoice, but
 * two different uploads give two different invoices. No Math.random().
 *
 * Latency
 * -------
 * Real model calls take a second or two and the UI has spinners and progress
 * copy built around that. An instant response makes those states invisible and
 * makes the demo feel fake in the other direction, so every call sleeps
 * DEMO_AI_LATENCY_MS (default 600) plus a little jitter.
 */

const zlib = require("zlib");
const { Rng, hashString } = require("./rng");
const C = require("./catalog");

// ---------------------------------------------------------------------------
// Latency + logging
// ---------------------------------------------------------------------------

const LATENCY_MS = (() => {
  const raw = process.env.DEMO_AI_LATENCY_MS;
  const n = raw == null || raw === "" ? 600 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 600;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sleep for roughly LATENCY_MS, jittered ±25% off the request's own seed. */
function fakeLatency(rng) {
  if (LATENCY_MS === 0) return Promise.resolve();
  const jitter = 0.75 + rng.float() * 0.5;
  return sleep(Math.round(LATENCY_MS * jitter));
}

let _announced = false;
function announceOnce() {
  if (_announced) return;
  _announced = true;
  console.log(
    "[demo] OpenAI: canned mode (set DEMO_AI=live with an API key for real calls)"
  );
}

// ---------------------------------------------------------------------------
// Request flattening + seeding
// ---------------------------------------------------------------------------

/**
 * Turn a chat message's `content` (string, or the multipart array the vision
 * callers use) into plain text. Image data-URLs are collapsed to a short
 * fingerprint: we want the bytes to influence the seed (two different invoice
 * scans should parse differently) without hashing megabytes of base64.
 */
function flattenContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text") return part.text || "";
      if (part.type === "image_url") {
        const url = String(part.image_url?.url || "");
        return `[image:${url.length}:${hashString(url.slice(0, 4096)).toString(36)}]`;
      }
      return "";
    })
    .join("\n");
}

function flattenRequest(params = {}) {
  const messages = Array.isArray(params.messages) ? params.messages : [];
  const system = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => flattenContent(m.content))
    .join("\n");
  const user = messages
    .filter((m) => m.role === "user")
    .map((m) => flattenContent(m.content))
    .join("\n");
  const schemaName =
    params.response_format?.json_schema?.name ||
    params.response_format?.type ||
    "";
  return { system, user, schemaName, model: params.model || "gpt-4o" };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Feature detection. Ordered most-specific first — several of these prompts
 * mention "JSON" and "home services", so the distinctive phrase for each one is
 * a line that only that service's prompt contains.
 */
function routeChat(req) {
  // Collapse whitespace first: these prompts are hard-wrapped template literals,
  // so a phrase like "scope-of-work write-up" has a newline in the middle of it.
  const s = req.system.toLowerCase().replace(/\s+/g, " ");
  const n = String(req.schemaName || "").toLowerCase();

  if (n.includes("bradford") || s.includes("bradford white")) return cannedBradfordWhite;
  if (n.includes("special_instructions") || s.includes("special installation instructions"))
    return cannedSpecialInstructions;
  if (n.includes("rename") || s.includes("rename servicetitan pricebook materials"))
    return cannedMaterialRename;
  if (n.includes("invoice") || s.includes("expert at reading supplier invoices"))
    return cannedInvoice;
  if (n.includes("pricebook_match") || s.includes("candidate pricebook skus"))
    return cannedPricebookMatch;
  if (n.includes("scope") || s.includes("scope-of-work write-up"))
    return cannedScope;
  if (n.includes("classification") || s.includes("call intelligence assistant") || s.includes('"summarybullets"'))
    return cannedClassification;

  return cannedUnknown;
}

// ---------------------------------------------------------------------------
// Response envelopes
// ---------------------------------------------------------------------------

function chatEnvelope(model, content, seed) {
  // Mirrors the shape the v4 SDK returns for a non-streaming completion. The
  // app only reads choices[0].message.content, but keeping the rest honest
  // means a future logging/usage change doesn't hit undefined.
  const promptTokens = 400 + (seed % 900);
  const completionTokens = Math.max(24, Math.round(content.length / 4));
  return {
    id: `chatcmpl-demo-${seed.toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: "fp_demo",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, refusal: null },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

const titleCase = (s) =>
  String(s)
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());

const money = (n) => Math.round(n * 100) / 100;

function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}
function daysAgo(n) {
  return new Date(Date.now() - n * 86400000);
}
function addYears(date, years) {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + years);
  return d;
}

/** Lazy handle on the generated tenant, so canned docs can reference real jobs. */
function tryWorld() {
  try {
    return require("./world").getWorld();
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Generator: special-instruction bulletizer
// ---------------------------------------------------------------------------
// Caller: specialInstructionsService.bulletizeInstructions
//   JSON.parse(content).bullets -> string[]
// The real model rewrites the OCR paragraph it was handed, so the canned
// version does the same transformation rather than inventing new text: clean up
// the dotted-abbreviation artifacts the OCR leaves behind, then split on
// sentence and clause boundaries. Output tracks the input, which is what makes
// the PDF Parser page look real when you feed it a different document.
function cannedSpecialInstructions(req, rng) {
  // Only the dotted forms — a bare "he" or "we" is an ordinary word, and the
  // lookahead keeps the trailing period from surviving into the sentence split.
  const cleaned = String(req.user || "")
    .replace(/\bh\.\s?e\.(?=\s|$|[,;])/gi, "HE")
    .replace(/\br\.\s?o\.(?=\s|$|[,;])/gi, "RO")
    .replace(/\bw\.\s?h\.(?=\s|$|[,;])/gi, "WH")
    .replace(/\s+/g, " ")
    .trim();

  let parts = cleaned
    .split(/(?<=[.!?])\s+|\s*;\s*|\s+•\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);

  // A single long run-on sentence is the common case — break it on the
  // conjunctions people actually dictate with.
  if (parts.length <= 1 && cleaned.length > 90) {
    parts = cleaned
      .split(/,\s+(?:and\s+then|then|and|also|plus)\s+|\s+-\s+/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 2);
  }

  const bullets = parts
    .map((s) => s.replace(/\s*\.\s*$/, "").replace(/^[-•*\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 8);

  // Occasional trailing reminder, the way the model tends to keep a parenthetical
  // note attached rather than dropping it.
  if (bullets.length && rng.chance(0.25) && /picture/i.test(cleaned) === false) {
    bullets[bullets.length - 1] += " (confirm with homeowner on arrival)";
  }

  return { bullets: bullets.length ? bullets : [cleaned].filter(Boolean) };
}

// ---------------------------------------------------------------------------
// Generator: material rename
// ---------------------------------------------------------------------------
// Caller: materialRenameService.suggestName
//   JSON.parse(content) -> { suggestedName, reason, confidence: high|med|low }
// suggestedName must be non-empty (the service throws otherwise) and confidence
// must be one of the three literals or it silently becomes "med".

// Supply-house shorthand -> what a tech would call it. Only the abbreviations
// that actually show up in a plumbing/HVAC book; anything unmatched is left
// alone rather than guessed at.
const ABBREV = {
  BRS: "Brass", CU: "Copper", SS: "Stainless Steel", GALV: "Galvanized",
  PVC: "PVC", CPVC: "CPVC", PEX: "PEX", ABS: "ABS", CSST: "CSST",
  VLV: "Valve", BV: "Ball Valve", GV: "Gate Valve", CK: "Check Valve",
  ELB: "Elbow", ELL: "Elbow", CPLG: "Coupling", CPL: "Coupling",
  NIP: "Nipple", TEE: "Tee", RED: "Reducing", BUSH: "Bushing", ADPT: "Adapter",
  UN: "Union", FLG: "Flange", CAP: "Capacitor", CONT: "Contactor",
  XFMR: "Transformer", TRANS: "Transformer", MTR: "Motor", BLWR: "Blower",
  CMPRSR: "Compressor", COMP: "Compressor", CNDR: "Condenser", EVAP: "Evaporator",
  IGN: "Ignitor", HSI: "Hot Surface Ignitor", TSTAT: "Thermostat",
  THERMO: "Thermostat", WH: "Water Heater", HTR: "Heater", FLT: "Filter",
  DR: "Drier", ASM: "Assembly", ASSY: "Assembly", SWT: "Sweat", THD: "Threaded",
  MIP: "MIP", FIP: "FIP", NPT: "NPT", OD: "OD", ID: "ID",
  PRV: "Pressure Reducing Valve", TP: "T&P Relief Valve", DU: "Dielectric Union",
};

function cannedMaterialRename(req, rng) {
  const currentName =
    (/current name:\s*(.+)/i.exec(req.user) || [])[1]?.trim() || "";
  const code = (/supplier code:\s*(.+)/i.exec(req.user) || [])[1]?.trim() || null;
  const description =
    (/description:\s*(.+)/i.exec(req.user) || [])[1]?.trim() || null;

  const source = `${currentName} ${description || ""}`;
  const tokens = currentName.split(/[\s\-_/]+/).filter(Boolean);

  // Size/spec tokens are the part techs search on, so they survive verbatim.
  // Dedupe on the numeric part and keep the variant that carries a unit
  // ("3/4 in" beats a second bare "3/4" picked up from the description).
  const rawSpecs = (source.match(/\b\d+(?:\.\d+)?\/\d+(?:\s?in)?\b|\b\d+(?:\.\d+)?\s?(?:in|ft|hp|va|amp|mfd|gal|ton|btu)\b/gi) || [])
    .map((s) => s.replace(/\s+/g, " ").trim());
  const specByNumber = new Map();
  for (const s of rawSpecs) {
    const num = (s.match(/^[\d./]+/) || [""])[0];
    const prev = specByNumber.get(num);
    if (!prev || s.length > prev.length) specByNumber.set(num, s);
  }
  const specs = [...specByNumber.values()];

  const expanded = [];
  for (const t of tokens) {
    const key = t.toUpperCase().replace(/[^A-Z&]/g, "");
    if (ABBREV[key]) expanded.push(ABBREV[key]);
  }

  let suggestedName;
  let reason;
  let confidence;

  if (expanded.length >= 2) {
    // Enough shorthand decoded to lead with the noun and follow with the spec.
    const noun = expanded[expanded.length - 1];
    const modifiers = expanded.slice(0, -1).join(" ");
    const spec = specs.slice(0, 2).join(" ");
    suggestedName = [modifiers, noun, spec].filter(Boolean).join(" ").trim();
    reason = `Expanded supply-house shorthand in "${currentName}" and kept the size spec.`;
    confidence = "high";
  } else if (expanded.length === 1) {
    const spec = specs.slice(0, 2).join(" ");
    suggestedName = [expanded[0], spec].filter(Boolean).join(" ").trim();
    reason = `Recognized the item type from "${currentName}"; other tokens left off as supplier noise.`;
    confidence = specs.length ? "med" : "low";
  } else if (description && /[a-z]/.test(description) && description.split(/\s+/).length >= 2) {
    // The description is prose — that's better source material than the code.
    suggestedName = titleCase(description.split(/[.,;]/)[0].slice(0, 58)).trim();
    reason = "Built the name from the supplier description; the display name is a part number.";
    confidence = "med";
  } else {
    // Truly opaque part number. The prompt explicitly asks us to say so rather
    // than invent a spec, so the low-confidence branch is the correct answer.
    // The part number keeps its original casing — it's an identifier.
    suggestedName = `Supplier Part ${currentName || code || "—"} (Verify Description)`;
    reason = "Source name is an opaque manufacturer part number — no item type or spec is inferable.";
    confidence = "low";
  }

  // Trim toward the 35-60 char band the prompt asks for, then put the trade
  // acronyms back in caps — Title Case turns MIP into "Mip", which reads wrong
  // to anyone who orders parts.
  suggestedName = restoreAcronyms(suggestedName.replace(/\s{2,}/g, " ").slice(0, 60).trim());
  if (!suggestedName) suggestedName = `Pricebook Material ${code || rng.int(1000, 9999)}`;

  return { suggestedName, reason, confidence };
}

const ACRONYMS = [
  "MIP", "FIP", "NPT", "PVC", "CPVC", "PEX", "ABS", "CSST", "HP", "OD", "ID",
  "VA", "MFD", "SEER", "BTU", "UV", "RO", "T&P", "PRV", "PSI",
];
function restoreAcronyms(s) {
  let out = s;
  for (const a of ACRONYMS) out = out.replace(new RegExp(`\\b${a}\\b`, "gi"), a);
  return out;
}

// ---------------------------------------------------------------------------
// Generator: supplier invoice OCR
// ---------------------------------------------------------------------------
// Caller: invoiceParserService.parseInvoice
//   Reads vendor / invoiceNumber / invoiceDate / jobNumber / jobNumberLabel /
//   subtotal / tax / total / lineItems[{description, sku, quantity, unitCost,
//   lineTotal}]. Numbers must be plain numbers.
// Vendors and parts come from the demo catalog and the job number from a real
// generated job, so the PO the user creates off this parse actually resolves.
function cannedInvoice(req, rng) {
  const vendor = rng.pick(C.VENDORS).name;
  const invoiceDate = daysAgo(rng.int(1, 26));

  const pool = rng.sample(C.PRICEBOOK_MATERIALS, rng.int(2, 5));
  const lineItems = pool.map(([name, sku, , cost]) => {
    const quantity = rng.weighted([[1, 6], [2, 4], [4, 2], [10, 1], [25, 1]]);
    const unitCost = money(cost * (0.94 + rng.float() * 0.16));
    return {
      description: name,
      sku,
      quantity,
      unitCost,
      lineTotal: money(unitCost * quantity),
    };
  });

  const subtotal = money(lineItems.reduce((s, li) => s + li.lineTotal, 0));
  const tax = money(subtotal * 0.0725);
  const total = money(subtotal + tax);

  // ~70% of supplier invoices carry our reference back; the rest only have the
  // supplier's own order number, which the prompt says to reject (null).
  let jobNumber = null;
  let jobNumberLabel = null;
  if (rng.chance(0.7)) {
    const world = tryWorld();
    const job = world && world.jobs && world.jobs.length ? rng.pick(world.jobs) : null;
    jobNumber = job ? String(job.jobNumber) : String(rng.int(100000, 999999));
    jobNumberLabel = rng.pick(["Customer PO", "Your PO #", "Customer Job #", "Job No."]);
  }

  const prefix = vendor.split(/\s+/)[0].slice(0, 3).toUpperCase();

  return {
    vendor,
    invoiceNumber: `${prefix}-${rng.int(100000, 999999)}`,
    invoiceDate: isoDate(invoiceDate),
    jobNumber,
    jobNumberLabel,
    subtotal,
    tax,
    total,
    lineItems,
  };
}

// ---------------------------------------------------------------------------
// Generator: Bradford White registration screenshot
// ---------------------------------------------------------------------------
// Caller: bradfordWhiteWarranty.parseWarrantyImage -> unitFromParsed()
//   Reads serial, model, type, mfgDate, originalMfgDate, tankWarrantyYears,
//   partsWarrantyYears, tankWarrantyExpires, partsWarrantyExpires,
//   registrationStatus, registrationDate. All dates ISO.
// The downstream math derives install date = expiry − warranty years, so these
// dates have to be internally consistent or the ST payload comes out wrong.
function cannedBradfordWhite(req, rng) {
  const bw = C.EQUIPMENT_MANUFACTURERS.waterHeater.find((m) => m.name === "Bradford White");
  const model = rng.pick(bw ? bw.models : ["RG250T6N"]);
  const type = /PV/.test(model) ? "RES GAS PV" : /TW/.test(model) ? "RES ELECTRIC" : "RES GAS";

  const installed = daysAgo(rng.int(20, 400));
  const mfg = new Date(installed.getTime() - rng.int(45, 260) * 86400000);
  const registration = new Date(installed.getTime() + rng.int(0, 21) * 86400000);

  const tankYears = rng.weighted([[6, 7], [10, 2], [8, 1]]);
  const partsYears = rng.chance(0.85) ? tankYears : 6;

  return {
    serial: `${rng.pick(["BL", "CE", "DK", "FH", "GM"])}${rng.int(10000000, 99999999)}`,
    model,
    type,
    mfgDate: isoDate(mfg),
    originalMfgDate: null,
    tankWarrantyYears: tankYears,
    partsWarrantyYears: partsYears,
    tankWarrantyExpires: isoDate(addYears(installed, tankYears)),
    partsWarrantyExpires: isoDate(addYears(installed, partsYears)),
    registrationStatus: "Registered",
    registrationDate: isoDate(registration),
  };
}

// ---------------------------------------------------------------------------
// Generator: pricebook SKU match
// ---------------------------------------------------------------------------
// Caller: pricebookMatcher.askLLM
//   JSON.parse(content) -> { skuId: number|null, confidence: number, reasoning }
//   The service then looks the skuId up in the candidate list it sent — an id
//   that isn't in that list is treated as "no match", so we must pick from the
//   candidates it actually gave us.
function tokensOf(s) {
  return new Set(
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2)
  );
}

function cannedPricebookMatch(req, rng) {
  const scopeLine = (/scope line:\s*"([^"]*)"/i.exec(req.user) || [])[1] || "";
  const candidates = [];
  const lineRe = /^-\s*id:(\d+)\s*\[([^\]]+)\]\s*"([^"]*)"(.*)$/gm;
  let m;
  while ((m = lineRe.exec(req.user)) !== null) {
    candidates.push({ id: Number(m[1]), type: m[2], name: m[3], rest: m[4] || "" });
  }
  if (candidates.length === 0) {
    return { skuId: null, confidence: 0.2, reasoning: "No candidate SKUs were supplied." };
  }

  const q = tokensOf(scopeLine);
  const scored = candidates
    .map((c) => {
      const t = tokensOf(`${c.name} ${c.rest}`);
      let hits = 0;
      for (const tok of q) if (t.has(tok)) hits++;
      // Coverage of the scope line, same idea as the fuzzy scorer upstream.
      return { ...c, coverage: q.size ? hits / q.size : 0, hits };
    })
    .sort((a, b) => b.coverage - a.coverage || a.name.length - b.name.length);

  const best = scored[0];

  // The service only reaches the LLM when fuzzy was ambiguous, so a genuine
  // "none of these" is a real outcome and the UI has a state for it.
  if (best.coverage < 0.2 || best.hits < 1) {
    return {
      skuId: null,
      confidence: 0.3,
      reasoning: `None of the candidates covers "${scopeLine.slice(0, 60)}" closely enough to bill from.`,
    };
  }

  const confidence = Math.min(0.95, money(0.55 + best.coverage * 0.4 + rng.float() * 0.05));
  return {
    skuId: best.id,
    confidence,
    reasoning: `"${best.name}" is the closest ${best.type.toLowerCase()} for this line — same work, matching spec.`,
  };
}

// ---------------------------------------------------------------------------
// Generator: scope-of-work / competitor quote
// ---------------------------------------------------------------------------
// Caller: scopeParserService.parseScope
//   Reads jobNumber, customerName, projectTitle, lineItems[{description,
//   quantity, notes}]. Descriptions are fed straight into the pricebook
//   matcher, so they're written to actually hit SKUs in the demo catalog —
//   otherwise every line comes back unmatched and the page looks broken.
const SCOPE_TEMPLATES = [
  {
    title: "Water Heater Replacement — 50 Gallon Power Vent",
    items: [
      ["Replace 50 gallon power vent water heater", 1, "Existing unit is 13 years old, basement utility room. Bradford White preferred."],
      ["Install thermal expansion tank", 1, "2 gallon, mount above cold inlet"],
      ["Replace T&P relief valve", 1, null],
      ["Haul away and dispose of old water heater", 1, null],
      ["Pull plumbing permit", 1, "City of Ridgemont"],
    ],
  },
  {
    title: "Furnace and Coil Changeout",
    items: [
      ["Replace 96% 80k BTU variable speed furnace", 1, "Upflow, existing return is 20x25"],
      ["Replace 3 ton cased evaporator coil", 1, "Match to existing condenser, R-410A"],
      ["Install smart thermostat", 1, "Homeowner wants WiFi control"],
      ["Pull mechanical permit", 1, null],
      ["Haul away old equipment", 1, null],
    ],
  },
  {
    title: "Main Line Drain and Sewer Diagnostic",
    items: [
      ["Clear main line drain", 1, "Backing up at basement floor drain"],
      ["Sewer camera inspection", 1, "Locate suspected root intrusion 40-60 ft out"],
      ["Hydro jetting main line", 1, "Only if camera confirms heavy buildup"],
    ],
  },
  {
    title: "Hall Bath Fixture Replacement",
    items: [
      ["Replace toilet - standard", 1, "Comfort height, homeowner supplying fixture"],
      ["Replace bath faucet", 1, "Widespread, 8 in centers"],
      ["Replace angle stop valves", 4, "Quarter turn, 1/2 x 3/8"],
      ["Install wax ring kit", 1, "Extra thick, flange sits low"],
    ],
  },
  {
    title: "AC Changeout — 3 Ton Condenser",
    items: [
      ["Replace 3 ton 14.3 SEER2 condenser", 1, "Existing pad is level, disconnect stays"],
      ["Replace refrigerant line set", 1, "3/4 x 3/8, approximately 25 ft run"],
      ["Recharge system with R-410A refrigerant", 6, "Per pound"],
      ["Replace 16x25x1 pleated filter", 2, null],
    ],
  },
  {
    title: "Sump Pump and Backup System",
    items: [
      ["Replace 1/3 HP sump pump", 1, "Cast iron, existing basin is 18 in"],
      ["Install battery backup sump pump", 1, "Homeowner had water in finished basement in April"],
      ["Replace sump check valve", 1, "1-1/2 in"],
    ],
  },
];

function cannedScope(req, rng) {
  const tpl = rng.pick(SCOPE_TEMPLATES);
  const world = tryWorld();

  // Half the scopes are for an existing customer with a job already open; the
  // rest are cold competitor quotes with no job number to link to.
  let customerName = null;
  let jobNumber = null;
  if (world && world.customers && world.customers.length && rng.chance(0.75)) {
    const cust = rng.pick(world.customers);
    customerName = cust.name;
    if (rng.chance(0.5) && world.jobs && world.jobs.length) {
      const job = world.jobs.find((j) => j.customerId === cust.id);
      jobNumber = job ? String(job.jobNumber) : null;
    }
  } else {
    customerName = `${rng.pick(C.LAST_NAMES)} Residence`;
  }

  // Drop a line or two sometimes so two scopes of the same template differ.
  const items = tpl.items.filter((_, i) => i < 3 || rng.chance(0.75));

  return {
    jobNumber,
    customerName,
    projectTitle: tpl.title,
    lineItems: items.map(([description, quantity, notes]) => ({
      description,
      quantity,
      notes,
    })),
  };
}

// ---------------------------------------------------------------------------
// Call transcripts + classification
// ---------------------------------------------------------------------------
// These two share one scenario table on purpose. The transcription shim renders
// a scenario into dialogue; the classification shim reads dialogue back and
// scores it against the same markers. That means the demo's call pipeline is
// internally consistent end-to-end (transcribe -> classify -> ST label) instead
// of two independent random generators that happen to sit next to each other.
//
// The marker sets are deliberately keyword-ish rather than perfect. A couple of
// scenarios (the warranty call that opens with a billing complaint, the price
// objection) are written to trip that scoring the same way a real classifier
// trips on them — the Call Reviews page exists to catch exactly those.

function callContext(rng) {
  const csr = rng.pick(C.OFFICE_TEAM.filter((o) => o.csr));
  const tech = rng.pick(C.TECHNICIANS);
  const city = rng.pick(C.CITIES);
  return {
    csr: csr.name.split(" ")[0],
    tech: tech.name.split(" ")[0],
    techFull: tech.name,
    first: rng.pick(rng.chance(0.5) ? C.FIRST_NAMES_M : C.FIRST_NAMES_F),
    last: rng.pick(C.LAST_NAMES),
    street: `${rng.int(100, 9800)} ${rng.pick(C.STREET_NAMES)} ${rng.pick(C.STREET_SUFFIXES)}`,
    city: city.name,
    day: rng.pick(["today", "tomorrow", "Thursday", "Monday", "Friday"]),
    window: rng.pick(["8 to 12", "10 to 2", "12 to 4", "2 to 6"]),
    jobNo: String(rng.int(100000, 999999)),
    amount: rng.int(180, 940),
  };
}

const GREET = (c) =>
  `CSR (${c.csr}): Thank you for calling Grounded Home Services, this is ${c.csr}. How can I help you today?`;

const SCENARIOS = [
  {
    key: "no_heat_emergency",
    category: "emergency_request",
    sentiment: "negative",
    isSpam: false,
    isJobRelated: true,
    confidence: [0.88, 0.96],
    markers: [/no heat/i, /furnace (is )?(out|not|won'?t)/i, /freezing/i, /emergency/i, /space heater/i],
    lines: (c) => [
      GREET(c),
      `Caller: Hi, this is ${c.first} ${c.last} over on ${c.street}. Our furnace quit sometime overnight and the house is down to 54.`,
      `CSR (${c.csr}): I'm sorry, that's miserable. Is anyone in the home who's medically at risk, or any kids or elderly?`,
      `Caller: My mother-in-law is staying with us, she's 81. We've got a space heater going in her room but that's it.`,
      `CSR (${c.csr}): Understood, I'm going to flag this as a no-heat priority. Do you hear the furnace trying to start at all?`,
      `Caller: It clicks a few times and then nothing. No blower, no flame, nothing.`,
      `CSR (${c.csr}): That's usually the ignitor or the pressure switch. I can get ${c.tech} out ${c.day} between ${c.window}. Our diagnostic is $129 and it goes toward the repair.`,
      `Caller: Anything sooner? I'll take whatever you have.`,
      `CSR (${c.csr}): Let me put you first on the no-heat list — if a call ahead of you clears I'll move you up and text you.`,
      `Caller: That's fine. Thank you.`,
      `CSR (${c.csr}): You're on the board. ${c.tech} will call about 30 minutes out. Stay warm.`,
    ],
    bullets: (c) => [
      `${c.first} ${c.last} at ${c.street} — no heat, house at 54 degrees`,
      `Elderly household member on site, flagged as priority`,
      `Furnace clicks, no ignition — likely ignitor or pressure switch`,
      `Booked ${c.day} ${c.window} with ${c.tech}; on no-heat bump list`,
    ],
    action: (c) => `Bump to first available — no-heat with elderly occupant at ${c.street}`,
  },
  {
    key: "no_cool_new_service",
    category: "new_service_request",
    sentiment: "neutral",
    isSpam: false,
    isJobRelated: true,
    confidence: [0.85, 0.94],
    markers: [/not cooling/i, /no cool/i, /blowing warm/i, /a\/?c (is )?(out|not)/i, /condenser/i],
    lines: (c) => [
      GREET(c),
      `Caller: Yeah, hi. My AC is blowing warm air. It runs, it just doesn't cool anything down.`,
      `CSR (${c.csr}): I can help with that. Can I get your name and the service address?`,
      `Caller: ${c.first} ${c.last}, ${c.street} in ${c.city}.`,
      `CSR (${c.csr}): Thanks. Is the outdoor unit running — the big fan on the outside?`,
      `Caller: The fan on top isn't spinning. There's a humming sound though.`,
      `CSR (${c.csr}): That's a classic capacitor symptom. Have you had us out before?`,
      `Caller: No, first time. My neighbor uses you guys.`,
      `CSR (${c.csr}): Appreciate that. I've got ${c.day} between ${c.window} with ${c.tech}. Diagnostic is $129, waived if you go ahead with the repair.`,
      `Caller: That works. Do I need to be home?`,
      `CSR (${c.csr}): Someone 18 or over, yes. You'll get a text with ${c.tech}'s photo when he's on the way.`,
      `Caller: Great, see you ${c.day}.`,
    ],
    bullets: (c) => [
      `New customer ${c.first} ${c.last}, ${c.street} in ${c.city}`,
      `AC running but blowing warm; outdoor fan humming, not spinning`,
      `Booked ${c.day} ${c.window} with ${c.tech} — $129 diagnostic`,
      `Neighbor referral, no prior job history`,
    ],
    action: (c) => `Confirm ${c.day} ${c.window} appointment and add capacitor to truck stock`,
  },
  {
    key: "status_check",
    category: "job_status_question",
    sentiment: "neutral",
    isSpam: false,
    isJobRelated: true,
    confidence: [0.8, 0.92],
    markers: [/still coming/i, /window/i, /eta/i, /running late/i, /supposed to be here/i, /on the way/i],
    lines: (c) => [
      GREET(c),
      `Caller: Hi, I have an appointment today between ${c.window} and it's almost the end of that window. Is your guy still coming?`,
      `CSR (${c.csr}): Let me pull that up. Name on the account?`,
      `Caller: ${c.last}, ${c.street}.`,
      `CSR (${c.csr}): I see it — ${c.tech} is on a call ahead of you that ran long. He's got about 40 minutes left there.`,
      `Caller: I've got to pick up my daughter at 4. Is that going to work?`,
      `CSR (${c.csr}): It'll be tight. I can either have him call you the second he clears, or we move you to first thing tomorrow.`,
      `Caller: Let's have him call. If it's after 3:30 I'll reschedule.`,
      `CSR (${c.csr}): Done, I'm putting that note on the job so he calls you directly.`,
      `Caller: Appreciate it.`,
    ],
    bullets: (c) => [
      `${c.last} at ${c.street} checking on ${c.window} arrival window`,
      `${c.tech} delayed on prior call, roughly 40 minutes out`,
      `Customer has a 4pm pickup — hard stop at 3:30`,
      `Tech to call customer directly before heading over`,
    ],
    action: (c) => `Have ${c.tech} call ${c.last} before 3:30 or reschedule to tomorrow morning`,
  },
  {
    key: "callback_repeat",
    category: "job_callback",
    sentiment: "negative",
    isSpam: false,
    isJobRelated: true,
    confidence: [0.86, 0.95],
    markers: [/was (just )?(out|here)/i, /doing it again/i, /same (thing|problem|issue)/i, /callback/i, /already paid/i],
    lines: (c) => [
      GREET(c),
      `Caller: You had somebody out here last Tuesday and it's doing the exact same thing again.`,
      `CSR (${c.csr}): I'm sorry to hear that. Can I get the address so I can pull the ticket?`,
      `Caller: ${c.street}. The name is ${c.last}. I paid $${c.amount} and it worked for four days.`,
      `CSR (${c.csr}): I've got the job here — ${c.techFull} replaced the capacitor. What's it doing now?`,
      `Caller: Same thing. Runs, doesn't cool, and now the breaker tripped once.`,
      `CSR (${c.csr}): A tripped breaker after a capacitor change usually points at the compressor or the contactor. That's a warranty callback on our side, so there's no charge for the visit.`,
      `Caller: I would hope not.`,
      `CSR (${c.csr}): Completely fair. I can get ${c.tech} back out ${c.day} between ${c.window}, and I'll note it as a return visit so he brings the meter and a contactor.`,
      `Caller: Fine. Just get it fixed this time.`,
      `CSR (${c.csr}): Understood. I'm also flagging it for our service manager to review.`,
    ],
    bullets: (c) => [
      `${c.last} at ${c.street} — repeat failure four days after capacitor repair`,
      `Original visit by ${c.techFull}, customer paid $${c.amount}`,
      `Now also tripping the breaker — possible contactor or compressor`,
      `No-charge return visit booked ${c.day} ${c.window}; flagged for service manager`,
    ],
    action: (c) => `Return visit ${c.day} — no charge, notify service manager on job ${c.jobNo}`,
  },
  {
    key: "estimate_followup",
    category: "estimate_followup",
    sentiment: "neutral",
    isSpam: false,
    isJobRelated: true,
    confidence: [0.78, 0.9],
    markers: [/estimate/i, /quote/i, /proposal/i, /financing/i, /thinking about it/i, /options/i],
    lines: (c) => [
      GREET(c),
      `Caller: Hi, ${c.first} ${c.last}. We had someone out a couple weeks ago who gave us a quote on a new furnace and I wanted to ask about it.`,
      `CSR (${c.csr}): Sure, let me find that. ${c.street}?`,
      `Caller: That's us. There were three options and I honestly don't remember the difference between the middle one and the top one.`,
      `CSR (${c.csr}): The middle option is a two-stage 80 percent, the top is a 96 percent variable speed — quieter, better on gas, and it comes with a longer parts warranty.`,
      `Caller: Is there financing on the top one?`,
      `CSR (${c.csr}): There is. We run zero percent for 18 months on anything over $5,000, or longer terms at a low rate.`,
      `Caller: Okay. My wife and I are going to talk about it this weekend.`,
      `CSR (${c.csr}): Take your time. Do you want me to have ${c.tech} call Monday to answer anything technical?`,
      `Caller: Yeah, Monday afternoon would be good.`,
      `CSR (${c.csr}): I'll set that up. The pricing holds for 30 days.`,
    ],
    bullets: (c) => [
      `${c.first} ${c.last}, ${c.street} — following up on furnace replacement estimate`,
      `Comparing mid-tier two-stage against 96% variable speed option`,
      `Asked about financing; quoted 0% for 18 months over $5,000`,
      `Wants ${c.tech} to call Monday afternoon; quote valid 30 days`,
    ],
    action: (c) => `Schedule ${c.tech} follow-up call Monday PM on the furnace proposal`,
  },
  {
    key: "billing_question",
    category: "billing_question",
    sentiment: "negative",
    isSpam: false,
    isJobRelated: true,
    confidence: [0.8, 0.92],
    markers: [/invoice/i, /charged/i, /bill/i, /card/i, /refund/i, /statement/i, /balance/i],
    lines: (c) => [
      GREET(c),
      `Caller: I'm looking at my card statement and I've got two charges from you for $${c.amount} on the same day.`,
      `CSR (${c.csr}): That shouldn't happen — let me look. Name and address?`,
      `Caller: ${c.first} ${c.last}, ${c.street}.`,
      `CSR (${c.csr}): I see one invoice on the job and one payment posted. The second one may be an authorization hold that hasn't dropped off yet.`,
      `Caller: It's been six days.`,
      `CSR (${c.csr}): That's longer than it should take. I'm going to send this to ${rndAP()} in accounts payable and have them pull the processor record today.`,
      `Caller: I'd like a call back either way.`,
      `CSR (${c.csr}): Absolutely. Best number is the one you're calling from?`,
      `Caller: Yes.`,
      `CSR (${c.csr}): You'll hear from us by end of day tomorrow at the latest.`,
    ],
    bullets: (c) => [
      `${c.first} ${c.last}, ${c.street} — duplicate $${c.amount} charge on card statement`,
      `One invoice and one payment on file; second charge may be a stale auth hold`,
      `Hold has not dropped in six days`,
      `Escalated to accounts payable, callback promised by end of day tomorrow`,
    ],
    action: (c) => `AP to pull processor record for ${c.last} and call back within 24 hours`,
  },
  {
    key: "warranty_looks_like_billing",
    category: "warranty_concern",
    sentiment: "negative",
    isSpam: false,
    isJobRelated: true,
    // Deliberately hard: the caller opens with a billing complaint and only
    // gets to the real issue (a part that should be under warranty) halfway
    // through. Keyword scoring lands on billing_question about as often as not,
    // which is the kind of miss the Call Reviews page is for.
    confidence: [0.52, 0.66],
    markers: [/warranty/i, /under warranty/i, /should be covered/i, /invoice/i, /charged/i, /bill/i],
    lines: (c) => [
      GREET(c),
      `Caller: I got an invoice for $${c.amount} and I don't think I should be paying it.`,
      `CSR (${c.csr}): Let me take a look. Address?`,
      `Caller: ${c.street}, ${c.last}.`,
      `CSR (${c.csr}): I see the invoice — that's for the inducer motor your tech replaced last week.`,
      `Caller: Right, and you installed that furnace two years ago. Isn't the motor under warranty?`,
      `CSR (${c.csr}): You're right that the part carries a ten year manufacturer warranty. What you're billed for is the labor — the labor warranty on that install was one year.`,
      `Caller: Nobody told me the labor was separate.`,
      `CSR (${c.csr}): That's a fair complaint and I want to get it in front of the right person. Do you happen to know if you're a Ground Club member? Members get labor covered at a discount.`,
      `Caller: I don't think we ever signed up.`,
      `CSR (${c.csr}): Then let me have our install coordinator review the file and call you. If the part was registered we may be able to submit the labor allowance to the manufacturer.`,
      `Caller: Please do, because $${c.amount} for a part that's supposedly under warranty doesn't sit right.`,
    ],
    bullets: (c) => [
      `${c.last} at ${c.street} disputing $${c.amount} invoice for inducer motor`,
      `Part is under 10-year manufacturer warranty; labor warranty expired at 1 year`,
      `Customer says labor exclusion was never explained at install`,
      `Install coordinator to review registration and check manufacturer labor allowance`,
    ],
    action: (c) => `Install coordinator to review warranty registration for ${c.last} and call back`,
  },
  {
    key: "reschedule",
    category: "reschedule_cancel",
    sentiment: "neutral",
    isSpam: false,
    isJobRelated: true,
    confidence: [0.86, 0.95],
    markers: [/reschedule/i, /move (my|the) appointment/i, /cancel/i, /can'?t be (home|there)/i, /different day/i],
    lines: (c) => [
      GREET(c),
      `Caller: I have a tune-up scheduled for ${c.day} and I need to move it. Something came up at work.`,
      `CSR (${c.csr}): Not a problem. Name on the account?`,
      `Caller: ${c.first} ${c.last}, ${c.street}.`,
      `CSR (${c.csr}): Got it. What day works better?`,
      `Caller: Any chance next week in the morning?`,
      `CSR (${c.csr}): I have Tuesday ${c.window} or Wednesday 8 to 12.`,
      `Caller: Wednesday.`,
      `CSR (${c.csr}): Done — Wednesday 8 to 12. You'll get a confirmation text tonight and a reminder the day before.`,
      `Caller: Thanks, sorry for the hassle.`,
      `CSR (${c.csr}): No hassle at all.`,
    ],
    bullets: (c) => [
      `${c.first} ${c.last}, ${c.street} — rescheduling maintenance tune-up`,
      `Work conflict on original ${c.day} appointment`,
      `Moved to Wednesday 8 to 12`,
      `Confirmation text and day-before reminder set`,
    ],
    action: () => `Release the original slot and confirm the Wednesday 8-12 tune-up`,
  },
  {
    key: "membership",
    category: "membership_question",
    sentiment: "positive",
    isSpam: false,
    isJobRelated: true,
    confidence: [0.82, 0.93],
    markers: [/membership/i, /ground club/i, /maintenance plan/i, /renew/i, /monthly plan/i, /dues/i],
    lines: (c) => [
      GREET(c),
      `Caller: Hi, we've got the Ground Club membership and I wanted to check on our visits for the year.`,
      `CSR (${c.csr}): Happy to. Address?`,
      `Caller: ${c.street}, under ${c.last}.`,
      `CSR (${c.csr}): You're active through next spring. You've used your cooling tune-up, and the heating one is still open.`,
      `Caller: Can I schedule that now, or is it too early?`,
      `CSR (${c.csr}): Now is a good time — the fall book fills up fast. I have ${c.day} ${c.window}.`,
      `Caller: Let's do it. And that's included, right, no charge?`,
      `CSR (${c.csr}): Included, plus you get 15 percent off any repair and no after-hours fee.`,
      `Caller: That's why we signed up. Thanks.`,
      `CSR (${c.csr}): Booked. You're all set.`,
    ],
    bullets: (c) => [
      `${c.last} at ${c.street} — active Ground Club member checking plan benefits`,
      `Cooling tune-up used; heating tune-up still available this term`,
      `Booked included heating tune-up ${c.day} ${c.window}`,
      `Confirmed 15% repair discount and waived after-hours fee`,
    ],
    action: () => `No follow-up needed — membership heating tune-up booked and confirmed`,
  },
  {
    key: "solicitation",
    category: "spam_robocall",
    sentiment: "neutral",
    isSpam: true,
    isJobRelated: false,
    confidence: [0.9, 0.97],
    markers: [/google (business )?listing/i, /seo/i, /first page/i, /marketing/i, /website traffic/i, /not interested/i],
    lines: (c) => [
      GREET(c),
      `Caller: Hi there, I'm calling about your Google business listing. Are you the owner or the person who handles marketing?`,
      `CSR (${c.csr}): I'm not, no.`,
      `Caller: No problem — we work with home service companies to get them on the first page of Google, and I'm seeing your listing isn't fully optimized. Do you have two minutes?`,
      `CSR (${c.csr}): We handle that in-house. We're not interested.`,
      `Caller: I understand, but if I could just show you the report I ran on your—`,
      `CSR (${c.csr}): We're not interested. Please take us off your list.`,
      `Caller: Sure, have a good day.`,
    ],
    bullets: () => [
      `Cold SEO / Google listing sales pitch, not a customer`,
      `Caller asked for the owner or marketing contact`,
      `CSR declined and requested removal from the call list`,
      `No service need, no follow-up required`,
    ],
    action: () => `Add number to the do-not-call list — no customer action needed`,
  },
  {
    key: "wrong_number",
    category: "wrong_number",
    sentiment: "neutral",
    isSpam: false,
    isJobRelated: false,
    confidence: [0.88, 0.96],
    markers: [/wrong number/i, /pharmacy/i, /sorry, I think I/i, /is this (the )?[a-z]+ (clinic|office|pharmacy)/i],
    lines: (c) => [
      GREET(c),
      `Caller: Oh — is this the pharmacy on ${rndStreet()}?`,
      `CSR (${c.csr}): No ma'am, this is Grounded Home Services, we do plumbing and HVAC.`,
      `Caller: I'm sorry, I must have hit the wrong contact.`,
      `CSR (${c.csr}): No problem at all. Have a good day.`,
      `Caller: You too.`,
    ],
    bullets: () => [
      `Wrong number — caller was trying to reach a pharmacy`,
      `Call lasted under 30 seconds`,
      `No service request, no customer record involved`,
    ],
    action: () => `No action — misdial`,
  },
  {
    key: "recruiting",
    category: "recruiting_call",
    sentiment: "neutral",
    isSpam: false,
    isJobRelated: false,
    confidence: [0.76, 0.9],
    markers: [/hiring/i, /apply/i, /position/i, /resume/i, /journeyman/i, /looking for work/i, /indeed/i],
    lines: (c) => [
      GREET(c),
      `Caller: Hey, I saw a posting for an HVAC install position. Are you still hiring?`,
      `CSR (${c.csr}): We are. Are you looking on the service side or install?`,
      `Caller: Install, mostly. I've got about six years, EPA universal, and I've done a lot of changeouts.`,
      `CSR (${c.csr}): That's a good fit. The best thing is to send a resume over and I'll get it to our install manager.`,
      `Caller: Can I email it?`,
      `CSR (${c.csr}): Yes — careers at our domain, and put "install" in the subject line.`,
      `Caller: Will do. How long before I hear back?`,
      `CSR (${c.csr}): Usually within a week. If it's a fit he'll set up a ride-along.`,
      `Caller: Sounds good, thanks.`,
    ],
    bullets: () => [
      `Job applicant calling about the HVAC install opening`,
      `Six years experience, EPA universal, changeout background`,
      `Directed to email resume with "install" in the subject`,
      `Install manager reviews within a week; ride-along if it fits`,
    ],
    action: () => `Watch for the resume and forward to the install manager`,
  },
  {
    key: "internal_tech",
    category: "internal_call",
    sentiment: "neutral",
    isSpam: false,
    isJobRelated: true,
    confidence: [0.72, 0.88],
    markers: [/purchase order/i, /po number/i, /supply house/i, /truck stock/i, /can you look up the job/i, /i'?m at the/i],
    lines: (c) => [
      GREET(c),
      `Caller: ${c.csr}, it's ${c.tech}. I'm at the supply house and I need a PO number for the job on ${c.street}.`,
      `CSR (${c.csr}): One second. That's job ${c.jobNo}?`,
      `Caller: That's the one. I need a condenser fan motor and a dual run cap.`,
      `CSR (${c.csr}): Okay, PO is going on ${c.jobNo}. Are they going to bill it or are you paying on the card?`,
      `Caller: Bill it. And tell the customer I'm about 45 minutes out.`,
      `CSR (${c.csr}): Will do. Anything else while I'm in here?`,
      `Caller: Nope, that's it. Thanks.`,
    ],
    bullets: (c) => [
      `Internal call — ${c.tech} at the supply house, not a customer`,
      `Requested PO for job ${c.jobNo} at ${c.street}`,
      `Parts: condenser fan motor and dual run capacitor, billed to account`,
      `Customer to be told tech is 45 minutes out`,
    ],
    action: (c) => `Issue PO on job ${c.jobNo} and text the customer the 45-minute ETA`,
  },
  {
    key: "price_objection",
    category: "new_service_request",
    sentiment: "negative",
    isSpam: false,
    isJobRelated: true,
    // Also intentionally muddy: this is a live lead that didn't book. A
    // classifier reading only the tail ("call around", "too much") will often
    // tag it as not-a-lead, which understates the unbooked-call count.
    confidence: [0.55, 0.7],
    markers: [/how much/i, /too much/i, /call around/i, /diagnostic fee/i, /just want a price/i, /over the phone/i],
    lines: (c) => [
      GREET(c),
      `Caller: How much do you charge to replace a water heater? Just ballpark.`,
      `CSR (${c.csr}): It depends on the unit and the venting, but a standard 50 gallon gas swap usually runs between $2,100 and $2,900 installed.`,
      `Caller: That seems like a lot. The heater itself is like eight hundred bucks.`,
      `CSR (${c.csr}): The equipment is part of it. The rest is the permit, the expansion tank, code updates on the venting, haul-away, and the labor warranty.`,
      `Caller: What do you charge just to come look at it?`,
      `CSR (${c.csr}): Our plumbing diagnostic is $119, and it applies to the work if you move forward.`,
      `Caller: I'm going to call around a little bit first.`,
      `CSR (${c.csr}): That's fair. Can I at least get your name and address so I can text you the quote breakdown?`,
      `Caller: ${c.first} at ${c.street}. Sure.`,
      `CSR (${c.csr}): I'll send that over in a few minutes. If the price is the issue, we also do financing.`,
      `Caller: Alright, thanks.`,
    ],
    bullets: (c) => [
      `${c.first} at ${c.street} pricing a 50 gallon gas water heater replacement`,
      `Quoted $2,100–$2,900 installed; caller pushed back on price`,
      `Did not book — shopping other contractors`,
      `CSR to text quote breakdown and mention financing`,
    ],
    action: (c) => `Text the quote breakdown to ${c.first} today and follow up in 48 hours`,
  },
];

// Small helpers used inside a couple of scenario scripts.
function rndAP() {
  const ap = C.OFFICE_TEAM.find((o) => /Accounts Payable/i.test(o.role));
  return ap ? ap.name.split(" ")[0] : "our billing team";
}
function rndStreet() {
  return `${C.STREET_NAMES[3]} ${C.STREET_SUFFIXES[0]}`;
}

/** Render a scenario into a transcript string. */
function renderTranscript(scenario, ctx) {
  return scenario.lines(ctx).join("\n");
}

// ---------------------------------------------------------------------------
// Generator: audio transcription
// ---------------------------------------------------------------------------
// Caller: transcriptionService.transcribeOneFile -> reads r.text; for
// verbose_json (whisper-1 only) it also reads .language, .duration, .segments.
function cannedTranscription(params) {
  const file = params && params.file;
  // Seed off whatever identifies the recording — the stream's path in the
  // normal case, so re-transcribing the same file gives the same words.
  const ident =
    (file && (file.path || file.name)) ||
    (params && params.prompt) ||
    "demo-recording";
  const seed = hashString(String(ident));
  const rng = new Rng(seed);

  const scenario = rng.pick(SCENARIOS);
  const ctx = callContext(rng);
  const text = renderTranscript(scenario, ctx);

  const out = { text };
  if (params && params.response_format === "verbose_json") {
    const lines = text.split("\n");
    out.task = "transcribe";
    out.language = "english";
    // Rough speech pace: ~2.6 words/second including pauses.
    out.duration = Math.round((text.split(/\s+/).length / 2.6) * 10) / 10;
    out.segments = lines.map((line, i) => ({
      id: i,
      seek: 0,
      start: i * 6,
      end: (i + 1) * 6,
      text: ` ${line}`,
      tokens: [],
      temperature: 0,
      avg_logprob: -0.21,
      compression_ratio: 1.5,
      no_speech_prob: 0.01,
    }));
  }
  return { out, rng };
}

// ---------------------------------------------------------------------------
// Generator: call classification
// ---------------------------------------------------------------------------
// Caller: classificationService.classifyCall
//   JSON.parse(content) -> { category, summaryBullets[], sentiment, isSpam,
//   isJobRelated, confidence, recommendedAction }. category must be one of
//   CATEGORIES or it is coerced to unknown_review_needed.
function cannedClassification(req, rng) {
  const transcript = req.user || "";

  // Score the transcript against every scenario's markers. This is the same
  // sort of shallow signal a small model leans on, which is why it produces
  // believable near-misses on the two ambiguous scripts above.
  let best = null;
  let bestScore = 0;
  for (const s of SCENARIOS) {
    let score = 0;
    for (const re of s.markers) if (re.test(transcript)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }

  // Nothing recognizable: short, garbled, or a transcript we didn't generate.
  if (!best || bestScore === 0) {
    const words = transcript.split(/\s+/).filter(Boolean).length;
    if (words < 40) {
      return {
        category: "unknown_review_needed",
        summaryBullets: [
          "Transcript too short to classify confidently",
          `Roughly ${words} words captured`,
          "No clear service request identified",
        ],
        sentiment: "neutral",
        isSpam: false,
        isJobRelated: false,
        confidence: 0.32,
        recommendedAction: "Listen to the recording and label manually",
      };
    }
    best = rng.pick(SCENARIOS);
  }

  // Rebuild the context from the transcript where we can, so the bullets name
  // the actual people and address in the call rather than a fresh random set.
  const ctx = callContext(new Rng(hashString(transcript)));
  // Pull the customer's name from the CALLER's lines only. The CSR introduces
  // herself in the greeting, and tagging the CSR as the customer is the exact
  // mistake the real prompt spends a paragraph warning against.
  const callerText = transcript
    .split("\n")
    .filter((l) => /^\s*caller\s*[:(]/i.test(l))
    .join("\n");
  const nameMatch = /(?:this is|it's|name is)\s+([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))?/.exec(callerText) ||
    /\b([A-Z][a-z]+)\s+(?:at|over on)\s+\d/.exec(callerText) ||
    /^\s*Caller:\s*([A-Z][a-z]+)\s+([A-Z][a-z]+),/m.exec(callerText);
  if (nameMatch) {
    ctx.first = nameMatch[1];
    if (nameMatch[2]) ctx.last = nameMatch[2];
  }
  const addrMatch = /\b(\d{2,5}\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?\s+(?:St|Ave|Rd|Dr|Ln|Ct|Way|Blvd|Pl|Ter|Trl))\b/.exec(transcript);
  if (addrMatch) ctx.street = addrMatch[1];
  const greetMatch = /CSR \(([^)]+)\)/.exec(transcript);
  if (greetMatch) ctx.csr = greetMatch[1];
  const techMatch = /(?:get|have|send)\s+([A-Z][a-z]+)\s+(?:back\s+)?out/.exec(transcript);
  if (techMatch) ctx.tech = techMatch[1];
  const amtMatch = /\$(\d{2,4})\b/.exec(transcript);
  if (amtMatch) ctx.amount = Number(amtMatch[1]);
  const jobMatch = /job\s+(\d{5,7})/i.exec(transcript);
  if (jobMatch) ctx.jobNo = jobMatch[1];

  const [lo, hi] = best.confidence;
  return {
    category: best.category,
    summaryBullets: best.bullets(ctx),
    sentiment: best.sentiment,
    isSpam: best.isSpam,
    isJobRelated: best.isJobRelated,
    confidence: money(lo + rng.float() * (hi - lo)),
    recommendedAction: best.action(ctx),
  };
}

// ---------------------------------------------------------------------------
// Generator: unrecognized prompt
// ---------------------------------------------------------------------------
// Better to fail loudly-ish than to hand a caller a shape it can't parse.
// Anything that lands here is a prompt added after this file was written.
function cannedUnknown(req) {
  console.warn(
    `[demo] OpenAI: no canned generator matched this prompt — returning a stub. ` +
      `System prompt starts: ${String(req.system).slice(0, 120).replace(/\s+/g, " ")}`
  );
  return {
    note: "demo mode: no canned generator is registered for this prompt",
    model: req.model,
  };
}

// ---------------------------------------------------------------------------
// Tiny PNG encoder (for images.generate)
// ---------------------------------------------------------------------------
// A real, valid 64x64 PNG rather than a fixed placeholder blob: the bytes get
// uploaded to the ST mock and rendered in the pricebook UI, so they have to
// decode. Colour is derived from the prompt so two SKUs don't look identical.

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function tinyPng(rng, size = 64) {
  const base = [rng.int(40, 215), rng.int(40, 215), rng.int(40, 215)];
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      // Soft vertical gradient so it reads as a rendered image, not a flat swatch.
      const shade = 1 - (y / size) * 0.45;
      raw[o++] = Math.min(255, Math.round(base[0] * shade));
      raw[o++] = Math.min(255, Math.round(base[1] * shade));
      raw[o++] = Math.min(255, Math.round(base[2] * shade));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

async function chatCompletionsCreate(params = {}) {
  announceOnce();
  const req = flattenRequest(params);
  const seed = hashString(`${req.system} ${req.user} ${req.schemaName}`);
  const rng = new Rng(seed);
  await fakeLatency(rng);

  const generator = routeChat(req);
  const payload = generator(req, rng);
  // Every caller in this app asks for JSON, whether or not it sets
  // response_format, and parses the message content directly.
  return chatEnvelope(req.model, JSON.stringify(payload, null, 2), seed);
}

async function audioTranscriptionsCreate(params = {}) {
  announceOnce();
  const { out, rng } = cannedTranscription(params);
  await fakeLatency(rng);
  // Drain the read stream if one was handed to us — leaving an open fd around
  // would keep the temp file locked on some platforms.
  try {
    const f = params.file;
    if (f && typeof f.destroy === "function") f.destroy();
  } catch (_) {}
  return out;
}

async function imagesGenerate(params = {}) {
  announceOnce();
  const seed = hashString(String(params.prompt || "pricebook image"));
  const rng = new Rng(seed);
  await fakeLatency(rng);
  const png = tinyPng(rng);
  return {
    created: Math.floor(Date.now() / 1000),
    data: [
      {
        b64_json: png.toString("base64"),
        revised_prompt: String(params.prompt || "").slice(0, 400),
      },
    ],
    usage: { input_tokens: 32, output_tokens: 0, total_tokens: 32 },
  };
}

/** Build a shim shaped like the pieces of the OpenAI SDK this app touches. */
function createClient() {
  return {
    __demo: true,
    chat: { completions: { create: chatCompletionsCreate } },
    audio: { transcriptions: { create: audioTranscriptionsCreate } },
    images: { generate: imagesGenerate },
  };
}

module.exports = {
  createClient,
  // exported for the demo seeder and for tests
  SCENARIOS,
  renderTranscript,
  callContext,
  _routeChat: routeChat,
  _tinyPng: tinyPng,
};
