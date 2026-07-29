/**
 * installTrackerService.js
 * ────────────────────────────────────────────────────────────────────────────
 * Backs the Install Tracker page. For a date range it lists every COMPLETED
 * install job (HVAC + Water Heater install types — see
 * config/installTrackerJobTypes.js) pulled live from ServiceTitan, then merges
 * in the office's saved follow-up state (db/installTrackerRepository.js):
 *
 *   • equipment_listed     — office confirmed the unit is in ServiceTitan
 *   • warranty_registered  — office confirmed the manufacturer warranty is done
 *
 * Both statuses are manual toggles — this service does NOT try to auto-detect
 * them. It only supplies the job list + the merged saved state.
 *
 * Data sources (live from ServiceTitan):
 *   • /jpm/v2/jobs           — completed install jobs in the range (jobTypeIds)
 *   • /crm/v2/customers/{id}  — customer display name (deduped, concurrency-capped)
 * ────────────────────────────────────────────────────────────────────────────
 */

const axios = require("axios");
const st = require("../api/servicetitan");
const cfg = require("../config/installTrackerJobTypes");
const repo = require("../db/installTrackerRepository");

// ── Rate-limit handling (mirrors backflowReportService) ─────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { tries = 4, label = "" } = {}) {
  let attempt = 0;
  let lastErr;
  while (attempt < tries) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const transient = status === 429 || (status >= 500 && status < 600);
      if (!transient || attempt === tries - 1) throw err;

      let waitMs;
      const ra = err.response?.headers?.["retry-after"];
      if (ra) {
        const asInt = parseInt(ra, 10);
        if (Number.isFinite(asInt)) waitMs = asInt * 1000;
        else {
          const dateMs = Date.parse(ra);
          if (!isNaN(dateMs)) waitMs = Math.max(0, dateMs - Date.now());
        }
      }
      if (!waitMs) waitMs = Math.min(15000, 800 * Math.pow(2, attempt));
      waitMs += Math.floor(Math.random() * 250);

      console.warn(
        `[InstallTracker] ${status} on ${label || "ST call"} — retrying in ${waitMs}ms (attempt ${attempt + 1}/${tries})`
      );
      await sleep(waitMs);
      attempt++;
    }
  }
  throw lastErr;
}

// ── ST jobs page-walker (completed install jobs in a date range) ────────────
async function fetchCompletedInstallJobs({ jobTypeIds, completedOnOrAfter, completedBefore }) {
  const tenant = process.env.ST_TENANT_ID;
  let all = [];
  let page = 1;
  while (page <= 100) {
    const res = await withRetry(async () => {
      const token = await st.getAccessToken();
      return axios.get(`https://api.servicetitan.io/jpm/v2/tenant/${tenant}/jobs`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "ST-App-Key": process.env.ST_APP_KEY,
        },
        params: {
          tenant,
          page,
          pageSize: 50,
          jobStatus: "Completed",
          completedOnOrAfter,
          completedBefore,
          jobTypeIds: jobTypeIds.join(","),
        },
      });
    }, { label: `jobs page ${page}` });
    const batch = res.data?.data || [];
    all = all.concat(batch);
    if (!res.data?.hasMore) break;
    page++;
  }
  return all;
}

// ── Concurrency-capped map (mirrors backflowReportService) ──────────────────
async function mapWithLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); }
      catch (err) { out[i] = { _error: err.message || String(err) }; }
    }
  });
  await Promise.all(workers);
  return out;
}

function pickCompletionDate(job) {
  return job.completedOn || job.completed || job.modifiedOn || null;
}

// ── Main entry ──────────────────────────────────────────────────────────────
/**
 * Build the install-tracker report for [from, to] (ISO YYYY-MM-DD).
 * @param {string} status  'all' | 'needs' | 'done' | 'no-equipment' | 'no-warranty'
 * Returns { rows, summary, meta }.
 */
async function buildTrackerReport({ from, to, status = "all" } = {}) {
  if (!from || !to) throw new Error("buildTrackerReport: from + to required");

  const startedAt = Date.now();
  const jobTypeIds = cfg.installJobTypeIds();
  const allowedIds = cfg.installJobTypeIdSet();

  const fromISO = new Date(`${from}T00:00:00Z`).toISOString();
  const toISO = new Date(`${to}T23:59:59.999Z`).toISOString();

  const rawJobs = await fetchCompletedInstallJobs({
    jobTypeIds,
    completedOnOrAfter: fromISO,
    completedBefore: toISO,
  });

  // ST has been observed to silently drop unknown/mistyped query params, so
  // guarantee only our install types survive (see servicetitan.js param notes).
  const jobs = rawJobs.filter((j) => allowedIds.has(String(j.jobTypeId)));
  const droppedNonInstall = rawJobs.length - jobs.length;

  // Resolve customer display names — dedupe by customerId so a busy month
  // isn't N calls when many jobs share a customer.
  const custIds = [...new Set(jobs.map((j) => j.customerId).filter(Boolean).map(String))];
  const custFails = { n: 0 };
  const custPairs = await mapWithLimit(custIds, 4, async (cid) => {
    try {
      const c = await withRetry(() => st.getCustomer(cid), { label: `customer ${cid}` });
      return [cid, c?.name || null];
    } catch (e) {
      custFails.n++;
      console.warn(`[InstallTracker] customer ${cid}: ${e.message}`);
      return [cid, null];
    }
  });
  const custNames = new Map(custPairs.filter(Boolean));

  // Merge saved overlay state, keyed by ST job id.
  const overlay = repo.getByJobIds(jobs.map((j) => j.id));

  let rows = jobs.map((job) => {
    const jobId = job.id;
    const saved = overlay.get(String(jobId)) || null;
    const jobTypeName =
      cfg.jobTypeName(job.jobTypeId) || job.jobTypeName || `Type ${job.jobTypeId}`;
    const category = cfg.jobTypeCategory(job.jobTypeId) || null;
    const completedOn = pickCompletionDate(job);
    const equipmentListed = !!(saved && saved.equipment_listed);
    const warrantyRegistered = !!(saved && saved.warranty_registered);

    return {
      jobId,
      jobNumber: job.jobNumber || String(jobId),
      customerId: job.customerId || null,
      customerName: custNames.get(String(job.customerId)) || job.customerName || "",
      locationId: job.locationId || null,
      jobTypeId: job.jobTypeId,
      jobType: jobTypeName,
      category,
      completedOn: completedOn ? completedOn.slice(0, 10) : null,
      equipmentListed,
      warrantyRegistered,
      done: equipmentListed && warrantyRegistered,
      equipmentListedAt: saved?.equipment_listed_at || null,
      equipmentListedBy: saved?.equipment_listed_by || null,
      warrantyRegisteredAt: saved?.warranty_registered_at || null,
      warrantyRegisteredBy: saved?.warranty_registered_by || null,
      notes: saved?.notes || "",
    };
  });

  // Summary counts over the full (unfiltered) set.
  const summary = summarize(rows);

  // Status filter (applied after summary so the tiles always reflect the range).
  const s = String(status || "all").toLowerCase();
  if (s === "needs")             rows = rows.filter((r) => !r.done);
  else if (s === "done")         rows = rows.filter((r) => r.done);
  else if (s === "no-equipment") rows = rows.filter((r) => !r.equipmentListed);
  else if (s === "no-warranty")  rows = rows.filter((r) => !r.warrantyRegistered);

  // Newest completion first.
  rows.sort((a, b) => String(b.completedOn || "").localeCompare(String(a.completedOn || "")));

  return {
    rows,
    summary,
    meta: {
      from, to, status: s,
      jobTypeMatched: cfg.INSTALL_JOB_TYPES.map((t) => t.name),
      jobsScanned: jobs.length,
      rawJobsFromST: rawJobs.length,
      droppedNonInstall,
      customerFails: custFails.n,
      elapsedMs: Date.now() - startedAt,
    },
  };
}

function summarize(rows) {
  const total = rows.length;
  let done = 0, needEquipment = 0, needWarranty = 0;
  const byCategory = {};
  for (const r of rows) {
    if (r.done) done++;
    if (!r.equipmentListed) needEquipment++;
    if (!r.warrantyRegistered) needWarranty++;
    const c = r.category || "Other";
    byCategory[c] = (byCategory[c] || 0) + 1;
  }
  return {
    total,
    done,
    needsAttention: total - done,
    needEquipment,
    needWarranty,
    byCategory,
  };
}

/**
 * Toggle one status flag on a job. `field` is the client name
 * ('equipmentListed' | 'warrantyRegistered'); it's mapped to the DB column
 * here so the route never has to know column names.
 * `snapshot` carries the row's display fields so the DB row reads well later.
 */
function setStatus({ jobId, field, value, actor, snapshot }) {
  const map = {
    equipmentListed: "equipment_listed",
    warrantyRegistered: "warranty_registered",
    equipment_listed: "equipment_listed",
    warranty_registered: "warranty_registered",
  };
  const col = map[field];
  if (!col) throw new Error(`Unknown status field: ${field}`);
  if (!jobId) throw new Error("jobId required");
  return repo.setFlag(Number(jobId), col, !!value, actor || null, normalizeSnapshot(jobId, snapshot));
}

function setNotes({ jobId, notes, snapshot }) {
  if (!jobId) throw new Error("jobId required");
  return repo.setNotes(Number(jobId), notes, normalizeSnapshot(jobId, snapshot));
}

// Map a UI snapshot object onto the repository's snake_case columns.
function normalizeSnapshot(jobId, snap = {}) {
  snap = snap || {};
  return {
    st_job_id: Number(jobId),
    job_number: snap.jobNumber ?? null,
    job_type_id: snap.jobTypeId ?? null,
    job_type_name: snap.jobType ?? null,
    category: snap.category ?? null,
    customer_id: snap.customerId ?? null,
    customer_name: snap.customerName ?? null,
    location_id: snap.locationId ?? null,
    completed_on: snap.completedOn ?? null,
  };
}

module.exports = { buildTrackerReport, setStatus, setNotes };
