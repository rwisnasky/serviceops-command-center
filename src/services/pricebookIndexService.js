/**
 * src/services/pricebookIndexService.js
 *
 * Local cache of the ServiceTitan pricebook (services, materials, equipment)
 * kept in SQLite so scope-of-work parsing can do fuzzy matching against the
 * whole catalog without hitting ST on every line item.
 *
 * Schema: see pricebook_index + pricebook_sync_log in src/db/index.js
 *
 *   syncAll()              → pulls every active Service/Material/Equipment and
 *                            upserts into pricebook_index. Writes a row to
 *                            pricebook_sync_log regardless of outcome.
 *   autoSyncIfStale(hours) → triggers syncAll only if last good sync is older
 *                            than `hours` (default 30). Cheap to call before
 *                            every parse — it no-ops on warm cache.
 *   searchIndex(q, opts)   → token-Jaccard fuzzy match against name/description;
 *                            returns top-N candidates with scores.
 *   getStats()             → sizes per type + last successful sync time.
 */

const { getDb } = require("../db/index");
const {
  searchPricebookServices,
  searchPricebookMaterials,
  searchPricebookEquipment,
  updateMaterial,
  updateEquipment,
  updateService,
} = require("../api/servicetitan");

// ── Tokenizer ────────────────────────────────────────────────────────────────
function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 2); // drop "a"/"of"/noise
}

function tokenString(...parts) {
  const seen = new Set();
  for (const p of parts) {
    for (const t of tokenize(p)) seen.add(t);
  }
  return [...seen].join(" ");
}

// ── Pick a price field regardless of sku type ────────────────────────────────
function pickPrice(item) {
  const candidates = [item.price, item.memberPrice, item.addOnPrice, item.amount, item.unitPrice];
  for (const v of candidates) {
    if (typeof v === "number") return v;
  }
  return 0;
}

// ── Fetch one type, paging through ST until done ─────────────────────────────
async function fetchAllOfType(searchFn, label) {
  const all = [];
  let page = 1;
  const pageSize = 200; // ST pricebook caps vary — 200 is well within every tenant's limit
  // Hard ceiling so a bug in ST pagination can't spin forever
  const MAX_PAGES = 50;
  while (page <= MAX_PAGES) {
    const res = await searchFn({ page, pageSize, active: "True" });
    const batch = Array.isArray(res.data) ? res.data : [];
    all.push(...batch);
    if (!res.hasMore || batch.length === 0) break;
    page++;
  }
  console.log(`[PricebookIndex]   ${label}: fetched ${all.length} items (${page} page${page === 1 ? "" : "s"})`);
  return all;
}

// ── Upsert ───────────────────────────────────────────────────────────────────
function upsertBatch(items, skuType) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO pricebook_index (st_id, sku_type, name, code, description, price, active, tokens, image_path, synced_at)
    VALUES (@st_id, @sku_type, @name, @code, @description, @price, @active, @tokens, @image_path, datetime('now'))
    ON CONFLICT(st_id, sku_type) DO UPDATE SET
      name        = excluded.name,
      code        = excluded.code,
      description = excluded.description,
      price       = excluded.price,
      active      = excluded.active,
      tokens      = excluded.tokens,
      -- Only overwrite image_path with a non-null value from ST; if ST's
      -- search response omits the image field (happens on materials search)
      -- we preserve whatever ensureImage() has cached locally.
      image_path  = COALESCE(excluded.image_path, pricebook_index.image_path),
      synced_at   = excluded.synced_at
  `);

  const tx = db.transaction(rows => {
    for (const r of rows) stmt.run(r);
  });

  const rows = items.map(it => {
    // ST returns image as a string path on some endpoints and an array on others
    let image_path = null;
    if (typeof it.image === "string" && it.image) image_path = it.image;
    else if (Array.isArray(it.images) && it.images.length > 0) {
      const first = it.images[0];
      image_path = typeof first === "string" ? first : (first?.path || first?.url || null);
    }
    return {
      st_id:       Number(it.id),
      sku_type:    skuType,
      name:        it.displayName || it.name || "",
      code:        it.code || it.sku || "",
      description: it.description || "",
      price:       pickPrice(it),
      active:      it.active === false ? 0 : 1,
      tokens:      tokenString(it.displayName || it.name, it.code || it.sku, it.description),
      image_path,
    };
  });

  tx(rows);
  return rows.length;
}

// ── Deactivate anything no longer returned by ST ─────────────────────────────
// We flip `active=0` instead of deleting so we still know the SKU existed
// historically (useful for CSRs reviewing old matches).
function markStaleInactive(freshIdsByType) {
  const db = getDb();
  const types = ["Service", "Material", "Equipment"];
  let totalStale = 0;
  for (const t of types) {
    const fresh = freshIdsByType[t] || [];
    if (fresh.length === 0) continue; // don't wipe a type on a zero-result sync
    const placeholders = fresh.map(() => "?").join(",");
    const info = db
      .prepare(
        `UPDATE pricebook_index SET active = 0
         WHERE sku_type = ? AND active = 1 AND st_id NOT IN (${placeholders})`
      )
      .run(t, ...fresh);
    totalStale += info.changes;
  }
  return totalStale;
}

// ── Public: full sync ────────────────────────────────────────────────────────
async function syncAll() {
  const db = getDb();
  const logInsert = db.prepare(`
    INSERT INTO pricebook_sync_log (status) VALUES ('running')
  `).run();
  const logId = logInsert.lastInsertRowid;

  const finishStmt = db.prepare(`
    UPDATE pricebook_sync_log
       SET status = ?, finished_at = datetime('now'),
           services = ?, materials = ?, equipment = ?, error = ?
     WHERE id = ?
  `);

  console.log("[PricebookIndex] Starting full sync…");
  try {
    const [services, materials, equipment] = await Promise.all([
      fetchAllOfType(searchPricebookServices,  "Services"),
      fetchAllOfType(searchPricebookMaterials, "Materials"),
      fetchAllOfType(searchPricebookEquipment, "Equipment"),
    ]);

    const s = upsertBatch(services,  "Service");
    const m = upsertBatch(materials, "Material");
    const e = upsertBatch(equipment, "Equipment");

    const stale = markStaleInactive({
      Service:   services.map(x => x.id),
      Material:  materials.map(x => x.id),
      Equipment: equipment.map(x => x.id),
    });

    finishStmt.run("ok", s, m, e, null, logId);
    console.log(
      `[PricebookIndex] ✅ Sync complete — ${s} services, ${m} materials, ${e} equipment` +
      (stale ? ` (${stale} marked inactive)` : "")
    );
    return { ok: true, services: s, materials: m, equipment: e, staleDeactivated: stale };
  } catch (err) {
    finishStmt.run("failed", 0, 0, 0, err.message, logId);
    console.error("[PricebookIndex] ❌ Sync failed:", err.message);
    throw err;
  }
}

// ── Public: auto-sync if stale ───────────────────────────────────────────────
async function autoSyncIfStale(maxAgeHours = 30) {
  const db = getDb();
  const row = db
    .prepare(`SELECT finished_at FROM pricebook_sync_log
              WHERE status='ok' ORDER BY id DESC LIMIT 1`)
    .get();
  if (row && row.finished_at) {
    const ageMs = Date.now() - new Date(row.finished_at.replace(" ", "T") + "Z").getTime();
    if (ageMs < maxAgeHours * 3600 * 1000) {
      return { skipped: true, ageHours: +(ageMs / 3600000).toFixed(1) };
    }
  }
  return await syncAll();
}

// ── Public: fuzzy search (Jaccard over token sets) ───────────────────────────
function searchIndex(query, { types = ["Service", "Material", "Equipment"], limit = 10, activeOnly = true } = {}) {
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return [];

  const db = getDb();
  const placeholders = types.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT st_id, sku_type, name, code, description, price, tokens
         FROM pricebook_index
        WHERE sku_type IN (${placeholders})
          ${activeOnly ? "AND active = 1" : ""}`
    )
    .all(...types);

  const scored = [];
  for (const r of rows) {
    const rTokens = new Set((r.tokens || "").split(" ").filter(Boolean));
    if (rTokens.size === 0) continue;

    let inter = 0;
    for (const t of qTokens) if (rTokens.has(t)) inter++;
    const union = qTokens.size + rTokens.size - inter;
    const jaccard = union === 0 ? 0 : inter / union;

    // Small bonus: overlap-coverage of the query (how much of the user's query
    // is contained in this row). Penalizes rows that merely share common words.
    const coverage = qTokens.size === 0 ? 0 : inter / qTokens.size;

    // Blend: weighted sum — coverage dominates for short queries, jaccard for longer
    const score = 0.35 * jaccard + 0.65 * coverage;
    if (score > 0) {
      scored.push({
        skuId: r.st_id,
        skuType: r.sku_type,
        name: r.name,
        code: r.code,
        description: r.description,
        price: r.price,
        score: +score.toFixed(3),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ── Public: stats ────────────────────────────────────────────────────────────
function getStats() {
  const db = getDb();
  const counts = db
    .prepare(`SELECT sku_type, COUNT(*) AS n, SUM(active) AS active FROM pricebook_index GROUP BY sku_type`)
    .all();

  const lastOk = db
    .prepare(`SELECT finished_at, services, materials, equipment FROM pricebook_sync_log
              WHERE status='ok' ORDER BY id DESC LIMIT 1`)
    .get();

  const lastAny = db
    .prepare(`SELECT started_at, status, error FROM pricebook_sync_log
              ORDER BY id DESC LIMIT 1`)
    .get();

  const totals = { Service: 0, Material: 0, Equipment: 0 };
  const active = { Service: 0, Material: 0, Equipment: 0 };
  for (const c of counts) {
    if (c.sku_type in totals) { totals[c.sku_type] = c.n; active[c.sku_type] = c.active; }
  }

  return {
    totals,
    active,
    lastSync: lastOk?.finished_at || null,
    lastAttempt: lastAny || null,
  };
}

// ── Duplicate detection ─────────────────────────────────────────────────────
//
// Two rules supported against the local pricebook cache:
//   rule="code" → records with the same normalized code (trim + upper-case)
//   rule="name" → records with the same normalized display name (trim + lower)
//
// A mfr+model rule isn't available yet — the index schema doesn't carry those
// fields. Adding it requires a v15 migration on pricebook_index plus a sync
// update to populate the new columns.
//
// getDuplicates({ type, rule, activeOnly }) → array of groups
//   [{ key, count, sku_type: 'Mixed'|'Service'|..., items: [{ st_id, ... }] }]
//
// getDuplicatesCount({ rule, activeOnly }) → total # of records that are part
//   of any duplicate group across all sku types. Cheap — one grouped query.
//
const VALID_RULES = new Set(["code", "name"]);
const VALID_TYPES = new Set(["all", "Service", "Material", "Equipment"]);

function _normalizeFieldSql(rule) {
  // Normalize code: trim + upper. Normalize name: trim + lower.
  if (rule === "code") return "UPPER(TRIM(code))";
  if (rule === "name") return "LOWER(TRIM(name))";
  throw new Error(`Unknown dupe rule: ${rule}`);
}

function getDuplicates({ type = "all", rule = "code", activeOnly = true } = {}) {
  if (!VALID_RULES.has(rule)) throw new Error(`Invalid rule "${rule}"`);
  if (!VALID_TYPES.has(type)) throw new Error(`Invalid type "${type}"`);

  const db = getDb();
  const normSql = _normalizeFieldSql(rule);
  const typeFilter = type === "all" ? "" : "AND sku_type = @type";
  const activeFilter = activeOnly ? "AND active = 1" : "";

  // Step 1: find the duplicate keys
  const keyRows = db
    .prepare(
      `SELECT ${normSql} AS key, COUNT(*) AS n
         FROM pricebook_index
        WHERE ${normSql} <> ''
          ${typeFilter}
          ${activeFilter}
        GROUP BY ${normSql}
        HAVING COUNT(*) > 1
        ORDER BY n DESC, key ASC`
    )
    .all({ type });

  if (keyRows.length === 0) return [];

  // Step 2: pull the records for each key (batched)
  const fetchStmt = db.prepare(
    `SELECT st_id, sku_type, name, code, description, price, active, synced_at
       FROM pricebook_index
      WHERE ${normSql} = @key
        ${typeFilter}
        ${activeFilter}
      ORDER BY sku_type, st_id`
  );

  const groups = keyRows.map(({ key, n }) => {
    const items = fetchStmt.all({ key, type });
    const skuTypes = new Set(items.map(i => i.sku_type));
    return {
      key,
      count: n,
      sku_type: skuTypes.size === 1 ? [...skuTypes][0] : "Mixed",
      items,
    };
  });

  return groups;
}

function getDuplicatesCount({ type = "all", rule = "code", activeOnly = true } = {}) {
  if (!VALID_RULES.has(rule)) throw new Error(`Invalid rule "${rule}"`);
  if (!VALID_TYPES.has(type)) throw new Error(`Invalid type "${type}"`);

  const db = getDb();
  const normSql = _normalizeFieldSql(rule);
  const typeFilter = type === "all" ? "" : "AND sku_type = @type";
  const activeFilter = activeOnly ? "AND active = 1" : "";

  // Sum of rows whose normalized key appears more than once.
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(n), 0) AS total, COUNT(*) AS groups
         FROM (
           SELECT COUNT(*) AS n
             FROM pricebook_index
            WHERE ${normSql} <> ''
              ${typeFilter}
              ${activeFilter}
            GROUP BY ${normSql}
            HAVING COUNT(*) > 1
         )`
    )
    .get({ type });

  return { records: row.total || 0, groups: row.groups || 0 };
}

// ── Merge / Soft-merge ───────────────────────────────────────────────────────
//
// "Soft merge" in our world = deactivate duplicates in ServiceTitan (set
// active=false). ST has no native merge endpoint for pricebook SKUs, so we
// emulate a merge by picking one canonical SKU and deactivating the others.
// Optionally we copy selected fields (price, name, description, code) from
// the canonical onto itself — no-op unless the caller opts in with copyFields.
//
// Every merge writes a row to pricebook_merge_log so we can undo (reactivate
// the duplicates and restore the canonical snapshot if fields were copied).
//
// NOTE: This DOES NOT reassign references on jobs/estimates/invoices that
// already point at the deactivated duplicates. Historical records keep their
// original SKU link — deactivating only hides the SKU from future lookups.

const ALLOWED_COPY_FIELDS = new Set(["displayName", "name", "description", "price", "memberPrice", "cost", "code"]);

/**
 * Look up a single SKU in the local index by ST id + type.
 * Returns the row or null.
 */
function getIndexRecord(stId, skuType) {
  const db = getDb();
  return (
    db
      .prepare(
        `SELECT st_id, sku_type, name, code, description, price, active
           FROM pricebook_index
          WHERE st_id = ? AND sku_type = ?`
      )
      .get(Number(stId), String(skuType)) || null
  );
}

/**
 * Suggest a canonical SKU given a list of duplicate st_ids of the same type.
 * Rule: lowest st_id that is currently active. Rationale: oldest record is
 * usually the one referenced by the most historical jobs/estimates — breaking
 * fewer links. Active-first because we can't keep a deactivated record as the
 * canonical "keep".
 *
 * Returns { canonicalStId, reason } or throws if inputs invalid.
 */
function suggestCanonical({ stIds, skuType }) {
  if (!Array.isArray(stIds) || stIds.length < 2) {
    throw new Error("suggestCanonical: stIds must be an array of at least 2");
  }
  if (!VALID_TYPES.has(skuType) || skuType === "all") {
    throw new Error(`suggestCanonical: invalid skuType "${skuType}"`);
  }

  const db = getDb();
  const placeholders = stIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT st_id, active
         FROM pricebook_index
        WHERE sku_type = ? AND st_id IN (${placeholders})
        ORDER BY active DESC, st_id ASC`
    )
    .all(skuType, ...stIds.map(Number));

  if (rows.length === 0) {
    throw new Error("suggestCanonical: none of the given stIds found in local index");
  }
  const active = rows.filter(r => r.active === 1);
  if (active.length === 0) {
    // All duplicates already inactive — pick lowest id
    return { canonicalStId: rows[0].st_id, reason: "all duplicates inactive; lowest ST id selected" };
  }
  return { canonicalStId: active[0].st_id, reason: "lowest active ST id selected" };
}

function _pickUpdateFn(skuType) {
  if (skuType === "Material") return updateMaterial;
  if (skuType === "Equipment") return updateEquipment;
  if (skuType === "Service") return updateService;
  throw new Error(`_pickUpdateFn: unsupported skuType "${skuType}"`);
}

/**
 * Perform a soft merge:
 *   - Deactivate each duplicate in ServiceTitan (active=false).
 *   - Optionally PATCH the canonical with copyFields (price/description/etc).
 *   - Mirror active=0 into the local pricebook_index.
 *   - Write a pricebook_merge_log row (status ok | partial | failed).
 *
 * Returns { ok, logId, deactivated: [ids], failed: [{id,error}], canonicalUpdated: bool }.
 */
async function mergeDuplicates({
  canonicalStId,
  duplicateStIds,
  skuType,
  copyFields = null, // null or {} => no-op; object of ALLOWED_COPY_FIELDS => PATCH canonical
  userNote = null,
  dryRun = false,
  generateImage = false, // if true and canonical lacks an image, ensureImage after merge
  imageSource = "hybrid",
} = {}) {
  if (!canonicalStId) throw new Error("mergeDuplicates: canonicalStId required");
  if (!Array.isArray(duplicateStIds) || duplicateStIds.length === 0) {
    throw new Error("mergeDuplicates: duplicateStIds must be a non-empty array");
  }
  if (!VALID_TYPES.has(skuType) || skuType === "all") {
    throw new Error(`mergeDuplicates: invalid skuType "${skuType}"`);
  }
  if (duplicateStIds.map(Number).includes(Number(canonicalStId))) {
    throw new Error("mergeDuplicates: canonicalStId cannot be in duplicateStIds");
  }

  // Sanitize copyFields
  let cleanCopy = null;
  if (copyFields && typeof copyFields === "object") {
    cleanCopy = {};
    for (const [k, v] of Object.entries(copyFields)) {
      if (ALLOWED_COPY_FIELDS.has(k)) cleanCopy[k] = v;
    }
    if (Object.keys(cleanCopy).length === 0) cleanCopy = null;
  }

  const canonical = getIndexRecord(canonicalStId, skuType);
  if (!canonical) {
    throw new Error(`mergeDuplicates: canonical ${skuType} ${canonicalStId} not in local index — run a pricebook sync first`);
  }

  // Snapshot duplicates BEFORE for audit/undo
  const snapshots = duplicateStIds
    .map(id => getIndexRecord(id, skuType))
    .filter(Boolean)
    .map(r => ({ st_id: r.st_id, code: r.code, name: r.name, price: r.price, active: r.active }));

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      canonical: { st_id: canonical.st_id, code: canonical.code, name: canonical.name },
      wouldDeactivate: snapshots,
      wouldCopy: cleanCopy,
    };
  }

  const updateFn = _pickUpdateFn(skuType);
  const deactivated = [];
  const failed = [];

  // Deactivate duplicates one by one (sequential — ST rate limits are generous
  // but we want clean audit + partial-failure tracking)
  for (const dupId of duplicateStIds) {
    try {
      await updateFn(Number(dupId), { active: false });
      deactivated.push(Number(dupId));
    } catch (err) {
      failed.push({ st_id: Number(dupId), error: err.message });
    }
  }

  // Optionally update canonical
  let canonicalUpdated = false;
  let canonicalError = null;
  if (cleanCopy) {
    try {
      await updateFn(Number(canonicalStId), cleanCopy);
      canonicalUpdated = true;
    } catch (err) {
      canonicalError = err.message;
    }
  }

  // Mirror into local index so the UI reflects the merge immediately.
  // A full sync will overwrite this with ST's authoritative state later.
  const db = getDb();
  const updateActive = db.prepare(
    `UPDATE pricebook_index SET active = 0 WHERE st_id = ? AND sku_type = ?`
  );
  for (const id of deactivated) updateActive.run(Number(id), skuType);

  if (canonicalUpdated && cleanCopy) {
    const sets = [];
    const params = {};
    if ("displayName" in cleanCopy || "name" in cleanCopy) {
      sets.push("name = @name");
      params.name = cleanCopy.displayName || cleanCopy.name;
    }
    if ("code" in cleanCopy) { sets.push("code = @code"); params.code = cleanCopy.code; }
    if ("description" in cleanCopy) { sets.push("description = @description"); params.description = cleanCopy.description; }
    if ("price" in cleanCopy) { sets.push("price = @price"); params.price = Number(cleanCopy.price); }
    if (sets.length > 0) {
      params.st_id = Number(canonicalStId);
      params.sku_type = skuType;
      db.prepare(
        `UPDATE pricebook_index SET ${sets.join(", ")} WHERE st_id = @st_id AND sku_type = @sku_type`
      ).run(params);
    }
  }

  // Write audit row
  let status = "ok";
  if (failed.length > 0 && deactivated.length === 0) status = "failed";
  else if (failed.length > 0 || (cleanCopy && !canonicalUpdated)) status = "partial";

  const errorText = [
    ...failed.map(f => `dup ${f.st_id}: ${f.error}`),
    canonicalError ? `canonical copy: ${canonicalError}` : null,
  ]
    .filter(Boolean)
    .join(" | ") || null;

  const insert = db
    .prepare(
      `INSERT INTO pricebook_merge_log
         (sku_type, canonical_st_id, canonical_code, canonical_name,
          duplicate_st_ids, duplicate_snapshot, field_copy, fields_copied,
          canonical_snapshot, status, error, user_note)
       VALUES
         (@sku_type, @canonical_st_id, @canonical_code, @canonical_name,
          @duplicate_st_ids, @duplicate_snapshot, @field_copy, @fields_copied,
          @canonical_snapshot, @status, @error, @user_note)`
    )
    .run({
      sku_type: skuType,
      canonical_st_id: Number(canonicalStId),
      canonical_code: canonical.code || null,
      canonical_name: canonical.name || null,
      duplicate_st_ids: JSON.stringify(deactivated),
      duplicate_snapshot: JSON.stringify(snapshots),
      field_copy: cleanCopy && canonicalUpdated ? 1 : 0,
      fields_copied: cleanCopy ? JSON.stringify(cleanCopy) : null,
      canonical_snapshot: JSON.stringify({
        code: canonical.code,
        name: canonical.name,
        price: canonical.price,
      }),
      status,
      error: errorText,
      user_note: userNote || null,
    });

  // Optional: ensure the canonical has an image after merge. Non-fatal — the
  // merge is already committed and logged; image is icing. Late-required so
  // circular import between pricebookImageService and this module is avoided.
  let imageResult = null;
  if (generateImage && status !== "failed") {
    try {
      const { ensureImage } = require("./pricebookImageService");
      imageResult = await ensureImage({
        stId: Number(canonicalStId),
        skuType,
        source: imageSource,
        force: false, // only fill in if canonical is missing an image
      });
    } catch (err) {
      imageResult = { ok: false, error: err.message };
    }
  }

  return {
    ok: status !== "failed",
    status,
    logId: insert.lastInsertRowid,
    canonicalStId: Number(canonicalStId),
    deactivated,
    failed,
    canonicalUpdated,
    canonicalError,
    image: imageResult,
  };
}

/**
 * Reverse a merge by reactivating all duplicates and restoring the canonical
 * snapshot. Marks the log row undone.
 *
 * Caveat: if a full sync has run between merge and undo, the local "mirror"
 * change we undid may already be overwritten — undo always hits ST directly,
 * so the authoritative state flips back regardless.
 */
async function undoMerge(logId) {
  if (!logId) throw new Error("undoMerge: logId required");
  const db = getDb();
  const log = db
    .prepare(`SELECT * FROM pricebook_merge_log WHERE id = ?`)
    .get(Number(logId));
  if (!log) throw new Error(`undoMerge: log ${logId} not found`);
  if (log.undone_at) throw new Error(`undoMerge: log ${logId} was already undone at ${log.undone_at}`);

  const duplicateIds = JSON.parse(log.duplicate_st_ids || "[]");
  const canonicalSnapshot = log.canonical_snapshot ? JSON.parse(log.canonical_snapshot) : null;
  const fieldsCopied = log.fields_copied ? JSON.parse(log.fields_copied) : null;

  const updateFn = _pickUpdateFn(log.sku_type);
  const reactivated = [];
  const failed = [];

  for (const id of duplicateIds) {
    try {
      await updateFn(Number(id), { active: true });
      reactivated.push(Number(id));
    } catch (err) {
      failed.push({ st_id: Number(id), error: err.message });
    }
  }

  // Restore canonical fields if any were copied
  let canonicalRestored = false;
  let canonicalError = null;
  if (log.field_copy && fieldsCopied && canonicalSnapshot) {
    const restore = {};
    if ("displayName" in fieldsCopied || "name" in fieldsCopied) restore.displayName = canonicalSnapshot.name;
    if ("code" in fieldsCopied) restore.code = canonicalSnapshot.code;
    if ("price" in fieldsCopied) restore.price = Number(canonicalSnapshot.price);
    if (Object.keys(restore).length > 0) {
      try {
        await updateFn(Number(log.canonical_st_id), restore);
        canonicalRestored = true;
      } catch (err) {
        canonicalError = err.message;
      }
    }
  }

  // Mirror into index
  const reactSt = db.prepare(
    `UPDATE pricebook_index SET active = 1 WHERE st_id = ? AND sku_type = ?`
  );
  for (const id of reactivated) reactSt.run(Number(id), log.sku_type);

  db.prepare(
    `UPDATE pricebook_merge_log SET undone_at = datetime('now'), status = 'undone' WHERE id = ?`
  ).run(Number(logId));

  return {
    ok: failed.length === 0,
    logId: Number(logId),
    reactivated,
    failed,
    canonicalRestored,
    canonicalError,
  };
}

/**
 * Fetch recent merge log rows (newest first).
 */
function getMergeLog({ limit = 50, skuType = null } = {}) {
  const db = getDb();
  const where = skuType && skuType !== "all" ? "WHERE sku_type = ?" : "";
  const params = skuType && skuType !== "all" ? [skuType, Number(limit)] : [Number(limit)];
  const rows = db
    .prepare(
      `SELECT id, merged_at, sku_type, canonical_st_id, canonical_code, canonical_name,
              duplicate_st_ids, field_copy, status, error, user_note, undone_at
         FROM pricebook_merge_log
         ${where}
        ORDER BY merged_at DESC
        LIMIT ?`
    )
    .all(...params);
  return rows.map(r => ({
    ...r,
    duplicate_st_ids: JSON.parse(r.duplicate_st_ids || "[]"),
    field_copy: !!r.field_copy,
    undone: !!r.undone_at,
  }));
}

module.exports = {
  syncAll,
  autoSyncIfStale,
  searchIndex,
  getStats,
  getDuplicates,
  getDuplicatesCount,
  suggestCanonical,
  mergeDuplicates,
  undoMerge,
  getMergeLog,
  getIndexRecord,
  tokenize,
};
