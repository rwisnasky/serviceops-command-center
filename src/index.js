require("dotenv").config();
const express = require("express");
const path = require("path");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);

// ── Demo mode ─────────────────────────────────────────────────────────────────
// DEMO_MODE=true runs the whole app against generated data with every external
// system mocked. See src/demo/README.md. In normal operation this is a no-op:
// `isDemo()` is false, `cronOrNoop` returns node-cron untouched, and
// `skipInDemo` passes calls straight through.
const demo = require("./demo/runtime");
// Order matters only in that both must run before any service issues a request.
// The adapter serves the raw-axios vendor call sites that bypass
// src/api/servicetitan.js; the guard is the backstop for everything else.
demo.installAxiosAdapter();
demo.installOutboundGuard();

const cron = demo.cronOrNoop(require("node-cron"));

// ── Global safety net ─────────────────────────────────────────────────────────
// A stray unhandled rejection or exception in a background poller must NOT be
// allowed to silently take down the whole process — that would stop every
// poller and cron at once. Log loudly and keep the server alive.
process.on("unhandledRejection", (reason) => {
  console.error("[Process] Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[Process] Uncaught exception:", err);
});

// ── DB init (must happen before routes that use the DB) ───────────────────────
const { initSchema } = require("./db/index");
initSchema();

// Seed the employee phone roster on first boot (idempotent — no-ops if rows
// already exist). Sourced from data/employee-roster.json which is parsed from
// EmployeePhoneRoster.xls. Enables caller-is-an-employee detection in matching.
const { seedEmployeePhonesIfEmpty } = require("./db/employeeRepository");
try {
  seedEmployeePhonesIfEmpty();
} catch (err) {
  console.error(`[EmployeePhones] Seed failed (non-fatal): ${err.message}`);
}

// Seed the first dashboard user from FIRST_USER_EMAIL/FIRST_USER_PASSWORD if
// the users table is empty. Idempotent — no-op once a user exists. The seeded
// user is flagged must_change_pw=1 so they're forced to rotate on first login.
const { seedFirstUserIfEmpty } = require("./db/userRepository");
seedFirstUserIfEmpty()
  .then((r) => {
    if (!r.seeded && r.reason && r.reason !== "users already exist") {
      console.warn(`[Auth] First-user seed skipped: ${r.reason}`);
    }
  })
  .catch((err) => console.error(`[Auth] First-user seed failed: ${err.message}`));

// ── Demo seeding ──────────────────────────────────────────────────────────────
// Populates the database with generated calls, timesheets, install-tracker rows
// and the rest, then creates the shared demo login. Both are idempotent and
// both no-op entirely when DEMO_MODE is off.
if (demo.isDemo()) {
  demo.seedDemoDatabaseOnBoot();
  demo.seedDemoUser().catch((err) => console.error(`[demo] user seed failed: ${err.message}`));
}

// ── Queue worker (starts background processing loop) ─────────────────────────
const { startWorker } = require("./services/callQueueService");
demo.skipInDemo("call queue worker", startWorker)();

// ── Call poller (checks ST every N minutes for new completed calls) ───────────
const { startPoller } = require("./services/callPollService");
demo.skipInDemo("call poller", startPoller)();

// ── Forms poller (checks ST every N minutes for new Happy Review submissions) ─
const { startFormsPoller } = require("./services/formsPollService");
demo.skipInDemo("forms poller", startFormsPoller)();

// ── Route imports ─────────────────────────────────────────────────────────────
const authRoutes     = require("./routes/auth");
const webhookRoutes  = require("./routes/webhook");
const analyticsRoutes = require("./routes/analytics");
const formsRoutes    = require("./routes/forms");
const fanclubsRoutes = require("./routes/fanclubs");
const callsRoutes    = require("./routes/calls");
const videosRoutes   = require("./routes/videos");
const fleetRoutes    = require("./routes/fleet");
const invoicesRoutes = require("./routes/invoices");
const pricebookRoutes = require("./routes/pricebook");
const monthlyReviewRoutes = require("./routes/monthlyReview");
const customerReviewRoutes = require("./routes/customerReview");
const scoreboardRoutes = require("./routes/scoreboard");
const usersRoutes = require("./routes/users");
const backflowRoutes = require("./routes/backflow");
const addressRoutes  = require("./routes/address");
const contractsRoutes = require("./routes/contracts");
const pdfParserRoutes = require("./routes/pdfParser");
const timesheetRoutes = require("./routes/timesheet");
const equipmentRoutes = require("./routes/equipment");
const paymentInvoicesRoutes = require("./routes/paymentInvoices");
const installTrackerRoutes = require("./routes/installTracker");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Session middleware (must come BEFORE routes & static auth wall) ──────────
// Sessions are persisted in their own SQLite file on the same /data volume as
// calls.db, so logins survive Railway redeploys. The cookie is httpOnly + signed,
// secure-only when running on HTTPS (Railway), and rolls 30 days.
const SESSION_DIR = path.dirname(process.env.DB_PATH || "/tmp/calls.db");
const IS_PROD = process.env.NODE_ENV === "production";
if (IS_PROD) {
  // Trust Railway's proxy so req.secure is correct and secure cookies actually get sent.
  app.set("trust proxy", 1);
}
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.warn(
    "[Auth] WARNING: SESSION_SECRET is not set. Using a dev fallback — " +
    "sessions will not survive a restart and are NOT safe for production. " +
    "Generate one with: openssl rand -hex 32"
  );
}
app.use(
  session({
    store: new SQLiteStore({
      db: "sessions.sqlite",
      dir: SESSION_DIR,
      table: "sessions",
    }),
    name: "st_hl_sid",
    secret: SESSION_SECRET || "dev-only-not-secure-please-set-SESSION_SECRET",
    resave: false,
    saveUninitialized: false,
    rolling: true, // refresh expiry on every request
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: IS_PROD,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  })
);

// ── requireAuth — gate everything except the whitelist below ─────────────────
// Public paths (no login needed):
//   /webhook/*  — ServiceTitan + GoHighLevel call us here
//   /health     — Railway health check
//   /login (GET+POST), /logout — auth flow itself
//   /css/*, /js/*, /favicon.ico, fonts — static assets needed to render /login
const PUBLIC_HTML_PATHS = new Set(["/login", "/logout", "/favicon.ico"]);
const PUBLIC_PREFIXES = ["/webhook", "/css/", "/js/", "/fonts/"];
function isPublic(req) {
  // Reject path-traversal before the prefix whitelist below. Without this, a
  // crafted "/css/../index.html" matches the "/css/" prefix and serve-static
  // then resolves it to a gated page, slipping past the login wall.
  if (req.path.includes("..")) return false;
  if (req.path === "/health") return true;
  if (PUBLIC_HTML_PATHS.has(req.path)) return true;
  for (const p of PUBLIC_PREFIXES) {
    if (req.path.startsWith(p)) return true;
  }
  return false;
}
function requireAuth(req, res, next) {
  if (isPublic(req)) return next();
  if (req.session?.userId) {
    // Enforce forced password rotation server-side. A user flagged
    // must_change_pw may reach ONLY the change-password page and the auth API
    // until they rotate — otherwise a temporary password keeps full access
    // indefinitely (the browser-side redirect alone was not enforcement).
    const { findById } = require("./db/userRepository");
    const me = findById(req.session.userId);
    if (me && me.must_change_pw) {
      const allowed =
        req.path === "/change-password" || req.path.startsWith("/api/auth/");
      if (!allowed) {
        if (
          req.path.startsWith("/api/") ||
          req.xhr ||
          req.get("accept")?.includes("application/json")
        ) {
          return res.status(403).json({ ok: false, error: "password change required" });
        }
        return res.redirect("/change-password");
      }
    }
    return next();
  }
  // API requests get a 401; HTML page requests get bounced to /login with a
  // ?next= so we can return them to the page they wanted after sign-in.
  if (req.path.startsWith("/api/") || req.xhr || req.get("accept")?.includes("application/json")) {
    return res.status(401).json({ ok: false, error: "not logged in" });
  }
  const next_ = encodeURIComponent(req.originalUrl || "/");
  return res.redirect(`/login?next=${next_}`);
}
app.use(requireAuth);

// Static files — served AFTER requireAuth so HTML pages in /public are gated.
// (CSS/JS subpaths are whitelisted above so the login page can still style.)
app.use(express.static(path.join(__dirname, "../public")));

// ── Routes ────────────────────────────────────────────────────────────────────
// Auth routes are mounted at root because /login, /logout, and /api/auth/*
// all live in the same module. requireAuth lets the public ones through; the
// /api/auth/me + /api/auth/change-password handlers do their own session check.
app.use(authRoutes);

app.use("/webhook",        webhookRoutes);
app.use("/api/analytics",  analyticsRoutes);
app.use("/api/forms",      formsRoutes);
app.use("/api/fanclubs",   fanclubsRoutes);
app.use("/api/calls",      callsRoutes);     // ← call intelligence admin routes
app.use("/api/videos",     videosRoutes);    // ← YouTube upload from ST job attachments
app.use("/api/fleet",      fleetRoutes);     // ← Fleet tracking (off-hours trip analysis)
app.use("/api/invoices",   invoicesRoutes);  // ← Supplier invoice → PO import
app.use("/api/pricebook",  pricebookRoutes); // ← Pricebook lookup + quote-to-estimate
app.use("/api/monthly-review", monthlyReviewRoutes); // ← Monthly operational review (profitability + utilization)
app.use("/api/customer-review", customerReviewRoutes); // ← Per-customer cost/benefit across all locations
app.use("/api/scoreboard", scoreboardRoutes);        // ← Per-job scoreboard (hours + invoice + appts)
app.use("/api/users",      usersRoutes);             // ← Dashboard user administration (add/reset/deactivate)
app.use("/api/backflow",   backflowRoutes);          // ← Backflow Details report (date-range filtered)
app.use("/api/address",    addressRoutes);           // ← Address verification + ST location audit
app.use("/api/contracts",  contractsRoutes);         // ← Contract Compare (PDF/DOCX/text diff)
app.use("/api/pdf-parser", pdfParserRoutes);       // ← PDF Parser: scanned PDF → OCR text + per-page JPGs
app.use("/api/timesheet",  timesheetRoutes);       // ← Employee timesheet (weekly grid + comp/P-Law balances)
app.use("/api/equipment",  equipmentRoutes);       // ← Installed Equipment → ServiceTitan + Rinnai ProPortal CSV
app.use("/api/payment-invoices", paymentInvoicesRoutes); // ← Payment ID → combined invoice PDF
app.use("/api/install-tracker", installTrackerRoutes);   // ← Completed installs: equipment-in-ST + warranty-registered tracking

// Demo-only: /api/demo/status and /api/demo/reset. No-op unless DEMO_MODE=true.
demo.mountDemoRoutes(app);

// Health check for Railway. Always returns 200 (so the platform probe doesn't
// restart-loop), but includes a poller watchdog: if a poller hasn't advanced
// its cursor in several intervals it's flagged `stale` and `degraded` goes true.
// Hit /health to see at a glance whether the background jobs are still alive.
app.get("/health", (req, res) => {
  let pollers = {};
  try {
    const { getDb } = require("./db/index");
    const db = getDb();
    const readKv = (k) =>
      db.prepare("SELECT value FROM kv_store WHERE key = ?").get(k)?.value || null;
    const STALE_FACTOR = 4; // stale if no run in 4x its interval
    const now = Date.now();
    const summarize = (key, intervalMin) => {
      const iso = readKv(key);
      if (!iso) return { lastRun: null, stale: null };
      const minutesAgo = Math.round((now - new Date(iso).getTime()) / 60000);
      return { lastRun: iso, minutesAgo, stale: minutesAgo > intervalMin * STALE_FACTOR };
    };
    pollers = {
      call: summarize("call_poll_last_run", parseInt(process.env.CALL_POLL_INTERVAL_MINUTES) || 5),
      forms: summarize("forms_poll_last_run", parseInt(process.env.FORMS_POLL_INTERVAL_MINUTES) || 5),
    };
  } catch (e) {
    pollers = { error: e.message };
  }
  const degraded = !!(pollers?.call?.stale || pollers?.forms?.stale);
  res.json({ status: "ok", degraded, pollers, timestamp: new Date().toISOString() });
});

// Change-password page (auth-gated by requireAuth above)
app.get("/change-password", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/change-password.html"))
);

// Serve pages
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/index.html"))
);
app.get("/memberships", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/memberships.html"))
);
app.get("/calls", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/calls.html"))
);
app.get("/videos", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/videos.html"))
);
app.get("/reviews", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/reviews.html"))
);
app.get("/fleet", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/fleet.html"))
);
app.get("/invoices", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/invoices.html"))
);
app.get("/pricebook", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/pricebook.html"))
);
app.get("/monthly-review", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/monthly-review.html"))
);
app.get("/fy-review", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/fy-review.html"))
);
app.get("/open-jobs", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/open-jobs.html"))
);
app.get("/customer-review", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/customer-review.html"))
);
app.get("/resolved-jobs", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/resolved-jobs.html"))
);
app.get("/backflow", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/backflow.html"))
);
app.get("/address", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/address.html"))
);
app.get("/scoreboard", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/scoreboard.html"))
);
app.get("/contract-compare", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/contract-compare.html"))
);
app.get("/pdf-parser", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/pdf-parser.html"))
);
app.get("/timesheet", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/timesheet.html"))
);
app.get("/equipment", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/equipment.html"))
);
app.get("/install-tracker", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/install-tracker.html"))
);
app.get("/payment-invoices", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/paymentInvoices.html"))
);
// NFC-friendly quick clock. Write this URL to a tag, e.g. /timesheet/tap?a=in
// (or ?a=toggle). Auth-gated like everything else — a phone already signed into
// the dashboard taps and clocks in; otherwise it bounces through /login first.
app.get("/timesheet/tap", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/timesheet-tap.html"))
);
app.get("/users", (req, res) => {
  // Admin-only page. requireAuth has already confirmed there's a session;
  // here we additionally require is_admin so a regular logged-in user gets
  // bounced back to the dashboard instead of landing on a page they can't
  // populate (every /api/users call would 403).
  const { findById } = require("./db/userRepository");
  const me = req.session?.userId ? findById(req.session.userId) : null;
  if (!me || !me.is_admin) return res.redirect("/");
  res.sendFile(path.join(__dirname, "../public/users.html"));
});

// ── Scheduled Jobs ────────────────────────────────────────────────────────────
// Note: Happy Review processing moved from an hourly cron to a cursor-based
// poller in services/formsPollService.js (started above). That path respects
// the persisted pause flag and advances its own "last polled at" cursor so
// deploys don't cause re-sends to GHL.

// Nightly pricebook index sync — keeps the local cache used for scope-of-work
// matching fresh. Runs at 3 AM. Safe to trigger manually from /api/pricebook/index/refresh.
cron.schedule("0 3 * * *", async () => {
  console.log("[Cron] Running nightly pricebook index sync…");
  try {
    const { syncAll } = require("./services/pricebookIndexService");
    const result = await syncAll();
    console.log(
      `[Cron] Pricebook index sync: ${result.services} services, ` +
      `${result.materials} materials, ${result.equipment} equipment`
    );
  } catch (err) {
    console.error("[Cron] Pricebook index sync error:", err.message);
  }
});

// Daily return visit sync (existing)
cron.schedule("0 6 * * *", async () => {
  console.log("[Cron] Running daily return visit sync...");
  try {
    const { syncReturnVisitsForDateRange } = require("./services/returnVisitService");
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const results = await syncReturnVisitsForDateRange(
      twoDaysAgo.toISOString(),
      new Date().toISOString()
    );
    console.log(`[Cron] Synced ${results.length} return visit jobs`);
  } catch (err) {
    console.error("[Cron] Return visit sync error:", err.message);
  }
});

// Nightly SQLite backup (on-volume, rotating). Stopgap until an off-volume
// target is configured. Runs at 2 AM; keeps DB_BACKUP_KEEP copies (default 7).
cron.schedule("0 2 * * *", async () => {
  console.log("[Cron] Running nightly DB backup…");
  try {
    const { runDbBackup } = require("./services/dbBackupService");
    const r = await runDbBackup({ keep: parseInt(process.env.DB_BACKUP_KEEP) || 7 });
    console.log(`[Cron] DB backup written: ${r.dest} (keeping ${r.kept} of ${r.total})`);
  } catch (err) {
    console.error("[Cron] DB backup error:", err.message);
  }
});

// Also take one backup shortly after boot so there's always a recent copy,
// even if the process rarely stays up until 2 AM. Skipped in demo mode — the
// database is regenerated from a seed, so there is nothing worth backing up.
if (!demo.isDemo()) {
  setTimeout(() => {
    const { runDbBackup } = require("./services/dbBackupService");
    runDbBackup({ keep: parseInt(process.env.DB_BACKUP_KEEP) || 7 })
      .then((r) => console.log(`[Backup] Startup DB backup written: ${r.dest}`))
      .catch((err) => console.error("[Backup] Startup DB backup failed:", err.message));
  }, 60000); // 60s after boot, once DB init has settled
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║   ServiceOps Command Center                                  ║
║   Running on port ${String(PORT).padEnd(43)}║
╠══════════════════════════════════════════════════════════════╣
║   Dashboard:   http://localhost:${PORT}                      ║
║   Webhook:     http://localhost:${PORT}/webhook/servicetitan ║
║   Call Hook:   http://localhost:${PORT}/webhook/servicetitan/calls ║
║   Call Admin:  http://localhost:${PORT}/api/calls            ║
╚══════════════════════════════════════════════════════════════╝
  `);
  demo.banner();
});

module.exports = app;
