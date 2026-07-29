# Calls Section Rebuild — PhoneCallRecap-Style

## Goal

Reframe the Command Center's Calls page around the PhoneCallRecap.ai model: **a call comes in → you see a crisp 3-4 bullet recap with a prominent customer-happiness badge → one click posts it to ServiceTitan.** Add an upload-a-recording entry point so the recap flow works for calls that weren't polled from ST. Keep ST write targets the same (job note if matched, customer note otherwise).

## Why this matters

The current page is a power-user cockpit — two dropdowns per card (Call Type + Call Reason), status chips, transcripts, manual job ID entry, confidence percentages. PhoneCallRecap's appeal is **scannability and speed**: a CSR should be able to glance at a stack of calls and post them without thinking. The analytical detail is still useful, but it belongs behind an "Advanced" disclosure, not in the primary visual.

---

## The new card, at a glance

```
┌─────────────────────────────────────────────────────────────────┐
│ (614) 555-0142   ✓ Marla Henderson · Job #2602739               │
│ Apr 17, 2026 · 3:42 PM · 2m18s                                  │
│                                                                 │
│   ┌─────────────┐                                               │
│   │  😊  HAPPY  │   ← large sentiment badge, color-coded        │
│   └─────────────┘                                               │
│                                                                 │
│   • Water heater installed last Tuesday is leaking from         │
│     the pressure relief valve                                   │
│   • Customer noticed it this morning; no major flooding         │
│   • Wants a tech back out as soon as possible                   │
│   • Asked about warranty coverage on the part                   │
│                                                                 │
│   → Dispatch tech for warranty callback today if possible       │
│                                                                 │
│   [ 📝 Post to ServiceTitan ]      ▼ Advanced    ✕ Dismiss      │
└─────────────────────────────────────────────────────────────────┘
```

Collapsed "Advanced" reveals: Call Type picker, Call Reason picker, manual job # override, transcript, confidence score, AI model. Everything you have today — just out of the way.

---

## Changes by file

### Backend

**`src/services/classificationService.js`** — update the OpenAI system prompt.
- Replace the current `summary` (2–3 sentence prose) with `summaryBullets` — a JSON array of 3–4 short bullets.
- Keep a derived `summary` field (bullets joined with `•`) for backward compatibility with existing records and the ST note writer.
- Rename sentiment semantics in outputs from `positive/neutral/negative` to `happy/neutral/unhappy` in the UI layer only — keep the DB field unchanged so no migration is needed.

Prompt change (summary rule):
> "summaryBullets": array of 3–4 bullets. Each bullet is one line, max ~15 words, focused on what a dispatcher needs to know. Order: reason for call → key details → outcome/commitments → follow-up needed. Skip bullets that don't apply rather than padding.

**`src/services/callProcessingService.js`** — update `buildNoteText()` to format the ST note as bullets instead of the current paragraph. The ST note ends up looking like:

```
📞 Phone Call Recap — (614) 555-0142 · Apr 17 3:42 PM · 2m18s

• Water heater installed last Tuesday is leaking from the PRV
• No major flooding; customer caught it early
• Wants a tech back out today if possible
• Asked about warranty coverage

→ Dispatch tech for warranty callback today
Customer Happiness: 😊 Happy
```

**`src/db/callRepository.js`** — add one new column, `summary_bullets TEXT` (JSON). Backward-compatible: existing records with only `summary` keep working; the UI falls back to splitting `summary` on sentence boundaries when `summary_bullets` is null.

**`src/routes/calls.js`** — add one new endpoint:

`POST /api/calls/upload` (multipart)
- fields: `recording` (file, required), `callerPhone` (optional), `callerName` (optional), `notes` (optional free-text context for the AI)
- Saves the upload to the same tmp dir as polled recordings, runs the existing transcription → classification → matching pipeline, inserts a new DB record with a synthetic ID (`upload-<uuid>`), and returns the completed record.
- Uses `multer` (already a common dep; add to `package.json` if not present).
- Rejects files >25 MB and non-audio mimetypes.

**`src/services/uploadedCallService.js`** — new thin wrapper that reuses `transcribeCallRecording`, `classifyCall`, and `matchCallToCustomer` without needing a ServiceTitan call ID. Mirrors the core of `processCall` but skips steps 1, 3 (recording is already on disk), and 8 (keep the upload until processed, then clean up).

### Frontend

**`public/calls.html`** — full rewrite. Structure:

1. **Toolbar row** — stats bar on left (unchanged); on the right: `↺ Refresh`, `🔃 Poll ST`, `⬆️ Upload Recording` (new).
2. **Upload modal** (new, hidden by default) — drag-and-drop zone, optional phone field, "Analyze" button, inline status during processing. Closes itself and prepends the new recap card on success.
3. **Recap card grid** — rebuilt to the mockup above. Key implementation notes:
   - Sentiment badge: one of three states, large pill with icon + label, color-coded via existing CSS vars (`--accent` for happy, `--muted` for neutral, `--danger`/`--accent2` for unhappy).
   - Bullets render from `call.summaryBullets` if present, else fall back to splitting `call.summary` on `. ` / `• `.
   - "Post to ServiceTitan" is a single big button. No job-number input visible by default. If the pipeline couldn't match a job or customer, the button opens the Advanced drawer with the job-number field focused and an inline hint.
   - "Advanced" is a `<details>` block. Inside: the Call Type picker, the Call Reason picker, the manual job # field, the transcript `<details>` (nested), confidence, model, match method. Everything the current card shows, just demoted.
   - "Dismiss" stays as a low-visual-weight link on the right.

4. **Keep existing behavior**: polling on processing calls, toast notifications, stats bar, show-dismissed toggle, `ciFindJob` related-jobs picker. Reuse the functions as-is where possible; only the rendering (`renderCiCallCard`) gets rewritten.

---

## Step-by-step implementation order

Suggested order so each step is independently testable and the page is never broken mid-rebuild:

1. **Prompt + DB** — update `classificationService.js` to emit `summaryBullets`; add the `summary_bullets` column via a migration in `src/db/`. Verify with `POST /api/calls/test-classify`.
2. **Note writer** — update `buildNoteText()` in `callProcessingService.js` to render the bullet-style ST note. Verify by running an apply-note on a test call.
3. **Upload endpoint + service** — add `/api/calls/upload`, `uploadedCallService.js`, and install `multer`. Test with `curl -F recording=@sample.mp3 http://localhost:3000/api/calls/upload`.
4. **Frontend rewrite** — rewrite `public/calls.html`. Start from the existing file (don't delete — copy to `calls.html.bak` first). Build new `renderCiCallCard` rendering the new layout; keep all `ci*()` JS functions.
5. **Upload modal UI** — add modal markup and JS that hits `/api/calls/upload`, streams progress, inserts the returned card on success.
6. **Polish pass** — sentiment badge colors, bullet spacing, advanced drawer animation, dismiss affordance, mobile responsive breakpoint.

Estimate: ~half a day of focused work. The riskiest step is the prompt rework (bullet quality is subjective — expect one or two iteration cycles on the wording).

---

## Open decisions (flag before implementation)

- **"Happy" vs "positive" label** — the user-facing word. I'd go with **Happy / Neutral / Unhappy** to match PhoneCallRecap's tone; the DB and internal API stays `positive/neutral/negative`. Confirm.
- **Sentiment color mapping** — propose: Happy = green accent, Neutral = muted gray, Unhappy = red `--danger`. The current CSS has `--accent` as red, so "happy" needs a green variable added to `styles.css` (or reuse `--accent3`). Confirm.
- **Post to ST when no customer/job match** — should the button stay disabled, or open the Advanced drawer? The mockup assumes it opens the drawer. Confirm.
- **Upload file size cap** — 25 MB default (roughly 30-40 min of compressed audio). Raise if you need longer calls.
- **Delete the Call Type / Call Reason ST writeback on dismiss?** — currently they're written back to the ST call record best-effort. In the one-click flow, should we still write them when the user clicks "Post to ST" without opening Advanced? Propose: **yes, always write the AI-inferred values unless the user overrode them** — that preserves the current ST hygiene benefit without forcing the user to click twice.

---

## What does NOT change

- Webhook receiver, polling service, transcription service, matching service, recording service, queue worker — all untouched.
- Stats endpoint, dismiss endpoint, category override endpoint, call-type/call-reason PATCH endpoints — untouched.
- ST tag map and tag writeback — untouched.
- All other Command Center pages.
