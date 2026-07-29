# MOCK_SPEC_PAGES.md — page → endpoint → data-source map

Companion to `MOCK_SPEC_DATABASE.md`. This document answers, for every page in
`public/`: what does its JavaScript call, where does that data actually come
from, what does the page look like with nothing behind it, and what does it do
with uploaded files.

**Data-source legend used throughout:**

| Code | Meaning |
|---|---|
| **DB** | SQLite only — seedable |
| **ST** | Live ServiceTitan API call at request time — *not* seedable without a mock ST |
| **GHL** / **YT** / **GOOG** / **AI** | Live GoHighLevel / YouTube / Google Geocoding / OpenAI call |
| **FILE** | Reads a file on disk (`data/monthly-cache/…`, a temp dir, an uploaded buffer) |
| **MEM** | Process memory only (a `Map` or module variable) — wiped on restart, **cannot be seeded** |
| **MIX** | Combination — details given per endpoint |

---

# Part 0 — Boot behavior (`src/index.js`)

## Route mounts (in order)

| Mount | Router file | Notes |
|---|---|---|
| *(root)* | `src/routes/auth.js` | Owns `GET/POST /login`, `POST /logout`, `GET /api/auth/me`, `POST /api/auth/change-password` |
| `/webhook` | `webhook.js` | **Auth-exempt.** `POST /webhook/servicetitan`, `POST /webhook/servicetitan/calls` |
| `/api/analytics` | `analytics.js` | |
| `/api/forms` | `forms.js` | Happy Reviews |
| `/api/fanclubs` | `fanclubs.js` | Memberships |
| `/api/calls` | `calls.js` | Call intelligence |
| `/api/videos` | `videos.js` | YouTube upload |
| `/api/fleet` | `fleet.js` | Off-hours trip analysis |
| `/api/invoices` | `invoices.js` | Supplier invoice → PO |
| `/api/pricebook` | `pricebook.js` | Pricebook / rename / merge / scope |
| `/api/monthly-review` | `monthlyReview.js` | Also backs `/fy-review`, `/open-jobs`, `/resolved-jobs` |
| `/api/customer-review` | `customerReview.js` | |
| `/api/scoreboard` | `scoreboard.js` | |
| `/api/users` | `users.js` | Whole router behind `requireAdmin` |
| `/api/backflow` | `backflow.js` | |
| `/api/address` | `address.js` | |
| `/api/contracts` | `contracts.js` | Contract compare |
| `/api/pdf-parser` | `pdfParser.js` | |
| `/api/timesheet` | `timesheet.js` | |
| `/api/equipment` | `equipment.js` | |
| `/api/payment-invoices` | `paymentInvoices.js` | |
| `/api/install-tracker` | `installTracker.js` | |

Static `express.static("public")` is mounted **after** `requireAuth`, so every
HTML page is login-gated. Page URLs are individually registered with
`res.sendFile` (`src/index.js:252–336`).

## Background jobs started at boot

| Job | Started at | Cadence | What it does |
|---|---|---|---|
| **Queue worker** | `callQueueService.startWorker()` — `index.js:47` | continuous loop | Drains the in-memory call queue: transcribe (OpenAI) → classify → match → write `processed_calls` |
| **Call poller** | `callPollService.startPoller()` — `index.js:51` | every `CALL_POLL_INTERVAL_MINUTES` (default 5) | Pulls new completed calls from ST `telecom/v2/…/calls`; cursor in `kv_store['call_poll_last_run']`; first run looks back `CALL_POLL_LOOKBACK_HOURS` (default 2) |
| **Forms poller** | `formsPollService.startFormsPoller()` — `index.js:55` | every `FORMS_POLL_INTERVAL_MINUTES` (default 5) | Cursor-polls ST Forms for Happy Review submissions (form id **1406**) and pushes them to GoHighLevel; respects `kv_store['happy_review_paused']`; cursor in `kv_store['forms_poll_last_run']`; dedupes via `processed_happy_reviews` |
| **Cron `0 2 * * *`** | `index.js:379` | 2:00 AM daily | Nightly SQLite backup on-volume, rotating, keeps `DB_BACKUP_KEEP` (default 7) |
| **Cron `0 3 * * *`** | `index.js:346` | 3:00 AM daily | `pricebookIndexService.syncAll()` — rebuilds `pricebook_index` + writes `pricebook_sync_log` |
| **Cron `0 6 * * *`** | `index.js:361` | 6:00 AM daily | `returnVisitService.syncReturnVisitsForDateRange(−2 days → now)`; dedupes via `processed_return_visits` |
| **Startup backup** | `setTimeout` — `index.js:392` | once, 60 s after boot | Same as the 2 AM backup |

Two boot-time seeds also run: `seedEmployeePhonesIfEmpty()` (`employee_phones` from
`data/employee-roster.json`) and `seedFirstUserIfEmpty()` (`users` from
`FIRST_USER_EMAIL` / `FIRST_USER_PASSWORD`).

Both `process.on("unhandledRejection")` and `process.on("uncaughtException")` are
trapped and logged so a poller failure can't kill the process.

## Auth middleware exempt list (`requireAuth`, `index.js:134–181`)

```js
PUBLIC_HTML_PATHS = new Set(["/login", "/logout", "/favicon.ico"]);
PUBLIC_PREFIXES   = ["/webhook", "/css/", "/js/", "/fonts/"];
// plus: req.path === "/health"
```

Rules:
1. Any path containing `..` is **never** public (blocks `/css/../index.html` traversal).
2. `/health` → public. Always returns HTTP 200 with `{status, degraded, pollers, timestamp}`; `degraded` is true when a poller cursor hasn't advanced in 4× its interval.
3. Logged-in users with `must_change_pw = 1` may reach **only** `/change-password` and `/api/auth/*`; everything else gets a redirect (HTML) or **403** `{ok:false, error:"password change required"}` (API).
4. Not logged in → `/api/*`, XHR, and `Accept: application/json` requests get **401** `{ok:false, error:"not logged in"}`; HTML requests get `302 → /login?next=<url>`.
5. `/users` has an extra `is_admin` check in the page handler (`index.js:327`) that redirects non-admins to `/`; the `/api/users` router re-checks `is_admin` from the DB on every request.

Sessions: `express-session` + `connect-sqlite3` in `sessions.sqlite` on the DB
volume, cookie `st_hl_sid`, httpOnly, sameSite lax, secure in production,
rolling 30-day expiry.

**Every page also implicitly calls `GET /api/auth/me` and `POST /logout`** via
`public/js/shared.js` (nav identity + sign-out).

---

# Part 1 — Monthly cache file shapes

Everything under "profitability" reads `data/monthly-cache/{YYYY}-{MM}/`. All
three files are a **bare JSON array** at top level. Month must be zero-padded.

### `jobs.json` — array of job objects

| Field | Type | Example | Consumed by |
|---|---|---|---|
| `jobNumber` | string | `"2603162"` | the join key for everything |
| `status` | string, **case-sensitive** | `"Completed"` \| `"In Progress"` \| `"Canceled"` \| `"Scheduled"` \| `"Hold"` \| `"Dispatched"` | `"Completed"` gates all revenue/GM; `OPEN_STATUSES` gates Open Jobs |
| `billed` | number | `1842.5` | headline billing, missed-invoice detection |
| `materialCost` | number | `410.22` | GM, exposure |
| `laborCost` | number | `265` | GM, labor-rate inference, Scoreboard fallback |
| `hours` | number | `3.5` | $/hr |
| `gm` | number (ST "Jobs Gross Margin", *not* derived) | `1167.28` | every GM figure |
| `customerId` | string | `"1000042"` | zero-billed follow-up pairing |
| `technicians` | **comma-joined string, not an array** | `"Marcus Ellery, Dale Prentiss"` | solo-tech labor-rate inference, Ellery matching |
| `createdDate` | ISO string or null | `"2026-03-04T00:00:00.000Z"` | job aging (`daysOpen`) |
| `completionDate` | ISO string or null | `"2026-03-11T00:00:00.000Z"` | Open Jobs linking |
| `summary` | string | `"3/9/2026 - 7-9 NO HEAT"` | on-time fallback parser (regex `M/D/YY - X-Y`) |
| `jobClass` | string | `"Service"` | carried, not aggregated |
| `jobId` | string | `"188234"` | only the appointment jobId→jobNumber map (the xlsx importer drops it) |
| `_source` | string | `"jc+wip"` \| `"jc-only"` \| `"wip"` \| `"wip-only"` \| `"live-only"` \| `"live-overlay"` | **`"jc-only"` excludes the job from every operational GM number** |
| `_hasCostData` | boolean | `true` | `false` excludes from operational totals; Customer Review requires `true` |

Minimum viable row:
```json
{"jobNumber":"2603162","jobType":"Service Call - HVAC","status":"Completed",
 "billed":1842.5,"materialCost":410.22,"laborCost":265,"hours":3.5,"gm":1167.28,
 "customerId":"1000042","customerName":"Acme","technicians":"Marcus Ellery",
 "primaryTech":"Marcus Ellery","createdDate":"2026-03-04T00:00:00.000Z",
 "completionDate":"2026-03-11T00:00:00.000Z","summary":"","soldHours":4,
 "_source":"jc+wip","_hasCostData":true}
```

### `timesheets.json` — array of per-tech activity rows

| Field | Type | Notes |
|---|---|---|
| `tech` | string | **must match the spelling in `jobs.json` `technicians`**; falsy rows are dropped |
| `date` | ISO string | only `.slice(0,10)` is used, so `"2026-03-09"` works |
| `activity` | string, exact spelling | `"Working"`, `"WORKING CONSTRUCTION JOB"`, `"Driving"`, `"Idle"`, `"OFF / UNPAID"`, `"Training"`, `"Meal"`, `"Meeting"`, `"Job Prep"` — anything else lands in `other`. Only `"Working"` counts as an arrival for on-time. |
| `startTime` | `"HH:MM"` 24h | required for on-time math; values without `:` are skipped |
| `endTime` | `"HH:MM"` | display only |
| `durationHours` | number | rows `<= 0` or `> 50` dropped; `Idle > 8` dropped as an artifact; Customer Review drops `> 24` |
| `jobNumber` | string (may be `""`) | join key |
| `businessUnit` | string | written, never read |
| `laborType` | string | written, never read |

```json
{"tech":"Marcus Ellery","businessUnit":"HVAC Service","date":"2026-03-09T00:00:00.000Z",
 "activity":"Working","startTime":"07:12","endTime":"09:45","durationHours":2.55,
 "jobNumber":"2603162","laborType":"Regular"}
```

### `appointments.json` — optional array

| Field | Type | Notes |
|---|---|---|
| `appointmentId` | number | written, not read |
| `jobId` | number | fallback key when `jobNumber` is null |
| `jobNumber` | string or null | primary join key |
| `scheduledStart` | ISO | **the on-time baseline.** Bare-`Z` timestamps get a hand-rolled UTC→America/Chicago conversion (`-5` Mar–Oct, `-6` Nov–Feb); explicit offsets are honored |
| `scheduledEnd` | ISO | defaults to start + 120 min if absent |
| `customerWindowStart` / `customerWindowEnd` | ISO or null | written, never read on these paths |
| `technicianIds` | number[] | not read here |
| `status`, `specialInstructions` | string | not read here |

**Trap:** if `appointments.json` is present and non-empty, on-time computation
switches to `dataSource: "servicetitan-appointments"` and **stops parsing job
summaries entirely**. Appointments with a null `jobNumber` whose `jobId` isn't in
`jobs.json` are silently dropped — and the xlsx importer drops `jobId` — so always
populate `jobNumber` on each appointment.

---

# Part 2 — Page-by-page map

## 1. `index.html` — Dashboard (`/`)

| Endpoint | Source | Detail |
|---|---|---|
| `GET /api/calls/review-since` | **DB** | `processed_calls` + `kv_store['calls_last_reviewed_at']` |
| `GET /api/calls/stats` | **DB** | `processed_calls` aggregate |
| `GET /api/calls/queue` | **MEM** | `callQueueService.getQueueSnapshot()` — a plain JS array, **not seedable** |
| `GET /api/pricebook/duplicates?count=true&rule=code&type=all&activeOnly=true` | **DB** | `pricebook_index` |
| `GET /api/timesheet/clock` | **DB** | `time_punches` for the session user |
| `GET /api/monthly-review/current` | **MIX (ST-first)** | `loadMonth(preferLive:true)` — **skips the cache entirely**; live jobs + per-job invoices; `job_review_status` overlay |
| `GET /api/fanclubs/preview?activeOnly=true` | **ST** | paginates all active memberships |
| `GET /api/forms/recent?hours=1` | **ST** | Forms API |
| `POST /api/forms/process-happy-reviews` | **ST + GHL** | |
| `POST /api/analytics/sync-return-visits` `{days:30}` | **ST + GHL** | fire-and-forget; responds `{started:true}` before any work runs, so the UI can never report a real failure |

**Empty state:** graceful everywhere. Hero shows `0` + *"You're all caught up — no new calls to review."*; Needs-Attention rows start hidden and collapse to *"✓ All clear — nothing waiting on you right now."*; This-Month tiles show `$0` / `0 completed jobs` / `0.0% margin`. **On fetch failure** the tiles stay at their literal `—` placeholder and the hero stays at *"Checking the queue…"* forever (the catch only `console.warn`s).

**Uploads:** none.

---

## 2. `calls.html` — Call Reviews (`/calls`)

All `/api/calls/*` additionally pass through `requireAdminKey` (`calls.js:81`), which is only enforced when `ADMIN_API_KEY` is set.

| Endpoint | Source |
|---|---|
| `GET /api/calls?limit=50[&status=][&posted=true][&includeDismissed=true]` | **DB** `processed_calls` |
| `GET /api/calls/stats` | **DB** |
| `GET /api/calls/{callId}` | **DB** + `src/config/knownCallers.js` annotation |
| `POST /api/calls/poll` | **ST** — fire-and-forget `{started:true}` |
| `POST /api/calls/{callId}/process` | **MEM → AI** — pushes onto the queue |
| `POST /api/calls/{callId}/reclassify` | **AI + ST**, then DB write |
| `PATCH /api/calls/{callId}/call-type` | **DB + ST** (best-effort ST write) |
| `PATCH /api/calls/{callId}/reason` | **DB + ST** |
| `PATCH /api/calls/{callId}/category` | **DB** (`manual_category`) |
| `PATCH /api/calls/{callId}/transcript` | **DB** |
| `POST /api/calls/{callId}/dismiss` | **DB** (`dismissed_at`) |
| `POST /api/calls/{callId}/apply-note` | **ST write** then DB `notes_applied_at` |
| `GET /api/calls/{callId}/related-jobs` | **ST** |
| `GET`/`PUT /api/calls/ai-instructions` | **DB** `app_settings` |
| `POST /api/calls/mark-reviewed` | **DB** `kv_store` — **fires unconditionally on every page load** (`calls.html:1236`) |
| `POST /api/calls/upload` | multipart — see below |

**Empty state:** the best-handled page in the app. Three distinct messages:
*"No calls detected yet. Poll ServiceTitan above or upload a recording to get started."*; *"No {reviewed\|posted\|waiting\|failed} calls yet."*; and ``All ${rawCalls.length} recent calls are under 30s (hang-ups / misdials). Nothing to review.`` HTTP errors render a red panel; a per-card render failure is isolated by `safeRenderCard()`.

**Upload:** `#upload-file`, `accept="audio/*,.mp3,.m4a,.wav,.ogg,.webm,.aac,.flac"`, drag-drop wired. FormData field **`recording`** (+ optional `callerPhone`, `callerName`, `contextNote`) → `POST /api/calls/upload`. Multer **diskStorage** → `RECORDINGS_TMP_DIR || /tmp/recordings`, filename `upload_{ts}_{rand}{ext}`, **25 MB** cap. `uploadedCallService.processUploadedCall()` transcribes via OpenAI, inserts a `processed_calls` row with a synthetic `upload-…` id, then deletes the temp file.

**Seeding gotcha:** cards are hidden unless duration is unknown or > 30 s (read from `transcript_metadata.duration` seconds or `raw_webhook_payload.leadCall.duration` `"HH:MM:SS"`).

---

## 3. `reviews.html` — Review Requests (`/reviews`)

| Endpoint | Source |
|---|---|
| `GET /api/forms/status` | **DB** `kv_store['happy_review_paused']` |
| `POST /api/forms/pause` / `/resume` | **DB** |
| `GET /api/forms/recent?hours=1` | **ST** Forms API (form id 1406) |
| `GET /api/forms/preview-happy-review?hours=2` | **ST**, heavy: submissions + `getJobByNumber` + `getInvoicesForJob` + location lookups. Caches into a module-level `lastPreviewedSubmission`. |
| `POST /api/forms/process-happy-reviews` `{hours}` | **ST reads + GHL webhook**; dedupes on `processed_happy_reviews`; returns **423** when paused |
| `POST /api/forms/process-last-preview` | **MEM + ST + GHL** — 400 *"No previewed submission on record — run Preview first"* after any restart |

**Empty state:** mostly graceful — *"⚠ No submissions found"*, *"✓ No Happy Review submissions found in the last 2 hours"*. Two defects: `loadPauseStatus()` has an empty catch so the label stays at *"Checking status..."*, and on a 500 the preview panel renders the literal string `undefined` (the error branch checks `data.found`, which is absent on an error body).

**Uploads:** none.

**Seedable surface:** the pause flag only. Everything else needs a live ST tenant with form id 1406 and its exact unit order (`units[0]`=Customer Name, `[1]`=Job ID, `[2]`=Email, `[3]`=Phone, `[4]`=Technician).

---

## 4. `memberships.html` — Memberships (`/memberships`)

| Endpoint | Source |
|---|---|
| `POST /api/fanclubs/test-sync` | **ST** (+ **GHL write** when `dryRun:false`) |
| `GET /api/fanclubs/lookup?type=customer\|location&id=` | **ST** — paginates all active memberships, then N× `getLocationsByCustomer` |
| `POST /api/fanclubs/send-webhook` | **GHL** |
| `POST /api/fanclubs/patch-check-months` | **ST + GHL** |
| `GET /api/fanclubs/ghl-field-options` | **GHL** |
| `GET /api/fanclubs/membership-types` | **ST** |
| `GET /api/fanclubs/customer-locations?customerId=` | **ST** |
| `POST /api/fanclubs/add-membership` | **ST write** |

**Zero SQLite involvement.** With no ST credentials the page is inert but not visibly broken — no result panel renders until you type an ID and click, and failures read as *"⚠ No active memberships found"*.

**Uploads:** none (bulk input is a textarea of IDs).

**Seeding note:** un-fakeable without a mock ST. The lookup UI reads a deeply nested response — `data.result.wouldSendToGHL.contactPayload.customFields.{membership_fan_club, fan_club_start_date, expiration_date, cooling_check_month, heating_check_month}` plus `result.visits.{total,completed,remaining}`. The plan dropdown falls back to a hard-coded `FAN_CLUB_PLANS` list of five ST type ids.

---

## 5. `videos.html` — Job Videos (`/videos`)

| Endpoint | Source |
|---|---|
| `POST /api/videos/upload` | **ST + YT + DB** |
| `GET /api/videos/recent?limit=15` | **DB** `video_uploads` (server caps limit at 100) |

**Empty state:** clean — `Loading…` → *"No uploads yet."*; failure → *"Failed to load: {msg}"*.

**Upload:** `#video-file-input`, `accept="video/*,.mp4,.mov,.m4v,.avi,.mkv,.webm"`, drag-drop. FormData `{jobNumber, videoFile}`. Multer **diskStorage** → `VIDEO_UPLOAD_TMP || /tmp/video-uploads`, **500 MB**. Server resolves the ST job → location street address, uploads to YouTube as **unlisted**, titles it with the street address, describes it `ServiceTitan Job #{n}`, unlinks the temp file, inserts into `video_uploads`. 404s if the job or its street address can't be resolved.

**Seeding note:** the list is fully seedable and needs no valid ST ids; the page reads the snake_case columns directly.

---

## 6. `fleet.html` — Fleet (`/fleet`)

100% SQLite + uploaded files. **No ServiceTitan anywhere in `src/routes/fleet.js`.**

| Endpoint | Source |
|---|---|
| `GET /api/fleet/technicians` | **DB** `fleet_technicians WHERE active=1` |
| `POST /api/fleet/technicians` | **DB** upsert on `truck_number` |
| `DELETE /api/fleet/technicians/{id}` | **DB** soft delete |
| `POST /api/fleet/seed` | **DB** — **auto-fires on every page load** (`fleet.html:534`), inserting trucks 76/57 |
| `POST /api/fleet/process` | **FILE + DB** — parses the uploads in memory, reads `known_addresses` for labels, upserts newly seen addresses. The report itself is never persisted. |
| `GET /api/fleet/addresses?search=` | **DB** `known_addresses` |
| `PUT`/`DELETE /api/fleet/addresses/{id}` | **DB** |
| `POST /api/fleet/addresses/propagate` | **DB** — street-key match to bulk-fill blank labels |
| `POST /api/fleet/addresses/import` | **FILE → DB** |

**Empty state:** *"No addresses found. Process a trip report to populate."* / *"No technicians configured. Add one below."*; the report area is `display:none` until a report runs. **But `loadAddresses()`, `loadTechs()` and `propagateAddresses()` have no try/catch** — a 500 makes `renderAddresses` throw `TypeError` on `data.addresses.length` and the list silently stays stale.

**Uploads — three:**
1. `#inp-trip` `.csv` → field **`tripFile`** → `POST /api/fleet/process`
2. `#inp-ts` `.xlsx,.xls` → field **`timesheetFile`** → same endpoint (optional; alternative is `manualStart`/`manualEnd` `HH:MM`)
3. `#inp-import-addr` `.xlsx,.xls` → field **`file`** → `POST /api/fleet/addresses/import`

Multer **memoryStorage**, 10 MB, shared instance — **nothing is written to disk**. CSV is `buffer.toString("utf-8")` and split manually; XLSX goes through `XLSX.read(buffer,{type:"buffer",cellDates:true})`.

Trip CSV shape: optional `sep=` first line, **semicolon-delimited**, headers `Ignition On/Trip Start`, `Ignition Off/Trip End`, `Depart`, `Arrive`, `Distance Traveled (Miles)`, `Hard Braking Events`, `Cornering Events`; timestamps `MM/DD/YYYY HH:MM AM|PM`. Timesheet XLSX: `Timesheet Activity Date` + `Start Time` + `End Time` (or legacy `Start Date Time` / `End Date Time`). Address import XLSX: `Address`, `Label`, `Truck`, `Sample Visit`.

---

## 7. `monthly-review.html` — Monthly Review (`/monthly-review`)

| Endpoint | Source |
|---|---|
| `GET /api/monthly-review/list` | **FILE** — directory listing of `data/monthly-cache/` matching `^\d{4}-\d{2}$`; returns `{months:[]}` when absent |
| `GET /api/monthly-review/current` | **ST** — `preferLive:true`, cache skipped; timesheets are a hard-coded `[]` stub; + `job_review_status` overlay |
| `GET /api/monthly-review/{year}/{month}` | **MIX** — current calendar month → live; otherwise `readCache()`; **if either `jobs.json` or `timesheets.json` is missing the whole month silently falls through to live ST** |
| `GET /api/monthly-review/fy-to-date/{year}/{month}` | **FILE + DB** — `readCache` only, **no live fallback** |
| `POST /api/monthly-review/refresh-appointments/{year}/{month}` | **ST → FILE** — writes `appointments.json` |
| `GET /api/monthly-review/job-lookup/{jobNumber}` | **MIX** — live job + appointments, then scans **every** cached `timesheets.json` for `activity === "Working"` rows |

**Empty state:** the month dropdown shows only *"Current month — {Month} {Year} (live)"*, and `/current` returns a fully-formed zeroed payload → **all-zero KPI tiles, not an empty state** (the *"No data for this period."* branch is unreachable). The FYTD section early-returns on `monthsWithData === 0` and stays hidden. If ST *throws*, the route 500s → *"Could not load review."*

**Uploads:** none in the page. Cache files are seeded out-of-band by `scripts/import-monthly-xlsx.js`.

---

## 8. `fy-review.html` — Fiscal Year Review (`/fy-review`)

| Endpoint | Source |
|---|---|
| `GET /api/monthly-review/fy/{FYxx}` | **FILE + DB overlay** — `fiscalAggregator.buildFullFY` → `readCache` per month. **No live fallback.** |

Fiscal year runs **Oct 1 → Sep 30**, labeled by the end year (`src/services/fiscalYear.js`).

**Empty state:** guaranteed zeros and graceful — KPI cards read `$0` / `0.0%`, all 12 rows read *"— no cached data for this month —"*, subtitle reads *"0 of 12 months have cached data"*.

**Uploads:** none.

---

## 9. `open-jobs.html` — Open Jobs (`/open-jobs`)

| Endpoint | Source |
|---|---|
| `GET /api/monthly-review/open-jobs` | **FILE + DB** — `openJobsService` reads `jobs.json` from **every** cached month directly (bypassing `readCache`), dedupes by `jobNumber` (later months win), then joins `job_review_status`. **No live ST call.** |
| `GET /api/monthly-review/employees` | **ST** — active employees, filtered/ordered by `src/config/officeTeam.js` |
| `POST /api/monthly-review/job-review-status/{jobNumber}` | **DB write** (+ optional live `addJobNote` when `pushToServiceTitan:true`) |
| `POST /api/monthly-review/job-review-status/{jobNumber}/create-st-task` | **ST write** + DB audit note |
| `POST /api/monthly-review/refresh-jobs-recent` | **ST → FILE** — pulls previous + current month, merges via `mergeLiveWithCache` (preserves xlsx cost columns), rewrites the cache |

**Empty state:** graceful — KPI tiles `0` / `$0`, header *"0 months cached · as of YYYY-MM-DD"*, table *"No jobs match the current filter."* A failing `/employees` call is caught and logged, non-fatal.

**Uploads:** none.

**Business rule:** PSM / membership job types (e.g. "PSM - Heating Maintenance") are dues-covered and must never be flagged as missed invoices.

---

## 10. `resolved-jobs.html` — Resolved Jobs (`/resolved-jobs`)

| Endpoint | Source |
|---|---|
| `GET /api/monthly-review/resolved[?onlyUnsynced=1]` | **DB only** — `job_review_status WHERE status='resolved'`, each row decorated with its `job_review_notes` and `pendingStatus/pendingJobType/pendingNotes/pendingPush` |
| `POST /api/monthly-review/resolved/{jobNumber}/push-to-st` | **DB + ST** — `updateJobStatus` / `updateJobType` / `addJobNote`, writing per-field sync flags back |
| `POST /api/monthly-review/resolved/push-to-st` | same, batched, body `{jobNumbers?: string[]}` |

**Empty state:** clean and fully seedable — *"No resolved jobs with pending pushes."* (or *"…yet."* on the All filter), KPIs 0/0/0, "Push all" disabled.

**Uploads:** none.

---

## 11. `customer-review.html` — Customer Review (`/customer-review`)

| Endpoint | Source |
|---|---|
| `GET /api/customer-review/search?q=` | **ST only** — customer by id / phone / name |
| `GET /api/customer-review/report?customerId&startDate&endDate[&expectedHourlyRate][&dateField=modified\|completed]` | **MIX, heavily live** — live `getJobsForCustomerInRange`, `getInvoicesForJob`, `getPurchaseOrdersForJob`, `getJobTypeNamesById`, payroll fallbacks; **plus two lazily-built 5-minute-TTL indexes over `data/monthly-cache/*/`** — `jobs.json` is the *only* source of margin (`materialCost`/`laborCost`/`gm`/`billed`), `timesheets.json` is the first-priority source of hours |
| `GET /api/customer-review/customer/:id` | defined but **never called by the page** |

**Empty state:** nothing renders until you search. With no ST data you get a *"No jobs found"* card plus an `emptyReason` diagnostic (*"ServiceTitan has zero jobs on file for this customer ID — confirm the ID is correct."* or *"Customer has N+ jobs … none fall inside <range> using either date field. Widen the date range."*). With jobs but no cache, margins render as dashes plus *"No cost data available for any job in this window — import the WIP xlsx for these months via Monthly Review to enable margin analysis."*

**Uploads:** none.

---

## 12. `scoreboard.html` — Job Scoreboard (`/scoreboard`)

| Endpoint | Source |
|---|---|
| `GET /api/scoreboard/{jobNumber}[?laborRate=N]` | **MIX, live-first** — live job, customer, location, appointments, invoices + items, and three Payroll v2 endpoints (`jobs/timesheets`, `jobs/splits`, `gross-pay-items`). Cache is used only as fallback: a tech-hours scan of every `timesheets.json`, a `cachedJob.laborCost` lookup across every `jobs.json`, and the per-tech labor-rate median map (process-lifetime memoized). **No SQLite.** |

The multi-job "rollup" tool calls the same endpoint N-way in parallel.

**Empty state:** idle text *"📋 Enter a job number above to load the scoreboard."*; ST down → *"⚠ ST job lookup failed: <msg>"*; unknown job → 404 *"Job N not found in ServiceTitan"*. Cache absence is invisible — labor silently falls back to a `fleetMedian = 50` $/hr estimate with a `warnings[]` entry.

**Uploads:** none.

---


## 14. `invoices.html` — Invoice → PO (`/invoices`)

| Endpoint | Source |
|---|---|
| `POST /api/invoices/parse` | **MIX, no DB write** — may trigger `autoSyncIfStale(30)` (live ST pricebook sync writing `pricebook_index` + `pricebook_sync_log`); `pdftoppm` page-1 PNG → **OpenAI gpt-4o vision**; live `findJobByNumber` + `findVendorByName` (10-min vendor cache); then `poPricebookMatchService.matchBatch()` against `pricebook_index` (`sku_type='Material' AND active=1`, exact normalized-code map then Jaccard at 0.65) |
| `POST /api/invoices/create-po` | **ST write + DB** — `st.createPurchaseOrder()`, **always** inserts an `invoice_uploads` row (`created`/`failed`) |
| `POST /api/invoices/add-to-pricebook` | **ST write + DB** — `st.createMaterial()` per item (price deliberately omitted), then upserts `pricebook_index` |
| `GET /api/invoices/recent?limit=25` | **DB** `invoice_uploads` |
| `DELETE /api/invoices/recent?scope=failed\|all` | **DB** |

**Empty state:** graceful. `Loading…` → *"No imports yet."*; failure → *"Failed to load: <msg>"* in red. An empty `pricebook_index` makes every parsed line come back `unmatched` with an inline "NEW — ADD?" form — no crash.

**Upload:** `#inv-file-input`, `accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*"`, drag-drop. FormData **`invoiceFile`** (+ optional `jobNumber`, `refreshVendors`). Multer **diskStorage** → `INVOICE_UPLOAD_TMP || /tmp/invoice-uploads`, filename `invoice-<ts>-<hex8><ext>`, **25 MB**. PDF → `pdftoppm -png -r 200 -f 1 -l 1` → base64 → OpenAI vision. Temp PNG unlinked; source deleted on parse error, on successful PO create, or by a 5-minute sweeper (30-min TTL over an in-memory `PREVIEWS` Map). No artifacts served back.

---

## 15. `pricebook.html` — Material Rename / Pricebook (`/pricebook`)

The page title is actually **"Material Rename"**; the search/cart and Scope→Estimate blocks are collapsed legacy `<details>` sections.

| Endpoint | Source |
|---|---|
| `GET /api/pricebook/{services\|materials\|equipment\|discounts-and-fees}?searchTerm&page&pageSize` | **ST** — live pass-through, zero caching |
| `POST /api/pricebook/estimate` | **ST** — `findJobByNumber` + `createEstimate` |
| `POST /api/pricebook/parse-scope` | **MIX** — `autoSyncIfStale(30)`; `pdftoppm -png -r 180` up to 5 pages → OpenAI vision; `pricebookMatcher.matchBatch()` over `pricebook_index` (Jaccard 0.55, floor 0.15) with an **OpenAI gpt-4o-mini tie-breaker** for the 0.15–0.55 band; then live job lookup. No DB write. |
| `POST /api/pricebook/parse-scope/resolve-job` | **ST** + in-memory stash |
| `POST /api/pricebook/create-estimate` | **ST write + DB** `scope_estimate_uploads` |
| `GET /api/pricebook/recent-scope-estimates?limit=10` | **DB** |
| `GET /api/pricebook/index/stats` | **DB** `pricebook_index` + `pricebook_sync_log` |
| `POST /api/pricebook/index/refresh` | **ST → DB** — `syncAll()` + `markStaleInactive` + a `pricebook_sync_log` row |
| `GET /api/pricebook/index/search?q=&limit=8` | **DB** |
| `GET /api/pricebook/duplicates?…` and `/duplicates/suggest-canonical?…` | **DB** — `UPPER(TRIM(code))` / `LOWER(TRIM(name))`, `HAVING COUNT(*)>1` |
| `POST /api/pricebook/merge` and `POST /api/pricebook/merge/{logId}/undo` | **ST + DB** `pricebook_merge_log` |
| `GET /api/pricebook/merge/log?limit=50` | **DB** |
| `GET /api/pricebook/rename/candidates?limit=25&includeReviewed=` | **DB** `pricebook_index` (Materials, active, unreviewed), ranked by `crypticScore()` |
| `POST /api/pricebook/rename/suggest` | **DB + ST + AI** |
| `POST /api/pricebook/rename/apply` / `/skip` | **ST PATCH + DB** `pricebook_rename_log` |
| `GET /api/pricebook/rename/recent?limit=25` | **DB** |
| `GET /api/pricebook/image-proxy?stId&skuType&t=` (as `<img src>`) | **ST** — **on failure returns HTTP 200 with a 1×1 transparent PNG**, so the `onerror` fallback never fires and a broken image shows as a blank square |

Uncalled by the page: `POST /index/rematch`, `GET /image-check`, `POST /ensure-image`, `GET /image-log`, `POST /image-test`, `GET /image-upload-inspect`.

**Empty state:** all graceful. `Indexed: 0 services · 0 materials · 0 equipment` + *"Never synced — click Refresh"*; *"✓ Queue empty — no cryptic material names left to review."* + *"🎉 Nothing left to rename."*; *"No renames yet."*; *"No scope-to-estimate runs yet."*; *"Click Refresh to scan the pricebook."* → *"✓ No code duplicates found for this scope."*; *"No merges yet."*; *"Type a keyword above to search live ServiceTitan pricing."* All five on-load fetches are pure SQLite reads, so an empty DB with no ST still renders cleanly.

**Upload:** `#scope-file`, `accept="application/pdf,image/png,image/jpeg"` (inside the collapsed legacy section). FormData **`scopeFile`** (+ optional `jobNumber`). Multer **diskStorage** → `SCOPE_UPLOAD_TMP || /tmp/scope-uploads`, **25 MB**. `pdftoppm -png -r 180 -f 1 -l 5` → OpenAI vision → matcher. No artifacts served back.

---

## 16. `pdf-parser.html` — PDF Parser (`/pdf-parser`)

**Zero SQLite.**

| Endpoint | Source |
|---|---|
| `POST /api/pdf-parser/parse` | **FILE + local binaries + AI** — `pdftoppm -jpeg quality=85 -r 200` → `page-NN.jpg`, **Tesseract** OCR per page → `ocr-text.txt`, `zip -j` bundle. All under `WORK_ROOT = PDF_PARSER_TMP \|\| <os.tmpdir()>/pdf-parser/<id>/`, `id = <Date.now()>-<hex8>`. Then OpenAI bullets with a **deterministic sentence-split fallback** when the key is missing. |
| `GET /api/pdf-parser/file/:id/:name` | **FILE** — validated against an in-memory `RESULTS` Map (1-hour TTL, disk swept every 10 min); path-guarded by `safeName()` + a `startsWith(WORK_ROOT/id)` check |
| `GET /api/pdf-parser/zip/:id` | **FILE** — `res.download` |
| `POST /api/pdf-parser/attach` | **ST write** — `createJobAttachment` per selected page JPG |
| `POST /api/pdf-parser/add-summary` | **ST write** — `appendJobSummary` with a `── Special Installation Instructions (added MM/DD/YYYY by <user>) ──` block |

**Empty state:** irrelevant — nothing fetches until a PDF is uploaded and the results wrapper is `display:none`. Expired result id → 410 *"These files have expired — please re-upload the ticket."*

**Upload:** `#jt-file-input`, `accept=".pdf,application/pdf"` — **PDF only**. FormData **`pdfFile`**. Multer **diskStorage** → `PDF_PARSER_UPLOAD_TMP || /tmp/pdf-parser-uploads`, **60 MB** (over-limit returns a clean 400 *"That PDF is too large (max 60 MB)."*). Source PDF always unlinked in `finally`. Artifacts (`page-01.jpg…`, `ocr-text.txt`, `<base>-extracted.zip`) are served back from `WORK_ROOT/<id>/`.

---

## 17. `contract-compare.html` — Contract Compare (`/contract-compare`)

| Endpoint | Source |
|---|---|
| `POST /api/contracts/compare` | **Pure in-request computation.** No SQLite, no ServiceTitan, no OpenAI, no disk. `pdf-parse` for PDF, `mammoth.extractRawText` for DOCX, UTF-8 for text; then normalize → split paragraphs → tag sections → `diffArrays`/`diffWordsWithSpace`. |

**Empty state:** *"Drop two files (or paste two passages) to compare"*; zero diffs → *"No changes between the two contracts."*; failures → *"Compare failed: <msg>"*. **Entirely unaffected by an empty database or a dead ST connection.**

**Upload:** two inputs `#cc-file-old` / `#cc-file-new`, `accept=".pdf,.docx,.txt,.md,…"`, both drag-drop. FormData fields **`oldFile`/`newFile`** (files) **or** **`oldText`/`newText`** (pasted); sides can mix. Multer **`memoryStorage()` — nothing hits disk** (deliberate; contracts are sensitive), **25 MB per file** (413 on over-limit).

---

## 18. `paymentInvoices.html` — Payment Invoices (`/payment-invoices`)

| Endpoint | Source |
|---|---|
| `GET /api/payment-invoices/lookup?paymentId=` | **ST** — `getPayment` + `getInvoicesByIds` |
| `GET /api/payment-invoices/download?paymentId=` | **ST → PDFKit** (in memory) |
| `GET /api/payment-invoices/download-zip?paymentId=` | **ST → PDFKit + JSZip** (in memory) |
| `GET /api/payment-invoices/download-one?paymentId=&invoiceId=` | same |

**100% live ServiceTitan, zero SQLite, zero disk.** ST exposes no branded invoice PDF, so the PDFs are rendered here with PDFKit and streamed as Buffers.

**Empty state:** result block hidden until a lookup succeeds. Non-numeric → *"Enter a numeric payment ID."*; unknown payment → 404 *"Payment <id> was not found in ServiceTitan."*; payment with no applied invoices → *"No invoices are applied to this payment."* with both download buttons disabled.

**Uploads:** none.

---

## 19. `backflow.html` — Backflow Report (`/backflow`)

| Endpoint | Source |
|---|---|
| `GET /api/backflow/list?from=YYYY-MM-DD&to=YYYY-MM-DD` | **ST only** — resolves backflow job type ids (1-hour in-proc cache), pages jobs by `completedOnOrAfter`/`completedBefore`/`jobTypeIds` (up to 100 pages) with a defensive client-side re-filter, then per job at concurrency 2: appointments, invoices, timesheets, customer — each individually retried 4× with backoff |
| `GET /api/backflow/list.csv?from=&to=` | same, rendered as a 12-column CSV attachment |

`GET /api/backflow/job-type` exists but is never called.

**The page auto-runs the report on load** with a month-to-date default range. Range is capped at 366 days (400 otherwise).

**Empty state:** no matching job type or zero rows → *"No backflow jobs in this range."* with **all-zero KPIs**. **But if ST is down**, the catch renders *"Failed to load: <msg>"*, sets the source to `Error`, and **leaves the KPI row blank rather than zeroed** — a dead ST connection reads as an error, not an empty state. Partial ST failures append *"⚠ N ServiceTitan calls failed (rate-limited or down) — some rows may be incomplete"*.

**Uploads:** none. There is **no local seed path** for this page whatsoever.

---

## 20. `equipment.html` — Equipment Registration (`/equipment`)

Tabs are generated from `src/config/equipmentTypes.js`:

| id | `apiBase` | `inputMode` | ProPortal |
|---|---|---|---|
| `american-standard-hvac` | `american-standard` | `pdf` | no |
| `bradford-white-water-heater` | `bradford-white` | `image` | no |
| `rinnai-sensei-tankless` | *(null — uses generic routes)* | `form` | **yes** |

**Shared endpoints (all tabs):**

| Endpoint | Source |
|---|---|
| `GET /api/equipment/types` | in-memory config |
| `GET /api/equipment/customers?q=` | **ST** — `getCustomer` / `searchCustomersByName` / `searchLocationsByAddress` |
| `GET /api/equipment/locations?customerId=` | **ST** |
| `GET /api/equipment/recent?limit=15` | **DB** `installed_equipment_registrations` (client filters by exact `equipment_type_id`) |

**Rinnai tab (hard-coded paths):**

| Endpoint | Source |
|---|---|
| `POST /api/equipment/decode-serial` | pure local (`rinnaiSerial.decodeRinnaiSerial`) |
| `POST /api/equipment/preview` | **ST + DB** — contacts/location/installed equipment + `repo.findBySerial` dup check |
| `POST /api/equipment/submit` | **ST write + DB insert** |
| `GET /api/equipment/proportal/pending?typeId=rinnai-sensei-tankless` | **DB** |
| `POST /api/equipment/proportal/export` | **DB** — builds the CSV, sets `proportal_exported=1` |

**Dynamic `apiBase` paths — the full real set (2 × 5):**
```
POST /api/equipment/american-standard/parse        (multipart)
POST /api/equipment/american-standard/preview      (json)
POST /api/equipment/american-standard/submit       (json)
GET  /api/equipment/american-standard/job-lookup?jobNumber=
POST /api/equipment/american-standard/attach-pdf   (multipart)
POST /api/equipment/bradford-white/parse           (multipart)
POST /api/equipment/bradford-white/preview         (json)
POST /api/equipment/bradford-white/submit          (json)
GET  /api/equipment/bradford-white/job-lookup?jobNumber=
POST /api/equipment/bradford-white/attach-pdf      (multipart)
```
`parse` = uploaded file only. `preview` = **ST + DB** dup check. `submit` = **ST write + DB insert** per unit (American Standard may additionally create a membership or drop an ST customer note). `job-lookup` = **ST**. `attach-pdf` = **ST write**.
`GET /api/equipment/american-standard/jobs` exists but no page JS calls it.

**Empty state:** *"No equipment types configured."*; ProPortal queue `0`; recent list *"Nothing yet."*; preview panel default *"Fill in the details and hit Preview."* **A dead ST connection on customer search looks like "no data", not an error** — `searchCustomers` catches and returns `[]` → *"No matching customers."* `/locations` is *not* caught → 500 → the page renders *"No active locations for this customer."* A failed ST write on submit still returns HTTP 200 with `ok:false` and **still persists the row** → *"Saved for ProPortal, but the ServiceTitan write failed: …"*

**Uploads — one per PDF/image tab (`#as-file-<typeId>`):**

| Tab | `accept` | Field | Endpoints | Multer |
|---|---|---|---|---|
| American Standard | `application/pdf` | **`warrantyPdf`** | `…/american-standard/parse`, `…/attach-pdf` | `memoryStorage`, 15 MB, PDF only |
| Bradford White | `image/*,application/pdf` | **`warrantyPdf`** (same name) | `…/bradford-white/parse`, `…/attach-pdf` | `memoryStorage`, 15 MB, image or PDF |

- **AS parse** → `pdf-parse` with a custom `pagerender` that rebuilds x/y reading order → `{warrantyNumber, customer, dealer, units[]}`. Install date is derived: `install = coverageEnd − termYears`. Serial decoded Trane-style (chars 1–2 = year, 3–4 = week). No writes.
- **BW parse** → buffer written to `os.tmpdir()`, PDF→PNG via `pdftoppm`, then **OpenAI Vision** with a strict-JSON prompt (serial, model, type, mfgDate, tank/parts years + expiries, registration status). **Hard 500 if `OPENAI_API_KEY` is unset.** Temp file unlinked in `finally`.
- **submit** → `st.createInstalledEquipment` per unit + `repo.recordRegistration` per unit. AS adds a 5-year `serviceProviderWarrantyStart/End` when `applyLaborWarranty` **and** ≥ 2 units, and a free FAN Club membership (default path writes an ST customer note; a real membership only when `ST_ENABLE_MEMBERSHIP_CREATE=true`).
- **attach-pdf** → `st.createJobAttachment` with filename `AmericanStandard_Warranty_<warrantyNumber|date>.pdf` or `BradfordWhite_Registration_<date>.<ext>`.
- **Rinnai ProPortal CSV is not an upload** — it's generated server-side from `proportal_row` and downloaded client-side as a Blob named `RinnaiProPortal_<today>.csv`.

---

## 21. `install-tracker.html` — Install Tracker (`/install-tracker`)

| Endpoint | Source |
|---|---|
| `GET /api/install-tracker/list?from=&to=&status=all` (auto-runs on load, last 90 days) | **ST + DB overlay** — pages ST jobs with `jobStatus=Completed`, `completedOnOrAfter/Before`, `jobTypeIds=1232,1227,1229,1233,1234,1216,1208`, then `getCustomer` per unique customer (concurrency 4, 429/5xx retry), then overlays `install_tracker` by `st_job_id` |
| `GET /api/install-tracker/list.csv?from=&to=&status=` (anchor href) | same |
| `POST /api/install-tracker/status` `{jobId, field, value, snapshot}` | **DB** `install_tracker` (row created lazily by `ensureRow`) |
| `POST /api/install-tracker/notes` `{jobId, notes, snapshot}` | **DB** |

`GET /api/install-tracker/job-types` exists but is not called.

**Empty state:** ST reachable but no jobs → KPI cards `0` and *"No installs match the current filters."* ST unreachable → 500 → *"Failed to load: …"* with the source label *"Error"*. Bad date range → 400 (*"Both `from` and `to` (YYYY-MM-DD) are required."*, *"Date range too large (N days). Keep it ≤ 366 days."*).

**Uploads:** none.

**Pure overlay:** seeded `install_tracker` rows are **invisible** unless the matching ST job comes back from the live query.

---

## 22. `address.html` — Address Audit (`/address`)

| Endpoint | Source |
|---|---|
| `GET /api/address/health` (on load) | env check `!!GOOGLE_MAPS_API_KEY` |
| `GET /api/address/cache-stats` (on load + after actions) | **DB** `address_audit_cache` |
| `POST /api/address/reclassify` | **DB only** — re-runs `classify()` over cached `original_json`/`verified_json`, zero Google calls |
| `POST /api/address/clear-cache` | **DB** `DELETE FROM address_audit_cache` |
| `GET /api/address/find-issues?count=&maxScan=&startPage=&modifiedOnOrAfter=` | **ST + GOOG + DB** — pages ST locations (`pageSize ≤ 200`, `active=true`), then `verifyPageOfLocations` at concurrency 5: fingerprint match → cache hit (no Google call); miss/drift → Google Geocoding → `upsertCacheRow` |
| `POST /api/address/verify` | **GOOG only** — no ST, no cache write |
| `POST /api/address/apply` | **ST PATCH** (falls back to PUT on 404/405) + cache `markApplied` |
| `POST /api/address/dismiss` | **DB** `dismissed_at` |

`GET /api/address/audit` is implemented but never called by this page.

**Empty state:** no `GOOGLE_MAPS_API_KEY` → banner *"Heads up — GOOGLE_MAPS_API_KEY isn't set on the server…"* and 503 on `/find-issues`, `/audit`, `/verify`. Empty cache → the stats strip is simply hidden. Clean scan → *"Scanned N addresses and didn't find any issues — clean batch!"*; filter mismatch → *"No rows match this filter. N issues total — try \"All found\"."*; failure → *"Failed to load: <msg>"*. `runFind()` is gated behind a `confirm()` quota warning.

**Uploads:** none.

**Pure overlay:** a seeded cache row only appears if that ST location is returned by the live walk, and only counts as a *hit* if `address_fingerprint` matches the current ST address exactly.

---

## 23. `timesheet.html` — Timesheet (`/timesheet`)

**100% SQLite. No ServiceTitan anywhere.** The employee is always `req.session.userId` — no user id is ever accepted from the client.

| Endpoint | Tables |
|---|---|
| `GET /api/timesheet/summary` | `users`, `timesheet_balances` (row created lazily) |
| `GET /api/timesheet/periods` | `timesheets` |
| `POST /api/timesheet/draft` | `timesheets` (upsert on `user_id + period_start`) |
| `POST /api/timesheet/:id/process` | `timesheets` + `timesheet_balances` (one transaction) |
| `POST /api/timesheet/:id/reopen` | same |
| `DELETE /api/timesheet/:id` | `timesheets` |
| `GET /api/timesheet/clock?periodStart=` | `time_punches` |
| `POST /api/timesheet/clock/in` `{at, workDate, note}` | `time_punches` |
| `POST /api/timesheet/clock/out` `{at}` | `time_punches` + `timesheets` (auto-fills the Regular cell) |
| `POST /api/timesheet/clock/break/start` \| `/break/end` `{at}` | `time_punches` |
| `POST /api/timesheet/clock/adjust` `{clockIn, note}` | `time_punches` |
| `POST /api/timesheet/clock/manual` `{workDate, clockIn, clockOut, breakSeconds, note}` | `time_punches` + `timesheets` |

**Empty state:** fully graceful and fully seedable — balances lazily create as `comp: 0, plaw: 0`; *"No periods yet."*; *"Not clocked in"* / *"Clock in to start tracking today's hours."* Ordering guards return 400 with messages like *"Process the earlier period (2026-07-08) first — weeks must be processed oldest-first…"*

**Uploads:** none.

---

## 24. `timesheet-tap.html` — NFC quick clock (`/timesheet/tap`)

Subset of the same SQLite endpoints: `GET /api/timesheet/summary`, `GET /api/timesheet/clock`, `POST /api/timesheet/clock/in`, `/clock/out`, `/clock/break/start`, `/clock/break/end`. Sends `{at: ISO, workDate: local YYYY-MM-DD}`.

**Empty state:** *"Not clocked in"* / *"Ready"* / *"Tap to start today's shift."* **On HTTP 401 it redirects to `/login?next=<path>`** rather than showing an error. Clocking out into a processed week → *"<h> h recorded, but that week is processed — reopen it to include these hours."*

**Uploads:** none.

---

## 25. `users.html` — User Admin (`/users`, admin-only)

**100% SQLite `users`.** The whole router is behind `requireAdmin`, which re-reads `is_admin` from the DB on every request; the page route itself redirects non-admins to `/`.

`GET /api/users` · `POST /api/users` `{email, firstName, lastName, password}` · `PATCH /api/users/:id` `{firstName,lastName}` or `{isAdmin}` · `POST /api/users/:id/reset-password` `{newPassword}` · `POST /api/users/:id/deactivate` · `POST /api/users/:id/activate` · `DELETE /api/users/:id`

**Empty state:** *"Loading users…"* → *"No users yet."* (unreachable in practice — you must be a logged-in admin to see the page). Guard rails return 400: *"you can't deactivate your own account"*, *"can't deactivate the last active account"*, *"can't delete the last user"*, *"can't remove the last active admin"*, *"you can't demote your own admin access — ask another admin to do it"*. Duplicate email → 409.

**Uploads:** none.

---

## 26. `login.html` — Login (`/login`, auth-exempt)

`POST /login` `{email, password}` → **DB** `users`, bcrypt cost 12 with a constant-time dummy-hash compare. In-memory per-IP throttle: 8 failures / 15 min → 429 *"too many attempts — try again in N minute(s)"*. The session is regenerated on success and redirects to `/change-password?forced=1` when `must_change_pw`, else to `?next=` or `/`. Errors: *"invalid email or password"*, *"email and password are required"*.

**Uploads:** none.

---

## 27. `change-password.html` — Change Password (`/change-password`)

`POST /api/auth/change-password` `{currentPassword, newPassword}` → **DB** `users`; sets a new bcrypt hash and clears `must_change_pw`. Errors: 401 *"not logged in"* / *"current password is incorrect"*, 400 *"new password must be at least 8 characters"*.

**Uploads:** none.

---

# Part 3 — Cross-cutting notes for the seeder

## Pages by seedability

**Fully seedable from SQLite alone (no ServiceTitan needed):**
`/calls` (list view), `/videos`, `/fleet`, `/resolved-jobs`, `/timesheet`, `/timesheet/tap`, `/users`, `/login`, `/change-password`, the pricebook rename / duplicates / merge / recent panels, the invoices "Recent Imports" panel, and the equipment "Recent" + ProPortal-queue panels.

**Seedable from `data/monthly-cache/` JSON files:**

**Not seedable without a mock ServiceTitan / GoHighLevel:**
`/memberships` (100% ST+GHL), `/reviews` (beyond the pause flag), `/backflow` (100% ST), `/payment-invoices` (100% ST), `/scoreboard` (live-first), `/customer-review` (search + job list are live), `/install-tracker` (row list is live; SQLite is only an overlay), `/address` (row list is live ST + Google), `/equipment` customer/location pickers, `/monthly-review`'s "current month" tiles, and the dashboard's memberships / construction / utilization counts.

**Cannot be seeded at all (process memory):**

## Upload inventory

| Page | Input accept | FormData field | Endpoint | Multer | Limit |
|---|---|---|---|---|---|
| `/calls` | `audio/*,.mp3,.m4a,.wav,.ogg,.webm,.aac,.flac` | `recording` | `POST /api/calls/upload` | disk → `/tmp/recordings` | 25 MB |
| `/videos` | `video/*,.mp4,.mov,…` | `videoFile` | `POST /api/videos/upload` | disk → `/tmp/video-uploads` | 500 MB |
| `/fleet` | `.csv` | `tripFile` | `POST /api/fleet/process` | memory | 10 MB |
| `/fleet` | `.xlsx,.xls` | `timesheetFile` | `POST /api/fleet/process` | memory | 10 MB |
| `/fleet` | `.xlsx,.xls` | `file` | `POST /api/fleet/addresses/import` | memory | 10 MB |
| `/invoices` | `.pdf,.png,.jpg,.jpeg,.webp` | `invoiceFile` | `POST /api/invoices/parse` | disk → `/tmp/invoice-uploads` | 25 MB |
| `/pricebook` | `application/pdf,image/png,image/jpeg` | `scopeFile` | `POST /api/pricebook/parse-scope` | disk → `/tmp/scope-uploads` | 25 MB |
| `/pdf-parser` | `.pdf` only | `pdfFile` | `POST /api/pdf-parser/parse` | disk → `/tmp/pdf-parser-uploads` | 60 MB |
| `/contract-compare` | `.pdf,.docx,.txt,.md` ×2 | `oldFile` / `newFile` | `POST /api/contracts/compare` | **memory (never disk)** | 25 MB each |
| `/equipment` (AS) | `application/pdf` | `warrantyPdf` | `…/american-standard/parse`, `…/attach-pdf` | memory | 15 MB |
| `/equipment` (BW) | `image/*,application/pdf` | `warrantyPdf` | `…/bradford-white/parse`, `…/attach-pdf` | memory | 15 MB |

## Environment / binary dependencies that gate whole pages

| Requirement | Gates |
|---|---|
| `OPENAI_API_KEY` | call transcription + classification, invoice parse, scope parse, pricebook LLM tie-breaker, rename suggest, Bradford White OCR (hard 500). Only the PDF-parser bullets degrade gracefully. |
| `GOOGLE_MAPS_API_KEY` | `/address` — 503 on every verify endpoint without it |
| ST OAuth creds + `ST_TENANT_ID` + `ST_APP_KEY` | every **ST**-marked endpoint above |
| `GHL_HAPPY_REVIEW_WEBHOOK_URL`, `GHL_MEMBERSHIP_WEBHOOK_URL` | `/reviews`, `/memberships` pushes |
| `pdftoppm` (poppler-utils) | invoice parse, scope parse, PDF parser, Bradford White PDF input |
| `tesseract` | PDF-parser OCR |
| `zip` | PDF-parser bundle download (`/parse` still succeeds without it) |
| `SESSION_SECRET` | falls back to a dev value with a loud warning; sessions won't survive a restart |
| `DB_PATH=/data/calls.db` | Railway persistence — wrong value means the DB resets every deploy |
