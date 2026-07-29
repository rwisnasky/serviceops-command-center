# CLAUDE.md — ServiceOps Command Center

> **Read this file first.** It is the orientation map for this codebase. Read it
> before exploring, and you'll know where everything lives without opening 60
> files. When you change the architecture (add a page, route, service, cron, or
> data table), update the relevant table below in the same commit so this stays
> the source of truth.

## What this is

A private internal operations dashboard ("the Command Center") for **Grounded
Home Services**, a residential plumbing and HVAC contractor. It sits between **ServiceTitan** (the field-service
system of record) and **GoHighLevel** (marketing/CRM automation) and layers on
call intelligence, profitability reporting, equipment registration, timesheets,
and a pile of other back-office tools. Single login-gated Node/Express app,
server-rendered static HTML pages + JSON APIs, SQLite for storage.

## Stack

- **Runtime:** Node 20, Express 4 (`src/index.js` is the entry point)
- **DB:** SQLite via `better-sqlite3`; sessions via `connect-sqlite3` +
  `express-session`
- **Scheduling:** `node-cron` + long-running poller loops started at boot
- **External APIs:** ServiceTitan (`src/api/servicetitan.js`, ~94 KB — the big
  one), GoHighLevel (`src/api/gohighlevel.js`), YouTube (`src/api/youtube.js` via
  `googleapis`), OpenAI (`openai` — call transcription + Vision OCR)
- **Parsing/docs:** `pdf-parse`, `pdfkit`, `mammoth` (.docx), `xlsx`, `multer`
  (uploads)
- **Auth:** `bcrypt` password hashes; login-gated dashboard
- **Hosting:** Railway. Persistent volume `serviceops-data` mounted at
  `/data`; `DB_PATH=/data/calls.db` so SQLite survives redeploys. Auto-deploys on
  every push to GitHub. Health probe at `/health`.

## Run / deploy

```bash
npm run dev        # nodemon, localhost:3000
npm start          # node src/index.js
npm run add-user -- jane@x.com pw     # user admin (also list-users, reset-password)
```

Deploy = push to GitHub; Railway rebuilds. Env vars live in Railway's Variables
tab (mirror of `.env`). Key ones: `DB_PATH=/data/calls.db`, `SESSION_SECRET`,
`NODE_ENV=production`, `FIRST_USER_EMAIL/PASSWORD` (one-time seed), plus
ServiceTitan / GoHighLevel / OpenAI / YouTube credentials.

## Directory layout

```
serviceops-command-center/
├── src/
│   ├── index.js            # entry: DB init, seeds, pollers, cron, route mounting
│   ├── api/                # external API clients (ServiceTitan, GHL, YouTube)
│   ├── config/             # config-driven behavior (equipment types, known callers, office team)
│   ├── db/                 # SQLite schema + repositories (one per domain)
│   ├── routes/             # Express routers, one per feature area (mounted under /api/*)
│   └── services/           # business logic (~45 modules; routes call into these)
├── public/                 # the dashboard pages (static .html + css/js)
├── scripts/                # CLI utilities (add-user, list-users, reset-password)
├── docs/                   # design notes (CALLS_REBUILD_PLAN, INVOICE_TO_PO, YOUTUBE_SETUP, ST API docs)
├── data/                   # monthly-cache/ (generated in demo mode), seed data
└── package.json
```

Architecture is consistent: **page (`public/*.html`) → route (`src/routes/*.js`,
mounted at `/api/<feature>`) → service(s) (`src/services/*.js`) → repository
(`src/db/*.js`) and/or API client (`src/api/*.js`).** To add a feature you touch
one file in each layer.

## Feature map — page → route → main services

| Page (URL)          | HTML                     | API mount            | Primary services |
|---------------------|--------------------------|----------------------|------------------|
| `/` (dashboard)     | index.html               | `/api/analytics`     | analytics / return visits |
| `/calls`            | calls.html               | `/api/calls`         | callProcessingService, classificationService, transcriptionService, callClassificationSync, callPollService, callQueueService |
| `/reviews`          | reviews.html             | `/api/forms`         | happyReviewService, formsPollService |
| `/memberships`      | memberships.html         | `/api/fanclubs`      | fanClubService |
| `/videos`           | videos.html              | `/api/videos`        | youtubeUploadService |
| `/fleet`            | fleet.html               | `/api/fleet`         | fleet trip analysis (off-hours) |
| `/invoices`         | invoices.html            | `/api/invoices`      | invoiceImportService, invoiceParserService, poPricebookMatchService |
| `/pricebook`        | pricebook.html           | `/api/pricebook`     | pricebookIndexService, pricebookImageService, pricebookMatcher, materialRenameService, scope*Service |
| `/monthly-review`   | monthly-review.html      | `/api/monthly-review`| monthlyReviewService, monthlyDataLoader |
| `/fy-review`        | fy-review.html           | (via monthly-review) | fiscalYear, fiscalAggregator |
| `/open-jobs`        | open-jobs.html           | (via monthly-review) | openJobsService |
| `/resolved-jobs`    | resolved-jobs.html       | (via customer/monthly)| — |
| `/customer-review`  | customer-review.html     | `/api/customer-review`| per-customer cost/benefit |
| `/scoreboard`       | scoreboard.html          | `/api/scoreboard`    | per-job hours + invoice + appts |
| `/backflow`         | backflow.html            | `/api/backflow`      | backflowReportService |
| `/address`          | address.html             | `/api/address`       | addressAuditService, addressCacheRepository, nameNormalizer |
| `/contract-compare` | contract-compare.html    | `/api/contracts`     | contractDiffService |
| `/pdf-parser`       | pdf-parser.html          | `/api/pdf-parser`    | pdfParserService (scanned PDF → OCR + per-page JPGs) |
| `/timesheet` (+`/timesheet/tap`) | timesheet.html / timesheet-tap.html | `/api/timesheet` | timeClockService, timesheetBalanceService |
| `/equipment`        | equipment.html           | `/api/equipment`     | equipmentRegistrationService, americanStandard*/bradfordWhite* services, rinnaiSerial (config in config/equipmentTypes.js) |
| `/install-tracker`  | install-tracker.html     | `/api/install-tracker`| installTrackerService (config in config/installTrackerJobTypes.js; overlay in db/installTrackerRepository.js) |
| `/payment-invoices` | paymentInvoices.html     | `/api/payment-invoices`| paymentInvoiceService |
| `/users` (admin)    | users.html               | `/api/users`         | userRepository |
| `/login` `/logout` `/change-password` | (auth pages) | `authRoutes` (root) | userRepository |
| `/webhook/*`        | —                        | `/webhook`           | webhook receiver (ST + GHL); **auth-exempt** |

## Data layer (`src/db/`)

`index.js` owns schema init (`initSchema()`, called at boot) and the shared
`better-sqlite3` connection. Repositories, one per domain:
`callRepository`, `jobReviewRepository`, `employeeRepository`, `userRepository`,
`timeClockRepository`, `timesheetRepository`, `installedEquipmentRepository`,
`installTrackerRepository`, `addressCacheRepository`. DB file lives at `DB_PATH`
(`/data/calls.db` in prod).

## Background jobs (started in `src/index.js`)

- **Queue worker** — `callQueueService.startWorker()` processes the call pipeline.
- **Call poller** — `callPollService.startPoller()` pulls new completed calls from
  ServiceTitan every N minutes.
- **Forms poller** — `formsPollService.startFormsPoller()` cursor-polls ST for new
  Happy Review submissions and pushes to GHL (respects a persisted pause flag;
  advances its own "last polled" cursor so redeploys don't re-send).
- **Cron 3:00 AM** — nightly pricebook index sync (`pricebookIndexService.syncAll()`;
  manual trigger: `POST /api/pricebook/index/refresh`).
- **Cron 6:00 AM** — daily return-visit sync for the last 2 days
  (`returnVisitService.syncReturnVisitsForDateRange`).

## Auth model

`requireAuth` middleware gates everything except: `/webhook/*`, `/health`,
`/login`, `/logout`, static `/css/*` `/js/*` `/fonts/*` `/favicon.ico`. Sessions
persist in `sessions.sqlite` on the `/data` volume (survive redeploys). `/users`
additionally requires `is_admin`. New users are seeded with `must_change_pw=1`.

## Config-driven behavior (`src/config/`)

- **`equipmentTypes.js`** — declaratively defines each Equipment page tab
  (manufacturer, parser, serial decoder, CSV mapping). Adding a manufacturer =
  add a config object + a parser + wire routes; no page rewrite.
- **`installTrackerJobTypes.js`** — the ServiceTitan job type ids the Install
  Tracker watches (HVAC + Water Heater installs). Edit this list to change what
  counts as an install; nothing else changes.
- **`knownCallers.js`** — force-labels known vendor/office numbers in ServiceTitan
  (call type + reason + agent) so they skip manual review.
- **`officeTeam.js`** — office staff roster.

## Gotchas & operational knowledge

Hard-won operational details that aren't obvious from the code:

- **ServiceTitan silently ignores unknown query params.** Customer search uses
  `phone` (not `phoneNumber`); job number field is `jobNumber` (not `number`).
- **Membership/PSM job types** (e.g. "PSM - Heating Maintenance") are
  dues-covered — never flag them as missed invoices in Open Jobs.
- **Known-caller auto-labeling**: e.g. (614) 555-0177 → Excused / Vendor / Renata Vasilenko;
  verify `agentId` on first use.
- **Fleet vehicle → technician**: 12 = Marcus Ellery, 21 = Wes Calloway.
- **The co-owner runs bid/construction jobs in a separate spreadsheet**, not in
  ServiceTitan — that work is deliberately out of scope for the ST integration,
  pricebook and SKU workstreams, and its absence explains gaps in the reports.
- **Railway persistence** depends on `DB_PATH=/data/calls.db` pointing at the
  mounted volume — if that's wrong the DB resets every deploy.

## Where to look for X

- "How does a call get transcribed/classified?" → `services/callProcessingService.js`,
  `classificationService.js`, `transcriptionService.js`; storage in `db/callRepository.js`.
- "Add a new equipment manufacturer" → `config/equipmentTypes.js` + a new
  `services/<mfg>Service.js` + `<mfg>Warranty.js`; see the American Standard /
  Bradford White pair as the template.
- "Profitability / monthly numbers" → `services/monthlyReviewService.js` +
  `monthlyDataLoader.js`; fiscal-year rollups in `fiscalYear.js` / `fiscalAggregator.js`.
- "ServiceTitan API call" → `src/api/servicetitan.js` (everything ST goes through here).
- "Why did the dashboard reset its data?" → check the Railway volume mount and
  `DB_PATH`.
