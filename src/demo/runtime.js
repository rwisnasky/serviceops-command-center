/**
 * src/demo/runtime.js
 *
 * Everything demo mode changes about how the app *runs*, as opposed to what
 * data it serves.
 *
 * Five jobs:
 *   1. Answer "are we in demo mode?" in one place.
 *   2. Suppress background work — pollers and crons have nothing to poll, and a
 *      poller that quietly fails every 5 minutes fills the logs with noise that
 *      looks like a broken app.
 *   3. Serve the vendor HTTP calls that bypass src/api/servicetitan.js, by
 *      swapping axios' adapter (see ./axiosAdapter.js).
 *   4. Be the last line of defence against outbound network calls. The mocks
 *      should already prevent them; this catches anything that slips through a
 *      path nobody remembered to mock.
 *   5. Seed and expose the demo account, and mount the demo control endpoints.
 */

const { IS_DEMO } = require("./mode");

const DEMO_USER = {
  email: process.env.DEMO_USER_EMAIL || "demo@groundedhs.example",
  password: process.env.DEMO_USER_PASSWORD || "demo1234",
  displayName: "Demo User",
};

// ---------------------------------------------------------------------------
// 1. Mode
// ---------------------------------------------------------------------------

function isDemo() {
  return IS_DEMO;
}

function banner() {
  if (!IS_DEMO) return;
  const { getWorld } = require("./world");
  const s = getWorld().stats;
  console.log(
    [
      "",
      "  ┌─────────────────────────────────────────────────────────────┐",
      "  │  DEMO MODE                                                  │",
      "  │  All external systems are mocked. No data leaves this        │",
      "  │  process. Every customer, job, invoice and call below is     │",
      "  │  generated.                                                  │",
      "  ├─────────────────────────────────────────────────────────────┤",
      `  │  ${String(s.customers).padStart(5)} customers   ${String(s.jobs).padStart(5)} jobs        ${String(s.invoices).padStart(5)} invoices  │`,
      `  │  ${String(s.calls).padStart(5)} calls       ${String(s.appointments).padStart(5)} appts       ${String(s.pricebookItems).padStart(5)} SKUs      │`,
      "  ├─────────────────────────────────────────────────────────────┤",
      `  │  Sign in:  ${DEMO_USER.email.padEnd(37)}   │`,
      `  │  Password: ${DEMO_USER.password.padEnd(37)}   │`,
      "  └─────────────────────────────────────────────────────────────┘",
      "",
    ].join("\n")
  );
}

// ---------------------------------------------------------------------------
// 2. Background work
// ---------------------------------------------------------------------------

/**
 * Wrap a background starter so it becomes a no-op in demo mode.
 *
 * The pollers themselves are worth keeping in the repo — the cursor handling in
 * formsPollService is some of the more careful code here — they just have
 * nothing to do when ServiceTitan is a local object.
 */
function skipInDemo(label, fn) {
  return function guarded(...args) {
    if (IS_DEMO) {
      console.log(`[demo] ${label} not started (nothing to poll in demo mode)`);
      return null;
    }
    return fn(...args);
  };
}

/**
 * Same idea for node-cron. Returns a shim with cron's `.schedule()` signature
 * that logs and does nothing when demo mode is on.
 */
function cronOrNoop(cron) {
  if (!IS_DEMO) return cron;
  return {
    schedule(expr, _fn, opts) {
      console.log(`[demo] cron "${expr}" not scheduled`);
      return { start() {}, stop() {}, destroy() {} };
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Vendor HTTP interception
// ---------------------------------------------------------------------------

/**
 * Swap axios' adapter so the handful of services that call ServiceTitan,
 * Google and GoHighLevel with raw `axios` — instead of going through
 * src/api/servicetitan.js — are served from the generated world.
 *
 * Must run before any of those services issues its first request, i.e. at the
 * top of src/index.js, next to installOutboundGuard(). It is a no-op outside
 * demo mode and idempotent inside it. See ./axiosAdapter.js for the route list
 * and for why interception beat editing nine services.
 */
function installAxiosAdapter() {
  if (!IS_DEMO) return;
  require("./axiosAdapter").installAxiosAdapter();
}

// ---------------------------------------------------------------------------
// 4. Outbound network guard
// ---------------------------------------------------------------------------

/**
 * Belt and braces. Every external client is mocked and the axios adapter above
 * catches the raw-axios call sites, so nothing *should* try to open a socket.
 * This asserts it — and it still covers anything that isn't axios at all (a
 * stray `https.get`, a vendor SDK with its own transport).
 *
 * Rather than trusting that, patch the HTTP agents and refuse any request to a
 * host that isn't explicitly allowed. Localhost stays open (the app talks to
 * itself in a couple of places) and api.openai.com is allowed only when the
 * owner has deliberately turned live AI on with DEMO_AI=live.
 *
 * A blocked call throws with a message naming the host, so if some path was
 * missed it shows up as a loud, specific error instead of a mysterious timeout
 * against a real vendor API.
 */
function installOutboundGuard() {
  if (!IS_DEMO) return;
  if (String(process.env.DEMO_ALLOW_NETWORK).toLowerCase() === "true") {
    console.warn("[demo] outbound network guard DISABLED via DEMO_ALLOW_NETWORK");
    return;
  }

  const http = require("http");
  const https = require("https");

  const allowHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  if (String(process.env.DEMO_AI).toLowerCase() === "live") {
    allowHosts.add("api.openai.com");
  }

  const isAllowed = (host) => {
    if (!host) return true; // unix sockets / malformed — let node deal with it
    const h = String(host).toLowerCase().split(":")[0];
    return allowHosts.has(h) || h.endsWith(".localhost");
  };

  const wrap = (mod, name) => {
    const originalRequest = mod.request;
    mod.request = function guardedRequest(...args) {
      const opts = typeof args[0] === "string" || args[0] instanceof URL ? { href: args[0] } : args[0] || {};
      let host = opts.hostname || opts.host;
      if (!host && opts.href) {
        try {
          host = new URL(String(opts.href)).hostname;
        } catch {
          host = null;
        }
      }
      if (!isAllowed(host)) {
        throw new Error(
          `[demo] blocked outbound ${name} request to "${host}". ` +
            `Demo mode must not reach external services — this call path is missing a mock. ` +
            `(Override with DEMO_ALLOW_NETWORK=true if you know what you're doing.)`
        );
      }
      return originalRequest.apply(this, args);
    };
    // `get` is a thin wrapper over `request` in Node, but it captures its own
    // reference, so it has to be re-pointed too.
    const originalGet = mod.get;
    mod.get = function guardedGet(...args) {
      const req = mod.request(...args);
      req.end();
      return req;
    };
    return () => {
      mod.request = originalRequest;
      mod.get = originalGet;
    };
  };

  wrap(http, "http");
  wrap(https, "https");
  console.log("[demo] outbound network guard active (only localhost is reachable)");
}

// ---------------------------------------------------------------------------
// 5. Demo account + control endpoints
// ---------------------------------------------------------------------------

/**
 * Ensure the shared demo login exists. Unlike the normal first-user seed this
 * does NOT set must_change_pw — a public demo where the first visitor is forced
 * to change the shared password, locking everyone else out, would be a bad
 * afternoon.
 */
async function seedDemoUser() {
  if (!IS_DEMO) return { seeded: false, reason: "not demo mode" };

  const userRepo = require("../db/userRepository");

  try {
    const existing = userRepo.findByEmail(DEMO_USER.email);
    if (existing) {
      // Reset the password back to the documented one on every boot, so a
      // visitor who changes it can't lock out the next visitor.
      await userRepo.updatePassword(existing.id, DEMO_USER.password);
      return { seeded: false, reason: "demo user already existed — password reset" };
    }

    await userRepo.createUser({
      email: DEMO_USER.email,
      password: DEMO_USER.password,
      firstName: "Demo",
      lastName: "User",
      displayName: DEMO_USER.displayName,
      isAdmin: true,
      mustChangePw: false,
    });
    return { seeded: true };
  } catch (err) {
    console.error(`[demo] demo user seed failed: ${err.message}`);
    return { seeded: false, reason: err.message };
  }
}

/**
 * Run the database seeder on boot. Idempotent — it checks its own marker row
 * and no-ops if the database already has demo data.
 */
function seedDemoDatabaseOnBoot() {
  if (!IS_DEMO) return { seeded: false, reason: "not demo mode" };
  try {
    const { getDb } = require("../db/index");
    const { seedDemoDatabase } = require("./seed");
    const result = seedDemoDatabase(getDb());

    // The profitability pages don't read SQLite or the API — they read the
    // month-end job-costing files under data/monthly-cache/. Without these,
    // fiscal-year review and Customer Review margins both render
    // "no data yet". See ./monthlyCache.js.
    try {
      require("./monthlyCache").writeMonthlyCache({});
    } catch (err) {
      console.error(`[demo] monthly cache generation failed: ${err.message}`);
    }

    return result;
  } catch (err) {
    console.error(`[demo] database seed failed: ${err.message}`);
    return { seeded: false, error: err.message };
  }
}

/**
 * Mount /api/demo/*. Deliberately small:
 *   GET  /api/demo/status  — what mode we're in, world stats, mutation count
 *   POST /api/demo/reset   — rebuild the world and re-seed the database
 */
function mountDemoRoutes(app) {
  if (!IS_DEMO) return;

  const express = require("express");
  const router = express.Router();

  router.get("/status", (req, res) => {
    const { getWorld } = require("./world");
    const st = require("../api/servicetitan");
    const ghl = require("../api/gohighlevel");
    const world = getWorld();
    res.json({
      demoMode: true,
      seed: world.seed,
      builtAt: world.builtAt,
      world: world.stats,
      mutations: st.__demo ? st.__demo.mutations.count : 0,
      crm: ghl.__demo ? ghl.__demo.stats() : null,
      ai: String(process.env.DEMO_AI).toLowerCase() === "live" ? "live" : "canned",
      account: { email: DEMO_USER.email, password: DEMO_USER.password },
    });
  });

  router.post("/reset", async (req, res) => {
    try {
      const { resetWorld } = require("./world");
      const { getDb } = require("../db/index");
      const { seedDemoDatabase } = require("./seed");
      const world = resetWorld();
      const result = seedDemoDatabase(getDb(), { force: true, world });
      res.json({ ok: true, reseeded: true, seed: world.seed, result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.use("/api/demo", router);
  console.log("[demo] control endpoints mounted at /api/demo");
}

module.exports = {
  isDemo,
  IS_DEMO,
  DEMO_USER,
  banner,
  skipInDemo,
  cronOrNoop,
  installAxiosAdapter,
  installOutboundGuard,
  seedDemoUser,
  seedDemoDatabaseOnBoot,
  mountDemoRoutes,
};
