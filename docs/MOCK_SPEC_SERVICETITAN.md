# Mock Spec — `src/api/servicetitan.js`

Reference for building a drop-in mock of the ServiceTitan API client.
Source: `src/api/servicetitan.js` (~2,518 lines). **68 exported functions.**

Everything here is derived from (a) what the function literally returns and
(b) what callers in `src/routes/**` and `src/services/**` actually read off it.
A wrong return shape breaks a page — match the envelope exactly.

---

## 0. Conventions used below

- **READ** = only issues GETs to ServiceTitan.
- **WRITE** = issues POST / PATCH / PUT / DELETE to ServiceTitan.
- "ST envelope" means ServiceTitan's standard list wrapper:
  ```js
  { page, pageSize, totalCount, hasMore, data: [ ... ] }
  ```
  Some functions return this envelope verbatim; most unwrap it to a bare array.
  **The distinction is load-bearing.** It is called out per function.
- "Swallows errors → `[]`" means the function catches, `console.warn`s, and
  returns an empty array. A mock that throws instead will change behavior.

---

## 1. Module-level state (must be reproduced or stubbed)

| Name | Declared at | Shape | TTL | Notes |
|---|---|---|---|---|
| `tokenCache` | L3 | `{ token: string\|null, expiresAt: number }` | until `expires_in`; refreshed 60 s early | Cleared to `{token:null,expiresAt:0}` on any 401 from GET/POST/PUT |
| `tokenInFlight` | L4 | `Promise<string>\|null` | — | De-dupes concurrent token refreshes (no stampede) |
| `MATERIAL_SAFE_LIST` | L149 | `Set<number>` = `{4021784}` | const | `deactivateMaterial` **throws** for any ID in it |
| `VENDOR_CACHE` | L800 | `{ vendors: Array\|null, expiresAt: number }` | 10 min (`VENDOR_CACHE_TTL_MS`) | Full active vendor list; cleared by `invalidateVendorCache()` |
| `PO_TYPE_ID_CACHE` | L947 | `number\|null` | process lifetime | Overridden by `ST_PO_TYPE_ID` env |
| `INVENTORY_LOCATION_ID_CACHE` | L948 | `number\|null` | process lifetime | Overridden by `ST_INVENTORY_LOCATION_ID` env |
| `_employeeCache` | L1503 | `{ list: Array\|null, expiresAt: number }` | 10 min (`EMPLOYEE_CACHE_TTL_MS`) | Bypassed with `listEmployees({force:true})` |
| `_techCache` | L2157 | `{ at: number, map: Map\|null }` | 5 min | Backs `getTechniciansMap()` |
| `_jobTypeCache` | L2333 | `{ byName: Map, byId: Map, fetchedAt: number }\|null` | 10 min (`JOB_TYPE_TTL_MS`) | Written by `fetchAllJobTypes()` |

### Environment variables the client reads
`ST_CLIENT_ID`, `ST_CLIENT_SECRET`, `ST_APP_KEY`, `ST_TENANT_ID`,
`ST_PO_TYPE_ID`, `ST_INVENTORY_LOCATION_ID`, `ST_DEFAULT_SKU_ID`,
`ST_DEFAULT_BUSINESS_UNIT_ID`.

---

## 2. Internal (NOT exported) helpers — pagination & plumbing

These are private but a faithful mock must reproduce their observable effects.

| Helper | Purpose |
|---|---|
| `withRetry(fn, {retries=4, baseDelayMs=500, label})` | Retries on network error or status **429/502/503/504**, exponential backoff 0.5/1/2/4 s, honors `Retry-After` header. Applied to **GETs and the token fetch only** — never to writes. |
| `stClient()` | Returns `{ get(path, params), post(path, body), put(path, body) }`. Auto-injects `tenant` query param, `Authorization`, `ST-App-Key`. GET wrapped in `withRetry`; POST/PUT retry **once on 401 only**. Returns the raw **axios response** (so callers use `res.data`). |
| `sleep(ms)`, `RETRYABLE_STATUS` | Backoff primitives. |
| `_stAuthHeaders()` | `{ Authorization, "ST-App-Key", "Content-Type": "application/json" }` — used by the raw-axios PATCH wrappers. |
| `_stErrorMessage(err)` | Normalizes ST error bodies to a ≤500-char string (`title` → `detail` → JSON). |
| `_pricebookSearch(pathSegment)` | **Factory** that produces the four `searchPricebook*` functions. |
| `fetchAllActiveVendors()` | Paginates `/inventory/v2/vendors` (pageSize 200, max 50 pages), caches 10 min. **Throws** on a page failure with ST's body in the message. |
| `getDefaultPoTypeId()` | Env override → cache → first active PO type. **Throws** if none. |
| `getDefaultInventoryLocationId()` | Env override → cache → first active warehouse, then truck-location. **Throws** if none. |
| `vendorTokens(name)` / `jaccardScore(a,b)` | Vendor fuzzy matching (drops corporate suffixes; Jaccard 0..1, threshold 0.6, ties within 0.01 → refuse). |
| `canonicalJobStatus(s)` / `ST_JOB_STATUSES` | Maps loose spellings → `Scheduled\|Dispatched\|InProgress\|Hold\|Completed\|Canceled`. |

**There is no exported pagination helper.** Every paginating function loops
internally on `res.data.hasMore` with its own page cap:

| Function | pageSize | Page cap |
|---|---|---|
| `fetchAllActiveVendors` (internal) | 200 | 50 |
| `getJobsForCustomerInRange` | 200 | 20 |
| `listEmployees` | 200 | 25 |
| `getInstalledEquipmentByLocation` | 100 | unbounded (`hasMore`) |
| `getInvoicesByIds` | 50 (chunks of 50 ids) | unbounded |
| `getJobLaborSplits` | 200 | 10 |
| `getJobTimesheets` | 200 | 10 |
| `getJobGrossPayItems` | 200 | 10 |
| `getPurchaseOrdersForJob` | 50 | 10 |
| `fetchAllJobTypes` | 200 | 25 |
| `getAllAppointmentsForDateRange` | 50 | unbounded |
| `findReturnVisitJobs` | 50 | unbounded |
| `getRecurringServicesForMembership` | 50 | 5 |

---

## 3. Auth

### `getAccessToken()` — READ (auth)
- **Params:** none.
- **Returns:** `Promise<string>` — the bare OAuth access token.
- **State:** populates `tokenCache`; de-duped via `tokenInFlight`.
- **Throws:** axios error if the token endpoint fails after 4 retries.
- Callers: internal only, plus a couple of raw-axios call sites elsewhere in the app.

---

## 4. Calls / Telecom

### `getCall(callId)` — READ
- **Params:** `callId` (number|string, required).
- **Returns:** `Promise<object>` — raw ST call object (`res.data`, **not** an envelope).
- **Fields callers actually read:** `from`, `callerPhoneNumber`, `createdOn`,
  `callDate`, `startedOn`, `duration`.
  (`direction`, `callType`, `reason{}`, `campaign{}`, `recordingUrl` exist on the
  ST payload but are never consumed — most call metadata comes from the
  webhook/poll payload `leadCall`, not from here.)
- **Throws:** yes — raw axios error propagates (no try/catch). `callProcessingService.js:110-116` wraps it non-fatally.

### `updateCallReasonOnST(stCallId, { reasonName?, callType?, agentId? })` — **WRITE** (PUT)
- **Params:**
  - `stCallId` (number|string, required)
  - options object, all optional, defaults `null`:
    - `reasonName` (string) — becomes `body.reason = { name, lead }`
    - `callType` (string) — one of `Excused | Unbooked | NotLead | Booked | Abandoned`
    - `agentId` (number|string) — coerced to Number, only sent if finite and > 0
- **Behavior:** `lead` is derived — `true` only when `callType === "Unbooked"`.
- **Returns:**
  - `null` if nothing to send (no callType, no reason, no agentId), **and**
  - `null` on any ST failure (fails silently — logs a warning),
  - otherwise `res.data` (ST's updated call object).
- **Throws:** never.

### `getCallRecordingStream(callId)` — READ
- **Params:** `callId` (required).
- **Returns:** the **entire axios response object** (`responseType: "stream"`), not `.data`.
  Callers pipe `res.data` themselves and may read `res.headers`.
- **Throws:** yes. ST 404s when the recording isn't ready yet; callers retry.
- Mock note: return `{ status: 200, headers: {...}, data: <Readable> }`.

---

## 5. Customers / Contacts / Locations

### `searchCustomersByPhone(phoneNumber)` — READ
- **Params:** `phoneNumber` (string, required; internally stripped to digits).
- **Query:** `phone=<digits>` (NOT `phoneNumber` — ST silently ignores unknown params), `pageSize: 5`, `active: true`.
- **Returns:** `Promise<Array<customer>>` — **bare array**, `res.data.data || []`.
- **Throws:** never — swallows errors → `[]`.

### `searchCustomersByName(name, { pageSize = 15 })` — READ
- **Params:** `name` (string, required); options `{ pageSize?: number = 15 }`.
- **Guard:** returns `[]` immediately if `name` is falsy or trimmed length < 2.
- **Returns:** `Promise<Array<customer>>` — bare array.
- **Throws:** never — swallows → `[]`.

### `searchContactsByPhone(phoneNumber)` — READ
- **Params:** `phoneNumber` (string|number, required; digits-stripped).
- **Endpoint:** `/crm/v2/.../customers/contacts?phone=<digits>&pageSize=5`.
- **Returns:** `Promise<Array<contact>>` — bare array. Each contact carries `customerId`.
- **Throws:** never — swallows → `[]`.
- Caller reads `contacts[0].customerId` (`matchingService.js:122`).

### `getCustomer(customerId)` — READ
- **Params:** `customerId` (number|string, required).
- **Returns:** `Promise<object>` — single raw customer object.
- **Throws:** **yes, and callers depend on it.**
  `callProcessingService.js:479-497` catches, checks `err.response.status === 404`,
  and rethrows a tagged error with `isCustomerNotFound = true` that the UI branches on.
  Elsewhere it's `.catch(() => null)` + null-check.

### `getCustomerContacts(customerId)` — READ
- **Params:** `customerId` (required).
- **Query:** `pageSize: 50`, `active: true`.
- **Returns:** `Promise<Array<contact>>` — bare array.
- **Throws:** never — swallows → `[]`.

### `getLocationById(locationId)` — READ
- **Params:** `locationId` (required).
- **Returns:** `Promise<object|null>` — `res.data || null` (single location).
- **Throws:** yes (404 propagates). Callers null-check (`customerReview.js:649`, `happyReviewService.js:145`).

### `getLocationsByCustomer(customerId, { pageSize = 5 })` — READ
- **Params:** `customerId` (required); options `{ pageSize?: number = 5 }`.
  ⚠️ Default is only **5** — `equipmentRegistrationService` explicitly passes 100.
- **Query:** `customerId`, `pageSize`, `active: true`.
- **Returns:** `Promise<Array<location>>` — bare array.
- **Throws:** yes (no try/catch).

### `searchLocationsByAddress(query, { pageSize = 20 })` — READ
- **Params:** `query` (string, required); options `{ pageSize?: number = 20 }`.
- **Guard:** returns `[]` if trimmed query length < 3.
- **Query:** `street=<q>`, `pageSize`, `active: "True"`.
- **Returns:** `Promise<Array<location>>` — bare array. Each has `customerId`.
- **Throws:** never — swallows → `[]`.

### `addCustomerNote(customerId, text)` — **WRITE** (POST)
- **Params:** `customerId` (required), `text` (string, required).
- **Body sent:** `{ text, isPinned: false }`.
- **Returns:** `res.data` — created note object. **Callers ignore the value.**
- **Throws:** yes. `callProcessingService.js` catches and rethrows with `stStatus` attached.

### `applyTagToCustomer(customerId, tagTypeId)` — **WRITE** (POST)
- **Params:** `customerId` (required), `tagTypeId` (number, required).
- **Body sent:** `{ typeId: tagTypeId }`.
- **Returns:** `res.data`. Callers ignore it.
- **Throws:** yes.

#### Entity field shapes

**customer** — `id`, `name`, `type`, `balance`, `email`, `active`, `phoneSettings`,
`address: { street, unit, city, state, zip, country }`
(alternate spellings tolerated by callers: `streetAddress`, `stateCode`, `postalCode`),
sometimes `contacts: [{ type, value }]`.
`doNotMail` is never read.

**contact** — `id`, `customerId`, `type` (`"Phone"|"MobilePhone"|"HomePhone"|"WorkPhone"|"Cell"|"Mobile"|"Email"`), `value`.
`memo` / `phoneSettings` never read.

**location** — `id`, `name`, `customerId`, `active`,
`address: { street, unit, city, state, zip, country }` (+ same alternates).

---

## 6. Jobs / Appointments

### `getJob(jobId)` — READ
- **Params:** `jobId` (internal ST id, required).
- **Returns:** `Promise<object>` — single raw job. **Not** an envelope.

### `getJobs({ modifiedOnOrAfter?, modifiedBefore?, modifiedOnOrBefore?, technicianId?, page = 1, pageSize = 50 })` — READ
- **Params:** all optional, single options object.
  - `modifiedOnOrAfter` (ISO string) — inclusive lower bound
  - `modifiedBefore` (ISO string) — exclusive upper bound (ST-spec name)
  - `modifiedOnOrBefore` — legacy alias; internally coerced to `modifiedBefore`
  - `technicianId` — sent on the wire as `technicianIds`
  - `page` (number = 1), `pageSize` (number = 50)
- **Returns:** `Promise<ST envelope>` — **the full `{ page, pageSize, totalCount, hasMore, data: [...] }`**, i.e. `res.data`. Callers use `.data` and `.hasMore`.
- **Throws:** yes.

### `getJobByNumber(jobNumber)` — READ
- **Params:** `jobNumber` (string|number, required).
- **Query:** sends **both** `jobNumber` and `number` (belt-and-braces), `pageSize: 1`.
- **Returns:** `Promise<object|null>` — a single job, or `null`:
  - `null` if no rows,
  - `null` if the returned job's `jobNumber` does **not** string-equal the request
    (deliberate anti-corruption guard, L2021-2028 — logs a warning).
- **Throws:** yes on transport failure. `scoreboard.js:102-107` distinguishes:
  throw → HTTP 500, `null` → HTTP 404.

### `findJobByNumber(jobNumberOrId)` — READ
- **Params:** `jobNumberOrId` (string|number, required — accepts either identifier).
- **Behavior:** pass 1 = `getJobByNumber`; pass 2 = if all digits, try `getJob(value)` and accept if it resolves.
- **Returns:** **always an object**, never null:
  ```js
  { jobId: "62695261" | null, jobNumber: "2602739" | null }
  ```
  `jobId` is a **string** (`String(job.id)`). `jobNumber` may be `null` on the pass-2 path.
  Not-found → `{ jobId: null, jobNumber: null }`.
- **Throws:** never (both passes are wrapped). But `pdfParser.js:216-219` still guards it and maps a throw → 502.

### `getAppointments({ startsOnOrAfter?, startsOnOrBefore?, technicianId?, jobId?, page = 1, pageSize = 50 })` — READ
- **Params:** single options object, all optional.
  ⚠️ `technicianId` is **singular** on the wire (plural `technicianIds` is silently ignored by ST).
- **Returns:** `Promise<ST envelope>` — full `res.data` with `.data` and `.hasMore`.
- **Throws:** yes.

### `getAllAppointmentsForDateRange(startDate, endDate, technicianId = null)` — READ
- **Params:** `startDate` (ISO, required), `endDate` (ISO, required), `technicianId` (optional, default `null`).
- **Behavior:** loops `getAppointments` at pageSize 50 until `hasMore` is false.
- **Returns:** `Promise<Array<appointment>>` — **flat concatenated array**.
- **Throws:** yes (propagates from `getAppointments`).

### `getJobAppointments(jobId)` — READ
- **Params:** `jobId` (required).
- **Returns:** `Promise<Array<appointment>>` — bare array (`data.data || []`). **Single page only** (pageSize 50, no pagination).
- **Throws:** yes.

### `getRecentJobsForCustomer(customerId, opts = {})` — READ
- **Params:**
  - `customerId` (required)
  - `opts` — **polymorphic**: either a `number` (legacy: treated as pageSize) or `{ pageSize?: number }`. Default pageSize **10**.
- **Query:** `customerId`, `pageSize`, `sort: "-ModifiedOn"`.
- **Returns:** `Promise<Array<job>>` — bare array, **re-sorted in JS** descending by
  `modifiedOn || createdOn`, falling back to numeric `id`.
- **Throws:** never — swallows → `[]`.

### `getJobsForCustomerInRange(customerId, startISO, endISO, { dateField = "modified" })` — READ
- **Params:**
  - `customerId` (required — falsy returns `[]`)
  - `startISO` (string|null), `endISO` (string|null) — either may be null/omitted (unbounded on that side)
  - options `{ dateField?: "modified" | "completed" }`, default `"modified"`
- **Behavior:** date filtering is done **client-side** (ST returns zero rows when
  `customerId` + date filters are combined on this tenant). Walks up to 20 pages ×
  200. Jobs with an unparseable timestamp are **included** conservatively.
- **Returns:** `Promise<Array<job>>` — bare array, JS-sorted newest-first by
  `modifiedOn || completedOn || createdOn`.
- **Throws:** never — a page failure breaks the loop and returns what was collected.

### `addJobNote(jobId, text)` — **WRITE** (POST)
- **Params:** `jobId` (internal id, required), `text` (string, required).
- **Body sent:** `{ text, isPinned: false }`.
- **Returns:** `res.data` — created note. Callers ignore the value.
- **Throws:** **yes, and callers depend on it.** `callProcessingService.js:567-607`
  catches, and on `err.response.status === 404` sets `err.isJobNotFound = true`,
  which `routes/calls.js:475-481` uses to switch the UI to manual job entry.

### `updateJobStatus(jobId, statusName)` — **WRITE** (raw axios PATCH)
- **Params:** `jobId` (required), `statusName` (string, loose spelling OK — `"in progress"`, `"In_Progress"`, `"cancelled"` all map).
- **Returns:** a **result object, never a throw**:
  - success: `{ ok: true, status: <httpStatus>, value: <canonicalStatus>, data: <ST body> }`
  - bad input: `{ ok: false, error: "jobId required" }` or `{ ok: false, error: "Unknown ST job status: <x>" }` (no `value` on the first, `value` present on the second)
  - ST failure: `{ ok: false, error: <normalized ST message>, value: <canonicalStatus> }`
- **Throws:** never.

### `updateJobType(jobId, jobTypeName)` — **WRITE** (raw axios PATCH)
- **Params:** `jobId` (required), `jobTypeName` (string, case-insensitive).
- **Returns:** result object, never throws:
  - success: `{ ok: true, status, value: <resolvedName>, jobTypeId: <number>, data }`
  - `{ ok: false, error: "jobId required" }`
  - unknown type: `{ ok: false, reason: "unknown-job-type", error: 'No active ST job type matches "<x>"', value: <jobTypeName> }`
  - ST 403/422: `{ ok: false, reason: "locked-by-tenant", error, value, jobTypeId }`
  - other ST failure: `{ ok: false, reason: "patch-failed", error, value, jobTypeId }`
- **Caller dependency:** `routes/monthlyReview.js:660-700` branches on
  `reason === "locked-by-tenant"` to fall back to posting a note.

### `appendJobSummary(jobId, addition)` — **WRITE** (GET then raw axios PATCH)
- **Params:** `jobId` (required), `addition` (string, required — must be non-blank).
- **Behavior:** reads the current job to preserve `job.summary`, joins with `\n\n`,
  then PATCHes `{ summary }`. If the read fails it still PATCHes (prior text lost).
- **Returns:** never throws:
  - `{ ok: true, status, summaryLength: <number>, data }`
  - `{ ok: false, error: "jobId required" }`
  - `{ ok: false, error: "nothing to append" }`
  - `{ ok: false, error: <normalized ST message> }`
- Checked at `routes/pdfParser.js:310`.

#### Entity field shapes

**job** — `id`, `jobNumber`, `jobStatus` (callers read `jobStatus || status`),
`customerId`, `locationId`, `jobTypeId`, `businessUnitId`, `createdOn`, `modifiedOn`,
`completedOn`, `summary`, `priority`, `noCharge`, `campaignId`, `leadTechnicianId`.
Callers also probe (present on some ST responses / denormalized views):
`status`, `jobTypeName`, `jobType`, `type.name`, `createdDate`, `completed`,
`businessUnitName`, `businessUnit.name`, `campaignName`, `campaign.name`,
`technicians` (array of strings **or** objects with `.name`/`.id`), `customerName`,
`customer.id`, `customer.name`, `total`, `firstAppointmentDate`, `startDate`,
`scheduledDate`, `address.street`, `location.address.street`.
A mock should emit the first (canonical) block always and may omit the probes.

**appointment** — `id`, `jobId`, `appointmentNumber`, `start`, `end`,
`arrivalWindowStart`, `arrivalWindowEnd`, `status`, `specialInstructions`,
plus a technician reference in **any** of these shapes (callers normalize all of them):
`technicianIds: number[]`, `technicianId`, `technician: { id, name }`,
`assignments: [{ technicianId, technician: { id } }]`.

---

## 7. Invoices / Payments / Purchase Orders

### `getInvoicesForJob(jobNumber, jobId = null)` — READ
- **Params:** `jobNumber` (string|number, required), `jobId` (internal id, optional, default `null`).
- **Behavior:** if `jobId` given, query `{ jobId }` first and return those rows if
  non-empty; otherwise fall back to a `{ jobNumber }` query.
- **Returns:** `Promise<Array<invoice>>` — **bare array**.
- **Throws:** yes (no try/catch).

### `getInvoicesByIds(ids = [])` — READ
- **Params:** `ids` (array of number|string, default `[]`). Deduped and stringified internally.
- **Behavior:** chunks of 50 ids, pages each chunk at pageSize 50 until `hasMore` false.
- **Returns:** `Promise<Array<invoice>>` — flat array, **no guaranteed order**, `[]` for empty input.
- **Throws:** yes.

### `getInvoicesByCustomer(customerId, pageSize = 1)` — READ
- **Params:** `customerId` (required), `pageSize` (number, default **1**) — positional, not an options object.
- **Returns:** `Promise<Array<invoice>>` — bare array. (Diagnostic helper for schema inspection.)
- **Throws:** yes.

### `getPayment(paymentId)` — READ
- **Params:** `paymentId` (required).
- **Behavior:** ST has no `/payments/{id}` path; this hits the **list** endpoint with `ids=<paymentId>` and takes row 0.
- **Returns:** `Promise<object|null>` — the payment object, or **`null` when not found**.
- **Throws:** yes on transport failure.
- **Caller dependency:** `paymentInvoiceService.js:141-146` converts `null` into a tagged `PAYMENT_NOT_FOUND` error.

### `getPurchaseOrdersForJob(jobId)` — READ
- **Params:** `jobId` (required — falsy returns `[]`).
- **Behavior:** pages `jobIds=<jobId>` at pageSize 50, max 10 pages.
- **Returns:** `Promise<Array<purchaseOrder>>` — bare array.
- **Throws:** never — on 401/403/404 it breaks quietly (no warn); on other errors it warns and breaks, returning what it has. Caller sets a `poUnavailable` diagnostic flag when the array is empty and it suspects a scope problem.

### `createPurchaseOrder({ jobId, vendorId, items, summary, date, vendorDocumentNumber, shipToDescription, tax, shipping, requiredOn, shipToOverride })` — **WRITE** (POST)
- **Params** (single destructured object):
  | Key | Type | Required | Default |
  |---|---|---|---|
  | `jobId` | number\|string | **yes** | — |
  | `vendorId` | number\|string | **yes** | — |
  | `items` | array | **yes, ≥1** | `[]` |
  | `summary` | string | no | `""` |
  | `date` | ISO string | no | `null` → now |
  | `vendorDocumentNumber` | string | no | `null` |
  | `shipToDescription` | string | no | `null` |
  | `tax` | number | no | `0` |
  | `shipping` | number | no | `0` |
  | `requiredOn` | ISO string | no | `null` → `date` |
  | `shipToOverride` | `{ description?, address? }` | no | `null` |

  Item shape accepted: `{ skuId?, skuName?, vendorPartNumber?, description?, quantity?, cost? }`.
  Missing `skuId` falls back to `Number(process.env.ST_DEFAULT_SKU_ID)`.
- **Derived server-side:** `businessUnitId` from `getJob(jobId)` (or `ST_DEFAULT_BUSINESS_UNIT_ID`),
  `typeId` from `getDefaultPoTypeId()`, `inventoryLocationId` from `getDefaultInventoryLocationId()`,
  `shipTo = { description: "Vendor Counter Pickup", address: {street:"",unit:"",city:"",state:"",zip:"",country:"USA"} }`,
  `impactsTechnicianPayroll: false`.
- **Returns:** `Promise<object>` — ST's created PO (`res.data`). Callers read only `.id` and `.number`.
- **Throws:** yes, with distinct messages:
  - `"createPurchaseOrder: jobId is required"` / `"...vendorId is required"` / `"...at least one line item required"`
  - `"createPurchaseOrder: could not load job <id> (<status>): <msg>"`
  - `"createPurchaseOrder: job <id> has no businessUnitId and ST_DEFAULT_BUSINESS_UNIT_ID is not set."`
  - `"ST_DEFAULT_SKU_ID env var is not set. ..."`
  - `"ST purchase order rejected (<status>): <ST body>"`

### `findVendorByName(name)` — READ
- **Params:** `name` (string, required).
- **Behavior:** fetches/uses the cached full active-vendor list, then
  (1) exact normalized token match wins; (2) best Jaccard ≥ 0.60 wins;
  (3) if the top two are both ≥ 0.60 and within 0.01 of each other → **ambiguous, returns null**.
- **Returns:** `Promise<object|null>` — the raw vendor object, or `null`.
  Callers read only `vendor.id` and `vendor.name`.
- **Throws:** never — a vendor-fetch failure is caught and returns `null`.
- **Caller dependency:** `invoiceImportService.js:73-83` branches on `null` to show a "create the vendor in ST" message.

### `invalidateVendorCache()` — (no I/O)
- **Params:** none. **Returns:** `undefined`. **Throws:** never.
- Resets `VENDOR_CACHE` so the next `findVendorByName` refetches.

#### Entity field shapes

**invoice** — canonical: `id`, `number`, `total`, `subtotal`, `tax`, `balance`,
`invoicedOn`, `createdOn`, `summary` (HTML),
`status: { name, value }`, `customer: { id, name }`, `location: { name }`,
`businessUnit: { name }`, `job: { id, number }`,
`items: [{ skuName, sku: { code, displayName }, code, description, name, quantity, price, unitPrice, total, cost, totalCost, type, skuType }]`.
Callers ALSO probe these alternates — safest to include them or match one casing consistently:
`invoiceNumber`, `referenceNumber`, `subTotal` (capital T — `paymentInvoiceService` prefers it,
`scoreboard` prefers lowercase `subtotal`), `salesTax`, `invoiceDate`, `date`,
`statusName`, `jobNumber`, item `qty`.
`dueDate` and `royaltyStatus` are never read.

**payment** — `id`, `referenceNumber`, `memo`, `paidOn`, `total`, `unappliedAmount`,
`type`, `status`, `customer: { id, name }`,
`appliedTo: [{ appliedId, appliedTypeId, appliedAmount, appliedOn }]`.
Caller alternates: `paymentId`, `reference`, `date`, `createdOn`, `amount`,
`typeName`, `paymentType`, `transactionStatus`, and array aliases `splits[]` / `invoices[]`
with entry keys `invoiceId` / `invoice.id`.
⚠️ `paymentInvoiceService` deliberately does **not** use `appliedId` (it's the split
record id); it reads a scalar-numeric `entry.appliedTo`, `entry.invoiceId`, or `entry.invoice.id`.

**purchaseOrder** — `id`, `number`, `total`, `subTotal`, `tax`, `status`, `vendor`,
`sentOn`, `items: [{ skuName, quantity, cost, total }]`.
Only `total`, `subTotal`, `id`, `number` are ever read.

---

## 8. Pricebook

### `searchPricebookServices(opts)` / `searchPricebookMaterials(opts)` / `searchPricebookEquipment(opts)` / `searchPricebookDiscountsAndFees(opts)` — READ
All four are produced by the `_pricebookSearch(pathSegment)` factory and share an identical signature.
- **Params:** single options object, all optional:
  `{ searchTerm?: string, page?: number = 1, pageSize?: number = 25, active?: string = "True", extra?: object = {} }`.
  `extra` is spread into the query. `searchTerm` is only sent when truthy. `includeTotal: true` is always sent.
- **Returns:** `Promise<ST envelope>` — **`res.data` verbatim**, i.e.
  `{ page, pageSize, totalCount, hasMore, data: [ ...items ] }`.
  Falls back to `{ data: [], hasMore: false, totalCount: 0 }` if `res.data` is falsy.
  ⚠️ These are the *only* list functions besides `getJobs`/`getAppointments` that return the envelope rather than a bare array.
- **Throws:** yes.

### `getPricebookItem(skuType, itemId)` — READ
- **Params:**
  - `skuType` (string, required) — accepts `"material"|"materials"|"equipment"|"service"|"services"` (case-insensitive)
  - `itemId` (number|string, required)
- **Returns:** `Promise<object>` — the full raw SKU record including `image`/`images`
  (which the search endpoints don't reliably return).
- **Throws:** yes:
  - `"getPricebookItem: itemId required"`
  - `` `getPricebookItem: unsupported skuType "<x>"` ``
  - `` `getPricebookItem(<path> <id>) failed (<status>): <detail>` ``

### `createMaterial(body)` — **WRITE** (POST, raw axios)
- **Params:** `body` (object, required) — must include `code` and `description`; everything else optional.
- **Returns:** `Promise<object>` — created material (`res.data`).
- **Throws:** `"createMaterial: body.code required"`, `"createMaterial: body.description required"`,
  or `` `createMaterial failed (<status>): <detail>` ``.

### `updateMaterial(materialId, updates)` — **WRITE** (PATCH, PUT fallback)
- **Params:** `materialId` (required), `updates` (object, required).
- **Behavior:** PATCH first; on 404/405 retry as PUT.
- **Returns:** `Promise<object>` — `res.data`, the updated material.
- **Throws:** `"updateMaterial: materialId required"`, `"updateMaterial: updates object required"`,
  `` `updateMaterial PATCH failed (<status>): <detail>` ``, `` `updateMaterial PUT failed (...)` ``.

### `updateEquipment(equipmentId, updates)` — **WRITE** (PATCH, PUT fallback)
Same contract as `updateMaterial`, against `/pricebook/v2/.../equipment/{id}`.
Throws `"updateEquipment: equipmentId required"` / `"updateEquipment: updates object required"` /
`` `updateEquipment PATCH failed (...)` `` / `` `updateEquipment PUT failed (...)` ``.

### `updateService(serviceId, updates)` — **WRITE** (PATCH, PUT fallback)
Same contract, against `/pricebook/v2/.../services/{id}`. Analogous throw messages.

### `deactivateMaterial(materialId)` — **WRITE** (DELETE, then PATCH, then PUT)
- **Params:** `materialId` (number|string, required).
- **Safety:** throws immediately for any id in `MATERIAL_SAFE_LIST` (currently `4021784`):
  `` `Refusing to touch material <id> — it's on the safe list. ...` ``
- **Behavior:** DELETE → on 404/405/501 fall back to `PATCH { active: false }` → on 404/405 fall back to PUT.
- **Returns:** `Promise<{ method: "DELETE"|"PATCH"|"PUT", status: number, data: any|null }>`.
  (The JSDoc mentions `"none"` / `"both-failed"` but the code never returns those — it throws instead.)
- **Throws:** `"deactivateMaterial: materialId required"`, the safe-list error, or
  `` `deactivateMaterial {DELETE|PATCH|PUT} failed (<status>): <detail>` ``.

### `uploadPricebookImage(imageBytes, { contentType = "image/png", filename })` — **WRITE** (multipart POST)
- **Params:** `imageBytes` (Buffer|ArrayBuffer-like, required);
  options `{ contentType?: string = "image/png", filename?: string }`.
  Auto-generates `pricebook-<ts>-<rand>.{png|jpg|webp}` when `filename` is omitted.
- **Returns:** `Promise<{ path: string, raw: any, contentType: string, filename: string }>`.
  `path` is normalized out of whichever shape ST returned (plain string,
  `{path}`, `{imagePath}`, `{image}`, `{url}`, `{file}`, `{fileName}`).
- **Throws:** `"uploadPricebookImage: imageBytes required"`,
  `"uploadPricebookImage: could not extract path from response: <raw>"` (deliberate — so we
  never PATCH a SKU with JSON garbage), or `` `uploadPricebookImage failed (<status>): <detail>` ``.

### `fetchPricebookImageBytes(pathOrUrl)` — READ
- **Params:** `pathOrUrl` (string, required) — either an absolute `http(s)://` URL or a
  relative store path like `"Images/abc.png"`.
- **Returns:** `Promise<{ bytes: Buffer, contentType: string }>` — `contentType` defaults to `"image/png"`.
- **Throws:** `"fetchPricebookImageBytes: pathOrUrl required"` or
  `` `fetchPricebookImageBytes(<path>) failed (<status>): <detail>` ``.

### `attachPricebookImage(skuType, itemId, body)` — **WRITE** (POST)
- **Params:** `skuType` (same accepted values as `getPricebookItem`), `itemId`, `body` (object sent as JSON).
- **Endpoint:** `POST /pricebook/v2/.../{materials|equipment|services}/{id}/image`.
- **Returns:** `Promise<{ ok: true, status: number, data: any }>`.
- **Throws:** `` `attachPricebookImage: unsupported skuType "<x>"` `` or
  `` `attachPricebookImage(<path> <id>) failed (<status>): <detail>` ``. Never returns `ok:false`.

#### Entity field shape

**pricebook item** — `id`, `code`, `displayName`, `name`, `sku`, `description`, `active`,
`price`, `memberPrice`, `addOnPrice`, `amount`, `unitPrice`,
`image` (string), `images` (array of string **or** `{ path, url, image }`).
`getPricebookItem` additionally returns `manufacturer`, `model`, `modelNumber`,
`primaryVendor`, `otherVendors: []`, `vendors: [{ vendorId, id, vendorName, name, vendor: { name }, primary, isPrimary }]`.
`categories` is never read.

---

## 9. Estimates

### `createEstimate({ jobId, name, summary, items })` — **WRITE** (POST)
- **Params** (single destructured object):
  - `jobId` (number|string, **required**)
  - `name` (string, optional) — defaults to `"Phone Quote"`
  - `summary` (string, optional) — defaults to `""`
  - `items` (array, **required, non-empty**) — each `{ skuId, skuType?, quantity?, unitPrice?, description? }`;
    `skuType` defaults to `"Service"` (`"Service"|"Material"|"Equipment"`), `quantity` defaults to `1`.
    `unitPrice` / `description` are only included when provided.
- **Returns:** `Promise<object>` — ST's created estimate. Callers read `.id`.
- **Throws:** `"createEstimate: jobId required"`, `"createEstimate: items array required"`,
  or the raw axios error from ST (its 400 body is surfaced to the UI by the route).

---

## 10. Technicians / Employees / Payroll

### `getTechnicians()` — READ
- **Params:** none.
- **Query:** `pageSize: 200`, **single page** (no pagination).
- **Returns:** `Promise<Array<technician>>` — bare array (`res.data.data || []`).
  Note: this one uses `res.data.data` (not optional-chained) — a malformed body throws a TypeError.
- **Throws:** yes.

### `getTechnicianByName(name)` — READ
- **Params:** `name` (string, required).
- **Behavior:** substring, case-insensitive match against `t.name` or `` `${t.firstName} ${t.lastName}` ``.
- **Returns:** `Promise<object|undefined>` — the matched technician, or **`undefined`** (`Array.find`), *not* `null`.
- **Throws:** yes (propagates from `getTechnicians`).

### `getTechniciansMap()` — READ (cached 5 min)
- **Params:** none.
- **Returns:** `Promise<Map<string, string>>` — **a real `Map`**, keys are `String(tech.id)`,
  values are `t.name` → `` `${firstName} ${lastName}` `` → `` `Tech ${id}` ``.
- **Throws:** yes.

### `listEmployees({ active = true, force = false })` — READ (cached 10 min)
- **Params:** options object — `active` (boolean, default `true`), `force` (boolean, default `false`, bypasses cache).
- **Behavior:** pages at 200, max 25 pages.
- **Returns:** `Promise<Array<employee>>` — bare array.
- **Throws:** yes.
- Caller (`routes/monthlyReview.js:407-424`) reads `id, name, firstName, lastName, email, role, roleId, active`.

### `createEmployeeTask(body)` — **WRITE** (POST)
- **Params:** `body` (object):
  - **required:** `name` (string), `assignedToId` (number)
  - optional: `description` (→ `""`), `reportedById`, `priority` (→ `"normal"`; `low|normal|high|urgent`),
    `completeBy` (ISO), `jobId`, `customerId`, `employeeTaskTypeId`, `employeeTaskSourceId`,
    `businessUnitId`, `reportedDate` (→ `new Date().toISOString()`).
  - `isClosed: false` is always sent; all `null`/`undefined` keys are stripped before POST.
- **Returns:** `Promise<object>` — created task. Caller reads `.id`.
- **Throws:** `"createEmployeeTask: name is required"`, `"createEmployeeTask: assignedToId is required"`, or the axios error.

### `getJobLaborSplits(jobId)` — READ
- **Params:** `jobId` (falsy → `[]`).
- **Query:** `/payroll/v2/.../jobs/splits?jobIds=<id>&pageSize=200&active=True`, max 10 pages.
- **Returns:** `Promise<Array<split>>` — bare array.
- **Throws:** yes (401/403 if the Payroll scope isn't granted). `scoreboard.js:438-450` inspects `Promise.allSettled` rejections for 401/403/404 to emit scope warnings.
- **Row fields read:** `split`, `hoursWorked`, `hours`, `paidDurationHours`, `technicianId`, `startedOn`, `endedOn`, plus the job-match keys below.

### `getJobTimesheets(jobId)` — READ
- **Params:** `jobId` (falsy → `[]`).
- **Query:** `/payroll/v2/.../jobs/timesheets?jobIds=<id>&pageSize=200&active=True`, max 10 pages.
- **Returns:** `Promise<Array<timesheet>>` — bare array.
- **Throws:** yes.
- **Row fields read:** `dispatchedOn`, `arrivedOn`, `doneOn`, `canceledOn`, `paidDurationHours`, `technicianId`, `appointmentId`, plus job-match keys.

### `getJobGrossPayItems(jobId)` — READ
- **Params:** `jobId` (falsy → `[]`).
- **Query:** `/payroll/v2/.../gross-pay-items?jobIds=<id>&pageSize=200`, max 10 pages. (No `active` filter.)
- **Returns:** `Promise<Array<grossPayItem>>` — bare array.
- **Throws:** yes.
- **Row fields read:** `paidDurationHours`, `hoursWorked`, `regularHours`, `activity`, `payoutType`, `paidTimeType`, `startedOn`/`startsAt`, `endedOn`/`endsAt`, `date`, `employeeId`, `payrollId`, plus job-match keys.

> ⚠️ **Payroll job-match caveat.** ST does not reliably honor `jobIds=` on these three
> endpoints, so every consumer re-filters client-side via `payrollRowMatchesJob`, probing:
> `row.jobId`, `row.JobId`, `row.parentJobId`, `row.job.id`, `row.job.jobId`,
> `row.jobNumber`, `row.JobNumber`, `row.job.number`, `row.job.jobNumber`.
> A mock should put a matching `jobId` on every row it returns.

#### Entity field shape

**technician / employee** — `id`, `name`, `firstName`, `lastName`, `email`, `active`,
`role`, `roleId`, `businessUnitId` (never read).

---

## 11. Analytics helpers (composed, no new endpoints)

### `findReturnVisitJobs(startDate, endDate)` — READ
- **Params:** `startDate` (ISO, required), `endDate` (ISO, required).
- **Behavior:** pages `getJobs({modifiedOnOrAfter, modifiedBefore})` fully, then fetches each
  job's appointments with **concurrency 6**; a per-job appointment failure is warned and skipped.
- **Returns:** `Promise<Array<{ job, appointments, appointmentCount, isReturnVisit }>>`
  — only jobs with **more than one** appointment. `isReturnVisit` is always `true`.
  Order is nondeterministic (concurrent workers).
- **Throws:** yes if the job listing itself fails.

### `getReturnVisitStatsByTechnician(startDate, endDate)` — READ
- **Params:** same as above.
- **Returns:** `Promise<Array<{ techId, techName, returnVisitCount, jobs: Array<job> }>>`,
  sorted by `returnVisitCount` descending.
  `techId` comes from the earliest appointment's `technician.id`, defaulting to the **string** `"unknown"`;
  `techName` defaults to `"Unknown"`.
- **Throws:** propagates from `findReturnVisitJobs`.

### `getDailyAppointmentCounts(startDate, endDate)` — READ
- **Params:** `startDate`, `startDate` (ISO).
- **Returns:** `Promise<Record<string, number>>` — a **plain object** keyed by `YYYY-MM-DD`
  (the date part of `appt.start`) with integer counts. Appointments with no `start` are skipped.
- **Throws:** propagates from `getAllAppointmentsForDateRange`.

---

## 12. Memberships / Installed Equipment

### `createMembership(body)` — **WRITE** (POST, raw axios)
- **Params:** `body` (object) — must include `customerId` and `membershipTypeId`;
  typical extras `locationIds`, `from`, `to`, `businessUnitId`.
- **Returns:** `Promise<object>` — created membership. Caller reads `.id`.
- **Throws:** `"createMembership: customerId and membershipTypeId required"` or
  `` `createMembership failed (<status>): <detail>` ``.
- **Caller dependency:** `americanStandardService.js:235-252` catches the throw and falls
  back to `addCustomerNote` so the free membership year isn't lost. The endpoint is
  documented as *not verified against production*.

### `getRecurringServicesForMembership(membershipId)` — READ
- **Params:** `membershipId` (number|string, required).
- **Behavior:** ST **ignores all filters** on this endpoint, so it walks up to 5 pages of
  50 (ordered `Id` descending) and filters client-side on `String(s.membershipId) === String(membershipId)`.
  Returns as soon as one page yields matches. Unreliable for newer memberships —
  `fanClubService` falls back to duration-based estimation on `[]`.
- **Returns:** `Promise<Array<recurringService>>` — bare array; `[]` when nothing matches.
- **Throws:** never — swallows → `[]`.
- **Fields read:** `membershipId`, `from`, `recurrenceInterval`, `durationLength`, `firstVisitComplete`, `memo`.

### `getInstalledEquipmentByLocation(locationId)` — READ
- **Params:** `locationId` (falsy → `[]`).
- **Query:** `/equipmentsystems/v2/.../installed-equipment?locationIds=<id>&pageSize=100&active=True`, full pagination.
- **Returns:** `Promise<Array<installedEquipment>>` — bare array; on error returns **whatever was collected so far** (partial), not a throw.
- **Throws:** never.
- Callers read only `.serialNumber` (duplicate-serial guard), all inside swallowing try/catch.

### `createInstalledEquipment(body)` — **WRITE** (POST, raw axios)
- **Params:** `body` (object) — `locationId` **required**; normally also `name`,
  `manufacturer`, `model`, `serialNumber`, `installedOn`, `manufacturerWarrantyStart/End`.
  Date fields must be ISO-8601 (e.g. `"2026-07-09T00:00:00Z"`).
- **Returns:** `Promise<object>` — the created record including its new `id`.
- **Throws:** `"createInstalledEquipment: body.locationId required"` or
  `` `createInstalledEquipment failed (<status>): <detail>` ``, with an appended hint
  `" — the app/tenant is likely missing the equipment-systems WRITE scope."` on 403.
- **Caller dependency:** three services convert the throw into a persisted
  `st_write_status: "failed"` + `st_error` row; it is never rethrown to the UI.

---

## 13. Job types

### `fetchAllJobTypes()` — READ (populates `_jobTypeCache`)
- **Params:** none. **Always** hits ST (unconditional refresh).
- **Query:** `/jpm/v2/.../job-types?pageSize=200&active=True`, max 25 pages.
- **Returns:** `Promise<{ byName: Map<string, {id, name}>, byId: Map<string, string>, fetchedAt: number }>`
  — the cache object itself. `byName` keys are lowercased+trimmed names; `byId` keys are `String(id)`.
- **Throws:** yes.

### `getJobTypeNamesById()` — READ (cached 10 min)
- **Params:** none.
- **Returns:** `Promise<Map<string, string>>` — `String(jobTypeId)` → job type name.
  (`/jpm/v2/jobs` only ever returns the numeric `jobTypeId`, never the name — this is how pages resolve it.)
- **Throws:** propagates from `fetchAllJobTypes`.

### `resolveJobTypeId(name)` — READ (cached 10 min)
- **Params:** `name` (string; falsy/blank → `null`).
- **Behavior:** case-insensitive exact lookup on the trimmed lowercased name;
  a miss against a *fresh* cache triggers one forced refresh and a retry.
- **Returns:** `Promise<{ id: number, name: string } | null>` — **an object, not a bare id.**
- **Throws:** propagates from `fetchAllJobTypes`.

---

## 14. Attachments

### `createJobAttachment(jobId, fileBytes, { filename, contentType = "image/jpeg" })` — **WRITE** (multipart POST)
- **Params:**
  - `jobId` (number|string, **required**) — the **internal** ST job id, not the job number.
    Resolve typed numbers with `findJobByNumber` first.
  - `fileBytes` (Buffer, **required**)
  - options `{ filename?: string, contentType?: string = "image/jpeg" }` —
    filename defaults to `` `attachment-<Date.now()>.jpg` ``.
- **Endpoint:** `POST /forms/v2/tenant/{tenant}/jobs/{id}/attachments`, field name `file`. Requires OAuth scope `tn.frm.jobs:w`.
- **Returns:** `Promise<{ fileName: string, raw: any }>` — `fileName` falls back to the
  generated name if ST's body has no `fileName`/`filename`/`name`. Callers read `.fileName`.
- **Throws:** `"createJobAttachment: jobId required"`, `"createJobAttachment: fileBytes required"`, or
  `` `createJobAttachment(job <id>) failed (<status>): <detail>` `` — with
  `" — the app/tenant is missing the 'tn.frm.jobs:w' (Forms: jobs write) scope."` appended on 403.

---

## 15. Quick reference — return shape by function

| Function | R/W | Return |
|---|---|---|
| `getAccessToken` | R | `string` |
| `getCall` | R | single object |
| `updateCallReasonOnST` | **W** | object \| `null` (never throws) |
| `getCallRecordingStream` | R | **axios response** (stream) |
| `searchCustomersByPhone` | R | array (never throws) |
| `searchCustomersByName` | R | array (never throws) |
| `searchContactsByPhone` | R | array (never throws) |
| `getRecentJobsForCustomer` | R | array, JS-sorted (never throws) |
| `getJobsForCustomerInRange` | R | array, JS-sorted (never throws) |
| `searchLocationsByAddress` | R | array (never throws) |
| `addJobNote` | **W** | object (throws; `isJobNotFound` on 404) |
| `addCustomerNote` | **W** | object (throws) |
| `createMembership` | **W** | object (throws) |
| `applyTagToCustomer` | **W** | object (throws) |
| `findJobByNumber` | R | `{ jobId: string\|null, jobNumber: string\|null }` (never throws) |
| `getAppointments` | R | **ST envelope** |
| `getAllAppointmentsForDateRange` | R | array |
| `getJob` | R | single object |
| `getJobs` | R | **ST envelope** |
| `getJobAppointments` | R | array (single page) |
| `getTechnicians` | R | array |
| `getTechnicianByName` | R | object \| **`undefined`** |
| `listEmployees` | R | array (cached) |
| `createEmployeeTask` | **W** | object |
| `getCustomer` | R | single object (throws 404) |
| `getCustomerContacts` | R | array (never throws) |
| `getLocationById` | R | object \| `null` |
| `getLocationsByCustomer` | R | array |
| `getInstalledEquipmentByLocation` | R | array (never throws; partial on error) |
| `createInstalledEquipment` | **W** | object |
| `getRecurringServicesForMembership` | R | array (never throws) |
| `findReturnVisitJobs` | R | array of `{job, appointments, appointmentCount, isReturnVisit}` |
| `getReturnVisitStatsByTechnician` | R | array of `{techId, techName, returnVisitCount, jobs}` |
| `getDailyAppointmentCounts` | R | plain object `{ "YYYY-MM-DD": n }` |
| `getInvoicesForJob` | R | array |
| `getPayment` | R | object \| `null` |
| `getInvoicesByIds` | R | array |
| `getInvoicesByCustomer` | R | array |
| `getPurchaseOrdersForJob` | R | array (never throws) |
| `getJobByNumber` | R | object \| `null` |
| `findVendorByName` | R | object \| `null` (never throws) |
| `invalidateVendorCache` | — | `undefined` |
| `createPurchaseOrder` | **W** | object |
| `updateMaterial` | **W** | object |
| `updateEquipment` | **W** | object |
| `updateService` | **W** | object |
| `getPricebookItem` | R | single object |
| `uploadPricebookImage` | **W** | `{ path, raw, contentType, filename }` |
| `fetchPricebookImageBytes` | R | `{ bytes: Buffer, contentType: string }` |
| `attachPricebookImage` | **W** | `{ ok: true, status, data }` |
| `createMaterial` | **W** | object |
| `deactivateMaterial` | **W** | `{ method, status, data }` |
| `searchPricebookServices` | R | **ST envelope** |
| `searchPricebookMaterials` | R | **ST envelope** |
| `searchPricebookEquipment` | R | **ST envelope** |
| `searchPricebookDiscountsAndFees` | R | **ST envelope** |
| `createEstimate` | **W** | object |
| `getJobLaborSplits` | R | array |
| `getJobTimesheets` | R | array |
| `getJobGrossPayItems` | R | array |
| `getTechniciansMap` | R | **`Map<string,string>`** |
| `updateJobStatus` | **W** | `{ ok, status?, value?, data?, error?, reason? }` (never throws) |
| `updateJobType` | **W** | `{ ok, status?, value?, jobTypeId?, data?, error?, reason? }` (never throws) |
| `resolveJobTypeId` | R | `{ id, name }` \| `null` |
| `fetchAllJobTypes` | R | `{ byName: Map, byId: Map, fetchedAt }` |
| `getJobTypeNamesById` | R | **`Map<string,string>`** |
| `createJobAttachment` | **W** | `{ fileName, raw }` |
| `appendJobSummary` | **W** | `{ ok, status?, summaryLength?, data?, error? }` (never throws) |

---

## 16. Mocking checklist / gotchas

1. **Three return dialects.** ST envelope (`getJobs`, `getAppointments`, all four
   `searchPricebook*`), bare array (everything else that lists), single object.
   Getting this wrong is the #1 breakage source.
2. **Two functions return a JS `Map`,** not a plain object: `getTechniciansMap`,
   `getJobTypeNamesById`. `fetchAllJobTypes` returns an object holding two Maps.
3. **`findJobByNumber` never returns null** — it returns `{jobId:null, jobNumber:null}`,
   and `jobId` is a **string** when found.
4. **`getTechnicianByName` returns `undefined`,** not `null`.
5. **Four writes never throw** and instead return a result envelope:
   `updateJobStatus`, `updateJobType`, `appendJobSummary`, `updateCallReasonOnST`
   (the last returns `null` on failure/no-op).
6. **Eight reads never throw** and return `[]`/`null` instead: `searchCustomersByPhone`,
   `searchCustomersByName`, `searchContactsByPhone`, `searchLocationsByAddress`,
   `getCustomerContacts`, `getRecentJobsForCustomer`, `getJobsForCustomerInRange`,
   `getRecurringServicesForMembership`, plus `getInstalledEquipmentByLocation`,
   `getPurchaseOrdersForJob`, and `findVendorByName` (→ `null`).
7. **Error-tagging contracts to preserve if you simulate failures:**
   `getCustomer` 404 → `err.response.status === 404` (becomes `isCustomerNotFound`);
   `addJobNote` 404 → becomes `err.isJobNotFound`; payroll 401/403 → scope warnings on the scoreboard;
   `updateJobType` 403/422 → `reason: "locked-by-tenant"`.
8. **`getJobByNumber` returns `null` on a job-number mismatch,** by design — a mock that
   returns an arbitrary job here will reproduce the exact silent-data-corruption bug this guard exists to prevent.
9. **Env-var throws.** `createPurchaseOrder` throws if `ST_DEFAULT_SKU_ID` is unset;
   the PO-type and inventory-location resolvers throw if ST has no active rows and no env override.
   Set those env vars (or stub the internals) in the mock.
10. **Duplicated-casing fields.** `invoice.subtotal` vs `invoice.subTotal` are both read by
    different services. Emit both in fixtures.
