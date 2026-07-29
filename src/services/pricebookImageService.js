/**
 * src/services/pricebookImageService.js
 *
 * Fills in missing images on pricebook SKUs. Used both standalone and as a
 * post-step on applyRename / mergeDuplicates so techs and CSRs have a visual
 * hook on every item in the book.
 *
 *   hasImage({ stId, skuType })
 *     → true if the local index already has an image_path, else GETs the
 *       authoritative ST record and refreshes the cache.
 *
 *   ensureImage({ stId, skuType, source, force, promptOverride })
 *     → End-to-end: checks current state, tries `source` pipeline (hybrid by
 *       default: manufacturer first, AI fallback), uploads the bytes to ST,
 *       PATCHes the SKU, writes a pricebook_image_log row, mirrors
 *       image_path into pricebook_index. Skips (and logs 'existing') if the
 *       SKU already has an image and `force` is false.
 *
 *   generateAIImage({ title, model, manufacturer, description, skuType })
 *     → OpenAI gpt-image-1 call. Returns { bytes, prompt }. Safe to call
 *       standalone if a caller just wants bytes without touching ST.
 *
 *   fetchManufacturerImage({ manufacturer, model })
 *     → Stubbed. Returns null in v1. Future: scrape American Standard / Trane
 *       product pages by model number. The caller falls back to AI gen when
 *       this returns null, so adding real scrape logic is a drop-in later.
 *
 *   listRecent(limit, stIdFilter)
 *     → Recent pricebook_image_log rows for the audit panel.
 *
 * Design notes:
 * - Single-SKU operation only. A batch sweep is a separate route that calls
 *   ensureImage in a loop with its own rate limiting.
 * - Logs every attempt, including 'skipped' and 'existing', so the UI can
 *   show "we tried and here's why we did/didn't replace your image".
 * - Undo is not provided — the SKU keeps its original image field history in
 *   ServiceTitan, and regenerating is cheap. If someone wants to revert to
 *   "no image", they can clear it via a PATCH directly.
 */

const { getDb } = require("../db/index");
const {
  getPricebookItem,
  uploadPricebookImage,
  attachPricebookImage,
  updateMaterial,
  updateEquipment,
  updateService,
} = require("../api/servicetitan");

// Lazy OpenAI client — same pattern as materialRenameService so the server
// can boot without OPENAI_API_KEY for routes that don't hit the LLM. In
// DEMO_MODE this is the canned shim, which returns a real (tiny) PNG.
const { getClient } = require("../api/openaiClient");

const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
// gpt-image-1 supports 1024x1024 (square), 1024x1536 (portrait), 1536x1024 (landscape).
// Square works well for the pricebook thumbnail — ST renders thumbnails in a
// near-square frame on the tech app.
const IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || "1024x1024";

// ── Update function picker (shared with merge service style) ─────────────────
function pickUpdateFn(skuType) {
  const t = String(skuType || "").toLowerCase();
  if (t === "material" || t === "materials") return updateMaterial;
  if (t === "equipment") return updateEquipment;
  if (t === "service" || t === "services") return updateService;
  throw new Error(`pricebookImageService: unsupported skuType "${skuType}"`);
}

// ── Extract current image from an ST SKU response ────────────────────────────
// ST responses are inconsistent: some types return `image: "Images/..."`,
// others return `images: [{ path, url }]` or just `images: ["Images/..."]`.
function extractImagePath(stItem) {
  if (!stItem) return null;
  if (typeof stItem.image === "string" && stItem.image.trim()) return stItem.image.trim();
  if (Array.isArray(stItem.images) && stItem.images.length > 0) {
    for (const entry of stItem.images) {
      if (typeof entry === "string" && entry.trim()) return entry.trim();
      if (entry && typeof entry === "object") {
        const p = entry.path || entry.url || entry.image;
        if (p) return String(p);
      }
    }
  }
  return null;
}

// ── hasImage: cache-first with ST fallback ───────────────────────────────────
async function hasImage({ stId, skuType }) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT image_path, image_checked_at FROM pricebook_index WHERE st_id = ? AND sku_type = ?`
    )
    .get(Number(stId), skuType);
  if (row && row.image_path) return { exists: true, imagePath: row.image_path, source: "cache" };

  // Cache miss (or known-null). Ask ST directly.
  let item;
  try {
    item = await getPricebookItem(skuType, stId);
  } catch (err) {
    return { exists: false, error: err.message, source: "st-lookup-failed" };
  }

  const path = extractImagePath(item);
  // Update cache whether we found one or not — the checked-at timestamp is
  // how we tell "we know this has no image" from "we haven't looked yet".
  db.prepare(
    `UPDATE pricebook_index
        SET image_path = ?, image_checked_at = datetime('now')
      WHERE st_id = ? AND sku_type = ?`
  ).run(path || null, Number(stId), skuType);

  return { exists: !!path, imagePath: path, source: "st" };
}

// ── Manufacturer scrape (stub) ───────────────────────────────────────────────
// v1 stub: always returns null. Future implementation should:
//   - match on manufacturer (American Standard, Trane, Mitsubishi, etc.)
//   - look up the model number in their product catalog or cut-sheet CDN
//   - fetch + return { bytes, contentType, sourceUrl }
// Kept as a separate function so the substitution is drop-in later.
// eslint-disable-next-line no-unused-vars
async function fetchManufacturerImage({ manufacturer, model }) {
  if (!manufacturer || !model) return null;
  // TODO(enrichment): implement manufacturer image fetch. See
  // pricebook_configurable_equipment_2ton_draft.md for model-number examples.
  return null;
}

// ── AI image generation ──────────────────────────────────────────────────────
function buildImagePrompt({ title, model, manufacturer, description, skuType }) {
  // The prompt is tuned to produce clean product-catalog imagery: white
  // background, centered subject, no text overlays (which would read like
  // fake model numbers printed on the casing).
  const subject = [
    manufacturer ? manufacturer : null,
    title,
    model && !title.includes(model) ? `(${model})` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const kind = (skuType || "").toLowerCase();
  const kindHint =
    kind === "material" ? "hardware or plumbing/HVAC component" :
    kind === "equipment" ? "HVAC equipment unit" :
    kind === "service" ? "service icon or tool used for the job" :
    "HVAC/plumbing item";

  return [
    `Photorealistic product catalog image of a ${kindHint}: ${subject}.`,
    description ? `Item details: ${description.slice(0, 160)}.` : null,
    "Clean white background, soft studio lighting, centered composition.",
    "No text, no model numbers, no watermarks, no price tags, no brand logos stamped on the unit.",
  ]
    .filter(Boolean)
    .join(" ");
}

async function generateAIImage({ title, model, manufacturer, description, skuType } = {}) {
  if (!title) throw new Error("generateAIImage: title required");
  const client = getClient();
  const prompt = buildImagePrompt({ title, model, manufacturer, description, skuType });

  // NOTE: gpt-image-1 does NOT accept `response_format` (only dall-e-2/3 do).
  // It always returns b64_json by default. Adding response_format here would
  // cause OpenAI to 400 with "Unknown parameter: 'response_format'".
  const res = await client.images.generate({
    model: IMAGE_MODEL,
    prompt,
    size: IMAGE_SIZE,
    n: 1,
  });

  const b64 = res.data?.[0]?.b64_json;
  if (!b64) throw new Error("generateAIImage: OpenAI returned no image data");
  const bytes = Buffer.from(b64, "base64");
  return { bytes, prompt, contentType: "image/png" };
}

// ── ensureImage: the end-to-end orchestration ────────────────────────────────
/**
 * source: 'hybrid' (default) | 'ai' | 'manufacturer'
 * force:  if true, regenerate even when the SKU already has an image
 * dryRun: returns the decision + prompt without calling OpenAI or ST
 */
async function ensureImage({
  stId,
  skuType,
  source = "hybrid",
  force = false,
  dryRun = false,
  promptOverride = null,
} = {}) {
  if (!stId) throw new Error("ensureImage: stId required");
  if (!skuType) throw new Error("ensureImage: skuType required");

  const db = getDb();
  const row = db
    .prepare(
      `SELECT st_id, sku_type, name, code, description FROM pricebook_index
         WHERE st_id = ? AND sku_type = ?`
    )
    .get(Number(stId), skuType);
  if (!row) throw new Error(`ensureImage: SKU ${skuType} ${stId} not in local index`);

  // 1) Are we already done?
  const current = await hasImage({ stId, skuType });
  if (current.exists && !force) {
    db.prepare(
      `INSERT INTO pricebook_image_log (st_id, sku_type, source, image_path, status)
       VALUES (?, ?, 'existing', ?, 'skipped')`
    ).run(Number(stId), skuType, current.imagePath);
    return {
      ok: true,
      status: "skipped",
      reason: "SKU already has an image",
      imagePath: current.imagePath,
      source: "existing",
    };
  }

  // Pull the ST record so we have manufacturer + model for prompt context
  let stItem = null;
  try {
    stItem = await getPricebookItem(skuType, stId);
  } catch (err) {
    // Non-fatal — we can still generate a generic image from the index row
    console.warn(`[Image] getPricebookItem failed for ${skuType} ${stId}: ${err.message}`);
  }

  const manufacturer = stItem?.manufacturer || null;
  const model = stItem?.model || stItem?.modelNumber || row.code || null;
  const title = row.name || stItem?.displayName || stItem?.name || "";
  const description = row.description || stItem?.description || "";

  // 2) Try manufacturer scrape first when source is hybrid/manufacturer
  let bytes = null;
  let chosenSource = null;
  let prompt = null;

  if (source === "manufacturer" || source === "hybrid") {
    try {
      const mfg = await fetchManufacturerImage({ manufacturer, model });
      if (mfg && mfg.bytes) {
        bytes = mfg.bytes;
        chosenSource = "manufacturer";
      }
    } catch (err) {
      console.warn(`[Image] manufacturer fetch failed: ${err.message}`);
    }
  }

  // 3) Fall back to AI generation when allowed
  if (!bytes && (source === "ai" || source === "hybrid")) {
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        wouldGenerate: true,
        prompt: promptOverride || buildImagePrompt({ title, model, manufacturer, description, skuType }),
        source: "ai",
      };
    }
    try {
      if (promptOverride) {
        const client = getClient();
        // gpt-image-1: do NOT pass response_format — it will error.
        const res = await client.images.generate({
          model: IMAGE_MODEL,
          prompt: promptOverride,
          size: IMAGE_SIZE,
          n: 1,
        });
        const b64 = res.data?.[0]?.b64_json;
        if (!b64) throw new Error("OpenAI returned no image data");
        bytes = Buffer.from(b64, "base64");
        prompt = promptOverride;
      } else {
        const gen = await generateAIImage({ title, model, manufacturer, description, skuType });
        bytes = gen.bytes;
        prompt = gen.prompt;
      }
      chosenSource = "ai";
    } catch (err) {
      db.prepare(
        `INSERT INTO pricebook_image_log (st_id, sku_type, source, prompt, status, error)
         VALUES (?, ?, 'ai', ?, 'failed', ?)`
      ).run(Number(stId), skuType, prompt || null, err.message);
      throw new Error(`ensureImage AI generation failed: ${err.message}`);
    }
  }

  if (!bytes) {
    db.prepare(
      `INSERT INTO pricebook_image_log (st_id, sku_type, source, status, error)
       VALUES (?, ?, ?, 'failed', ?)`
    ).run(Number(stId), skuType, source, "no image source produced bytes");
    throw new Error(`ensureImage: ${source} produced no image`);
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      source: chosenSource,
      prompt,
      bytesLength: bytes.length,
    };
  }

  // 4) Upload to ST
  let uploaded;
  try {
    uploaded = await uploadPricebookImage(bytes, { contentType: "image/png" });
  } catch (err) {
    db.prepare(
      `INSERT INTO pricebook_image_log (st_id, sku_type, source, prompt, status, error)
       VALUES (?, ?, ?, ?, 'failed', ?)`
    ).run(Number(stId), skuType, chosenSource, prompt || null, err.message);
    throw new Error(`ensureImage upload failed: ${err.message}`);
  }
  const imagePath = uploaded.path;
  console.log(`[Image] ST upload for ${skuType} ${stId} returned path: ${imagePath}`);
  console.log(`[Image] ST upload raw response:`, JSON.stringify(uploaded.raw).slice(0, 500));

  // 5) Attach the uploaded image to the SKU + VERIFY the change actually
  // took effect. ST's PATCH endpoints silently accept unknown body fields
  // and return 200, so "the PATCH succeeded" does NOT mean the image was
  // set. We re-GET the SKU after each attempt and confirm the image field
  // actually changed.
  //
  // Shape inventory — we don't know which ST expects, and the Temp/xxx.png
  // path returned by /images suggests a staged upload that needs the right
  // reference in the right field. Attempts are ordered from most-likely to
  // least-likely, and include both PATCH and a direct sub-endpoint attach.
  const updateFn = pickUpdateFn(skuType);

  const buildFullUrl = (p) => {
    if (!p) return null;
    if (/^https?:\/\//i.test(p)) return p;
    return `https://api.servicetitan.io/${p.replace(/^\/+/, "")}`;
  };

  // Pull out the filename and the uuid (without extension) from the
  // Temp/xxxxx.png path — these are likely what ST actually wants as a
  // handle on the upload.
  const basename = imagePath.split("/").pop() || imagePath;          // "uuid.png"
  const uuid = basename.replace(/\.[^.]+$/, "");                     // "uuid"
  const fullUrl = buildFullUrl(imagePath);

  const attempts = [
    // ── PATCH shapes on the SKU itself ──────────────────────────────────
    { kind: "patch", label: "image-scalar",           body: { image: imagePath } },
    { kind: "patch", label: "image-basename",         body: { image: basename } },
    { kind: "patch", label: "image-uuid",             body: { image: uuid } },
    { kind: "patch", label: "image-fullurl",          body: { image: fullUrl } },
    { kind: "patch", label: "imageUrl-path",          body: { imageUrl: imagePath } },
    { kind: "patch", label: "imageUrl-fullurl",       body: { imageUrl: fullUrl } },
    { kind: "patch", label: "imageName-basename",     body: { imageName: basename } },
    { kind: "patch", label: "imageFileId-uuid",       body: { imageFileId: uuid } },
    { kind: "patch", label: "iconFileId-uuid",        body: { iconFileId: uuid } },
    { kind: "patch", label: "picture-path",           body: { picture: imagePath } },
    { kind: "patch", label: "thumbnail-path",         body: { thumbnail: imagePath } },
    { kind: "patch", label: "primaryImage-path",      body: { primaryImage: imagePath } },
    { kind: "patch", label: "images-array-string",    body: { images: [imagePath] } },
    { kind: "patch", label: "images-array-basename",  body: { images: [basename] } },
    { kind: "patch", label: "images-array-object-url",  body: { images: [{ url: imagePath }] } },
    { kind: "patch", label: "images-array-object-path", body: { images: [{ path: imagePath }] } },
    { kind: "patch", label: "images-array-object-fileName", body: { images: [{ fileName: basename, path: imagePath }] } },
    { kind: "patch", label: "image-obj-fileName",     body: { image: { fileName: basename, path: imagePath } } },
    { kind: "patch", label: "assets-type-image-url",  body: { assets: [{ type: "Image", url: imagePath }] } },
    { kind: "patch", label: "assets-type-image-path", body: { assets: [{ type: "Image", path: imagePath }] } },
    { kind: "patch", label: "attachments-path",       body: { attachments: [{ path: imagePath }] } },
    // ── Direct sub-endpoint attach: POST /materials/{id}/image ─────────
    { kind: "attach", label: "attach-path",           body: { path: imagePath } },
    { kind: "attach", label: "attach-image",          body: { image: imagePath } },
    { kind: "attach", label: "attach-fileName",       body: { fileName: basename } },
    { kind: "attach", label: "attach-string",         body: imagePath }, // raw string body
  ];

  const attemptResults = [];
  let patchedWith = null;

  for (const attempt of attempts) {
    let callResponse = null;
    let callErr = null;
    try {
      if (attempt.kind === "attach") {
        const r = await attachPricebookImage(skuType, stId, attempt.body);
        callResponse = r.data;
      } else {
        callResponse = await updateFn(Number(stId), attempt.body);
      }
    } catch (err) {
      callErr = err.message;
      attemptResults.push({ label: attempt.label, kind: attempt.kind, callError: callErr, verified: false });
      console.warn(`[Image] ${attempt.kind} ${attempt.label} threw: ${callErr}`);
      continue;
    }

    // Log the actual ST response body — for attempts that silently succeed,
    // this response sometimes carries hints ("field X ignored", etc.).
    const respSummary =
      callResponse == null ? "(empty)" :
      typeof callResponse === "string" ? callResponse.slice(0, 200) :
      JSON.stringify(callResponse).slice(0, 200);

    // Verify: re-GET and see if the image field now reflects our upload.
    let verifyItem;
    try {
      verifyItem = await getPricebookItem(skuType, stId);
    } catch (err) {
      attemptResults.push({
        label: attempt.label,
        kind: attempt.kind,
        callError: null,
        respSummary,
        verifyError: err.message,
        verified: false,
      });
      console.warn(`[Image] Verify GET after ${attempt.label} threw: ${err.message}`);
      continue;
    }

    const found = extractImagePath(verifyItem);
    const okVerified = !!found;
    attemptResults.push({
      label: attempt.label,
      kind: attempt.kind,
      callError: null,
      respSummary,
      verified: okVerified,
      foundAfter: found,
    });
    console.log(
      `[Image] ${attempt.kind} ${attempt.label}: verified=${okVerified} foundAfter=${found || "(still empty)"} resp=${respSummary}`
    );

    if (okVerified) {
      patchedWith = { label: attempt.label, foundAfter: found };
      break;
    }
  }

  if (!patchedWith) {
    // All shapes failed. Log + throw with the full attempt trace.
    const summary = attemptResults
      .map((a) => `${a.label}: ${a.callError ? `call err (${a.callError})` : `CALLED resp=${a.respSummary || "(empty)"} img=${a.foundAfter || "(empty)"}`}`)
      .join(" | ");
    // Include the full upload raw response — ST may have returned an id/token
    // alongside the Temp/ path that we need to PATCH with instead of the path.
    const uploadRawStr =
      uploaded && uploaded.raw != null
        ? (typeof uploaded.raw === "string"
            ? uploaded.raw.slice(0, 500)
            : JSON.stringify(uploaded.raw).slice(0, 500))
        : "(no raw)";
    db.prepare(
      `INSERT INTO pricebook_image_log (st_id, sku_type, source, image_path, prompt, status, error)
       VALUES (?, ?, ?, ?, ?, 'failed', ?)`
    ).run(
      Number(stId),
      skuType,
      chosenSource,
      imagePath,
      prompt || null,
      `PATCH verified-fail. uploadRaw=${uploadRawStr} | ${summary}`.slice(0, 1800)
    );
    throw new Error(
      `ensureImage: uploaded to ${imagePath} but no PATCH shape made the image appear on the SKU. uploadRaw=${uploadRawStr} | Attempts: ${summary}`
    );
  }

  // 6) Mirror into local cache + write audit row (store the path ST ended
  // up serving, not the one we sent — they may differ).
  const finalPath = patchedWith.foundAfter || imagePath;
  db.prepare(
    `UPDATE pricebook_index
        SET image_path = ?, image_checked_at = datetime('now')
      WHERE st_id = ? AND sku_type = ?`
  ).run(finalPath, Number(stId), skuType);

  db.prepare(
    `INSERT INTO pricebook_image_log (st_id, sku_type, source, image_path, prompt, status, error)
     VALUES (?, ?, ?, ?, ?, 'ok', ?)`
  ).run(
    Number(stId),
    skuType,
    chosenSource,
    finalPath,
    prompt || null,
    `PATCH shape that worked: ${patchedWith.label}`
  );

  console.log(`[Image] ✅ ${skuType} ${stId}: set image via ${chosenSource} (${patchedWith.label}) → ${finalPath}`);

  return {
    ok: true,
    status: "ok",
    source: chosenSource,
    imagePath: finalPath,
    uploadPath: imagePath,
    patchShape: patchedWith.label,
    prompt,
  };
}

// ── Log query ────────────────────────────────────────────────────────────────
function listRecent(limit = 50, stId = null) {
  const db = getDb();
  if (stId) {
    return db
      .prepare(
        `SELECT id, st_id, sku_type, source, image_path, prompt, status, error, created_at
           FROM pricebook_image_log
          WHERE st_id = ?
          ORDER BY datetime(created_at) DESC
          LIMIT ?`
      )
      .all(Number(stId), Math.min(Number(limit) || 50, 500));
  }
  return db
    .prepare(
      `SELECT id, st_id, sku_type, source, image_path, prompt, status, error, created_at
         FROM pricebook_image_log
        ORDER BY datetime(created_at) DESC
        LIMIT ?`
    )
    .all(Math.min(Number(limit) || 50, 500));
}

module.exports = {
  hasImage,
  ensureImage,
  generateAIImage,
  fetchManufacturerImage,
  listRecent,
  // exposed for testing
  _buildImagePrompt: buildImagePrompt,
  _extractImagePath: extractImagePath,
};
