# MOCK_SPEC_DATABASE.md — SQLite schema reference for seeding

Source of truth: `src/db/index.js` (`initSchema()`, called once at boot from `src/index.js:21`)
plus four tables created ad-hoc outside that file (noted below).

- **Engine:** `better-sqlite3`, WAL mode, `foreign_keys = ON` (no actual FK constraints are declared — every "FK" below is by convention only).
- **File:** `process.env.DB_PATH`, default `/tmp/calls.db`, production `/data/calls.db` (Railway volume `serviceops-data`).
- **Sessions live in a *separate* file:** `sessions.sqlite` in `path.dirname(DB_PATH)`, table `sessions`, managed by `connect-sqlite3`. Never seed it.
- **Timestamp convention:** almost every `created_at` / `updated_at` defaults to SQLite `datetime('now')`, i.e. **UTC, `YYYY-MM-DD HH:MM:SS`, space separator, no `Z`**. Several front-ends do `str.replace(" ","T") + "Z"` before `new Date()`. Seed in this exact format or timestamps render as `Invalid Date`.
- **Booleans are INTEGER 0/1.**
- **Migrations are `try { ALTER TABLE … } catch {}`** — idempotent, run on every boot. Columns added this way are listed inline below and marked *(migration)*.

---

## Table inventory at a glance

| # | Table | Business meaning | Populated by |
|---|---|---|---|
| 1 | `processed_calls` | Every inbound ServiceTitan phone call, transcribed + AI-classified | **Poller** (`callPollService`) + **queue worker** + **user** (upload, edits) |
| 2 | `processed_happy_reviews` | Dedupe ledger for Happy Review form submissions pushed to GoHighLevel | **Poller** (`formsPollService`) |
| 3 | `installed_equipment_registrations` | One row per equipment unit registered on the Equipment page | **User action** |
| 4 | `employee_phones` | Roster of employee phone numbers, used to skip customer lookup on internal calls | **Seed file** `data/employee-roster.json` at boot |
| 5 | `video_uploads` | Log of job videos pushed to YouTube | **User action** |
| 6 | `fleet_technicians` | Truck number → technician name map | **User action** + `/api/fleet/seed` (auto-fires on page load) |
| 7 | `known_addresses` | Labeled addresses seen in fleet GPS trip reports | **User action** (trip CSV / xlsx import) |
| 8 | `invoice_uploads` | Audit log of supplier invoices turned into ServiceTitan POs | **User action** |
| 9 | `pricebook_index` | Local mirror of the ServiceTitan pricebook for fuzzy matching | **Cron 3 AM** + on-demand refresh |
| 10 | `pricebook_sync_log` | One row per pricebook sync run | **Cron 3 AM** + on-demand |
| 11 | `scope_estimate_uploads` | Audit log of estimates created from parsed scope-of-work docs | **User action** |
| 12 | `pricebook_merge_log` | Audit + undo breadcrumb for duplicate-SKU merges | **User action** |
| 13 | `pricebook_rename_log` | Audit + undo for the material rename queue | **User action** |
| 14 | `pricebook_image_log` | Audit of pricebook image fetch/generation attempts | **User action** (no page currently reads it) |
| 15 | `users` | Dashboard login accounts | **Boot seed** (`FIRST_USER_*`) + **admin action** |
| 16 | `address_audit_cache` | Per-ST-location address verification results from Google Geocoding | **User action** (scan button) |
| 17 | `job_review_status` | Office review state + corrections for flagged open jobs | **User action** |
| 18 | `job_review_notes` | Append-only note log per job, each with its own ST sync state | **User action** |
| 19 | `timesheets` | Weekly (Wed→Tue) employee hour grids | **User action** |
| 20 | `timesheet_balances` | Per-employee Comp Time + P-Law running balances | **User action** (lazily created on first read) |
| 21 | `time_punches` | Live clock-in/clock-out punches | **User action** |
| 22 | `app_settings` | Editable key/value app config (AI prompts) | **User action** |
| 23 | `install_tracker` | Manual overlay on live ST install jobs (equipment listed / warranty registered) | **User action** |
| 24 | `kv_store` *(ad-hoc)* | Poller cursors + pause flags + review watermark | **Pollers** + **user action** |
| 25 | `processed_return_visits` *(ad-hoc)* | Dedupe ledger for return-visit GHL enrollments | **Cron 6 AM** |

Tables created **outside** `initSchema()`:
- `kv_store` — created identically in four places: `src/db/callRepository.js:463`, `src/routes/forms.js:11`, `src/services/callPollService.js:56`, `src/services/formsPollService.js:36`.
- `processed_return_visits` — `src/services/returnVisitService.js:11` (`ensureReturnVisitTable()`).

---

## 1. `processed_calls`

Every inbound call the poller pulls from ServiceTitan `telecom/v2/…/calls`, plus manually uploaded recordings. Drives `/calls` and the dashboard hero counter.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `service_titan_call_id` | TEXT **NOT NULL UNIQUE** | ST call id; uploaded recordings use a synthetic `upload-…` id |
| `caller_phone_number` | TEXT | |
| `timestamp` | TEXT | ISO-8601 call timestamp |
| `raw_webhook_payload` | TEXT | **JSON** — original ST payload (see shapes below) |
| `transcript` | TEXT | |
| `transcript_metadata` | TEXT | **JSON** (see shapes below) |
| `summary` | TEXT | legacy single-paragraph AI recap |
| `category` | TEXT | AI-detected category |
| `sentiment` | TEXT | |
| `is_spam` | INTEGER DEFAULT 0 | 1 suppresses the "Post to ServiceTitan" button |
| `is_job_related` | INTEGER DEFAULT 0 | |
| `confidence` | REAL DEFAULT 0 | |
| `recommended_action` | TEXT | |
| `classification_model` | TEXT | e.g. `gpt-4o` |
| `matched_customer_id` | INTEGER | ST customer id |
| `matched_customer_name` | TEXT | |
| `matched_job_id` | INTEGER | ST internal job id |
| `matched_job_number` | TEXT | human-readable job number |
| `match_confidence` | REAL DEFAULT 0 | |
| `match_method` | TEXT | e.g. `phone_exact`, `employee_call` |
| `status` | TEXT DEFAULT `'pending'` | **`pending` \| `processing` \| `completed` \| `failed`** — only `completed` renders bullets/sentiment/Post button; `processing` triggers a 3-second client poll loop (30 attempts) |
| `error_message` | TEXT | |
| `processing_attempts` | INTEGER DEFAULT 0 | |
| `created_at` | TEXT DEFAULT `datetime('now')` | |
| `updated_at` | TEXT DEFAULT `datetime('now')` | |
| `notes_applied_at` | TEXT *(migration v2)* | non-null → card shows `✓ Posted to ServiceTitan → Job #…` |
| `manual_category` | TEXT *(v2)* | user override of the AI category |
| `call_reason` | TEXT *(v3)* | ST "why wasn't it booked" reason |
| `dismissed_at` | TEXT *(v3)* | non-null hides from the review queue |
| `call_type` | TEXT *(v4)* | validated enum: **`Excused` \| `Unbooked` \| `NotLead` \| `Booked` \| `Abandoned`** |
| `summary_bullets` | TEXT *(v10)* | **JSON array** of 3–4 strings; NULL falls back to sentence-splitting `summary` |
| `source` | TEXT DEFAULT `'polled'` *(v10)* | `polled` \| `upload` \| `webhook` |
| `applied_job_id` | INTEGER *(v11)* | |
| `applied_job_number` | TEXT *(v11)* | |
| `applied_customer_id` | INTEGER *(v11)* | |
| `candidate_jobs` | TEXT *(v12)* | **JSON array** of out-of-window jobs for manual review |
| `classification_synced_at` | TEXT *(v13)* | |
| `classification_synced_type` | TEXT *(v13)* | what callType was pushed to ST |
| `internal_employee` | TEXT *(v18)* | **JSON object** — renders the `🏢 Employee call` badge |

**Indexes:** `idx_processed_calls_st_id (service_titan_call_id)`, `idx_processed_calls_phone (caller_phone_number)`, `idx_processed_calls_status (status)`, `idx_processed_calls_created_at (created_at DESC)`.

### JSON blob shapes

`transcript_metadata` (from `transcriptionService`):
```json
{ "provider": "openai-whisper-1", "model": "whisper-1", "promptLength": 412,
  "companyNameFixupApplied": true, "duration": 183 }
```
Stub provider writes `{ "provider": "stub" }`.

`raw_webhook_payload` — the ST telecom call object. The only field the UI reads is
`leadCall.duration`, a `"HH:MM:SS"` or `"MM:SS"` string:
```json
{ "leadCall": { "id": 998877, "duration": "00:03:12", "from": "6145550177",
                "receivedOn": "2026-07-14T15:02:11Z" } }
```

`summary_bullets`:
```json
["Customer's furnace is short-cycling.", "Wants a tech out Thursday morning.",
 "Confirmed they're a FAN Club member."]
```

`candidate_jobs` (from `matchingService.summarizeCandidateJob`):
```json
[{ "jobId": 188234, "jobNumber": "2603162", "status": "Completed",
   "summary": "7-9 NO HEAT", "relevanceDate": "2026-06-02T00:00:00Z", "ageDays": 42 }]
```

`internal_employee` (from `matchingService`):
```json
{ "name": "Wes Calloway", "trade": "Plumbing", "extension": "214",
  "truckNumber": "57", "phoneType": "company" }
```

Parsing is forgiving: `safeParseJson()` (`callRepository.js:450`) returns the raw string on a parse error rather than throwing.

### Seeding gotchas
- **The `/calls` page hides any card whose duration is known and ≤ 30 seconds** (hang-ups/misdials). Either leave both `transcript_metadata` and `raw_webhook_payload` NULL, or set `transcript_metadata` to `{"duration":180}`.
- `service_titan_call_id` is TEXT and UNIQUE.
- The dashboard hero counts `WHERE is_spam = 0 AND dismissed_at IS NULL AND created_at > kv_store['calls_last_reviewed_at']`. Delete that kv key or the count is 0. (Note: opening `/calls` immediately re-stamps it.)

---

## 2. `processed_happy_reviews`

Dedupe ledger only — nothing renders from it. A seeded row causes that submission to be **skipped**, not shown.

| Column | Type |
|---|---|
| `id` | INTEGER PK AUTOINCREMENT |
| `submission_id` | TEXT NOT NULL UNIQUE |
| `customer_name` | TEXT |
| `job_number` | TEXT |
| `processed_at` | TEXT DEFAULT `datetime('now')` |

**Index:** `idx_phr_submission_id (submission_id)`. **Populated by:** the forms poller and `POST /api/forms/process-happy-reviews`.

---

## 3. `installed_equipment_registrations`

One row per unit registered on `/equipment`. Backs both the ServiceTitan Installed Equipment write and the Rinnai ProPortal CSV export.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `equipment_type_id` | TEXT NOT NULL | must be exactly `american-standard-hvac`, `bradford-white-water-heater`, or `rinnai-sensei-tankless` (client filters by exact string) |
| `st_installed_equipment_id` | INTEGER | NULL if the ST write failed |
| `st_customer_id` | INTEGER | |
| `st_customer_name` | TEXT | shown in the Recent table |
| `st_location_id` | INTEGER | |
| `location_address` | TEXT | formatted, display only |
| `model` | TEXT | |
| `serial_number` | TEXT | dedupe key for ProPortal export (uppercased, latest wins) |
| `installed_on` | TEXT | `YYYY-MM-DD` |
| `manufacture_date` | TEXT | `YYYY-MM-01`, decoded from serial |
| `warranty_start` | TEXT | `YYYY-MM-DD` |
| `warranty_end` | TEXT | `YYYY-MM-DD` |
| `form_data` | TEXT | **JSON** of the submitted form |
| `proportal_row` | TEXT | **JSON** keyed by the 17 exact ProPortal header strings |
| `proportal_exported` | INTEGER DEFAULT 0 | |
| `proportal_exported_at` | TEXT | |
| `st_write_status` | TEXT DEFAULT `'created'` | `created` \| `failed` \| `skipped`; `created` renders `✓ #id`, anything else `✗ failed` |
| `st_error` | TEXT | |
| `created_by` | TEXT | dashboard user email |
| `created_at` | TEXT DEFAULT `datetime('now')` | |

**Indexes:** `idx_ier_serial (serial_number)`, `idx_ier_location (st_location_id)`, `idx_ier_proportal (proportal_exported)`, `idx_ier_created_at (created_at DESC)`.

### `proportal_row` JSON shape
Keys are the literal column headers from `src/config/equipmentTypes.js` → `rinnaiSenseiTankless.proPortal.columns`. Any key mismatch produces a blank CSV cell:
```json
{ "First Name": "Dana", "Last Name": "Whitfield", "Email": "dana@example.com",
  "Company Name": "", "Phone": "6145550142",
  "Unit Address (Street)": "938 Orchard Pl", "Unit Address (City)": "Cedar Hollow",
  "Unit Address (State/Province)": "OH", "Unit Address (ZIP/Postal Code)": "43065",
  "Unit Address (Country/Territory)": "US",
  "Serial Number": "TL.2409.0034521", "Application Type": "Residential",
  "Recirculation Type": "None", "Registration Type": "Standard",
  "Fuel Type": "Natural Gas",
  "Registration Date": "2026-07-14", "Installation Date": "2026-07-10" }
```

The ProPortal "queued" counter requires **all three**: `proportal_exported = 0` **AND** `proportal_row IS NOT NULL` **AND** `equipment_type_id = 'rinnai-sensei-tankless'`.

---

## 4. `employee_phones`

Roster used by `matchingService` to short-circuit calls placed from employee numbers.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `phone_number` | TEXT NOT NULL UNIQUE | **10-digit normalized, digits only** (leading `1` stripped) |
| `employee_name` | TEXT NOT NULL | |
| `trade` | TEXT | |
| `extension` | TEXT | |
| `truck_number` | TEXT | stored as a string |
| `phone_type` | TEXT | `personal` \| `company` \| `mobile` \| `facility` |
| `active` | INTEGER DEFAULT 1 | |
| `source` | TEXT DEFAULT `'roster'` | `roster` \| `manual` \| `auto` |
| `created_at` / `updated_at` | TEXT DEFAULT `datetime('now')` | |

**Index:** `idx_employee_phones_active (active)`.

**Populated at boot** by `seedEmployeePhonesIfEmpty()` (`src/index.js:28`) from `data/employee-roster.json` — **only if the table is empty**. That file does **not** exist in the repo (gitignored / operator-supplied). Its shape:
```json
{ "entries": [
  { "phoneNumber": "(614) 555-0142", "employeeName": "Wes Calloway",
    "trade": "Plumbing", "extension": "214", "truckNumber": 57, "phoneType": "company" }
]}
```
Rows without a normalizable phone or without `employeeName` are silently skipped.

---

## 5. `video_uploads`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `job_number` | TEXT | renders as `—` when null |
| `job_id` | TEXT | |
| `street_address` | TEXT | renders as `(no address)` when null |
| `youtube_video_id` | TEXT **NOT NULL** | |
| `youtube_url` | TEXT **NOT NULL** | |
| `created_at` | TEXT DEFAULT `datetime('now')` | |

**Indexes:** `idx_video_uploads_created_at (created_at DESC)`, `idx_video_uploads_job_number (job_number)`.

Note: rows are passed to the browser **as-is**, so the `/videos` page reads snake_case field names.

---

## 6. `fleet_technicians`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `truck_number` | TEXT NOT NULL UNIQUE | seed as a string (`"76"`) |
| `tech_name` | TEXT NOT NULL | |
| `group_name` | TEXT | |
| `active` | INTEGER DEFAULT 1 | must be 1 or the row is invisible; delete is a soft delete |
| `created_at` / `updated_at` | TEXT DEFAULT `datetime('now')` | |

No index beyond the UNIQUE constraint. `POST /api/fleet/seed` (fired automatically on every `/fleet` page load) inserts truck **12 = Marcus Ellery** and **21 = Wes Calloway**.

---

## 7. `known_addresses`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `address` | TEXT NOT NULL | as it appeared in the GPS trip report |
| `normalized` | TEXT NOT NULL | **must equal `normalizeAddr()` output** (`src/routes/fleet.js:22`): lowercase → `[,.]`→space → collapse whitespace → strip the word `usa` → trim. A mismatch silently breaks trip tagging. |
| `label` | TEXT DEFAULT `''` | human label ("Shop", "Ferguson Supply"); the "needs label" badge tests `!r.label` |
| `truck_number` | TEXT | |
| `sample_visit` | TEXT | |
| `created_at` / `updated_at` | TEXT DEFAULT `datetime('now')` | |

**Index:** `idx_known_addresses_normalized (normalized)`.

---

## 8. `invoice_uploads`

Audit log for the supplier-invoice → ServiceTitan PO importer. One row is written on **every** `POST /api/invoices/create-po`, success or failure.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `vendor` | TEXT | |
| `invoice_number` | TEXT | |
| `invoice_date` | TEXT | |
| `job_number` | TEXT | |
| `job_id` | TEXT | |
| `vendor_id` | TEXT | |
| `total` | REAL | |
| `po_id` | TEXT | |
| `po_number` | TEXT | |
| `status` | TEXT NOT NULL | **`created` renders the green ✓ pill; anything else renders `✗ failed`** |
| `error` | TEXT | |
| `file_name` | TEXT | |
| `created_at` | TEXT DEFAULT `datetime('now')` | |
| `attached` | INTEGER DEFAULT 0 *(v8)* | PDF attached to the PO — currently always 0 (ST API limitation) |
| `attach_error` | TEXT *(v8)* | |
| `sent` | INTEGER DEFAULT 0 *(v9)* | PO auto-marked Sent — currently always 0 |
| `sent_error` | TEXT *(v9)* | |

**Indexes:** `idx_invoice_uploads_created_at (created_at DESC)`, `idx_invoice_uploads_job_number (job_number)`.

---

## 9. `pricebook_index`

Local mirror of the ServiceTitan pricebook. The single most load-bearing seed table — it feeds invoice line matching, scope parsing, the duplicate finder, the rename queue, and a dashboard "needs attention" row.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `st_id` | INTEGER NOT NULL | ServiceTitan SKU id |
| `sku_type` | TEXT NOT NULL | exactly **`Service`** \| **`Material`** \| **`Equipment`** (singular, capitalized) |
| `name` | TEXT | |
| `code` | TEXT | |
| `description` | TEXT | |
| `price` | REAL | |
| `active` | INTEGER DEFAULT 1 | |
| `tokens` | TEXT | **space-joined lowercased tokens** — rows with an empty token set are invisible to `searchIndex` and to all fuzzy matching. Build from name+code+description: lowercase, punctuation→space, keep tokens ≥ 2 chars, dedupe. |
| `synced_at` | TEXT DEFAULT `datetime('now')` | |
| `renamed_at` | TEXT *(v17)* | |
| `rename_reviewed_at` | TEXT *(v17)* | |
| `image_path` | TEXT *(v18)* | ST storage path (`Images/…`) |
| `image_checked_at` | TEXT *(v18)* | |

**Constraints/indexes:** `UNIQUE(st_id, sku_type)`, `idx_pricebook_index_sku_type (sku_type)`, `idx_pricebook_index_active (active)`.

**Populated by:** the 3 AM cron (`pricebookIndexService.syncAll()`), `POST /api/pricebook/index/refresh`, `autoSyncIfStale(30)` fired lazily from invoice/scope parsing, and single-row upserts from `POST /api/invoices/add-to-pricebook`.

Seeding notes:
- The **rename queue** filters `sku_type='Material' AND active=1 AND renamed_at IS NULL AND rename_reviewed_at IS NULL`, then ranks by `crypticScore(name)` — a friendly name like `Copper Fitting` scores 0 and **never appears**. Seed cryptic names like `LF3412BRSMIPTEE` or `VLV ASM CMPRSR 3/4`.
- The **duplicate finder** needs ≥ 2 active rows sharing `UPPER(TRIM(code))` (or `LOWER(TRIM(name))`).

---

## 10. `pricebook_sync_log`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `started_at` | TEXT DEFAULT `datetime('now')` | |
| `finished_at` | TEXT | |
| `status` | TEXT NOT NULL | `running` \| `ok` \| `failed` |
| `services` / `materials` / `equipment` | INTEGER DEFAULT 0 | row counts |
| `error` | TEXT | |

**⚠ Seeding trap:** if there is no `status='ok'` row with a recent `finished_at`, `autoSyncIfStale(30)` fires a **full live ServiceTitan pricebook sync** on the first invoice-parse or scope-parse — which runs `upsertBatch` + `markStaleInactive`, setting `active = 0` on every seeded row ST doesn't return. **Seed one `ok` row with `finished_at = datetime('now')` to suppress this.**

---

## 11. `scope_estimate_uploads`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `file_name` | TEXT | |
| `job_number` | TEXT | |
| `job_id` | INTEGER | |
| `estimate_id` | INTEGER | |
| `line_item_count` | INTEGER | |
| `total` | REAL | |
| `status` | TEXT NOT NULL | `created` \| `failed` |
| `error` | TEXT | |
| `created_at` | TEXT DEFAULT `datetime('now')` | |

**Index:** `idx_scope_estimate_uploads_created_at (created_at DESC)`.

---

## 12. `pricebook_merge_log`

Audit + undo record for soft-merging duplicate SKUs.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `merged_at` | TEXT DEFAULT `datetime('now')` | |
| `sku_type` | TEXT NOT NULL | `Service` \| `Material` \| `Equipment` |
| `canonical_st_id` | INTEGER NOT NULL | the SKU kept active |
| `canonical_code` / `canonical_name` | TEXT | snapshot |
| `duplicate_st_ids` | TEXT NOT NULL | **JSON array of integers** |
| `duplicate_snapshot` | TEXT | **JSON array** of pre-merge objects |
| `field_copy` | INTEGER DEFAULT 0 | |
| `fields_copied` | TEXT | **JSON object** `{field: newValue}` |
| `canonical_snapshot` | TEXT | **JSON object**, pre-merge, for undo |
| `status` | TEXT NOT NULL | `ok` \| `partial` \| `failed` \| `undone` |
| `error` | TEXT | |
| `user_note` | TEXT | |
| `undone_at` | TEXT | |

**Indexes:** `idx_pricebook_merge_log_merged_at (merged_at DESC)`, `idx_pricebook_merge_log_canonical (canonical_st_id, sku_type)`.

JSON shapes:
```json
duplicate_st_ids   : [881234, 881299]
duplicate_snapshot : [{"st_id":881234,"code":"CU-34-EL","name":"3/4 Copper Ell","price":2.15,"active":1}]
fields_copied      : {"description":"3/4 in. copper 90° elbow, wrot"}
canonical_snapshot : {"code":"CU34EL","name":"CU 3/4 ELL","price":2.10,"description":null}
```

---

## 13. `pricebook_rename_log`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `st_id` | INTEGER NOT NULL | |
| `sku_type` | TEXT NOT NULL | `Material` \| `Service` \| `Equipment` |
| `old_name` | TEXT | |
| `new_name` | TEXT | NULL when `status='skipped'` |
| `status` | TEXT NOT NULL | `applied` \| `skipped` \| `failed` — **only `applied` renders the image thumbnail** |
| `error` | TEXT | |
| `created_at` | TEXT DEFAULT `datetime('now')` | |

**Indexes:** `idx_pricebook_rename_log_created_at (created_at DESC)`, `idx_pricebook_rename_log_st_id (st_id, sku_type)`.

---

## 14. `pricebook_image_log`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `st_id` | INTEGER NOT NULL | |
| `sku_type` | TEXT NOT NULL | |
| `source` | TEXT NOT NULL | `manufacturer` \| `ai` \| `skipped` \| `existing` |
| `image_path` | TEXT | ST storage path |
| `prompt` | TEXT | AI prompt when `source='ai'` |
| `status` | TEXT NOT NULL | `ok` \| `failed` \| `skipped` |
| `error` | TEXT | |
| `created_at` | TEXT DEFAULT `datetime('now')` | |

**Indexes:** `idx_pricebook_image_log_created_at (created_at DESC)`, `idx_pricebook_image_log_st_id (st_id, sku_type)`.
**No page currently reads this** — only the uncalled `GET /api/pricebook/image-log`. Skip it when seeding.

---

## 15. `users`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `email` | TEXT NOT NULL UNIQUE **COLLATE NOCASE** | |
| `password_hash` | TEXT NOT NULL | **real bcrypt hash, cost 12** — a fake string makes login fail |
| `display_name` | TEXT | casual label shown in the nav (usually the first name) |
| `active` | INTEGER DEFAULT 1 | |
| `must_change_pw` | INTEGER DEFAULT 0 | 1 forces a server-side redirect to `/change-password` for **every** page and a 403 on every `/api/*` call |
| `created_at` | TEXT DEFAULT `datetime('now')` | |
| `last_login_at` | TEXT | |
| `is_admin` | INTEGER DEFAULT 0 *(v20)* | gates `/users` and the whole `/api/users` router |
| `first_name` | TEXT *(v25)* | printed on the timesheet |
| `last_name` | TEXT *(v25)* | |

**Index:** `idx_users_email (email)`.

**Populated by:** `seedFirstUserIfEmpty()` at boot from `FIRST_USER_EMAIL` / `FIRST_USER_PASSWORD` (only when the table is empty; seeded with `must_change_pw=1`), the `npm run add-user` CLI, and the `/users` admin page. `initSchema()` also runs an **admin bootstrap**: if users exist but none has `is_admin=1`, the oldest user is promoted (`src/db/index.js:601`).

**Seeding checklist:** at least one row with `is_admin=1 AND active=1` (otherwise `/api/users` 403s for everyone) and `must_change_pw=0` (otherwise the whole dashboard redirects to the password form).

---

## 16. `address_audit_cache`

One row per ServiceTitan location that has been address-verified against Google Geocoding. Lets repeat scans skip the Google call when the address hasn't drifted.

| Column | Type | Notes |
|---|---|---|
| `location_id` | INTEGER **PRIMARY KEY** | ST location id (not autoincrement) |
| `customer_id` | INTEGER | |
| `address_fingerprint` | TEXT NOT NULL | `sha1(lowercased, punctuation-stripped "street\|unit\|city\|state\|zip5").slice(0,16)`. Only a byte-exact match counts as a cache hit. |
| `status` | TEXT NOT NULL | `ok` \| `standardized` \| `partial` \| `undeliverable` \| `no-match` \| `incomplete` \| `error` |
| `verified_json` | TEXT | **JSON** — Google-standardized address |
| `verified_formatted` | TEXT | Google's `formatted_address` |
| `partial_match` | INTEGER DEFAULT 0 | |
| `location_type` | TEXT | `ROOFTOP` \| `RANGE_INTERPOLATED` \| `GEOMETRIC_CENTER` \| `APPROXIMATE` |
| `lat` / `lng` | REAL | |
| `place_id` | TEXT | |
| `error` | TEXT | |
| `checked_at` | TEXT DEFAULT `datetime('now')` | |
| `applied_at` | TEXT | non-null hides the row from `find-issues` |
| `dismissed_at` | TEXT | non-null hides the row from `find-issues` |
| `updated_at` | TEXT DEFAULT `datetime('now')` | |
| `original_json` | TEXT *(v21.1)* | **JSON** of the ST-side address; **`/reclassify` skips rows where this is NULL** and reports them as `legacyCount` |
| `original_name` | TEXT *(v21.2)* | ST `location.name` |
| `suggested_name` | TEXT *(v21.2)* | proposed rewrite |

**Indexes:** `idx_address_audit_status (status)`, `idx_address_audit_checked_at (checked_at DESC)`.

`original_json` / `verified_json` shape:
```json
{ "street": "938 Orchard Pl", "unit": "", "city": "Cedar Hollow",
  "state": "OH", "zip": "43065", "country": "USA" }
```

---

## 17. `job_review_status`

Office review state for jobs flagged on `/open-jobs`, plus non-destructive corrections that overlay the cached `jobs.json` at read time.

| Column | Type | Notes |
|---|---|---|
| `job_number` | TEXT **PRIMARY KEY** | |
| `status` | TEXT NOT NULL | `reviewed` \| `escalated` \| `resolved` (posting `open` with no corrections/notes **deletes** the row) |
| `notes` | TEXT | legacy single editable string |
| `reviewed_by` | TEXT | user email/name |
| `reviewed_at` | TEXT DEFAULT `datetime('now')` | |
| `updated_at` | TEXT DEFAULT `datetime('now')` | |
| `st_note_synced_at` | TEXT *(v22.1)* | |
| `st_note_synced_text` | TEXT *(v22.1)* | lets a re-push be skipped when unchanged |
| `st_note_error` | TEXT *(v22.1)* | |
| `corrected_status` | TEXT *(v22.2)* | overlays `job.status` at read time |
| `corrected_job_type` | TEXT *(v22.2)* | overlays `job.jobType` at read time |
| `status_synced_at` / `status_synced_value` / `status_sync_error` | TEXT *(v22.2)* | per-field ST push state |
| `job_type_synced_at` / `job_type_synced_value` / `job_type_sync_error` | TEXT *(v22.2)* | |

**Indexes:** `idx_job_review_status_status (status)`, `idx_job_review_status_updated_at (updated_at DESC)`.

The overlay (`monthlyDataLoader.applyReviewOverrides`) adds a `_corrections: {status:{from,to}, jobType:{from,to}}` breadcrumb to the in-memory job object; `jobs.json` is never rewritten.

---

## 18. `job_review_notes`

Append-only note log — each note carries its own ST sync state so a partial push is recorded honestly.

| Column | Type |
|---|---|
| `id` | INTEGER PK AUTOINCREMENT |
| `job_number` | TEXT NOT NULL |
| `text` | TEXT NOT NULL |
| `author` | TEXT |
| `added_at` | TEXT DEFAULT `datetime('now')` |
| `st_note_synced_at` | TEXT |
| `st_note_synced_text` | TEXT |
| `st_note_error` | TEXT |

**Indexes:** `idx_job_review_notes_job (job_number, added_at DESC)`, and a **partial index** `idx_job_review_notes_unsynced (job_number) WHERE st_note_synced_at IS NULL`.

---

## 19. `timesheets`

One row per (employee, pay period). Weeks run **Wednesday → Tuesday**.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `user_id` | INTEGER NOT NULL | → `users.id` by convention |
| `employee_name` | TEXT | snapshot at save time |
| `period_start` | TEXT NOT NULL | `YYYY-MM-DD`, **must be a Wednesday** |
| `period_end` | TEXT | `YYYY-MM-DD`, the Tuesday (= start + 6 days) |
| `status` | TEXT NOT NULL DEFAULT `'draft'` | `draft` \| `processed` |
| `grid_json` | TEXT | **JSON** 6×7 hour grid (shape below) |
| `notes` | TEXT | |
| `comp_used` | REAL DEFAULT 0 | |
| `banked_comp_input` | REAL | starting comp, entered once on the first sheet |
| `plaw_start_input` | REAL | starting P-Law, entered once |
| `applied_comp_delta` | REAL | snapshot of the balance change applied at process time |
| `applied_plaw_delta` | REAL | |
| `applied_init_comp` | REAL | non-null only if this sheet seeded the starting balance |
| `applied_init_plaw` | REAL | |
| `processed_at` | TEXT | |
| `created_at` / `updated_at` | TEXT DEFAULT `datetime('now')` | |
| `pay_overtime` | INTEGER DEFAULT 0 *(v23.1)* | 1 = OT paid this week, nothing banked |
| `ot_banked` | REAL DEFAULT 0 *(v23.1)* | hours over 40 banked to comp when `pay_overtime = 0` |

**Constraints/indexes:** `UNIQUE (user_id, period_start)`, `idx_timesheets_user (user_id, period_start DESC)`, `idx_timesheets_status (user_id, status)`.

### `grid_json` shape
`{ rowKey: { dayKey: "hours-as-string" } }` — values are **strings**, `""` for empty.
- Row keys: `regular`, `overtime`, `pto`, `plaw`, `holiday`, `comp`
- Day keys: `wed`, `thu`, `fri`, `sat`, `sun`, `mon`, `tue`
```json
{ "regular":  { "wed":"8", "thu":"8", "fri":"8", "sat":"", "sun":"", "mon":"8", "tue":"8" },
  "overtime": { "wed":"", "thu":"2", "fri":"", "sat":"", "sun":"", "mon":"", "tue":"" },
  "pto":{}, "plaw":{}, "holiday":{}, "comp":{} }
```
Server always recomputes totals from this grid (`timesheetBalanceService`) so the client can't spoof numbers. Regular caps at 8/day; the remainder is normalized into Overtime on every save.

**A `processed` row must have `applied_comp_delta`, `applied_plaw_delta`, `applied_init_comp`, `applied_init_plaw` and `processed_at` set** — reopen reverses exactly those recorded amounts, so missing values corrupt the balance.

---

## 20. `timesheet_balances`

| Column | Type | Notes |
|---|---|---|
| `user_id` | INTEGER **PRIMARY KEY** | one row per employee |
| `comp_balance` | REAL DEFAULT 0 | running two-way total (earned − used, 1:1) |
| `plaw_balance` | REAL DEFAULT 0 | frontloaded; only decreases |
| `comp_initialized` | INTEGER DEFAULT 0 | gates one-time seeding |
| `plaw_initialized` | INTEGER DEFAULT 0 | |
| `updated_at` | TEXT DEFAULT `datetime('now')` | |

Rows are created lazily on the first `GET /api/timesheet/summary`, so this table can be left empty.

---

## 21. `time_punches`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `user_id` | INTEGER NOT NULL | |
| `work_date` | TEXT NOT NULL | **local** `YYYY-MM-DD` the punch counts toward |
| `clock_in` | TEXT NOT NULL | ISO timestamp |
| `clock_out` | TEXT | ISO timestamp, NULL while active |
| `break_seconds` | INTEGER DEFAULT 0 | |
| `break_started_at` | TEXT | ISO while on break, else NULL |
| `hours` | REAL | rounded to 0.25, set on clock-out |
| `status` | TEXT NOT NULL DEFAULT `'active'` | `active` \| `closed` — **at most one `active` row per user** or clock-in throws "You're already clocked in." |
| `applied_period_start` | TEXT | pay period the hours landed in |
| `applied_day` | TEXT | grid day-key (`wed`…`tue`) |
| `note` | TEXT | |
| `source` | TEXT DEFAULT `'clock'` | `clock` \| `manual` |
| `created_at` / `updated_at` | TEXT DEFAULT `datetime('now')` | |

**Indexes:** `idx_time_punches_user_status (user_id, status)`, `idx_time_punches_user_date (user_id, work_date DESC)`.

---

## 22. `app_settings`

| Column | Type |
|---|---|
| `key` | TEXT **PRIMARY KEY** |
| `value` | TEXT |
| `updated_at` | TEXT DEFAULT `datetime('now')` |
| `updated_by` | TEXT |

Keys in use (both optional — absent/NULL/`""` means "use the built-in default", and `setSetting(key, null)` **deletes** the row):
- `classification_instructions` — the AI call-classification prompt (`classificationService.js:171`)
- `transcription_prompt` — the transcription prompt (`transcriptionService.js:104`)

Edited from the "AI Instructions" popup on `/calls` (`GET`/`PUT /api/calls/ai-instructions`).

---

## 23. `install_tracker`

**Pure overlay table.** The install list itself is always pulled live from ServiceTitan; this stores only what the office manually confirms.

| Column | Type | Notes |
|---|---|---|
| `st_job_id` | INTEGER **PRIMARY KEY** | ServiceTitan internal job id |
| `job_number` | TEXT | display snapshot |
| `job_type_id` | INTEGER | must be one of the watched ids (see below) |
| `job_type_name` | TEXT | |
| `category` | TEXT | **`HVAC`** \| **`Water Heater`** (drives the category filter) |
| `customer_id` | INTEGER | |
| `customer_name` | TEXT | |
| `location_id` | INTEGER | |
| `completed_on` | TEXT | ISO completion date snapshot |
| `equipment_listed` | INTEGER DEFAULT 0 | office confirmed the unit is in ST |
| `equipment_listed_at` | TEXT | |
| `equipment_listed_by` | TEXT | user email |
| `warranty_registered` | INTEGER DEFAULT 0 | |
| `warranty_registered_at` | TEXT | |
| `warranty_registered_by` | TEXT | |
| `notes` | TEXT | |
| `created_at` / `updated_at` | TEXT DEFAULT `datetime('now')` | |

**Index:** `idx_install_tracker_completed (completed_on DESC)`.

Rows are created lazily by `ensureRow()` when a toggle or note is saved. Watched job type ids come from `src/config/installTrackerJobTypes.js`: **1232, 1227, 1229, 1233, 1234, 1216, 1208**. A seeded row whose `st_job_id` isn't returned by the live ST query is **invisible**.

---

## 24. `kv_store` *(created ad-hoc, not in `initSchema`)*

```sql
CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT);
```

| Key | Value | Written by | Read by |
|---|---|---|---|
| `call_poll_last_run` | ISO timestamp | call poller | poller cursor + `/health` staleness watchdog |
| `forms_poll_last_run` | ISO timestamp | forms poller | poller cursor + `/health` |
| `happy_review_paused` | string `"true"` / `"false"` | `/api/forms/pause` \| `/resume` | forms poller + `/reviews` toggle |
| `calls_last_reviewed_at` | `YYYY-MM-DD HH:MM:SS` (UTC) | `POST /api/calls/mark-reviewed` (fires automatically on every `/calls` page load) | dashboard "new calls since last review" hero |

First run with no `call_poll_last_run` looks back `CALL_POLL_LOOKBACK_HOURS` (default 2).

---

## 25. `processed_return_visits` *(created ad-hoc)*

```sql
CREATE TABLE IF NOT EXISTS processed_return_visits (
  key            TEXT PRIMARY KEY,   -- "<jobId>:<appointmentId>"
  job_id         TEXT,
  appointment_id TEXT,
  processed_at   TEXT                -- ISO timestamp (not datetime('now'))
);
```

Dedupe guard for the 6 AM return-visit cron, whose 2-day scan window overlaps. Nothing in the UI reads it.

---

## Non-SQLite data stores (still "the database" for seeding purposes)

| Path | Shape | Who writes it |
|---|---|---|
| `data/monthly-cache/{YYYY}-{MM}/jobs.json` | bare JSON array of job objects | `scripts/import-monthly-xlsx.js` (office WIP/JC xlsx) + `POST /api/monthly-review/refresh-jobs-recent` |
| `data/monthly-cache/{YYYY}-{MM}/timesheets.json` | bare JSON array of tech activity rows | same |
| `data/monthly-cache/{YYYY}-{MM}/appointments.json` | bare JSON array (optional) | `POST /api/monthly-review/refresh-appointments/{y}/{m}` |
| `data/monthly-cache/{YYYY}-{MM}/imported-at.json` | `{importedAt, jobsCount, timesheetCount, appointmentCount}` | `writeCache()` |
| `data/employee-roster.json` | `{ entries: [...] }` — see table 4 | operator-supplied, read once at boot |
| `<dirname(DB_PATH)>/` DB backups | rotating SQLite copies, `DB_BACKUP_KEEP` (default 7) | 2 AM cron + one 60 s after boot |

**The month directory name must be zero-padded** (`2026-03`, not `2026-3`) — a `^\d{4}-\d{2}$` regex gates directory discovery everywhere.
**`readCache()` requires BOTH `jobs.json` and `timesheets.json` to exist**, or the month is treated as absent and the loader silently falls through to live ServiceTitan.

The exact per-field record shapes for these three files are documented in **MOCK_SPEC_PAGES.md → "Monthly cache file shapes"** because that's where they're consumed.

> As checked out today, `data/monthly-cache/` exists but is **completely empty** — zero month directories — and `data/employee-roster.json` does not exist. Every cache-backed page is therefore currently in its empty state.

---

## Which tables are populated by what — seeding priority

**Populated by background pollers/crons (seed these to fake "the system has been running"):**
`processed_calls`, `processed_happy_reviews`, `kv_store` (poller cursors), `pricebook_index`, `pricebook_sync_log`, `processed_return_visits`.

**Populated by user action (seed these to fake "people have been using it"):**
`installed_equipment_registrations`, `video_uploads`, `fleet_technicians`, `known_addresses`, `invoice_uploads`, `scope_estimate_uploads`, `pricebook_merge_log`, `pricebook_rename_log`, `pricebook_image_log`, `address_audit_cache`, `job_review_status`, `job_review_notes`, `timesheets`, `timesheet_balances`, `time_punches`, `app_settings`, `install_tracker`, `users`.

**Populated by boot-time seeding:**
`employee_phones` (from `data/employee-roster.json`, only when empty), `users` (from `FIRST_USER_EMAIL`/`FIRST_USER_PASSWORD`, only when empty; admin bootstrap promotes the oldest user).

**Tables with JSON blob columns (get these right or the UI degrades quietly):**
`processed_calls` (`raw_webhook_payload`, `transcript_metadata`, `summary_bullets`, `candidate_jobs`, `internal_employee`),
`installed_equipment_registrations` (`form_data`, `proportal_row`),
`address_audit_cache` (`original_json`, `verified_json`),
`pricebook_merge_log` (`duplicate_st_ids`, `duplicate_snapshot`, `fields_copied`, `canonical_snapshot`),
`timesheets` (`grid_json`).
