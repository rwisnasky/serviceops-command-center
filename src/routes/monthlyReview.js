/**
 * routes/monthlyReview.js
 *
 *   GET /api/monthly-review/:year/:month        — full review
 *   GET /api/monthly-review/current              — current calendar month (live)
 *   GET /api/monthly-review/list                 — list cached months
 */

const express = require("express");
const fs = require("fs");
const router = express.Router();

const loader  = require("../services/monthlyDataLoader");
const review  = require("../services/monthlyReviewService");
const fy      = require("../services/fiscalYear");
const fyAgg   = require("../services/fiscalAggregator");
const openJobs = require("../services/openJobsService");
const jobReviewRepo = require("../db/jobReviewRepository");
const { OFFICE_TEAM_NAMES } = require("../config/officeTeam");

// Look up a single job by its ServiceTitan job number and return:
//   • the scheduled appointment(s) with real start/end times from ST
//   • the actual arrival time(s) from any cached timesheet data
//   • a side-by-side comparison so the user can sanity-check on-time stats
//
// Used by the "Job lookup" tool on the monthly review page to spot-check
// individual jobs against what dispatch shows in ServiceTitan.
router.get("/job-lookup/:jobNumber", async (req, res) => {
  try {
    const jn = String(req.params.jobNumber).trim();
    if (!jn || !/^\d+$/.test(jn)) {
      return res.status(400).json({ error: "Invalid job number" });
    }
    const st = require("../api/servicetitan");
    const job = await st.getJobByNumber(jn);
    if (!job) return res.status(404).json({ error: `Job ${jn} not found in ServiceTitan` });

    const appts = await st.getJobAppointments(job.id);

    // Look up actual arrivals from any cached month that contains this job
    const fs = require("fs");
    const path = require("path");
    const arrivals = [];
    if (fs.existsSync(loader.CACHE_ROOT)) {
      for (const dir of fs.readdirSync(loader.CACHE_ROOT)) {
        const tsPath = path.join(loader.CACHE_ROOT, dir, "timesheets.json");
        if (!fs.existsSync(tsPath)) continue;
        const ts = JSON.parse(fs.readFileSync(tsPath, "utf8"));
        for (const e of ts) {
          if (e.activity !== "Working") continue;
          if (String(e.jobNumber).trim() !== jn) continue;
          arrivals.push({
            tech: e.tech,
            date: typeof e.date === "string" ? e.date.slice(0, 10) : e.date,
            startTime: e.startTime,
            endTime: e.endTime,
            durationHours: e.durationHours,
          });
        }
      }
    }
    arrivals.sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.startTime || "").localeCompare(b.startTime || ""));

    res.json({
      job: {
        jobNumber: job.jobNumber,
        jobId: job.id,
        type: job.jobTypeName || job.jobType,
        status: job.jobStatus || job.status,
        customerId: job.customerId,
        createdOn: job.createdOn,
        completedOn: job.completedOn,
        summary: job.summary || "",
      },
      appointments: (appts || []).map(a => ({
        appointmentId: a.id,
        appointmentNumber: a.appointmentNumber,
        scheduledStart: a.start,
        scheduledEnd: a.end,
        arrivalWindowStart: a.arrivalWindowStart,
        arrivalWindowEnd: a.arrivalWindowEnd,
        status: a.status,
        technicianIds: a.technicianIds || [],
      })),
      arrivals,
    });
  } catch (e) {
    console.error("[monthly-review/job-lookup]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Backfill ServiceTitan appointment data for a past month into the cache.
// One-shot, idempotent — safe to call multiple times.
router.post("/refresh-appointments/:year/:month", async (req, res) => {
  try {
    const year  = parseInt(req.params.year, 10);
    const month = parseInt(req.params.month, 10);
    if (!year || !month || month < 1 || month > 12) {
      return res.status(400).json({ error: "Invalid year/month" });
    }
    console.log(`[monthly-review] refresh-appointments ${year}-${month}`);
    const appts = await loader.loadLiveAppointmentsForMonth(year, month);
    loader.writeAppointmentsCache(year, month, appts);
    res.json({ ok: true, year, month, count: appts.length });
  } catch (e) {
    console.error("[monthly-review/refresh-appointments]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Refresh ServiceTitan jobs for a month into the cache. Preserves existing
// timesheets.json + appointments.json on disk (we only re-pull jobs) so the
// Open Jobs page can be made current without re-importing payroll data.
//
// IMPORTANT: this MERGES the live pull with the existing cache rather than
// overwriting it. Live mode (/jpm/v2/jobs) doesn't expose material / labor /
// hours / GM, so a naive overwrite would destroy the xlsx-imported cost data
// and leave the Monthly Review page showing $0 billing on every job. The
// merge logic (monthlyDataLoader.mergeLiveWithCache) keeps cost-bearing rows
// intact and only refreshes status / summary / technicians from live.
// Idempotent — safe to call as often as you like.
router.post("/refresh-jobs/:year/:month", async (req, res) => {
  try {
    const year  = parseInt(req.params.year, 10);
    const month = parseInt(req.params.month, 10);
    if (!year || !month || month < 1 || month > 12) {
      return res.status(400).json({ error: "Invalid year/month" });
    }
    const path = require("path");
    console.log(`[monthly-review] refresh-jobs ${year}-${month}`);
    const liveJobs = await loader.loadLiveJobsForMonth(year, month);
    const jobs = loader.mergeLiveWithCache(year, month, liveJobs);

    // Preserve whatever timesheets / appointments are already cached for this
    // month — we don't have a live timesheets pull yet, and re-fetching
    // appointments isn't needed just to refresh job status/billed totals.
    const dir = loader.cacheDir(year, month);
    const tsPath   = path.join(dir, "timesheets.json");
    const apptPath = path.join(dir, "appointments.json");
    const timesheets   = fs.existsSync(tsPath)   ? JSON.parse(fs.readFileSync(tsPath, "utf8"))   : [];
    const appointments = fs.existsSync(apptPath) ? JSON.parse(fs.readFileSync(apptPath, "utf8")) : null;

    loader.writeCache(year, month, jobs, timesheets, appointments);
    res.json({
      ok: true,
      year,
      month,
      jobsCount:        jobs.length,
      liveJobsCount:    liveJobs.length,
      timesheetsCount:  timesheets.length,
      appointmentCount: appointments ? appointments.length : 0,
      importedAt:       new Date().toISOString(),
    });
  } catch (e) {
    console.error("[monthly-review/refresh-jobs]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Convenience refresh: current calendar month + previous month. Captures
// in-flight jobs in the current month AND any jobs from last month that have
// since closed / been invoiced. Used by the "Refresh from ServiceTitan"
// button on the Open Jobs page.
router.post("/refresh-jobs-recent", async (req, res) => {
  try {
    const path = require("path");
    const now = new Date();
    const months = [];
    // Previous month, then current month — order matters for the loader log.
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    months.push({ year: prev.getFullYear(), month: prev.getMonth() + 1 });
    months.push({ year: now.getFullYear(),  month: now.getMonth() + 1 });

    const results = [];
    for (const { year, month } of months) {
      console.log(`[monthly-review] refresh-jobs-recent ${year}-${month}`);
      const liveJobs = await loader.loadLiveJobsForMonth(year, month);
      // Merge with cache so prior-month cost data (materials / labor / hours
      // / GM from the WIP + JC xlsx imports) is preserved across refreshes.
      // Without this, refreshing wipes out everything except status + billed.
      const jobs = loader.mergeLiveWithCache(year, month, liveJobs);
      const dir = loader.cacheDir(year, month);
      const tsPath   = path.join(dir, "timesheets.json");
      const apptPath = path.join(dir, "appointments.json");
      const timesheets   = fs.existsSync(tsPath)   ? JSON.parse(fs.readFileSync(tsPath, "utf8"))   : [];
      const appointments = fs.existsSync(apptPath) ? JSON.parse(fs.readFileSync(apptPath, "utf8")) : null;
      loader.writeCache(year, month, jobs, timesheets, appointments);
      results.push({ year, month, jobsCount: jobs.length, liveJobsCount: liveJobs.length });
    }
    res.json({ ok: true, refreshed: results, importedAt: new Date().toISOString() });
  } catch (e) {
    console.error("[monthly-review/refresh-jobs-recent]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Open jobs report — aging WIP, missed invoices, scheduled work.
// Every job is enriched with any review status the office has set
// (reviewed / escalated / resolved) plus the most-recent note.
router.get("/open-jobs", (req, res) => {
  try {
    const data = openJobs.buildOpenJobsReport();
    const statusByJob = jobReviewRepo.list();

    const enrich = j => {
      const s = statusByJob[j.jobNumber];
      if (!s) return { ...j, reviewStatus: "open" };
      return {
        ...j,
        reviewStatus:      s.status,
        reviewNotes:       s.notes || "",
        reviewedBy:        s.reviewed_by || "",
        reviewedAt:        s.reviewed_at || s.updated_at || null,
        stNoteSyncedAt:    s.st_note_synced_at || null,
        stNoteSyncedText:  s.st_note_synced_text || null,
        stNoteError:       s.st_note_error || null,
        // Corrections — surfaced so the review modal can pre-fill the
        // dropdown/input with the current override, and so the open-jobs
        // table can render a "corrected" badge alongside the row.
        correctedStatus:   s.corrected_status || "",
        correctedJobType:  s.corrected_job_type || "",
        statusSyncedAt:    s.status_synced_at || null,
        jobTypeSyncedAt:   s.job_type_synced_at || null,
      };
    };

    for (const k of Object.keys(data.buckets || {})) {
      data.buckets[k] = data.buckets[k].map(enrich);
    }
    if (Array.isArray(data.allOpen)) data.allOpen = data.allOpen.map(enrich);

    // Roll-up so the UI can size its status filter pills
    const statusCounts = { open: 0, reviewed: 0, escalated: 0, resolved: 0 };
    for (const j of data.allOpen || []) {
      const s = j.reviewStatus || "open";
      if (statusCounts[s] != null) statusCounts[s] += 1;
    }
    data.statusCounts = statusCounts;

    res.json(data);
  } catch (e) {
    console.error("[open-jobs]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// List every job-level review status (for offline use / quick audits).
router.get("/job-review-status", (req, res) => {
  try {
    res.json({ statuses: jobReviewRepo.list() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upsert (or clear) the review status for a single job.
// Body: {
//   status:              'reviewed'|'escalated'|'resolved'|'open',
//   notes?:              string,                 // legacy single-string notes field
//   appendNote?:         string,                 // append a new entry to job_review_notes
//   correctedStatus?:    string | null,          // override ST job status (null clears)
//   correctedJobType?:   string | null,          // override ST job type   (null clears)
//   reviewedBy?:         string,
//   pushToServiceTitan?: boolean  // when true, also POST the note to the ST job
// }
router.post("/job-review-status/:jobNumber", async (req, res) => {
  try {
    const jobNumber = String(req.params.jobNumber || "").trim();
    if (!jobNumber) return res.status(400).json({ error: "jobNumber required" });

    const {
      status,
      notes,
      appendNote,
      correctedStatus,
      correctedJobType,
      reviewedBy,
      pushToServiceTitan,
    } = req.body || {};

    // Best-effort attribution: prefer body, then the logged-in session user.
    let actor = reviewedBy;
    if (!actor && req.session?.userId) {
      try {
        const { findById } = require("../db/userRepository");
        const u = findById(req.session.userId);
        actor = u?.display_name || u?.email || null;
      } catch (_) {}
    }

    // Upsert the row first (status/notes/corrections).
    const row = jobReviewRepo.upsert({
      jobNumber,
      status,
      notes,
      reviewedBy: actor,
      correctedStatus,
      correctedJobType,
    });

    // Append a new note entry, if the caller asked for one. We do this
    // after upsert so the parent row is guaranteed to exist.
    if (appendNote && String(appendNote).trim()) {
      jobReviewRepo.appendNote({
        jobNumber,
        text: String(appendNote).trim(),
        author: actor,
      });
    }

    // ── Optional: push the note into the actual ServiceTitan job-notes feed
    //    so it shows up for accounting when they pull up the job in ST.
    //    Skipped automatically if the same text was already synced, or if
    //    the row was cleared (status='open' / row === null).
    let stSync = null;
    if (pushToServiceTitan && row) {
      const noteText = formatStNoteText(jobNumber, row);
      if (row.st_note_synced_text === noteText) {
        stSync = { skipped: true, reason: "Same note already in ServiceTitan" };
      } else {
        try {
          const st = require("../api/servicetitan");
          const job = await st.getJobByNumber(jobNumber);
          if (!job || !job.id) {
            throw new Error(`Job ${jobNumber} not found in ServiceTitan`);
          }
          await st.addJobNote(job.id, noteText);
          jobReviewRepo.markStSynced(jobNumber, noteText, null);
          stSync = { ok: true, jobId: job.id, text: noteText };
        } catch (err) {
          const msg = err.response?.data?.title || err.message || String(err);
          jobReviewRepo.markStSynced(jobNumber, null, msg);
          stSync = { ok: false, error: msg };
          console.warn(`[job-review-status] ST note push failed for ${jobNumber}: ${msg}`);
        }
      }
    }

    // Return the fresh row (it may have been mutated by markStSynced)
    const finalRow = jobReviewRepo.get(jobNumber);
    res.json({ ok: true, jobNumber, row: finalRow, stSync });
  } catch (e) {
    console.error("[job-review-status]", e.message);
    res.status(400).json({ error: e.message });
  }
});

// Build the note body posted to ST. Kept consistent so the "skip if synced"
// check works (the comparison is text-equality on st_note_synced_text).
function formatStNoteText(jobNumber, row) {
  const status = (row.status || "").toUpperCase();
  const who    = row.reviewed_by ? ` — ${row.reviewed_by}` : "";
  const note   = (row.notes || "").trim();
  const tail   = note ? `\n${note}` : "";
  return `[Open Jobs review] ${status}${who}${tail}`;
}

// Build the per-note ST body used by the append-only notes log on the
// Resolved tab push flow. We include the author for audit visibility.
function formatStNoteEntryText(entry) {
  const who = entry.author ? ` — ${entry.author}` : "";
  return `[Monthly Review note]${who}\n${entry.text}`;
}

// ──────────────────────────────────────────────────────────────────────
// Escalation assignment — surfaces the office/CSR team in a dropdown and
// creates a ServiceTitan Employee Task tied to the job, so the assigned
// person gets it in their ST task inbox.
// ──────────────────────────────────────────────────────────────────────

// Office / CSR team allowlist. When EMPTY, the /employees route returns
// ALL active employees. With entries populated, the dropdown is limited
// to people whose ST display name (or firstName + lastName, or email)
// contains one of these strings (case-insensitive).
//
// The ORDER here is preserved in the dropdown — the /employees route
// sorts matches by their index in this array, so Carol shows first,
// Cody shows last, regardless of alphabetical order.
// The list lives in ../config/officeTeam.js (shared with the Call Reviews
// classifier so office staff are never mistaken for the customer).

// Find which allowlist entry an employee matches (returns the index, or -1).
// Used both to filter and to preserve the allowlist's display order.
function _officeTeamIndex(emp) {
  if (OFFICE_TEAM_NAMES.length === 0) return 0; // unfiltered: everyone passes
  const haystack = [
    emp.name,
    emp.firstName && emp.lastName ? `${emp.firstName} ${emp.lastName}` : "",
    emp.email,
  ].filter(Boolean).join(" ").toLowerCase();
  return OFFICE_TEAM_NAMES.findIndex(n => haystack.includes(String(n).toLowerCase()));
}

function _matchesOfficeTeam(emp) {
  return _officeTeamIndex(emp) !== -1;
}

// GET /api/monthly-review/employees
// Returns the office/CSR team for the escalation dropdown.
// Filtered to active employees; further filtered by OFFICE_TEAM_NAMES
// if the allowlist is populated (otherwise returns all active employees).
router.get("/employees", async (req, res) => {
  try {
    const st = require("../api/servicetitan");
    const force = String(req.query.force || "") === "1";
    const all = await st.listEmployees({ active: true, force });
    const list = all
      .filter(_matchesOfficeTeam)
      .map(e => ({
        id:        e.id,
        name:      e.name || [e.firstName, e.lastName].filter(Boolean).join(" "),
        email:     e.email || "",
        role:      e.role || e.roleId || "",
        active:    e.active !== false,
        _order:    _officeTeamIndex(e),
      }))
      // Sort by allowlist order so the dropdown matches the order the office
      // gave us; fall back to alphabetical when no allowlist is configured.
      .sort((a, b) => {
        if (OFFICE_TEAM_NAMES.length === 0) return a.name.localeCompare(b.name);
        return a._order - b._order;
      })
      .map(({ _order, ...rest }) => rest);
    res.json({
      count: list.length,
      filtered: OFFICE_TEAM_NAMES.length > 0,
      allowlistSize: OFFICE_TEAM_NAMES.length,
      employees: list,
    });
  } catch (e) {
    console.error("[monthly-review/employees]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/monthly-review/job-review-status/:jobNumber/create-st-task
// Body:
//   {
//     assignedToId:    number   (required — ST employee ID)
//     assignedToName?: string   (display name, used in the audit note)
//     name?:           string   (defaults to "Review Job #<n> — <customer>")
//     description?:    string   (defaults to the escalation note text)
//     priority?:       'low' | 'normal' | 'high' | 'urgent'
//     dueInDays?:      number   (default 7)
//   }
//
// Creates the ST employee task linked to the job, then appends a record
// to the job_review_notes log so the row shows "✓ ST task #N assigned
// to <name>".
router.post("/job-review-status/:jobNumber/create-st-task", async (req, res) => {
  try {
    const st = require("../api/servicetitan");
    const jobNumber = String(req.params.jobNumber || "").trim();
    if (!jobNumber) return res.status(400).json({ error: "jobNumber required" });

    const {
      assignedToId,
      assignedToName,
      name,
      description,
      priority,
      dueInDays,
    } = req.body || {};
    if (!assignedToId) return res.status(400).json({ error: "assignedToId required" });

    // Look up the ST internal job ID + the customer ID + a default name.
    const job = await st.getJobByNumber(jobNumber);
    if (!job) return res.status(404).json({ error: `Job ${jobNumber} not found in ServiceTitan` });
    let customerName = "";
    try {
      if (job.customerId) {
        const cust = await st.getCustomer(job.customerId);
        customerName = cust?.name || "";
      }
    } catch (_) { /* best effort — don't fail the assignment over a name */ }

    // Default due date — N days out, end of day UTC
    const days = Number.isFinite(Number(dueInDays)) ? Number(dueInDays) : 7;
    const due = new Date();
    due.setUTCDate(due.getUTCDate() + days);
    due.setUTCHours(23, 0, 0, 0);

    // Pull the most recent escalation note for this job (if any) to use as
    // the default task description — saves the user retyping context.
    let existingNote = "";
    try {
      const repo = require("../db/jobReviewRepository");
      const row  = repo.get(jobNumber);
      if (row?.notes) existingNote = row.notes;
    } catch (_) { /* best effort */ }

    const taskName = (name || "").trim() ||
      `Review Job #${jobNumber}${customerName ? ` — ${customerName}` : ""}`;
    const taskDesc = (description || "").trim() ||
      (existingNote
        ? `Escalated from Open Jobs dashboard.\n\nReviewer note:\n${existingNote}`
        : `Escalated from Open Jobs dashboard for follow-up.`);

    const result = await st.createEmployeeTask({
      name:         taskName,
      description:  taskDesc,
      assignedToId: Number(assignedToId),
      priority:     priority || "normal",
      completeBy:   due.toISOString(),
      jobId:        job.id,
      customerId:   job.customerId || null,
    });

    // Audit trail — append a note on the review record so the dashboard
    // can show "✓ ST task #N assigned to <name>" beside the row.
    try {
      const repo = require("../db/jobReviewRepository");
      const actor = req.session?.userId
        ? (() => {
            try {
              const { findById } = require("../db/userRepository");
              const u = findById(req.session.userId);
              return u?.display_name || u?.email || "dashboard";
            } catch (_) { return "dashboard"; }
          })()
        : "dashboard";
      repo.appendNote({
        jobNumber,
        text: `✓ ST task #${result?.id || "?"} assigned to ${assignedToName || ("employee #" + assignedToId)} — due ${due.toISOString().slice(0, 10)}.`,
        author: actor,
      });
    } catch (e) {
      console.warn("[create-st-task] audit-note append failed:", e.message);
    }

    res.json({
      ok:           true,
      taskId:       result?.id || null,
      taskName,
      dueBy:        due.toISOString(),
      assignedToId,
      assignedToName: assignedToName || null,
      raw:          result,
    });
  } catch (e) {
    // Surface ST-side validation errors so the UI can show what's wrong
    const stStatus = e.response?.status;
    const stData   = e.response?.data;
    console.error("[create-st-task]", e.message, stStatus, stData);
    res.status(500).json({
      error: e.message,
      stStatus,
      stData,
    });
  }
});

// ──────────────────────────────────────────────────────────────────────
// Resolved tab — list resolved jobs with sync state, push corrections + new
// notes to ServiceTitan in a batch.
// ──────────────────────────────────────────────────────────────────────

// GET /api/monthly-review/resolved
// Returns all resolved rows with their note log and per-field sync flags.
//   ?onlyUnsynced=1   limit to rows that have something pending
router.get("/resolved", (req, res) => {
  try {
    const onlyUnsynced = String(req.query.onlyUnsynced || "") === "1";
    const rows = onlyUnsynced
      ? jobReviewRepo.listResolvedUnsynced()
      : jobReviewRepo.listResolved();
    res.json({
      count: rows.length,
      pendingCount: rows.filter(r => r.pendingPush).length,
      rows,
    });
  } catch (e) {
    console.error("[resolved] list failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/monthly-review/resolved/push-to-st
// Batch-push corrections + unsynced notes for every resolved row to ST.
// Body: { jobNumbers?: string[] }   restrict to a subset if provided.
// Each row's result is tracked independently — a failed jobType PATCH won't
// stop the corresponding status PATCH or note posts on the same job.
router.post("/resolved/push-to-st", async (req, res) => {
  try {
    const filter = Array.isArray(req.body?.jobNumbers)
      ? new Set(req.body.jobNumbers.map(String))
      : null;
    const rows = jobReviewRepo.listResolvedUnsynced()
      .filter(r => !filter || filter.has(r.job_number));
    const results = [];
    for (const row of rows) {
      results.push(await pushResolvedRowToST(row));
    }
    const summary = {
      attempted: results.length,
      fullySynced: results.filter(r => r.fullySynced).length,
      partial: results.filter(r => !r.fullySynced && r.anySuccess).length,
      failed: results.filter(r => !r.anySuccess && r.attempted > 0).length,
    };
    res.json({ ok: true, summary, results });
  } catch (e) {
    console.error("[resolved/push-to-st]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/monthly-review/resolved/:jobNumber/push-to-st
// Single-row push, same logic as the batch endpoint above.
router.post("/resolved/:jobNumber/push-to-st", async (req, res) => {
  try {
    const jobNumber = String(req.params.jobNumber || "").trim();
    if (!jobNumber) return res.status(400).json({ error: "jobNumber required" });
    const row = jobReviewRepo.decorateWithSyncState(jobReviewRepo.get(jobNumber) || {});
    if (!row.job_number) return res.status(404).json({ error: `No review row for job ${jobNumber}` });
    const result = await pushResolvedRowToST(row);
    res.json({ ok: result.anySuccess, result });
  } catch (e) {
    console.error(`[resolved/${req.params.jobNumber}/push-to-st]`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────────
// Core push routine — sequences corrected_status, corrected_job_type, and
// each unsynced note in the log, recording per-field results on the row.
//
// Failure semantics: a row is "fullySynced" only if every pending op
// succeeded. "anySuccess" is true if at least one op landed (helpful so the
// caller knows whether ST has any state for this row). On a tenant-locked
// jobType PATCH we fall back to posting an explanatory note so accounting
// at least sees the requested correction.
// ──────────────────────────────────────────────────────────────────────
async function pushResolvedRowToST(row) {
  const jobNumber = row.job_number;
  const st = require("../api/servicetitan");
  const out = {
    jobNumber,
    attempted: 0,
    anySuccess: false,
    fullySynced: true,   // flipped to false on any failure below
    status:  null,
    jobType: null,
    notes:   [],
    error:   null,
  };

  // Resolve the ST internal job ID up front — every operation needs it.
  let stJob;
  try {
    stJob = await st.getJobByNumber(jobNumber);
  } catch (e) {
    out.error = `getJobByNumber failed: ${e.message}`;
    out.fullySynced = false;
    return out;
  }
  if (!stJob || !stJob.id) {
    out.error = `Job ${jobNumber} not found in ServiceTitan`;
    out.fullySynced = false;
    return out;
  }
  const jobId = stJob.id;

  // 1. Status correction
  if (row.pendingStatus) {
    out.attempted++;
    const result = await st.updateJobStatus(jobId, row.corrected_status);
    if (result.ok) {
      jobReviewRepo.markStatusSynced(jobNumber, result.value, null);
      out.status = { ok: true, value: result.value };
      out.anySuccess = true;
    } else {
      jobReviewRepo.markStatusSynced(jobNumber, null, result.error);
      out.status = { ok: false, error: result.error };
      out.fullySynced = false;
    }
  }

  // 2. Job type correction — falls back to a note if ST locks the change
  if (row.pendingJobType) {
    out.attempted++;
    const result = await st.updateJobType(jobId, row.corrected_job_type);
    if (result.ok) {
      jobReviewRepo.markJobTypeSynced(jobNumber, result.value, null);
      out.jobType = { ok: true, value: result.value };
      out.anySuccess = true;
    } else if (result.reason === "locked-by-tenant") {
      // Tenant won't allow the PATCH — post a note flagging the requested
      // change so accounting can apply it manually in ST.
      try {
        const noteText = `[Job type correction requested] Should be: ${result.value}\n(Push blocked by tenant policy; please update job type manually.)`;
        await st.addJobNote(jobId, noteText);
        jobReviewRepo.markJobTypeSynced(jobNumber, null, "fallback-note-posted");
        out.jobType = { ok: false, fallback: "note-posted", value: result.value };
        out.anySuccess = true;
      } catch (e) {
        jobReviewRepo.markJobTypeSynced(jobNumber, null, `${result.error}; fallback-note-failed: ${e.message}`);
        out.jobType = { ok: false, error: result.error, fallbackError: e.message };
        out.fullySynced = false;
      }
    } else {
      jobReviewRepo.markJobTypeSynced(jobNumber, null, result.error);
      out.jobType = { ok: false, error: result.error };
      out.fullySynced = false;
    }
  }

  // 3. Append-only notes — push each unsynced entry as its own ST note.
  const unsyncedNotes = jobReviewRepo.listUnsyncedNotes(jobNumber);
  for (const entry of unsyncedNotes) {
    out.attempted++;
    const noteText = formatStNoteEntryText(entry);
    try {
      await st.addJobNote(jobId, noteText);
      jobReviewRepo.markNoteSynced(entry.id, noteText);
      out.notes.push({ id: entry.id, ok: true });
      out.anySuccess = true;
    } catch (e) {
      const msg = e.response?.data?.title || e.message;
      jobReviewRepo.markNoteError(entry.id, msg);
      out.notes.push({ id: entry.id, ok: false, error: msg });
      out.fullySynced = false;
    }
  }

  // If nothing was attempted there's nothing to be "fullySynced" about —
  // collapse the flag to false so the caller doesn't double-count.
  if (out.attempted === 0) out.fullySynced = false;

  return out;
}

// Fiscal-year-to-date rollup as of a given month
router.get("/fy-to-date/:year/:month", async (req, res) => {
  try {
    const year  = parseInt(req.params.year, 10);
    const month = parseInt(req.params.month, 10);
    if (!year || !month || month < 1 || month > 12) {
      return res.status(400).json({ error: "Invalid year/month" });
    }
    const data = await fyAgg.buildFYToDate(year, month);
    res.json(data);
  } catch (e) {
    console.error("[fy-to-date]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Full-FY rollup
router.get("/fy/:fyLabel", async (req, res) => {
  try {
    const fyLabel = String(req.params.fyLabel).toUpperCase();
    if (!fy.fyBounds(fyLabel)) {
      return res.status(400).json({ error: "Invalid FY label (expected e.g. FY26)" });
    }
    const data = await fyAgg.buildFullFY(fyLabel);
    res.json(data);
  } catch (e) {
    console.error("[fy]", e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get("/list", (req, res) => {
  try {
    const dir = loader.CACHE_ROOT;
    if (!fs.existsSync(dir)) return res.json({ months: [] });
    const months = fs.readdirSync(dir)
      .filter(f => /^\d{4}-\d{2}$/.test(f))
      .map(f => {
        const [y, m] = f.split("-").map(Number);
        return { year: y, month: m, key: f };
      })
      .sort((a, b) => (b.year - a.year) || (b.month - a.month));
    res.json({ months });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/current", async (req, res) => {
  try {
    const now = new Date();
    const data = await loader.loadMonth(now.getFullYear(), now.getMonth() + 1, { preferLive: true });
    console.log(`[monthly-review/current] ${now.getFullYear()}-${now.getMonth()+1}: ${data.jobs.length} jobs, ${data.timesheets.length} ts, ${(data.appointments||[]).length} appts`);
    const result = review.buildReview({
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      jobs: data.jobs,
      timesheets: data.timesheets,
      appointments: data.appointments || [],
    });
    res.json({
      ...result,
      source: data.source,
      liveCaveats: data.source === "live" ? {
        timesheetUnavailable: data.timesheets.length === 0,
        costsUnavailable: true, // material/labor cost not exposed by ST jobs API
      } : null,
    });
  } catch (e) {
    console.error("[monthly-review/current]", e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

router.get("/:year/:month", async (req, res) => {
  try {
    const year  = parseInt(req.params.year, 10);
    const month = parseInt(req.params.month, 10);
    if (!year || !month || month < 1 || month > 12) {
      return res.status(400).json({ error: "Invalid year/month" });
    }
    const now = new Date();
    const isCurrent =
      year === now.getFullYear() && month === now.getMonth() + 1;
    const data = await loader.loadMonth(year, month, { preferLive: isCurrent });
    const result = review.buildReview({
      year, month, jobs: data.jobs, timesheets: data.timesheets,
      appointments: data.appointments || [],
    });
    res.json({ ...result, source: data.source });
  } catch (e) {
    console.error("[monthly-review]", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
