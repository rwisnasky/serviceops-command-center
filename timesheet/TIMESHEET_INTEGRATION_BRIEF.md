# Timesheet Integration Brief

I'm adding an employee timesheet feature to this existing dashboard — the ST-HL
integration app that connects ServiceTitan and GoHighLevel, running on Railway.
It should be a **new route/tab inside the current app**, using the login and
session that already exist here — **not** a separate site and **not** a second
login.

## First: inspect this codebase and tell me

Before writing any integration code, please inspect this repository and answer:

1. **Is the frontend React, or something else?** (plain HTML/templates, a
   different framework, etc.) This determines whether my existing mockup drops in
   directly or needs translating.
2. **How is the current / logged-in user accessed?** (an auth hook like
   `useAuth()` / `useUser()`, a React context, a session object, etc.) The
   timesheet should **auto-fill the employee name from the logged-in user**, not
   ask them to type it.
3. **How is routing or navigation set up?** (React Router, tab state, a sidebar
   config, etc.) I need to add the timesheet as another screen in that system.
4. **How does the app call its backend API?** (a fetch or axios wrapper, the base
   URL, and how the auth token/session is attached to requests.) The timesheet's
   Save and Process actions should reuse this same layer.

## The timesheet itself

An administrative **weekly grid** modeled on Grounded Home Services's paper timesheet:

- **Columns:** Wednesday → Tuesday (that day order).
- **Rows:** Regular, Overtime, PTO Time, P-Law Time, Holiday, Comp Time.
- **Live totals:** each row totals across the week (right column), each day
  totals across all types (bottom row), plus a grand total.
- **Comp Time tracker:** Banked / Earned / Used / Left.
  - Tracked **1:1** (no overtime multiplier — comp is straight time-swapping).
  - `Left = Banked + Earned − Used`, computed live.
  - "Earned" pulls from the Comp Time row entered for the week.
- **Notes** field for the pay period.

## Behavior

- **Save Draft** — keeps the sheet editable, saves progress (nothing is locked).
- **Process Timesheet** — locks the period, submits it for manager approval, and
  triggers the balance update. Should be reopenable for corrections.
- **Multiple pay periods at once** — sometimes two weeks are turned in together
  (e.g. when the payroll person is out the following week). Support submitting
  more than one period, **processed oldest-first** so the running comp balance
  stays correct (Week 1's approval updates the balance before Week 2 calculates).

## Leave rules

- **PLAW is frontloaded** and set **individually per employee** at launch
  (we're starting mid-year, so each person gets a manually-set starting balance).
  It then only **counts down** as P-Law hours are used — no ongoing accrual math.
- **Comp Time** is bidirectional at 1:1 — earned adds, used subtracts.
- The heavier balance math (running comp balance, PLAW countdown, safe
  recalculation when an approved entry is edited) should live in this Railway
  backend, with the dashboard as the front-end. Each stored entry should record
  the exact balance change it caused ("applied delta") so edits reverse-then-
  reapply cleanly without double-counting.

## Branding (Grounded Home Services)

- Deep red `#8A181A` — headings, primary brand
- Blue `#278CAE` — secondary / focus states
- Navy `#00354E` — body text, dark headers
- Bright red `#DD1F26` — primary action buttons, alerts
- Clean sans-serif (system-ui / Inter / Roboto). Professional and reliable —
  this is a service business, not a playful brand.

## What I'm bringing into this conversation

I have a finished React mockup of the timesheet grid — `GroundedTimesheet.jsx` —
with the grid, live totals, the comp tracker, and the Save Draft / Process
Timesheet actions already built and styled in Grounded Home Services's colors. It currently uses
a plain text field for the employee name and mocks the Save/Process buttons with
local state.

**Please adapt it to this app:** replace the typed employee field with the
logged-in user from this app's auth, add it to this app's routing, and wire Save
and Process to this app's API layer — so it becomes a true drop-in rather than a
standalone page. Start by mapping out how it hooks in (auth, routing, API) based
on what you find in the codebase, then make the changes.
