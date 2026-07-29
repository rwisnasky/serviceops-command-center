# ServiceOps Command Center

An internal operations dashboard for a residential plumbing and HVAC contractor.
It sits between the field-service system of record (ServiceTitan) and the
marketing CRM (GoHighLevel), and adds the reporting and workflow tooling that
neither system provides on its own: call intelligence, per-job profitability,
equipment warranty registration, timesheets, address auditing, and a dozen other
back-office tools the office used every day.

**This repository runs as a self-contained demo.** Every external system is
mocked and every customer, job, invoice, technician and phone call you'll see is
generated. See [Demo mode](#demo-mode) — it's a substantial piece of the
engineering in its own right.

### ▶ [Try the live demo](https://REPLACE-WITH-YOUR-URL)

Sign in with **demo@groundedhs.example** / **demo1234**

Or run it locally — no credentials or API keys required:

```bash
git clone https://github.com/rwisnasky/serviceops-command-center.git
cd serviceops-command-center
npm install
cp .env.example .env        # already set to DEMO_MODE=true
npm start                   # http://localhost:3000
```

> **About this repository.** This is a portfolio piece — a real production
> system, rebuilt to run standalone on generated data. It's published to be
> read, not maintained: I'm not taking issues or pull requests, and it isn't
> intended for anyone to deploy for their own use. Happy to talk through any of
> it, though.

---

## The problem

A ~15-technician residential service company runs on ServiceTitan for dispatch
and invoicing, and GoHighLevel for marketing automation. Both are good at what
they do. Neither answers the questions the office actually asks:

- *We completed 2,400 jobs last year. Which ones never got invoiced?*
- *Of the 600 calls we took last month, how many were real leads, and how many
  did we fail to book?*
- *That system we installed in March — did anyone ever register the warranty?*
- *Is this job profitable once you count the tech's actual clocked hours?*

Answering any of those meant exporting spreadsheets and reconciling by hand. The
information existed; it was just spread across two systems, a phone log, and
several people's memory. This dashboard is the layer that joins them.

**Scale:** 27 pages, 23 API route modules, 46 service modules, 10 data
repositories, ~38k lines of application code.

---

## What it does

| Area | What it solves |
|---|---|
| **Call intelligence** | Pulls every inbound call from ServiceTitan, transcribes the recording, classifies it (booked / unbooked / not-a-lead / excused), matches it to a customer and a likely job, and surfaces the ones a human should look at. Corrections write back to ServiceTitan so the call metrics stop lying. |
| **Open Jobs** | Finds completed jobs with no invoice. Sounds trivial; isn't — membership visits and warranty callbacks are *supposed* to be $0, and flagging those as lost revenue was the failure mode that made an earlier version of this report useless. |
| **Profitability** | Per-job and per-month margin using real payroll hours from ServiceTitan's Payroll v2 endpoints, not estimated labor. Rolls up to fiscal-year review. |
| **Equipment registration** | One form writes a unit to ServiceTitan's Installed Equipment *and* produces the manufacturer's warranty-registration file. Manufacturer-specific parsing (PDF for one, photo-of-the-label OCR for another) sits behind a single config-driven UI. |
| **Install Tracker** | Completed installs that were never entered into ServiceTitan, or whose warranty was never registered. Two checkboxes and a note, over live job data. |
| **Address audit** | Geocodes every service location and finds the ones that will misroute a truck: abbreviation drift, wrong ZIP, missing directional. |
| **Timesheets** | Weekly Wed→Tue hour grids with comp-time and paid-leave balance tracking, plus a tap-to-clock kiosk view. |
| **Invoice → PO** | Drop in a supplier invoice PDF; it's parsed, matched against the pricebook, and turned into a ServiceTitan purchase order. |
| **Pricebook tools** | Duplicate-SKU detection and merge, bulk rename with an undo log, image generation and attachment. |

---

## Architecture

Deliberately boring, and consistent enough that adding a feature means touching
one file in each layer:

```
page (public/*.html)
  → route (src/routes/*.js, mounted at /api/<feature>)
    → service (src/services/*.js)          business logic
      → repository (src/db/*.js)           SQLite
      → API client (src/api/*.js)          ServiceTitan / GoHighLevel / YouTube / OpenAI
```

Node 20+, Express 4, SQLite via `better-sqlite3`, server-rendered static HTML
with vanilla JS on the front end. No build step, no framework. For an internal
tool maintained by one person, the absence of a toolchain is a feature — the
thing still runs, unchanged, two years later.

Decisions worth calling out:

**One place for each external system.** All 68 ServiceTitan operations go
through `src/api/servicetitan.js`. That single chokepoint is what later made the
whole app demoable by swapping one module.

**Config-driven where variation was predictable.** Adding an equipment
manufacturer is a config object plus a parser (`src/config/equipmentTypes.js`).
Changing what counts as an "install" is one array
(`src/config/installTrackerJobTypes.js`). Auto-labelling a vendor's phone number
is one entry (`src/config/knownCallers.js`). These were the three places the
business genuinely changed its mind often, so they became data rather than code.

**The vendor API is not the shape you want.** ServiceTitan silently ignores
query parameters it doesn't recognise — a mistyped filter returns *everything*,
successfully. It returns a list envelope on some endpoints and a bare array on
others. It doesn't reliably honour `jobIds` on the payroll endpoints, so every
payroll consumer re-filters client-side. A meaningful fraction of
`servicetitan.js` is defensive work against that.

---

## AI engineering

Five features use LLMs, each with a different cost of being wrong, and the
design differs accordingly:

| Feature | Model use | How wrong answers are handled |
|---|---|---|
| Call transcription | Audio → text | Long calls are segmented with ffmpeg first; the API rejects >25 min and used to fail silently. |
| Call classification | Transcript → category, summary bullets, sentiment, spam flag | **Never auto-applied blindly.** Low-confidence classifications surface for human review; the reviewer's correction is what writes to ServiceTitan. The UI assumes the model is sometimes wrong. |
| Warranty label OCR | Photo of a data plate → serial, model, dates | Serial numbers are *also* decoded arithmetically from the manufacturer's encoding scheme, and the two results are cross-checked. |
| Invoice parsing | Supplier PDF → vendor, line items, totals | Arithmetic is verified (lines must sum to subtotal) before a PO is created. Fuzzy vendor matching **refuses to guess** when the top two candidates score within 0.01 of each other. |
| Scope-of-work parsing | Estimate document → pricebook line items | Each line is matched against the local pricebook index; unmatched lines are shown as unmatched rather than silently dropped. |

The consistent principle: the model proposes, a deterministic check or a human
disposes. Every AI path writes an audit row, and every write to an external
system is logged or reversible.

---

## Demo mode

The interesting engineering problem here is arguably not the dashboard — it's
that an app which is 80% a *client* for two proprietary SaaS APIs can be run by
anyone, with no credentials, and still behave like the real thing.

`DEMO_MODE=true` does five things.

**1. A generated company.** `src/demo/world.js` builds a coherent fake tenant in
memory at boot (~120ms): 480 customers, 2,400 jobs across 15 months with
realistic seasonality, 2,900 appointments, 1,600 invoices whose line items come
from a real pricebook and whose totals track each job type's average ticket,
plus payroll splits, purchase orders, installed equipment, memberships and 640
phone calls. It's deterministic — one integer seed produces the same company
every time, so screenshots don't rot.

It's also **deliberately imperfect**. Several pages exist specifically to find
operational defects, so the generator plants them: ~4% of completed chargeable
jobs have no invoice, ~9% of addresses have formatting drift, ~30% of completed
installs were never entered into ServiceTitan, six pricebook SKUs are duplicated
with drifted pricing. A tidy dataset would make half the app look pointless.

**2. A mock that lies exactly like the real API.** `servicetitan.mock.js`
implements all 68 functions with byte-compatible return shapes — including the
awkward ones. `getJobs` returns a list envelope but `getJobAppointments` returns
a bare array. `getTechniciansMap` returns a JS `Map`. `findJobByNumber` never
returns null; it returns `{jobId: null, jobNumber: null}`, and a *string* id
when found. `getTechnicianByName` returns `undefined`, not null. Four write
functions never throw and instead return a result envelope; eleven reads swallow
their errors to `[]`.

Reproducing those quirks isn't pedantry. Callers branch on them, and a "cleaner"
mock that normalised everything to arrays would have broken about a third of the
pages — silently, as empty tables rather than stack traces.

**3. Interception for the code that cheats.** Nine services call vendors
directly with `axios` instead of going through the client module.
`src/demo/axiosAdapter.js` swaps axios' adapter and serves those URLs from the
same generated world, so the original call sites stay untouched and readable.

**4. An outbound network guard.** `src/demo/runtime.js` patches Node's HTTP
agents and throws on any request to a non-localhost host, naming the host in the
error. This is how the previous two items were found: turn the guard on, click
every page, and every unmocked path announces itself. Nothing can reach a real
vendor API, including by accident.

**5. AI without a key.** `src/api/openaiClient.js` returns either a real OpenAI
client or a canned shim. The shim routes on the request — model, JSON schema
name, prompt keywords — and returns contextually correct output seeded from a
hash of the prompt, so the same input always yields the same result and
different inputs yield different ones. Transcripts read like real service calls,
including some the classifier plausibly gets wrong. Set `DEMO_AI=live` with a
key to run the real thing.

Demo mode **fails safe**: it is the default, including when `DEMO_MODE` is unset
entirely, and you have to opt out with `DEMO_MODE=false`. Cloning the repo and
running `npm start` without reading anything should never quietly point at
production.

Additionally: pollers and crons don't start, every phone number is in the
`555-01XX` range that NANP permanently reserves for fiction, and there are two
control endpoints:

```
GET  /api/demo/status    # mode, seed, world stats, mutations made this session
POST /api/demo/reset     # regenerate the world and reseed the database
```

---

## Running it

**Locally**

```bash
npm install
cp .env.example .env
npm start
```

Node 20 or newer (`.nvmrc` pins 22, which is what the deploy target runs). The
demo database is created and seeded automatically on first boot.

`better-sqlite3` and `bcrypt` are native modules. Both ship prebuilt binaries
for current Node versions, so a normal install downloads rather than compiles.
If `npm install` does try to compile and fails on `ModuleNotFoundError: No
module named 'distutils'`, that's Python 3.12+ having removed `distutils` while
the bundled node-gyp still imports it — the fix is to use a Node version that
has a prebuilt binary rather than to fight node-gyp:

```bash
nvm use          # picks up .nvmrc
rm -rf node_modules package-lock.json && npm install
```

**Deploying** (Railway / Render / any Node host)

```
DEMO_MODE=true
SESSION_SECRET=<openssl rand -hex 32>
DB_PATH=/tmp/calls.db
NODE_ENV=production
```

**Deliberately no persistent volume.** Everything the app stores is derived
from `DEMO_SEED`, so ephemeral storage means each cold start rebuilds the world
from scratch — roughly 250 ms to seed the database and about a second to write
the month-end cache. The upside is that a public demo can't be permanently
vandalised: anything a visitor deletes comes back on the next restart, and
`POST /api/demo/reset` forces it on demand. The only thing lost is login
sessions, which for a shared demo account is not a loss.

Running against real systems is the case that needs a volume, with
`DB_PATH` pointing inside it — otherwise the database resets on every deploy.

`railway.json` and `nixpacks.toml` are included. The nixpacks config installs
`poppler-utils`, `tesseract`, `ffmpeg` and `zip` — used for PDF rasterisation,
OCR and audio segmentation. The demo doesn't need them, but keeping the build
identical to production keeps it honest. Health check is at `/health`.

**Useful commands**

```bash
npm run demo:seed               # seed the database (idempotent)
npm run demo:reseed             # force a rewrite
npm run add-user -- a@b.com password
DEMO_SEED=42 npm start          # a completely different fake company
DEMO_LATENCY_MS=250 npm start   # visible loading states, for recording a walkthrough
```

---

## Repository layout

```
src/
├── index.js              entry: DB init, seeding, pollers, cron, route mounting
├── api/                  external clients — each a dispatcher choosing live vs. mock
│                         (servicetitan, gohighlevel, youtube, openai)
├── config/               config-driven behaviour (equipment types, install job
│                         types, known callers, office roster)
├── db/                   SQLite schema + one repository per domain
├── routes/               Express routers, one per feature area
├── services/             business logic — 46 modules
└── demo/                 the demo layer (~8.6k lines)
    ├── world.js            generates the fake tenant
    ├── catalog.js          static content pools
    ├── rng.js              seeded deterministic PRNG
    ├── servicetitan.mock.js
    ├── gohighlevel.mock.js
    ├── youtube.mock.js
    ├── openai.mock.js
    ├── axiosAdapter.js     intercepts raw-axios vendor calls
    ├── runtime.js          mode switch, poller/cron suppression, network guard
    └── seed.js             populates SQLite
public/                   27 pages — static HTML + vanilla JS
docs/                     design notes
```

`CLAUDE.md` is an orientation map of the codebase — worth reading before
exploring.

---

## Notes

The original production deployment ran on Railway with a persistent volume,
auto-deploying on push, serving a live tenant. This build is that codebase with
every external dependency replaced by a mock, all client data replaced by
generated data, and the company renamed. No real customer, employee, address,
phone number or credential appears anywhere in this repository or its history.

"Grounded Home Services" is fictional. Every phone number is in the `555-01XX`
block that the North American Numbering Plan reserves for fiction, and the
service area, staff and customer list are invented.

ServiceTitan and GoHighLevel are named because they are what the system
genuinely integrates with — the shape of both APIs drove most of the
interesting decisions here. They are the trademarks of their respective owners
and are referenced descriptively only.

---

## About

Built and maintained by **Ryan Wisnasky** while running operations and
marketing systems at [Grounded Marketing](https://groundedagency.com) — where
this started as a way to answer questions the two systems of record couldn't,
and grew into the tool the office ran on daily.

Design, architecture, and implementation are mine, with Claude used heavily
throughout as a pair — including for the demo layer that lets this repository
run standalone.

Happy to walk through any part of it: **rwisnasky@gmail.com**

---

## License

© 2026 Ryan Wisnasky. All rights reserved.

Published for reading and evaluation. No license is granted to use, copy,
modify, or distribute this code. Get in touch if you want to do something with
it and we'll sort it out.
