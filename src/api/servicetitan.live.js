const axios = require("axios");

let tokenCache = { token: null, expiresAt: 0 };
let tokenInFlight = null; // de-dupes concurrent token refreshes (no refresh stampede)

// ── Retry helper ────────────────────────────────────────────────────────────
// Retries transient ServiceTitan failures (rate limits + gateway/5xx + network
// blips) with exponential backoff, honoring a Retry-After header when present.
// Use ONLY for idempotent operations (GETs, the token fetch) — never wrap a
// non-idempotent write, since a 5xx might mean the write actually landed.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

async function withRetry(fn, { retries = 4, baseDelayMs = 500, label = "ST request" } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const isNetwork = !err.response; // timeout / connection reset / DNS
      const retryable = isNetwork || RETRYABLE_STATUS.has(status);
      if (!retryable || attempt >= retries) throw err;

      // Prefer the server's Retry-After (seconds) if it gave one.
      const retryAfter = Number(err.response?.headers?.["retry-after"]);
      const backoff =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : baseDelayMs * 2 ** attempt; // 0.5s, 1s, 2s, 4s
      attempt++;
      console.warn(`[ST] ${label} ${status || "network error"} — retry ${attempt}/${retries} in ${backoff}ms`);
      await sleep(backoff);
    }
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) {
    return tokenCache.token;
  }
  // If a refresh is already running, wait on it instead of firing another.
  if (tokenInFlight) return tokenInFlight;

  tokenInFlight = (async () => {
    const res = await withRetry(
      () =>
        axios.post(
          "https://auth.servicetitan.io/connect/token",
          new URLSearchParams({
            grant_type: "client_credentials",
            client_id: process.env.ST_CLIENT_ID,
            client_secret: process.env.ST_CLIENT_SECRET,
          }),
          { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
        ),
      { label: "token fetch" }
    );
    tokenCache = {
      token: res.data.access_token,
      expiresAt: Date.now() + res.data.expires_in * 1000,
    };
    return tokenCache.token;
  })();

  try {
    return await tokenInFlight;
  } finally {
    tokenInFlight = null;
  }
}

function stClient() {
  return {
    // Reads are retried on transient failures. On a 401 the token cache is
    // cleared so the next attempt re-authenticates (self-heals early revocation).
    get: async (path, params = {}) => {
      return withRetry(
        async () => {
          const token = await getAccessToken();
          try {
            return await axios.get(`https://api.servicetitan.io${path}`, {
              headers: {
                Authorization: `Bearer ${token}`,
                "ST-App-Key": process.env.ST_APP_KEY,
              },
              params: { tenant: process.env.ST_TENANT_ID, ...params },
            });
          } catch (err) {
            if (err.response?.status === 401) tokenCache = { token: null, expiresAt: 0 };
            throw err;
          }
        },
        { label: `GET ${path}` }
      );
    },
    // Writes are NOT auto-retried on 5xx (a 5xx could mean it landed). We retry
    // once only on a 401, which is safe because the request was rejected unread.
    post: async (path, body = {}) => {
      const doPost = async () => {
        const token = await getAccessToken();
        return axios.post(`https://api.servicetitan.io${path}`, body, {
          headers: {
            Authorization: `Bearer ${token}`,
            "ST-App-Key": process.env.ST_APP_KEY,
            "Content-Type": "application/json",
          },
        });
      };
      try {
        return await doPost();
      } catch (err) {
        if (err.response?.status === 401) {
          tokenCache = { token: null, expiresAt: 0 };
          return doPost();
        }
        throw err;
      }
    },
    put: async (path, body = {}) => {
      const doPut = async () => {
        const token = await getAccessToken();
        return axios.put(`https://api.servicetitan.io${path}`, body, {
          headers: {
            Authorization: `Bearer ${token}`,
            "ST-App-Key": process.env.ST_APP_KEY,
            "Content-Type": "application/json",
          },
        });
      };
      try {
        return await doPut();
      } catch (err) {
        if (err.response?.status === 401) {
          tokenCache = { token: null, expiresAt: 0 };
          return doPut();
        }
        throw err;
      }
    },
  };
}

// ── Pricebook / Materials ─────────────────────────────────────────────────────

// Safety list — IDs that we must NEVER modify/deactivate through the admin
// endpoints, regardless of what the caller requests.
const MATERIAL_SAFE_LIST = new Set([
  4021784, // "Miscellaneous Material" — actively in use tenant-wide
]);

/**
 * Deactivate a pricebook material.
 * Tries two paths in order:
 *   1. DELETE /pricebook/v2/tenant/{tenant}/materials/{id}
 *   2. PATCH /pricebook/v2/tenant/{tenant}/materials/{id} with { active: false }
 *
 * ST's pricebook endpoint behavior varies — some tenants reject DELETE and
 * only honor active:false. We return which method actually worked (or
 * "both-failed" if neither did).
 *
 * Returns: { method: "DELETE"|"PATCH"|"none", status, data }
 */
async function deactivateMaterial(materialId) {
  if (!materialId) throw new Error("deactivateMaterial: materialId required");
  const idNum = Number(materialId);
  if (MATERIAL_SAFE_LIST.has(idNum)) {
    throw new Error(
      `Refusing to touch material ${idNum} — it's on the safe list. ` +
        `(Edit MATERIAL_SAFE_LIST in src/api/servicetitan.js if you really need to.)`
    );
  }

  const token = await getAccessToken();
  const url = `https://api.servicetitan.io/pricebook/v2/tenant/${process.env.ST_TENANT_ID}/materials/${idNum}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "ST-App-Key": process.env.ST_APP_KEY,
    "Content-Type": "application/json",
  };

  // Attempt 1: DELETE
  try {
    const res = await axios.delete(url, { headers });
    return { method: "DELETE", status: res.status, data: res.data ?? null };
  } catch (err) {
    const status = err.response?.status;
    if (status !== 404 && status !== 405 && status !== 501) {
      // Real error, not a shape mismatch — surface it
      const d = err.response?.data;
      const detail = d ? (typeof d === "string" ? d : JSON.stringify(d).slice(0, 300)) : err.message;
      throw new Error(`deactivateMaterial DELETE failed (${status || "?"}): ${detail}`);
    }
    console.log(`[ST] deactivateMaterial DELETE ${status} — falling back to PATCH active:false`);
  }

  // Attempt 2: PATCH active:false (fall back, then PUT if PATCH rejects too)
  const patchBody = { active: false };
  try {
    const res = await axios.patch(url, patchBody, { headers });
    return { method: "PATCH", status: res.status, data: res.data ?? null };
  } catch (err) {
    const status = err.response?.status;
    if (status === 404 || status === 405) {
      try {
        const res = await axios.put(url, patchBody, { headers });
        return { method: "PUT", status: res.status, data: res.data ?? null };
      } catch (err2) {
        const s = err2.response?.status;
        const d = err2.response?.data;
        const detail = d ? (typeof d === "string" ? d : JSON.stringify(d).slice(0, 300)) : err2.message;
        throw new Error(`deactivateMaterial PUT failed (${s || "?"}): ${detail}`);
      }
    }
    const d = err.response?.data;
    const detail = d ? (typeof d === "string" ? d : JSON.stringify(d).slice(0, 300)) : err.message;
    throw new Error(`deactivateMaterial PATCH failed (${status || "?"}): ${detail}`);
  }
}

/**
 * Create a new pricebook material (SKU).
 * POST /pricebook/v2/tenant/{tenant}/materials
 * Required fields per ST schema: code, description. Everything else optional.
 */
async function createMaterial(body) {
  if (!body || !body.code) throw new Error("createMaterial: body.code required");
  if (!body.description) throw new Error("createMaterial: body.description required");
  const token = await getAccessToken();
  const url = `https://api.servicetitan.io/pricebook/v2/tenant/${process.env.ST_TENANT_ID}/materials`;
  try {
    const res = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "ST-App-Key": process.env.ST_APP_KEY,
        "Content-Type": "application/json",
      },
    });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const detail = data ? (typeof data === "string" ? data : JSON.stringify(data).slice(0, 500)) : err.message;
    throw new Error(`createMaterial failed (${status || "?"}): ${detail}`);
  }
}

/**
 * Update fields on an existing pricebook material (SKU).
 *   updateMaterial(4021784, { chargeableByDefault: false })
 *
 * Tries PATCH first (ST's standard update verb), falls back to PUT if PATCH
 * returns 404/405. Returns the updated material or throws with ST's detail.
 */
async function updateMaterial(materialId, updates) {
  if (!materialId) throw new Error("updateMaterial: materialId required");
  if (!updates || typeof updates !== "object") {
    throw new Error("updateMaterial: updates object required");
  }
  const token = await getAccessToken();
  const url = `https://api.servicetitan.io/pricebook/v2/tenant/${process.env.ST_TENANT_ID}/materials/${materialId}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "ST-App-Key": process.env.ST_APP_KEY,
    "Content-Type": "application/json",
  };

  const tryRequest = async (method) => {
    const res = await axios({ url, method, headers, data: updates });
    return res.data;
  };

  try {
    return await tryRequest("patch");
  } catch (err) {
    const status = err.response?.status;
    if (status === 404 || status === 405) {
      console.log(`[ST] updateMaterial PATCH ${status} — trying PUT fallback`);
      try {
        return await tryRequest("put");
      } catch (err2) {
        const s = err2.response?.status;
        const d = err2.response?.data;
        const detail = d ? (typeof d === "string" ? d : JSON.stringify(d).slice(0, 400)) : err2.message;
        throw new Error(`updateMaterial PUT failed (${s || "?"}): ${detail}`);
      }
    }
    const data = err.response?.data;
    const detail = data ? (typeof data === "string" ? data : JSON.stringify(data).slice(0, 400)) : err.message;
    throw new Error(`updateMaterial PATCH failed (${status || "?"}): ${detail}`);
  }
}

/**
 * Update fields on an existing pricebook equipment (SKU).
 *   updateEquipment(12345, { active: false })
 *
 * Tries PATCH first, falls back to PUT on 404/405.
 */
async function updateEquipment(equipmentId, updates) {
  if (!equipmentId) throw new Error("updateEquipment: equipmentId required");
  if (!updates || typeof updates !== "object") {
    throw new Error("updateEquipment: updates object required");
  }
  const token = await getAccessToken();
  const url = `https://api.servicetitan.io/pricebook/v2/tenant/${process.env.ST_TENANT_ID}/equipment/${equipmentId}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "ST-App-Key": process.env.ST_APP_KEY,
    "Content-Type": "application/json",
  };

  const tryRequest = async (method) => {
    const res = await axios({ url, method, headers, data: updates });
    return res.data;
  };

  try {
    return await tryRequest("patch");
  } catch (err) {
    const status = err.response?.status;
    if (status === 404 || status === 405) {
      console.log(`[ST] updateEquipment PATCH ${status} — trying PUT fallback`);
      try {
        return await tryRequest("put");
      } catch (err2) {
        const s = err2.response?.status;
        const d = err2.response?.data;
        const detail = d ? (typeof d === "string" ? d : JSON.stringify(d).slice(0, 400)) : err2.message;
        throw new Error(`updateEquipment PUT failed (${s || "?"}): ${detail}`);
      }
    }
    const data = err.response?.data;
    const detail = data ? (typeof data === "string" ? data : JSON.stringify(data).slice(0, 400)) : err.message;
    throw new Error(`updateEquipment PATCH failed (${status || "?"}): ${detail}`);
  }
}

/**
 * Update fields on an existing pricebook service (SKU).
 *   updateService(67890, { active: false })
 *
 * Tries PATCH first, falls back to PUT on 404/405.
 */
async function updateService(serviceId, updates) {
  if (!serviceId) throw new Error("updateService: serviceId required");
  if (!updates || typeof updates !== "object") {
    throw new Error("updateService: updates object required");
  }
  const token = await getAccessToken();
  const url = `https://api.servicetitan.io/pricebook/v2/tenant/${process.env.ST_TENANT_ID}/services/${serviceId}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "ST-App-Key": process.env.ST_APP_KEY,
    "Content-Type": "application/json",
  };

  const tryRequest = async (method) => {
    const res = await axios({ url, method, headers, data: updates });
    return res.data;
  };

  try {
    return await tryRequest("patch");
  } catch (err) {
    const status = err.response?.status;
    if (status === 404 || status === 405) {
      console.log(`[ST] updateService PATCH ${status} — trying PUT fallback`);
      try {
        return await tryRequest("put");
      } catch (err2) {
        const s = err2.response?.status;
        const d = err2.response?.data;
        const detail = d ? (typeof d === "string" ? d : JSON.stringify(d).slice(0, 400)) : err2.message;
        throw new Error(`updateService PUT failed (${s || "?"}): ${detail}`);
      }
    }
    const data = err.response?.data;
    const detail = data ? (typeof data === "string" ? data : JSON.stringify(data).slice(0, 400)) : err.message;
    throw new Error(`updateService PATCH failed (${status || "?"}): ${detail}`);
  }
}

/**
 * Fetch one pricebook SKU by id + type. Uses the typed single-fetch endpoint
 * (GET /materials/{id} / /equipment/{id} / /services/{id}) which returns the
 * full record including `image`/`images` — fields the search endpoints don't
 * always return reliably.
 */
async function getPricebookItem(skuType, itemId) {
  if (!itemId) throw new Error("getPricebookItem: itemId required");
  const lower = String(skuType || "").toLowerCase();
  const path =
    lower === "material" || lower === "materials" ? "materials" :
    lower === "equipment" ? "equipment" :
    lower === "service" || lower === "services" ? "services" : null;
  if (!path) throw new Error(`getPricebookItem: unsupported skuType "${skuType}"`);

  const token = await getAccessToken();
  const url = `https://api.servicetitan.io/pricebook/v2/tenant/${process.env.ST_TENANT_ID}/${path}/${itemId}`;
  try {
    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "ST-App-Key": process.env.ST_APP_KEY,
      },
    });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const detail = data ? (typeof data === "string" ? data : JSON.stringify(data).slice(0, 400)) : err.message;
    throw new Error(`getPricebookItem(${path} ${itemId}) failed (${status || "?"}): ${detail}`);
  }
}

/**
 * Upload an image to the pricebook's image store.
 * POST /pricebook/v2/tenant/{tenant}/images
 *
 * ST's pricebook images endpoint is a multipart/form-data upload (same as
 * their customer-attachment + job-attachment endpoints). The field name is
 * `file`. On success it returns either a JSON object containing the image
 * path, or a plain-text string path.
 *
 * The returned path is then set on a SKU via its own PATCH call
 * (updateMaterial / updateEquipment / updateService) with `{ image: "<path>" }`.
 *
 * NOTE: An earlier revision of this helper sent JSON with base64 bytes — that
 * is NOT what the endpoint accepts and causes a 415/400 at the gateway.
 */
/**
 * Attach an image to a pricebook item via a type-specific sub-endpoint.
 * Tries POST /pricebook/v2/tenant/{tenant}/{materials|equipment|services}/{id}/image
 * with various body shapes. Returns { ok, status, data } on success; throws
 * with detail on failure. Used as a fallback when plain PATCH field shapes
 * are being silently ignored.
 */
async function attachPricebookImage(skuType, itemId, body) {
  const lower = String(skuType || "").toLowerCase();
  const path =
    lower === "material" || lower === "materials" ? "materials" :
    lower === "equipment" ? "equipment" :
    lower === "service" || lower === "services" ? "services" : null;
  if (!path) throw new Error(`attachPricebookImage: unsupported skuType "${skuType}"`);

  const token = await getAccessToken();
  const url = `https://api.servicetitan.io/pricebook/v2/tenant/${process.env.ST_TENANT_ID}/${path}/${itemId}/image`;
  try {
    const res = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "ST-App-Key": process.env.ST_APP_KEY,
        "Content-Type": "application/json",
      },
    });
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const detail = data ? (typeof data === "string" ? data : JSON.stringify(data).slice(0, 400)) : err.message;
    throw new Error(`attachPricebookImage(${path} ${itemId}) failed (${status || "?"}): ${detail}`);
  }
}

/**
 * Fetch the raw bytes for a pricebook image path (e.g. "Images/abc.png" or
 * an absolute URL like "https://...api.servicetitan.io/.../xyz.png").
 *
 * The image store requires ST auth headers, so the browser can't <img src>
 * it directly — the route /api/pricebook/image-proxy uses this helper to
 * stream bytes back to the browser.
 *
 * Returns { bytes: Buffer, contentType: string }.
 */
async function fetchPricebookImageBytes(pathOrUrl) {
  if (!pathOrUrl) throw new Error("fetchPricebookImageBytes: pathOrUrl required");
  const token = await getAccessToken();
  const isAbs = /^https?:\/\//i.test(pathOrUrl);
  // Normalize: if ST gave us an absolute URL, use as-is. If it's a path like
  // "Images/abc.png", join against the pricebook images endpoint.
  const url = isAbs
    ? pathOrUrl
    : `https://api.servicetitan.io/pricebook/v2/tenant/${process.env.ST_TENANT_ID}/images/${encodeURIComponent(pathOrUrl.replace(/^\/+/, ""))}`;
  try {
    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "ST-App-Key": process.env.ST_APP_KEY,
      },
      responseType: "arraybuffer",
      maxContentLength: 25 * 1024 * 1024,
    });
    const ct = res.headers["content-type"] || "image/png";
    return { bytes: Buffer.from(res.data), contentType: ct };
  } catch (err) {
    const status = err.response?.status;
    const detail =
      err.response?.data
        ? Buffer.isBuffer(err.response.data)
          ? err.response.data.toString("utf8").slice(0, 300)
          : String(err.response.data).slice(0, 300)
        : err.message;
    throw new Error(`fetchPricebookImageBytes(${pathOrUrl}) failed (${status || "?"}): ${detail}`);
  }
}

async function uploadPricebookImage(imageBytes, { contentType = "image/png", filename } = {}) {
  if (!imageBytes) throw new Error("uploadPricebookImage: imageBytes required");
  const buf = Buffer.isBuffer(imageBytes) ? imageBytes : Buffer.from(imageBytes);

  // Defer FormData require — avoids loading it on every axios import path.
  // eslint-disable-next-line global-require
  const FormData = require("form-data");
  const form = new FormData();
  // Unique-ish filename so ST doesn't collapse uploads on its side.
  const ext = contentType.includes("jpeg") ? "jpg" : contentType.includes("webp") ? "webp" : "png";
  const fname = filename || `pricebook-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`;
  form.append("file", buf, { filename: fname, contentType });

  const token = await getAccessToken();
  const url = `https://api.servicetitan.io/pricebook/v2/tenant/${process.env.ST_TENANT_ID}/images`;
  try {
    const res = await axios.post(url, form, {
      headers: {
        Authorization: `Bearer ${token}`,
        "ST-App-Key": process.env.ST_APP_KEY,
        ...form.getHeaders(),
      },
      maxContentLength: 20 * 1024 * 1024,
      maxBodyLength: 20 * 1024 * 1024,
    });
    const d = res.data;
    // Normalize the response into a path string. ST has been observed to
    // return one of:
    //   - "Images/abc123.png"                        (plain string)
    //   - { path: "Images/abc123.png" }              (object with path key)
    //   - { imagePath: "..." } / { url: "..." }      (variant keys)
    let path = null;
    if (typeof d === "string") {
      // Strip surrounding quotes if the server returned a JSON-quoted string
      path = d.replace(/^"|"$/g, "").trim();
    } else if (d && typeof d === "object") {
      path = d.path || d.imagePath || d.image || d.url || d.file || d.fileName || null;
    }
    if (!path) {
      // Last-resort — surface the raw response so the caller can see what
      // came back. Throw so we don't silently PATCH a SKU with JSON garbage.
      throw new Error(
        `uploadPricebookImage: could not extract path from response: ${
          typeof d === "string" ? d : JSON.stringify(d).slice(0, 300)
        }`
      );
    }
    return { path, raw: d, contentType, filename: fname };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const detail = data ? (typeof data === "string" ? data : JSON.stringify(data).slice(0, 400)) : err.message;
    throw new Error(`uploadPricebookImage failed (${status || "?"}): ${detail}`);
  }
}

// ── Job attachments ───────────────────────────────────────────────────────────

/**
 * Attach a file (e.g. a JPG extracted from a scanned PDF) to a ServiceTitan job.
 *
 * Forms v2:  POST /forms/v2/tenant/{tenant}/jobs/{id}/attachments
 *   - multipart/form-data, field name "file" (same upload shape as the
 *     pricebook image endpoint above — see uploadPricebookImage)
 *   - returns { fileName }
 *   - requires OAuth scope  tn.frm.jobs:w  on the app AND tenant authorization
 *
 * NOTE: `jobId` is the INTERNAL ST job id (integer), not the job number the
 * office types. Resolve a typed job number with findJobByNumber() first.
 *
 * @param {number|string} jobId
 * @param {Buffer} fileBytes
 * @param {object} [opts]
 * @param {string} [opts.filename]
 * @param {string} [opts.contentType="image/jpeg"]
 * @returns {Promise<{ fileName: string, raw: any }>}
 */
async function createJobAttachment(jobId, fileBytes, { filename, contentType = "image/jpeg" } = {}) {
  if (!jobId) throw new Error("createJobAttachment: jobId required");
  if (!fileBytes) throw new Error("createJobAttachment: fileBytes required");
  const buf = Buffer.isBuffer(fileBytes) ? fileBytes : Buffer.from(fileBytes);

  // eslint-disable-next-line global-require
  const FormData = require("form-data");
  const form = new FormData();
  const fname = filename || `attachment-${Date.now()}.jpg`;
  form.append("file", buf, { filename: fname, contentType });

  const token = await getAccessToken();
  const url = `https://api.servicetitan.io/forms/v2/tenant/${process.env.ST_TENANT_ID}/jobs/${jobId}/attachments`;
  try {
    const res = await axios.post(url, form, {
      headers: {
        Authorization: `Bearer ${token}`,
        "ST-App-Key": process.env.ST_APP_KEY,
        ...form.getHeaders(),
      },
      maxContentLength: 60 * 1024 * 1024,
      maxBodyLength: 60 * 1024 * 1024,
    });
    const d = res.data;
    const fileName =
      (d && typeof d === "object" ? d.fileName || d.filename || d.name : null) || fname;
    return { fileName, raw: d };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const detail = data ? (typeof data === "string" ? data : JSON.stringify(data).slice(0, 400)) : err.message;
    // Give the most common misconfig a friendly hint.
    const hint = status === 403
      ? " — the app/tenant is missing the 'tn.frm.jobs:w' (Forms: jobs write) scope."
      : "";
    throw new Error(`createJobAttachment(job ${jobId}) failed (${status || "?"}): ${detail}${hint}`);
  }
}

// ── Notes ─────────────────────────────────────────────────────────────────────

/**
 * Add a note to a ServiceTitan job.
 * POST /jpm/v2/tenant/{tenant}/jobs/{jobId}/notes
 */
async function addJobNote(jobId, text) {
  const client = stClient();
  const res = await client.post(
    `/jpm/v2/tenant/${process.env.ST_TENANT_ID}/jobs/${jobId}/notes`,
    { text, isPinned: false }
  );
  return res.data;
}

/**
 * Add a note to a ServiceTitan customer.
 * POST /crm/v2/tenant/{tenant}/customers/{customerId}/notes
 */
async function addCustomerNote(customerId, text) {
  const client = stClient();
  const res = await client.post(
    `/crm/v2/tenant/${process.env.ST_TENANT_ID}/customers/${customerId}/notes`,
    { text, isPinned: false }
  );
  return res.data;
}

/**
 * Create a membership on a customer.
 * POST /memberships/v2/tenant/{tenant}/memberships
 *
 * body: { customerId, locationIds?, membershipTypeId, from, to, businessUnitId?, ... }
 * NOTE: the exact required fields are account-specific and this path is not yet
 * verified against production — callers should guard the call and fall back
 * (e.g. to a customer note) on failure. Throws with ST's detail on error.
 */
async function createMembership(body) {
  if (!body || !body.customerId || !body.membershipTypeId) {
    throw new Error("createMembership: customerId and membershipTypeId required");
  }
  const token = await getAccessToken();
  const url = `https://api.servicetitan.io/memberships/v2/tenant/${process.env.ST_TENANT_ID}/memberships`;
  try {
    const res = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "ST-App-Key": process.env.ST_APP_KEY,
        "Content-Type": "application/json",
      },
    });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const detail = data ? (typeof data === "string" ? data : JSON.stringify(data).slice(0, 500)) : err.message;
    throw new Error(`createMembership failed (${status || "?"}): ${detail}`);
  }
}

/**
 * Apply a tag to a ServiceTitan customer.
 * POST /crm/v2/tenant/{tenant}/customers/{customerId}/tags
 *
 * tagTypeId — the numeric ID of the tag type (from Settings → Tags in ST)
 */
async function applyTagToCustomer(customerId, tagTypeId) {
  const client = stClient();
  const res = await client.post(
    `/crm/v2/tenant/${process.env.ST_TENANT_ID}/customers/${customerId}/tags`,
    { typeId: tagTypeId }
  );
  return res.data;
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

/**
 * Look up a job's internal ID from its display job number (e.g. "2602739").
 *
 * ServiceTitan has two different job identifiers:
 *   - Job Number: the human-readable number shown in the ST UI (e.g. 2602739)
 *   - Job ID:     the internal database ID used in API calls  (e.g. 62695261)
 *
 * This function accepts EITHER format and always returns the internal Job ID.
 * If a 7-8 digit number is passed and it doesn't match a job number, it is
 * assumed to already be an internal ID and returned as-is.
 *
 * Returns null if no job found.
 */
async function findJobByNumber(jobNumberOrId) {
  const value = String(jobNumberOrId).trim();

  // Pass 1 — look up by human-facing job number (the common case).
  try {
    const job = await getJobByNumber(value);
    if (job) {
      console.log(`[ST] Resolved job number ${value} → internal ID ${job.id}`);
      return { jobId: String(job.id), jobNumber: job.jobNumber };
    }
  } catch (err) {
    console.warn(`[ST] findJobByNumber search failed: ${err.response?.status} ${err.message}`);
  }

  // Pass 2 — maybe the user (or a legacy override) gave us the internal ID
  // directly. Only trust this if the ID actually resolves to a real job.
  // This matters because the parser can extract the WRONG number (e.g. from
  // "Order #") — we must not silently pass a bogus ID to createPurchaseOrder.
  if (/^\d+$/.test(value)) {
    try {
      const job = await getJob(value);
      if (job && job.id) {
        console.log(`[ST] ${value} matched as internal job ID → jobNumber ${job.jobNumber}`);
        return { jobId: String(job.id), jobNumber: job.jobNumber || null };
      }
    } catch (err) {
      // 404 from /jobs/{id} means no such internal job — expected for bad numbers
      const status = err.response?.status;
      if (status && status !== 404) {
        console.warn(`[ST] findJobByNumber: getJob(${value}) failed: ${status} ${err.message}`);
      }
    }
  }

  console.log(`[ST] No job found for "${value}" (neither by number nor by internal ID)`);
  return { jobId: null, jobNumber: null };
}

// ── Inventory / Purchase Orders ───────────────────────────────────────────────

// ── Vendor matching ────────────────────────────────────────────────────────────
//
// ST's GET /inventory/v2/vendors endpoint does NOT honor a `name` query param,
// so the old "just ask ST to filter" approach was wrong — we were getting the
// full (or alphabetical) vendor list and picking index 0, which caused
// invoices from "Meridian Supply Co." to match "ABC Supply Co".
//
// Instead we fetch the full active vendor list (paginated + cached 10 min)
// and do token-based fuzzy matching client-side.

const CORP_SUFFIX_TOKENS = new Set([
  "co", "company", "corp", "corporation", "inc", "incorporated",
  "llc", "ltd", "limited", "lp", "llp", "plc", "pllc", "pc",
  "gmbh", "nv", "bv",
]);

/**
 * Normalize a vendor name into an array of matching tokens.
 * Drops corporate-entity suffixes so "Meridian Supply Co." and
 * "Meridian Supply Co." tokenize the same way.
 */
function vendorTokens(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !CORP_SUFFIX_TOKENS.has(t));
}

/**
 * Jaccard similarity over token sets. Returns 0..1.
 */
function jaccardScore(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

// In-memory cache of the full active vendor list (10 min TTL).
let VENDOR_CACHE = { vendors: null, expiresAt: 0 };
const VENDOR_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Fetch every active vendor from ST, paginating until done.
 * Cached for VENDOR_CACHE_TTL_MS.
 *
 * NOTE: ST caps pageSize on this endpoint (requests over the cap return 400).
 * Empirically 200 is safe and matches what we use for /settings/technicians.
 */
async function fetchAllActiveVendors() {
  if (VENDOR_CACHE.vendors && Date.now() < VENDOR_CACHE.expiresAt) {
    return VENDOR_CACHE.vendors;
  }
  const client = stClient();
  const all = [];
  const PAGE_SIZE = 200;
  const MAX_PAGES = 50; // safety cap: 10k vendors
  for (let page = 1; page <= MAX_PAGES; page++) {
    let res;
    try {
      res = await client.get(
        `/inventory/v2/tenant/${process.env.ST_TENANT_ID}/vendors`,
        { page, pageSize: PAGE_SIZE, active: "True" }
      );
    } catch (err) {
      // Surface ST's actual response body — axios default message is useless
      const body = err.response?.data;
      const detail = body
        ? typeof body === "string" ? body : JSON.stringify(body).slice(0, 400)
        : err.message;
      throw new Error(
        `ST vendors fetch failed (page ${page}, pageSize ${PAGE_SIZE}): ` +
          `${err.response?.status || "?"} — ${detail}`
      );
    }
    const batch = res.data?.data || [];
    all.push(...batch);
    const hasMore =
      res.data?.hasMore === true ||
      (batch.length === PAGE_SIZE && all.length < (res.data?.totalCount || Infinity));
    if (!hasMore || batch.length === 0) break;
  }
  console.log(`[ST] Cached ${all.length} active vendors for ${VENDOR_CACHE_TTL_MS / 60000}m`);
  VENDOR_CACHE = {
    vendors: all,
    expiresAt: Date.now() + VENDOR_CACHE_TTL_MS,
  };
  return all;
}

/**
 * Find a ServiceTitan vendor by name using fuzzy token matching.
 * Returns the matched vendor object or null if no confident match.
 *
 * Matching rules (in order):
 *   1. Exact normalized match (after dropping corporate suffixes) → always wins.
 *   2. Best Jaccard score ≥ MIN_MATCH_SCORE → wins.
 *   3. Otherwise → null (UI will ask user to create the vendor in ST).
 */
async function findVendorByName(name) {
  if (!name) return null;

  let vendors;
  try {
    vendors = await fetchAllActiveVendors();
  } catch (err) {
    console.warn(
      `[ST] findVendorByName: fetch vendors failed: ${err.response?.status} ${err.message}`
    );
    return null;
  }
  if (!vendors.length) return null;

  const queryTokens = vendorTokens(name);
  if (!queryTokens.length) {
    console.warn(`[ST] findVendorByName: query "${name}" normalized to empty tokens`);
    return null;
  }
  const queryKey = queryTokens.join(" ");

  // Pass 1 — exact normalized match (after dropping corporate suffixes)
  const exact = vendors.find((v) => vendorTokens(v.name).join(" ") === queryKey);
  if (exact) {
    console.log(`[ST] Vendor exact match: "${name}" → "${exact.name}" (id ${exact.id})`);
    return exact;
  }

  // Pass 2 — fuzzy score
  const MIN_MATCH_SCORE = 0.6;
  const scored = vendors
    .map((v) => ({ vendor: v, score: jaccardScore(queryTokens, vendorTokens(v.name)) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1];

  // Ambiguous: top two are tied at/above threshold → refuse to guess
  if (
    best && runnerUp &&
    best.score >= MIN_MATCH_SCORE &&
    Math.abs(best.score - runnerUp.score) < 0.01
  ) {
    console.log(
      `[ST] Vendor AMBIGUOUS for "${name}" — two vendors tied at ${best.score.toFixed(2)}: ` +
        `"${best.vendor.name}" and "${runnerUp.vendor.name}". Refusing to guess.`
    );
    return null;
  }

  if (best && best.score >= MIN_MATCH_SCORE) {
    console.log(
      `[ST] Vendor fuzzy match: "${name}" → "${best.vendor.name}" ` +
        `(id ${best.vendor.id}, score ${best.score.toFixed(2)})`
    );
    return best.vendor;
  }

  // Log the top few candidates so we can tune the threshold from Railway logs
  const topN = scored.slice(0, 3).filter((s) => s.score > 0);
  if (topN.length) {
    console.log(
      `[ST] Vendor NO MATCH for "${name}" (best score ${best.score.toFixed(2)} < ${MIN_MATCH_SCORE}). ` +
        `Near-misses: ${topN.map((s) => `"${s.vendor.name}" (${s.score.toFixed(2)})`).join(", ")}`
    );
  } else {
    console.log(`[ST] Vendor NO MATCH for "${name}" — no candidates shared any tokens.`);
  }
  return null;
}

/**
 * Force a refresh of the vendor cache on the next call.
 * Exposed so callers (e.g. the Invoices UI "Re-check" button) can invalidate
 * after a user creates a new vendor in ServiceTitan.
 */
function invalidateVendorCache() {
  VENDOR_CACHE = { vendors: null, expiresAt: 0 };
}

// ── PO type discovery ─────────────────────────────────────────────────────────
// ST requires a `typeId` on every purchase order — but that ID is
// tenant-specific. Strategy:
//   1. If ST_PO_TYPE_ID env var is set, use it (explicit override).
//   2. Otherwise, fetch the list of PO types on first use and pick the first
//      active one (typically "Standard"). Cache it for the process lifetime.

let PO_TYPE_ID_CACHE = null;
let INVENTORY_LOCATION_ID_CACHE = null;

async function getDefaultPoTypeId() {
  if (process.env.ST_PO_TYPE_ID) return Number(process.env.ST_PO_TYPE_ID);
  if (PO_TYPE_ID_CACHE) return PO_TYPE_ID_CACHE;

  const client = stClient();
  try {
    const res = await client.get(
      `/inventory/v2/tenant/${process.env.ST_TENANT_ID}/purchase-order-types`,
      { pageSize: 50, active: "True" }
    );
    const types = res.data?.data || [];
    const first = types.find((t) => t.active !== false) || types[0];
    if (!first?.id) {
      throw new Error(
        "No PO types found in ServiceTitan. Create one in ST or set ST_PO_TYPE_ID."
      );
    }
    PO_TYPE_ID_CACHE = Number(first.id);
    console.log(
      `[ST] Auto-selected PO typeId=${PO_TYPE_ID_CACHE} (${first.name || "unnamed"}). ` +
        `Set ST_PO_TYPE_ID to override.`
    );
    return PO_TYPE_ID_CACHE;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
    throw new Error(
      `Could not resolve a default PO typeId (${err.response?.status || "?"}): ${detail}. ` +
        `Set ST_PO_TYPE_ID env var to a valid purchase-order-type ID.`
    );
  }
}

async function getDefaultInventoryLocationId() {
  if (process.env.ST_INVENTORY_LOCATION_ID) return Number(process.env.ST_INVENTORY_LOCATION_ID);
  if (INVENTORY_LOCATION_ID_CACHE) return INVENTORY_LOCATION_ID_CACHE;

  const client = stClient();
  const endpoints = [
    // ST uses different paths across tenants — try warehouses first, then the
    // generic "truck-locations" / "locations" endpoints under inventory.
    `/inventory/v2/tenant/${process.env.ST_TENANT_ID}/warehouses`,
    `/inventory/v2/tenant/${process.env.ST_TENANT_ID}/truck-locations`,
  ];
  for (const url of endpoints) {
    try {
      const res = await client.get(url, { pageSize: 50, active: "True" });
      const locs = res.data?.data || [];
      const first = locs.find((l) => l.active !== false) || locs[0];
      if (first?.id) {
        INVENTORY_LOCATION_ID_CACHE = Number(first.id);
        console.log(
          `[ST] Auto-selected inventoryLocationId=${INVENTORY_LOCATION_ID_CACHE} ` +
            `(${first.name || "unnamed"}, from ${url}). Set ST_INVENTORY_LOCATION_ID to override.`
        );
        return INVENTORY_LOCATION_ID_CACHE;
      }
    } catch (err) {
      // Try the next endpoint
      continue;
    }
  }
  throw new Error(
    "Could not resolve a default inventoryLocationId. Set ST_INVENTORY_LOCATION_ID " +
      "env var to a valid warehouse/truck-location ID from ServiceTitan."
  );
}

/**
 * Create a Purchase Order on a job.
 * POST /inventory/v2/tenant/{tenant}/purchase-orders
 *
 * We derive as much as possible from the job itself so the caller doesn't need
 * to know ServiceTitan's required-field set:
 *   - businessUnitId ← from the job
 *   - shipTo         ← from the job's location address
 *   - typeId         ← from ST_PO_TYPE_ID env var, or auto-discovered default
 *
 * Caller-supplied fields:
 *   jobId, vendorId, items, summary, date, vendorDocumentNumber
 *   tax, shipping (numeric; default to 0)
 *   requiredOn     (ISO date; defaults to `date` or today)
 *   shipToOverride (optional address object; if provided, beats the job's location)
 */
async function createPurchaseOrder({
  jobId,
  vendorId,
  items = [],
  summary = "",
  date = null,
  vendorDocumentNumber = null,
  shipToDescription = null,
  tax = 0,
  shipping = 0,
  requiredOn = null,
  shipToOverride = null,
}) {
  if (!jobId) throw new Error("createPurchaseOrder: jobId is required");
  if (!vendorId) throw new Error("createPurchaseOrder: vendorId is required");
  if (!items.length)
    throw new Error("createPurchaseOrder: at least one line item required");

  // 1. Pull the job so we can derive businessUnitId + locationId
  let job;
  try {
    job = await getJob(jobId);
  } catch (err) {
    throw new Error(
      `createPurchaseOrder: could not load job ${jobId} (${err.response?.status || "?"}): ${err.message}`
    );
  }
  const businessUnitId =
    job?.businessUnitId || (process.env.ST_DEFAULT_BUSINESS_UNIT_ID && Number(process.env.ST_DEFAULT_BUSINESS_UNIT_ID));
  if (!businessUnitId) {
    throw new Error(
      `createPurchaseOrder: job ${jobId} has no businessUnitId and ST_DEFAULT_BUSINESS_UNIT_ID is not set.`
    );
  }

  // 2. Build shipTo.
  //
  // For supplier invoices, the real-world ship-to is the counter where the
  // tech picked up the materials — not the customer's job site. This matches
  // how manual POs are entered in this tenant (description = "Vendor Counter
  // Pickup", no address). ST still requires a nested address object, so we
  // send one with empty strings to satisfy the schema.
  //
  // Callers can override via shipToOverride ({ description, address }) or by
  // passing a custom shipToDescription — useful if later we want to route
  // certain POs to be delivered directly to a job site.
  let address = { street: "", unit: "", city: "", state: "", zip: "", country: "USA" };
  let shipDescription = "Vendor Counter Pickup";
  if (shipToOverride) {
    if (shipToOverride.address) address = shipToOverride.address;
    if (shipToOverride.description) shipDescription = shipToOverride.description;
  } else if (shipToDescription) {
    shipDescription = shipToDescription;
  }
  const shipTo = { description: shipDescription, address };

  // 3. Resolve typeId + inventoryLocationId (tenant-specific, auto-discovered)
  const typeId = await getDefaultPoTypeId();
  const inventoryLocationId = await getDefaultInventoryLocationId();

  // 4. Resolve default skuId — every line item on an ST PO must reference a SKU
  //    in inventory. We route all parsed items through one "Non-Stock Purchase"
  //    SKU the user creates in ST, with the real item text in `description`.
  if (!process.env.ST_DEFAULT_SKU_ID) {
    throw new Error(
      "ST_DEFAULT_SKU_ID env var is not set. Every ServiceTitan PO line item needs a " +
        "real SKU id. Create a generic SKU in ST (e.g. named 'Non-Stock Purchase' or " +
        "'Auto-Imported Item'), grab its ID, then set ST_DEFAULT_SKU_ID=<id> in Railway."
    );
  }
  const defaultSkuId = Number(process.env.ST_DEFAULT_SKU_ID);

  const dateIso = date || new Date().toISOString();
  const requiredOnIso = requiredOn || dateIso;

  const client = stClient();
  const body = {
    jobId: Number(jobId),
    vendorId: Number(vendorId),
    businessUnitId: Number(businessUnitId),
    typeId: Number(typeId),
    inventoryLocationId: Number(inventoryLocationId),
    impactsTechnicianPayroll: false, // supplier invoices don't affect payroll
    // Note: ST's `request` field was previously set to a free-text string, but
    // ST's validator still reported it as missing — it likely expects a nested
    // object (PurchaseOrderRequest). The Zapier MCP wrapper doesn't expose this
    // field at all, so omitting it here lets ST auto-handle the default. If
    // this still errors, the fallback is to try `request: {}` then a populated
    // object shape.
    summary,
    memo: summary, // ST's native name for the summary/memo field
    date: dateIso,
    requiredOn: requiredOnIso,
    tax: Number(tax) || 0,
    shipping: Number(shipping) || 0,
    shipTo,
    vendorDocumentNumber: vendorDocumentNumber || undefined,
    shipToDescription: shipToDescription || undefined,
    items: items.map((it) => ({
      skuId: it.skuId ? Number(it.skuId) : defaultSkuId,
      // ST requires a vendor part number per line — the parser's `sku` is the
      // supplier's own part code (e.g. "PP COUP 1" on a Meridian invoice).
      vendorPartNumber:
        it.skuName || it.vendorPartNumber || (it.description || "").slice(0, 60) || "",
      description:
        [it.skuName, it.description].filter(Boolean).join(" — ") || "Item",
      quantity: Number(it.quantity || 1),
      cost: Number(it.cost || 0),
    })),
  };

  let res;
  try {
    res = await client.post(
      `/inventory/v2/tenant/${process.env.ST_TENANT_ID}/purchase-orders`,
      body
    );
  } catch (err) {
    // Surface ST's response body so we know WHY it rejected the PO
    // (e.g. bad jobId, bad vendorId, missing required field, validation error)
    const status = err.response?.status;
    const data = err.response?.data;
    const detail = data
      ? typeof data === "string" ? data : JSON.stringify(data).slice(0, 600)
      : err.message;
    console.error(
      `[ST] createPurchaseOrder failed (${status}) — body sent: ${JSON.stringify(body).slice(0, 400)}\n      ST response: ${detail}`
    );
    throw new Error(`ST purchase order rejected (${status || "?"}): ${detail}`);
  }
  return res.data;
}

// ── Telecom / Calls ───────────────────────────────────────────────────────────

/**
 * Get details for a single call.
 * GET /telecom/v2/tenant/{tenant}/calls/{id}
 */
async function getCall(callId) {
  const token = await getAccessToken();
  const res = await axios.get(
    `https://api.servicetitan.io/telecom/v2/tenant/${process.env.ST_TENANT_ID}/calls/${callId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "ST-App-Key": process.env.ST_APP_KEY,
      },
    }
  );
  return res.data;
}

/**
 * Get the recording stream for a call.
 * GET /telecom/v2/tenant/{tenant}/calls/{id}/recording
 *
 * Returns the Axios response (stream) so callers can pipe it to a file.
 * ST may return 404 if the recording is not yet ready — callers should retry.
 */
async function getCallRecordingStream(callId) {
  const token = await getAccessToken();
  const res = await axios.get(
    `https://api.servicetitan.io/telecom/v2/tenant/${process.env.ST_TENANT_ID}/calls/${callId}/recording`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "ST-App-Key": process.env.ST_APP_KEY,
      },
      responseType: "stream",
    }
  );
  return res;
}

/**
 * Search for customers by phone number.
 * Used by the matching service to link a caller to a ServiceTitan customer.
 * GET /crm/v2/tenant/{tenant}/customers — filter by phone
 */
/**
 * Search customers by name (typeahead). ST CRM v2 /customers accepts a `name`
 * substring match. Returns up to `pageSize` (default 15) matches. Used by the
 * Customer Review page for the customer picker.
 */
async function searchCustomersByName(name, { pageSize = 15 } = {}) {
  if (!name || String(name).trim().length < 2) return [];
  const client = stClient();
  try {
    const res = await client.get(
      `/crm/v2/tenant/${process.env.ST_TENANT_ID}/customers`,
      { name: String(name).trim(), pageSize, active: "True" }
    );
    return res.data?.data || [];
  } catch (err) {
    console.warn(`[ST] searchCustomersByName failed: ${err.response?.status} ${err.message}`);
    return [];
  }
}

/**
 * Search LOCATIONS by street address (substring match on the `street` filter).
 * Each location carries a `customerId`, so callers can resolve the owning
 * customer. Used to let the office find a customer by typing their address.
 * GET /crm/v2/tenant/{tenant}/locations?street=...
 */
async function searchLocationsByAddress(query, { pageSize = 20 } = {}) {
  const q = String(query || "").trim();
  if (q.length < 3) return [];
  const client = stClient();
  try {
    const res = await client.get(
      `/crm/v2/tenant/${process.env.ST_TENANT_ID}/locations`,
      { street: q, pageSize, active: "True" }
    );
    return res.data?.data || [];
  } catch (err) {
    console.warn(`[ST] searchLocationsByAddress failed: ${err.response?.status} ${err.message}`);
    return [];
  }
}

/**
 * Pull every job belonging to a customer whose completion or modification
 * timestamp falls within [startISO, endISO).
 *
 * IMPORTANT — ST API quirks discovered while building Customer Review:
 *
 *  1. /jpm/v2/jobs returns ZERO results when `customerId` is combined with
 *     `completedOnOrAfter` / `modifiedOnOrAfter` on this tenant, even though
 *     each filter works fine on its own. So we don't send the date filter
 *     to ST at all — we pull all jobs for the customer and filter client-side.
 *
 *  2. `sort=-ModifiedOn` is not reliably honored when combined with
 *     `customerId` on busy commercial accounts (SCOTT AFB PROPERTIES has
 *     2,099 jobs and ST appeared to return them in default order, not by
 *     modifiedOn descending). The previous version of this function had an
 *     early-exit predicated on the sort working — it'd bail as soon as it
 *     saw one too-old job — and that cut a 2k-job customer down to 5 hits.
 *     We now walk every page up to the safety cap; no early-exit.
 *
 * Performance: with pageSize=200 a 2,099-job customer paginates in ~11
 * requests (~6 seconds). Adequate for an investigative report. Cap is
 * 20 pages × 200 = 4,000 jobs/customer/query, which covers everything.
 */
async function getJobsForCustomerInRange(customerId, startISO, endISO, { dateField = "modified" } = {}) {
  if (!customerId) return [];
  const client = stClient();

  const startMs = startISO ? Date.parse(startISO) : null;
  const endMs   = endISO   ? Date.parse(endISO)   : null;

  const params = {
    customerId,
    pageSize: 200,
    sort: "-ModifiedOn", // best-effort; we don't rely on it being honored
  };

  const out = [];
  let page = 1;
  let totalFetched = 0;
  const MAX_PAGES = 20;

  while (page <= MAX_PAGES) {
    params.page = page;
    let resp;
    try {
      resp = await client.get(`/jpm/v2/tenant/${process.env.ST_TENANT_ID}/jobs`, params);
    } catch (err) {
      console.warn(`[ST] getJobsForCustomerInRange page ${page} failed: ${err.response?.status} ${err.message}`);
      break;
    }
    const batch = resp.data?.data || [];
    if (!batch.length) break;
    totalFetched += batch.length;

    for (const j of batch) {
      // Choose the timestamp to filter on; fall back to whichever exists.
      const tsStr = dateField === "completed"
        ? (j.completedOn || j.modifiedOn)
        : (j.modifiedOn  || j.completedOn);
      const ts = tsStr ? Date.parse(tsStr) : NaN;

      if (isNaN(ts)) {
        // Date field missing — include conservatively so the user sees them.
        out.push(j);
        continue;
      }
      if (endMs   != null && ts >= endMs) continue;   // newer than window
      if (startMs != null && ts <  startMs) continue; // older than window
      out.push(j);
    }

    if (!resp.data?.hasMore) break;
    page++;
  }

  if (page > MAX_PAGES) {
    console.warn(`[ST] getJobsForCustomerInRange hit ${MAX_PAGES}-page safety cap for customer ${customerId} (fetched ${totalFetched}, kept ${out.length})`);
  }

  // JS-side sort by modifiedOn descending — ST's `sort` param is unreliable
  // when combined with customerId, so we sort here so the UI's "All Jobs"
  // and per-location tables list newest first.
  out.sort((a, b) => {
    const ta = Date.parse(a.modifiedOn || a.completedOn || a.createdOn || 0);
    const tb = Date.parse(b.modifiedOn || b.completedOn || b.createdOn || 0);
    return (isNaN(tb) ? 0 : tb) - (isNaN(ta) ? 0 : ta);
  });

  console.log(`[ST] getJobsForCustomerInRange ${customerId} (${dateField}): fetched ${totalFetched} jobs, ${out.length} matched window`);
  return out;
}

async function searchCustomersByPhone(phoneNumber) {
  const client = stClient();
  // Normalize to digits-only for the search param
  const digits = phoneNumber.replace(/\D/g, "");
  try {
    // ST CRM v2 customer search uses the `phone` parameter (NOT `phoneNumber`).
    // Passing an unknown param caused ST to silently return every customer,
    // so every call previously "matched" the first customer in the tenant.
    const res = await client.get(
      `/crm/v2/tenant/${process.env.ST_TENANT_ID}/customers`,
      { phone: digits, pageSize: 5, active: true }
    );
    return res.data?.data || [];
  } catch (err) {
    // Phone search may not be supported on all ST plans — return empty
    console.warn(`[ST] searchCustomersByPhone failed: ${err.response?.status} ${err.message}`);
    return [];
  }
}

/**
 * Search for recent jobs for a customer, newest first.
 *
 * Accepts either a number (legacy callers passed pageSize directly) or an
 * options object `{ pageSize }`.
 *
 * NOTE: ST's /jpm/v2/jobs endpoint sorts via `sort=-ModifiedOn` (leading `-`
 * means descending). The old `orderBy`/`orderByDirection` params were silently
 * ignored, making ST return jobs in default (ID-ascending) order — which
 * surfaced the *oldest* job instead of the most recent.
 *
 * We also sort JS-side as a defensive fallback in case the API layer or a
 * proxy strips/alters the `sort` param.
 */
async function getRecentJobsForCustomer(customerId, opts = {}) {
  const client = stClient();
  const pageSize = typeof opts === "number"
    ? opts
    : (opts && typeof opts.pageSize === "number" ? opts.pageSize : 10);

  try {
    const res = await client.get(
      `/jpm/v2/tenant/${process.env.ST_TENANT_ID}/jobs`,
      { customerId, pageSize, sort: "-ModifiedOn" }
    );
    const jobs = res.data?.data || [];

    // Defensive: sort by modifiedOn descending in JS in case ST ignored `sort`.
    // Falls back to createdOn, then id, so we never regress to random order.
    jobs.sort((a, b) => {
      const toTs = (j) => {
        const s = j.modifiedOn || j.createdOn || "";
        const t = Date.parse(s);
        return isNaN(t) ? (Number(j.id) || 0) : t;
      };
      return toTs(b) - toTs(a);
    });
    return jobs;
  } catch (err) {
    console.warn(`[ST] getRecentJobsForCustomer failed: ${err.message}`);
    return [];
  }
}

// ── Appointments ──────────────────────────────────────────────────────────────
async function getAppointments({ startsOnOrAfter, startsOnOrBefore, technicianId, jobId, page = 1, pageSize = 50 } = {}) {
  const client = stClient();
  const params = { page, pageSize };
  if (startsOnOrAfter) params.startsOnOrAfter = startsOnOrAfter;
  if (startsOnOrBefore) params.startsOnOrBefore = startsOnOrBefore;
  // ST's /jpm/v2/appointments endpoint filters on the SINGULAR `technicianId`.
  // We previously sent `technicianIds` (plural), which ST silently ignores —
  // so tech-filtered appointment queries were returning EVERY tech's
  // appointments. (Confirmed against the live API + ST's appointments schema.)
  if (technicianId) params.technicianId = technicianId;
  if (jobId) params.jobId = jobId;

  const res = await client.get(`/jpm/v2/tenant/${process.env.ST_TENANT_ID}/appointments`, params);
  return res.data;
}

async function getAllAppointmentsForDateRange(startDate, endDate, technicianId = null) {
  let allAppointments = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const data = await getAppointments({
      startsOnOrAfter: startDate,
      startsOnOrBefore: endDate,
      technicianId,
      page,
      pageSize: 50,
    });

    allAppointments = allAppointments.concat(data.data || []);
    hasMore = data.hasMore || false;
    page++;
  }

  return allAppointments;
}

// ── Jobs ──────────────────────────────────────────────────────────────────────
async function getJob(jobId) {
  const client = stClient();
  const res = await client.get(`/jpm/v2/tenant/${process.env.ST_TENANT_ID}/jobs/${jobId}`);
  return res.data;
}

// NOTE on param names: ST's /jpm/v2/jobs spec uses `modifiedOnOrAfter`
// (inclusive lower bound) and `modifiedBefore` (exclusive upper bound).
// There is NO `modifiedOnOrBefore` — we used to pass that and ST silently
// ignored it, leaving the query unbounded on the upper end and capping at
// the page-100 safety break, which made current-month billing show as $0.
// Keep both names accepted here for back-compat with internal callers, but
// always send `modifiedBefore` on the wire.
async function getJobs({ modifiedOnOrAfter, modifiedBefore, modifiedOnOrBefore, technicianId, page = 1, pageSize = 50 } = {}) {
  const client = stClient();
  const params = { page, pageSize };
  if (modifiedOnOrAfter) params.modifiedOnOrAfter = modifiedOnOrAfter;
  // Accept either name from callers, but always send the ST-spec name.
  const upperBound = modifiedBefore || modifiedOnOrBefore;
  if (upperBound) params.modifiedBefore = upperBound;
  if (technicianId) params.technicianIds = technicianId;

  const res = await client.get(`/jpm/v2/tenant/${process.env.ST_TENANT_ID}/jobs`, params);
  return res.data;
}

async function getJobAppointments(jobId) {
  const data = await getAppointments({ jobId });
  return data.data || [];
}

// ── Technicians ───────────────────────────────────────────────────────────────
async function getTechnicians() {
  const client = stClient();
  const res = await client.get(`/settings/v2/tenant/${process.env.ST_TENANT_ID}/technicians`, { pageSize: 200 });
  return res.data.data || [];
}

async function getTechnicianByName(name) {
  const techs = await getTechnicians();
  const lower = name.toLowerCase();
  return techs.find(
    (t) =>
      `${t.name}`.toLowerCase().includes(lower) ||
      `${t.firstName} ${t.lastName}`.toLowerCase().includes(lower)
  );
}

// ── Employees ────────────────────────────────────────────────────────────────
// Process-level cache so the dashboard isn't hammering /settings/v2/employees
// every time someone opens the escalation dropdown. TTL is 10 minutes — long
// enough to feel snappy, short enough that a new hire shows up quickly.
let _employeeCache = { list: null, expiresAt: 0 };
const EMPLOYEE_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * List ServiceTitan employees (the office/CSR/dispatch team — i.e. the
 * /settings/v2/employees endpoint, distinct from technicians at
 * /settings/v2/technicians).
 *
 * @param {object} opts
 * @param {boolean} opts.active     — only active employees (default true)
 * @param {boolean} opts.force      — bypass the cache
 */
async function listEmployees({ active = true, force = false } = {}) {
  if (!force && _employeeCache.list && Date.now() < _employeeCache.expiresAt) {
    return _employeeCache.list;
  }
  const client = stClient();
  const out = [];
  let page = 1;
  while (true) {
    const res = await client.get(
      `/settings/v2/tenant/${process.env.ST_TENANT_ID}/employees`,
      { pageSize: 200, page, active }
    );
    const batch = res.data?.data || [];
    out.push(...batch);
    if (!res.data?.hasMore || batch.length === 0) break;
    page += 1;
    if (page > 25) break; // hard guard — 5000 employees would be absurd here
  }
  _employeeCache = { list: out, expiresAt: Date.now() + EMPLOYEE_CACHE_TTL_MS };
  return out;
}

/**
 * Create a ServiceTitan employee task (Task Management v2).
 * POST /taskmanagement/v2/tenant/{tenant}/tasks
 *
 * The body accepts a lot of optional fields; we expose the ones the
 * dashboard's escalation workflow needs. ST will reject the call if
 * required reference IDs (employeeTaskTypeId, employeeTaskSourceId) are
 * missing for some tenants — the caller is responsible for passing them
 * if their tenant requires it.
 *
 * @param {object} body
 * @param {string} body.name                 — task title (required by ST UI)
 * @param {string} [body.description]        — task body
 * @param {number} body.assignedToId         — employee ID to assign to
 * @param {number} [body.reportedById]       — employee ID of the reporter
 * @param {string} [body.priority]           — 'low' | 'normal' | 'high' | 'urgent'
 * @param {string} [body.completeBy]         — ISO UTC datetime for due date
 * @param {number} [body.jobId]              — link to a job
 * @param {number} [body.customerId]         — link to a customer
 * @param {number} [body.employeeTaskTypeId] — required by some tenants
 * @param {number} [body.employeeTaskSourceId] — required by some tenants
 * @param {number} [body.businessUnitId]
 *
 * Returns the created task object from ST.
 */
async function createEmployeeTask(body) {
  if (!body || !body.name) throw new Error("createEmployeeTask: name is required");
  if (!body.assignedToId)   throw new Error("createEmployeeTask: assignedToId is required");
  const client = stClient();
  const payload = {
    name:                 body.name,
    description:          body.description || "",
    assignedToId:         body.assignedToId,
    reportedById:         body.reportedById         ?? null,
    priority:             body.priority             ?? "normal",
    completeBy:           body.completeBy           ?? null,
    jobId:                body.jobId                ?? null,
    customerId:           body.customerId           ?? null,
    employeeTaskTypeId:   body.employeeTaskTypeId   ?? null,
    employeeTaskSourceId: body.employeeTaskSourceId ?? null,
    businessUnitId:       body.businessUnitId       ?? null,
    reportedDate:         body.reportedDate         ?? new Date().toISOString(),
    isClosed:             false,
  };
  // Strip null/undefined so ST doesn't reject the payload — the spec allows
  // most fields to be omitted, just not present-and-null on some tenants.
  for (const k of Object.keys(payload)) {
    if (payload[k] === null || payload[k] === undefined) delete payload[k];
  }
  const res = await client.post(
    `/taskmanagement/v2/tenant/${process.env.ST_TENANT_ID}/tasks`,
    payload
  );
  return res.data;
}

// ── Customers ─────────────────────────────────────────────────────────────────
async function getCustomer(customerId) {
  const client = stClient();
  const res = await client.get(`/crm/v2/tenant/${process.env.ST_TENANT_ID}/customers/${customerId}`);
  return res.data;
}

// Fetch contacts for a customer separately — the main customer endpoint does not include contacts
async function getCustomerContacts(customerId) {
  const client = stClient();
  try {
    const res = await client.get(`/crm/v2/tenant/${process.env.ST_TENANT_ID}/customers/${customerId}/contacts`, {
      pageSize: 50,
      active: true,
    });
    return res.data?.data || [];
  } catch (err) {
    console.warn(`[ST] getCustomerContacts failed for customer ${customerId}:`, err.message);
    return [];
  }
}

/**
 * Tenant-wide contact search by phone. Used as a fallback when a customer
 * can't be found via /customers?phone=... — many callers are stored as
 * customer contacts (secondary household member, spouse, etc.) rather than
 * on the main customer record.
 *
 * Returns an array of contacts; each includes a `customerId` we can resolve
 * back to the actual customer via getCustomer().
 *
 * NOTE: This endpoint uses `phone` as the filter param (same gotcha as
 * /customers — ST silently ignores unknown params and returns everything).
 */
async function searchContactsByPhone(phoneNumber) {
  const client = stClient();
  const digits = String(phoneNumber).replace(/\D/g, "");
  try {
    const res = await client.get(
      `/crm/v2/tenant/${process.env.ST_TENANT_ID}/customers/contacts`,
      { phone: digits, pageSize: 5 }
    );
    return res.data?.data || [];
  } catch (err) {
    console.warn(`[ST] searchContactsByPhone failed: ${err.response?.status} ${err.message}`);
    return [];
  }
}

// ── Analytics Helpers ─────────────────────────────────────────────────────────

/**
 * For a given date range, find all jobs that had more than one appointment.
 * Returns array of { job, appointments, technicianIds, isReturnVisit }
 */
async function findReturnVisitJobs(startDate, endDate) {
  let allJobs = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const data = await getJobs({ modifiedOnOrAfter: startDate, modifiedBefore: endDate, page, pageSize: 50 });
    allJobs = allJobs.concat(data.data || []);
    hasMore = data.hasMore || false;
    page++;
  }

  const results = [];

  // Fetch each job's appointments with BOUNDED concurrency instead of a
  // one-at-a-time sequential loop. On a busy date range this was an unbounded
  // N+1 that made thousands of serial round-trips and hung / timed out.
  const CONCURRENCY = 6;
  let idx = 0;
  async function worker() {
    while (idx < allJobs.length) {
      const job = allJobs[idx++];
      let appointments = [];
      try {
        appointments = await getJobAppointments(job.id);
      } catch (err) {
        console.warn(
          `[ST] findReturnVisitJobs: appointments fetch failed for job ${job.id}: ` +
          `${err.response?.status || ""} ${err.message}`
        );
        continue; // skip this job rather than abort the whole scan
      }
      if (appointments.length > 1) {
        results.push({
          job,
          appointments,
          appointmentCount: appointments.length,
          isReturnVisit: true,
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, allJobs.length) }, worker));

  return results;
}

/**
 * Get return visit stats broken down by technician
 */
async function getReturnVisitStatsByTechnician(startDate, endDate) {
  const returnVisitJobs = await findReturnVisitJobs(startDate, endDate);
  const techMap = {};

  for (const { job, appointments } of returnVisitJobs) {
    // First appointment's technician is the "originating" tech
    const sorted = [...appointments].sort((a, b) => new Date(a.start) - new Date(b.start));
    const firstAppt = sorted[0];
    const techId = firstAppt?.technician?.id || "unknown";
    const techName = firstAppt?.technician?.name || "Unknown";

    if (!techMap[techId]) {
      techMap[techId] = { techId, techName, returnVisitCount: 0, jobs: [] };
    }
    techMap[techId].returnVisitCount++;
    techMap[techId].jobs.push(job);
  }

  return Object.values(techMap).sort((a, b) => b.returnVisitCount - a.returnVisitCount);
}

/**
 * Get daily appointment counts for a date range
 */
async function getDailyAppointmentCounts(startDate, endDate) {
  const appointments = await getAllAppointmentsForDateRange(startDate, endDate);
  const dailyMap = {};

  for (const appt of appointments) {
    const day = appt.start?.split("T")[0];
    if (!day) continue;
    dailyMap[day] = (dailyMap[day] || 0) + 1;
  }

  return dailyMap;
}

// ── Membership Recurring Services ─────────────────────────────────────────────
// Uses the recurring-services endpoint (not recurring-service-events).
// recurring-services = the visit slots included in the membership package (e.g. 3 total)
// recurring-service-events = every individual scheduled event instance over the membership lifespan (e.g. 50)
// The ST membership report uses recurring-services, so we do too.
//
// NOTE: ST API ignores all filters on this endpoint — returns records globally, oldest first.
// We attempt a few pages but this is unreliable for newer memberships.
// fanClubService falls back to duration-based estimation when no records are found.
async function getRecurringServicesForMembership(membershipId) {
  const client = stClient();
  const targetId = String(membershipId);

  try {
    for (let page = 1; page <= 5; page++) {
      const res = await client.get(
        `/memberships/v2/tenant/${process.env.ST_TENANT_ID}/recurring-services`,
        { pageSize: 50, page, orderBy: "Id", orderByDirection: "Descending" }
      );
      const records = res.data?.data || [];
      if (records.length === 0) break;

      const matches = records.filter((s) => String(s.membershipId) === targetId);
      if (matches.length > 0) return matches;
    }
    return [];
  } catch (err) {
    console.warn(`[ST] getRecurringServicesForMembership failed for ${membershipId}:`, err.message);
    return [];
  }
}

// ── Installed Equipment (Equipment Systems module) ────────────────────────────
// NOTE: This is DIFFERENT from pricebook "equipment" above. Pricebook equipment
// is the catalog (models you sell). Installed Equipment is a specific physical
// unit at a customer location (serial, install date, warranty). It lives under
// the equipment-systems/v2 module and is keyed to a locationId.
//
// SCOPE GOTCHA: the app + tenant must have the equipment-systems WRITE scope
// authorized or POST returns 403 (same class of issue as the Forms tn.frm.jobs:w
// scope). If createInstalledEquipment 403s, that's the first thing to check.

/**
 * List installed equipment at a location. Used to guard against creating a
 * duplicate unit (same serial) that's already recorded.
 * GET /equipmentsystems/v2/tenant/{tenant}/installed-equipment?locationIds=...
 */
async function getInstalledEquipmentByLocation(locationId) {
  if (!locationId) return [];
  const client = stClient();
  const all = [];
  let page = 1;
  try {
    // Paginate all pages. This backs the duplicate-serial guard before creating
    // installed equipment; a location with >100 units would otherwise miss an
    // existing serial on page 2+ and create a duplicate record.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await client.get(
        `/equipmentsystems/v2/tenant/${process.env.ST_TENANT_ID}/installed-equipment`,
        { locationIds: locationId, page, pageSize: 100, active: "True" }
      );
      const rows = res.data?.data || [];
      all.push(...rows);
      if (!res.data?.hasMore || rows.length === 0) break;
      page++;
    }
    return all;
  } catch (err) {
    console.warn(
      `[ST] getInstalledEquipmentByLocation failed for location ${locationId}: ` +
      `${err.response?.status} ${err.message}`
    );
    return all; // return whatever we managed to collect
  }
}

/**
 * Create an Installed Equipment record on a customer location.
 * POST /equipmentsystems/v2/tenant/{tenant}/installed-equipment
 *
 * Required: locationId. Everything else optional but we normally send name,
 * manufacturer, model, serialNumber, installedOn, and manufacturerWarranty*.
 * Date fields must be ISO-8601 (e.g. "2026-07-09T00:00:00Z").
 *
 * Returns the created record (with its new id) or throws with ST's detail.
 */
async function createInstalledEquipment(body) {
  if (!body || !body.locationId) {
    throw new Error("createInstalledEquipment: body.locationId required");
  }
  const token = await getAccessToken();
  const url = `https://api.servicetitan.io/equipmentsystems/v2/tenant/${process.env.ST_TENANT_ID}/installed-equipment`;
  try {
    const res = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "ST-App-Key": process.env.ST_APP_KEY,
        "Content-Type": "application/json",
      },
    });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const detail = data ? (typeof data === "string" ? data : JSON.stringify(data).slice(0, 500)) : err.message;
    const hint = status === 403
      ? " — the app/tenant is likely missing the equipment-systems WRITE scope."
      : "";
    throw new Error(`createInstalledEquipment failed (${status || "?"}): ${detail}${hint}`);
  }
}

// ── Locations ─────────────────────────────────────────────────────────────────

// Fetch a single location by its ID — fastest and most reliable address lookup
async function getLocationById(locationId) {
  const client = stClient();
  const res = await client.get(`/crm/v2/tenant/${process.env.ST_TENANT_ID}/locations/${locationId}`);
  return res.data || null;
}

// Fallback: find locations by customer ID when no location ID is available
async function getLocationsByCustomer(customerId, { pageSize = 5 } = {}) {
  const client = stClient();
  const res = await client.get(`/crm/v2/tenant/${process.env.ST_TENANT_ID}/locations`, {
    customerId,
    pageSize,
    active: true,
  });
  return res.data?.data || [];
}

// ── Invoices ──────────────────────────────────────────────────────────────────
// ST API prefers jobId (internal numeric ID) — falls back to jobNumber if no results
async function getInvoicesForJob(jobNumber, jobId = null) {
  const client = stClient();

  // Try by internal jobId first (most reliable)
  if (jobId) {
    const res = await client.get(`/accounting/v2/tenant/${process.env.ST_TENANT_ID}/invoices`, { jobId });
    const results = res.data?.data || [];
    if (results.length > 0) return results;
  }

  // Fall back to jobNumber
  const res = await client.get(`/accounting/v2/tenant/${process.env.ST_TENANT_ID}/invoices`, { jobNumber });
  return res.data?.data || [];
}

// ── Payments ────────────────────────────────────────────────────────────────
// Fetch a single payment by its ServiceTitan ID. The payment object carries an
// `appliedTo` array describing which invoices (and how much) the payment was
// applied to. That's the link we use to find "all invoices for this payment."
//
// ST field shape (accounting/v2 payment):
//   { id, referenceNumber, memo, paidOn/date, total, unappliedAmount,
//     customer:{id,name}, type, status,
//     appliedTo:[ { appliedId, appliedTypeId, appliedAmount, appliedOn } ] }
//
// `appliedId` is the invoice ID. Older/edge payloads sometimes name the array
// `splits` or expose `invoiceId` directly, so the caller normalizes.
async function getPayment(paymentId) {
  const client = stClient();
  // ST's accounting API doesn't expose a /payments/{id} path — that returns an
  // API-gateway "Unable to match incoming request to an operation" error. Use
  // the list endpoint with an `ids` filter (same pattern as getInvoicesForJob)
  // and take the single row back.
  const res = await client.get(
    `/accounting/v2/tenant/${process.env.ST_TENANT_ID}/payments`,
    { ids: String(paymentId) }
  );
  const rows = res.data?.data || [];
  return rows[0] || null;
}

// Fetch full invoice records (including line items) for a set of invoice IDs.
// Uses the invoices list endpoint with an `ids` filter (comma-separated). ST
// caps page size, so we page through until every requested ID is returned.
// Returns an array of full invoice objects in no guaranteed order.
async function getInvoicesByIds(ids = []) {
  const wanted = [...new Set(ids.map((x) => String(x)).filter(Boolean))];
  if (wanted.length === 0) return [];

  const client = stClient();
  const collected = [];
  // Chunk to stay well under any URL-length limits on the ids filter.
  const CHUNK = 50;
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const slice = wanted.slice(i, i + CHUNK);
    let page = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await client.get(
        `/accounting/v2/tenant/${process.env.ST_TENANT_ID}/invoices`,
        { ids: slice.join(","), page, pageSize: 50 }
      );
      const rows = res.data?.data || [];
      collected.push(...rows);
      if (!res.data?.hasMore || rows.length === 0) break;
      page += 1;
    }
  }
  return collected;
}

// Fetch a small page of invoices for a customer — used only to reveal the
// invoice schema when diagnosing field mappings.
async function getInvoicesByCustomer(customerId, pageSize = 1) {
  const client = stClient();
  const res = await client.get(
    `/accounting/v2/tenant/${process.env.ST_TENANT_ID}/invoices`,
    { customerId, pageSize }
  );
  return res.data?.data || [];
}

// ── Telecom: update call (reason, etc.) ───────────────────────────────────────

/**
 * Write the call classification and/or reason back to the ServiceTitan call record.
 * PUT /telecom/v2/tenant/{tenant}/calls/{id}
 *
 * Options:
 *   reasonName — display name of the call reason (e.g. "Hang up")
 *   callType   — ST classification enum: Excused | Unbooked | NotLead | Booked | Abandoned
 *   agentId    — ST employee ID to set as the answering agent on the call (optional)
 *
 * The `lead` flag on the reason is derived from callType:
 *   Unbooked → lead: true (unbooked service request = a lost lead)
 *   Everything else → lead: false
 *
 * Fails silently so the UI workflow is never blocked by ST rejecting the update.
 */
async function updateCallReasonOnST(stCallId, { reasonName = null, callType = null, agentId = null } = {}) {
  const client = stClient();
  const body = {};

  if (callType) {
    body.callType = callType;
  }
  if (reasonName) {
    body.reason = {
      name: reasonName,
      lead: callType === "Unbooked",
    };
  }
  // Optional: reassign the answering agent (ST employee ID). Used by the
  // known-caller rules to attribute recurring vendor calls to the CSR who
  // actually handles them, since the phone system doesn't always tag it.
  if (agentId != null && agentId !== "") {
    const idNum = Number(agentId);
    if (Number.isFinite(idNum) && idNum > 0) body.agentId = idNum;
  }

  if (!body.callType && !body.reason && body.agentId == null) return null;

  try {
    const res = await client.put(
      `/telecom/v2/tenant/${process.env.ST_TENANT_ID}/calls/${stCallId}`,
      body
    );
    console.log(`[ST] Updated call ${stCallId} → callType: ${callType || '(unchanged)'}, reason: "${reasonName || '(unchanged)'}", agentId: ${body.agentId ?? '(unchanged)'}`);
    return res.data;
  } catch (err) {
    console.warn(`[ST] updateCallReasonOnST failed for call ${stCallId}: ${err.response?.status} ${err.message}`);
    return null;
  }
}

// ── Jobs by number ─────────────────────────────────────────────────────────────
async function getJobByNumber(jobNumber) {
  const client = stClient();
  // ServiceTitan silently ignores unknown query params, so a wrong filter name
  // returns an ARBITRARY job instead of erroring — callers then attach POs,
  // notes, and files to the wrong job (silent data corruption). The correct
  // filter is `jobNumber` (not `number`). We send both (the ignored one is
  // harmless) AND assert the returned job's number matches, so a silent
  // mis-filter yields null ("not found") rather than the wrong job.
  const res = await client.get(`/jpm/v2/tenant/${process.env.ST_TENANT_ID}/jobs`, {
    jobNumber,
    number: jobNumber,
    pageSize: 1,
  });
  const job = res.data?.data?.[0] || null;
  if (!job) return null;
  if (String(job.jobNumber) !== String(jobNumber)) {
    console.warn(
      `[ST] getJobByNumber(${jobNumber}) — API returned job #${job.jobNumber}, which does not match. Treating as not found rather than risk acting on the wrong job.`
    );
    return null;
  }
  return job;
}

// ── Payroll: per-job labor splits ──────────────────────────────────────────
// ServiceTitan Payroll v2 exposes per-tech labor "splits" attached to a job —
// the most direct source of truth for "how long was each tech on this job".
// Per ST's published spec each split has:
//   { id, jobId, technicianId, startedOn, endedOn, hoursWorked, active, ... }
//
// We page until hasMore=false. Cap at 200 items per call (the API max).
// Requires the Payroll scope; returns 401/403 if the ST app isn't granted it.
async function getJobLaborSplits(jobId) {
  if (!jobId) return [];
  const client = stClient();
  const tenant = process.env.ST_TENANT_ID;
  let results = [];
  let page = 1;
  while (true) {
    const res = await client.get(
      `/payroll/v2/tenant/${tenant}/jobs/splits`,
      { jobIds: jobId, page, pageSize: 200, active: "True" }
    );
    const batch = res.data?.data || [];
    results = results.concat(batch);
    if (!res.data?.hasMore) break;
    page++;
    if (page > 10) break;
  }
  return results;
}

// ── Inventory: purchase orders attached to a job ──────────────────────────
// ST's /inventory/v2/purchase-orders endpoint supports a `jobIds` filter so
// we can pull every PO ever issued against a given job. Used by Customer
// Review to surface actual materials cost (what the vendor invoiced for
// material on this job) alongside the WIP-reported materialCost column,
// which is an internal accounting aggregate.
//
// Returns: array of POs, each with { id, number, total, subTotal, tax,
// status, vendor, sentOn, items: [{ skuName, quantity, cost, total, ... }] }
async function getPurchaseOrdersForJob(jobId) {
  if (!jobId) return [];
  const client = stClient();
  const tenant = process.env.ST_TENANT_ID;
  let results = [];
  let page = 1;
  while (true) {
    let res;
    try {
      res = await client.get(
        `/inventory/v2/tenant/${tenant}/purchase-orders`,
        { jobIds: jobId, page, pageSize: 50 }
      );
    } catch (err) {
      // 401/403 = scope not granted; 404 = endpoint disabled. Either way,
      // bail out quietly — the caller decides whether to surface a warning.
      const status = err.response?.status;
      if (status !== 401 && status !== 403 && status !== 404) {
        console.warn(`[ST] getPurchaseOrdersForJob(${jobId}) page ${page} failed: ${status} ${err.message}`);
      }
      break;
    }
    const batch = res.data?.data || [];
    results = results.concat(batch);
    if (!res.data?.hasMore) break;
    page++;
    if (page > 10) break;
  }
  return results;
}

// ── Payroll: per-job timesheet entries (actual hours) ─────────────────────
// This is the right endpoint for "how many hours did each tech log on this
// job". Each row is a per-appointment time entry with paidDurationHours,
// startedOn / endedOn, technicianId.
//
// Endpoint: GET /payroll/v2/tenant/{tenant}/jobs/timesheets?jobIds={jobId}
// Per ST spec each row has:
//   { id, jobId, technicianId, appointmentId, startedOn, endedOn,
//     paidDurationHours, active, ... }
async function getJobTimesheets(jobId) {
  if (!jobId) return [];
  const client = stClient();
  const tenant = process.env.ST_TENANT_ID;
  let results = [];
  let page = 1;
  while (true) {
    const res = await client.get(
      `/payroll/v2/tenant/${tenant}/jobs/timesheets`,
      { jobIds: jobId, page, pageSize: 200, active: "True" }
    );
    const batch = res.data?.data || [];
    results = results.concat(batch);
    if (!res.data?.hasMore) break;
    page++;
    if (page > 10) break;
  }
  return results;
}

// ── Payroll: per-job gross-pay items ───────────────────────────────────────
// Gross pay items break out per-tech paid time on a job by activity / pay type
// (regular, overtime, etc.) and are the closest live analogue to the cached
// xlsx timesheet rows. Filtered by jobId.
//
// Endpoint: GET /payroll/v2/tenant/{tenant}/gross-pay-items?jobIds={jobId}
// Field shape per ST spec includes: { activity, employeeId, payoutType,
// amountType, paidDurationHours, paidTimeType, jobId, date }
async function getJobGrossPayItems(jobId) {
  if (!jobId) return [];
  const client = stClient();
  const tenant = process.env.ST_TENANT_ID;
  let results = [];
  let page = 1;
  while (true) {
    const res = await client.get(
      `/payroll/v2/tenant/${tenant}/gross-pay-items`,
      { jobIds: jobId, page, pageSize: 200 }
    );
    const batch = res.data?.data || [];
    results = results.concat(batch);
    if (!res.data?.hasMore) break;
    page++;
    if (page > 10) break;
  }
  return results;
}

// Cached technician roster (id → name) so we can translate splits/appointment
// technicianIds into human-readable names without hitting ST every time.
let _techCache = { at: 0, map: null };
async function getTechniciansMap() {
  if (_techCache.map && Date.now() - _techCache.at < 5 * 60 * 1000) {
    return _techCache.map;
  }
  const techs = await getTechnicians();
  const map = new Map();
  for (const t of techs || []) {
    const name = t.name || `${t.firstName || ""} ${t.lastName || ""}`.trim() || `Tech ${t.id}`;
    map.set(String(t.id), name);
  }
  _techCache = { at: Date.now(), map };
  return map;
}

// ── Pricebook search (live passthrough) ───────────────────────────────────────
// Each helper hits the pricebook v2 endpoint for one item type and passes the
// caller's searchTerm / paging straight through. We default `active` to "True"
// so CSRs never see retired items in the lookup.
function _pricebookSearch(pathSegment) {
  return async function search({ searchTerm, page = 1, pageSize = 25, active = "True", extra = {} } = {}) {
    const client = stClient();
    const tenant = process.env.ST_TENANT_ID;
    const params = {
      page,
      pageSize,
      includeTotal: true,
      active,
      ...extra,
    };
    if (searchTerm) params.searchTerm = searchTerm;
    const res = await client.get(`/pricebook/v2/tenant/${tenant}/${pathSegment}`, params);
    return res.data || { data: [], hasMore: false, totalCount: 0 };
  };
}

const searchPricebookServices        = _pricebookSearch("services");
const searchPricebookMaterials       = _pricebookSearch("materials");
const searchPricebookEquipment       = _pricebookSearch("equipment");
const searchPricebookDiscountsAndFees = _pricebookSearch("discounts-and-fees");

/**
 * Create a ServiceTitan estimate from a cart of pricebook items.
 *
 * items: [{ skuId, skuType: "Service"|"Material"|"Equipment", quantity, unitPrice?, description? }]
 *
 * We target the Sales/Estimates v2 API:
 *   POST /sales/v2/tenant/{tenant}/estimates
 *
 * The shape here matches ST's published schema; if your tenant's endpoint
 * diverges, the backend will surface ST's 400 message to the UI so you can
 * see exactly which field to adjust.
 */
async function createEstimate({ jobId, name, summary, items }) {
  if (!jobId) throw new Error("createEstimate: jobId required");
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("createEstimate: items array required");
  }
  const client = stClient();
  const tenant = process.env.ST_TENANT_ID;

  const body = {
    jobId: Number(jobId),
    name: name || "Phone Quote",
    summary: summary || "",
    items: items.map(it => ({
      skuId: Number(it.skuId),
      skuType: it.skuType || "Service",
      quantity: Number(it.quantity) || 1,
      ...(it.unitPrice != null ? { unitPrice: Number(it.unitPrice) } : {}),
      ...(it.description ? { description: String(it.description) } : {}),
    })),
  };

  const res = await client.post(`/sales/v2/tenant/${tenant}/estimates`, body);
  return res.data;
}

// ── Job updates (status / type) ────────────────────────────────────────────
//
// Used by the Monthly Review "Resolved → Push to ServiceTitan" flow.
// The reviewer can correct status (e.g. "this is actually Completed, not
// In Progress") and job type. Status takes a string name we map to ST's
// internal enum; job type takes a name we resolve to a tenant-specific
// job-type ID. Either field can fail independently — callers should pass
// only what they want changed and inspect the returned shape per field.
//
// Endpoint: PATCH /jpm/v2/tenant/{tenant}/jobs/{id}
// The PATCH body accepts (per ST spec) jobStatus, jobTypeId, summary, and
// a handful of other top-level fields. Sending unknown keys is silently
// ignored (the usual ST gotcha) so we keep the body minimal.

// ST job-status enum. Values are case-sensitive in the ST UI even though
// the API accepts a few of them case-insensitively. We map common
// spellings (with or without a space) to the canonical form.
const ST_JOB_STATUSES = {
  scheduled:   "Scheduled",
  dispatched:  "Dispatched",
  inprogress:  "InProgress",
  hold:        "Hold",
  completed:   "Completed",
  canceled:    "Canceled",
  cancelled:   "Canceled",
};

function canonicalJobStatus(s) {
  if (!s) return null;
  const key = String(s).toLowerCase().replace(/[\s_-]/g, "");
  return ST_JOB_STATUSES[key] || null;
}

/**
 * PATCH a ServiceTitan job's status.
 * Returns { ok, status, value, error } — never throws on a 4xx ST response,
 * since the batch-push flow needs to record per-field failure cleanly.
 */
async function updateJobStatus(jobId, statusName) {
  if (!jobId) return { ok: false, error: "jobId required" };
  const canonical = canonicalJobStatus(statusName);
  if (!canonical) return { ok: false, error: `Unknown ST job status: ${statusName}` };

  const tenant = process.env.ST_TENANT_ID;
  const url = `https://api.servicetitan.io/jpm/v2/tenant/${tenant}/jobs/${jobId}`;
  const headers = await _stAuthHeaders();
  try {
    const res = await axios.patch(url, { jobStatus: canonical }, { headers });
    return { ok: true, status: res.status, value: canonical, data: res.data };
  } catch (err) {
    return { ok: false, error: _stErrorMessage(err), value: canonical };
  }
}

/**
 * Append a block of text to a ServiceTitan job's Summary, preserving whatever
 * is already there. Reads the current summary first, concatenates with a blank
 * line, then PATCHes. Never overwrites existing content.
 *
 * Returns { ok, summaryLength, error } — does not throw on a 4xx ST response,
 * so the route can report a clean failure.
 *
 * @param {number|string} jobId  internal ST job id
 * @param {string} addition      text block to append (already formatted)
 */
async function appendJobSummary(jobId, addition) {
  if (!jobId) return { ok: false, error: "jobId required" };
  if (!addition || !String(addition).trim()) return { ok: false, error: "nothing to append" };

  const tenant = process.env.ST_TENANT_ID;
  const url = `https://api.servicetitan.io/jpm/v2/tenant/${tenant}/jobs/${jobId}`;
  const headers = await _stAuthHeaders();

  // Read the existing summary so we append rather than clobber. If the read
  // fails we still proceed (better to add the instructions than drop them) but
  // we won't be able to preserve prior text.
  let existing = "";
  try {
    const job = await getJob(jobId);
    existing = job && typeof job.summary === "string" ? job.summary : "";
  } catch (err) {
    console.warn(`[ST] appendJobSummary: could not read existing summary for job ${jobId}: ${err.message}`);
  }

  const newSummary =
    existing && existing.trim() ? `${existing.trimEnd()}\n\n${addition}` : addition;

  try {
    const res = await axios.patch(url, { summary: newSummary }, { headers });
    return { ok: true, status: res.status, summaryLength: newSummary.length, data: res.data };
  } catch (err) {
    return { ok: false, error: _stErrorMessage(err) };
  }
}

// Cache of job types — lookups are expensive (page through pricebook-like
// list) and the type set rarely changes. Refreshed on demand if a name
// misses the cache.
let _jobTypeCache = null;       // { byName, byId, fetchedAt }
const JOB_TYPE_TTL_MS = 10 * 60 * 1000;  // 10 min

async function fetchAllJobTypes() {
  const client = stClient();
  const tenant = process.env.ST_TENANT_ID;
  let all = [];
  let page = 1;
  while (true) {
    // ST endpoint: /jpm/v2/tenant/{tenant}/job-types — page through active
    // types only. The `tenant` query param is added automatically by stClient.
    const res = await client.get(
      `/jpm/v2/tenant/${tenant}/job-types`,
      { page, pageSize: 200, active: "True" }
    );
    const batch = res.data?.data || [];
    all = all.concat(batch);
    if (!res.data?.hasMore) break;
    page++;
    if (page > 25) break;
  }
  const byName = new Map();
  const byId   = new Map();
  for (const t of all) {
    if (t.name) byName.set(String(t.name).trim().toLowerCase(), { id: t.id, name: t.name });
    if (t.id != null) byId.set(String(t.id), t.name || String(t.id));
  }
  _jobTypeCache = { byName, byId, fetchedAt: Date.now() };
  return _jobTypeCache;
}

/**
 * Return a Map<jobTypeId-as-string, name> for resolving the `jobTypeId` field
 * that ST puts on jobs back into a human-readable name. The /jpm/v2/jobs
 * endpoint never includes the name itself — only the numeric id.
 */
async function getJobTypeNamesById() {
  if (_jobTypeCache && _jobTypeCache.byId && Date.now() - _jobTypeCache.fetchedAt < JOB_TYPE_TTL_MS) {
    return _jobTypeCache.byId;
  }
  await fetchAllJobTypes();
  return _jobTypeCache.byId;
}

async function resolveJobTypeId(name) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return null;
  const fresh = _jobTypeCache && (Date.now() - _jobTypeCache.fetchedAt) < JOB_TYPE_TTL_MS;
  let cache = fresh ? _jobTypeCache : await fetchAllJobTypes();
  let hit = cache.byName.get(key);
  if (!hit && fresh) {
    // Cache miss against a stale-ish cache — refresh once and try again.
    cache = await fetchAllJobTypes();
    hit = cache.byName.get(key);
  }
  return hit || null;
}

/**
 * PATCH a ServiceTitan job's type.
 *
 * Some tenants lock job-type changes behind a workflow guard and reject the
 * PATCH with a 4xx. Callers should fall back to posting an explanatory note
 * (e.g. via addJobNote) when ok=false and reason='locked-by-tenant'.
 *
 * Returns { ok, value, jobTypeId, error, reason }
 */
async function updateJobType(jobId, jobTypeName) {
  if (!jobId) return { ok: false, error: "jobId required" };
  const resolved = await resolveJobTypeId(jobTypeName);
  if (!resolved) {
    return {
      ok: false,
      reason: "unknown-job-type",
      error: `No active ST job type matches "${jobTypeName}"`,
      value: jobTypeName,
    };
  }
  const tenant = process.env.ST_TENANT_ID;
  const url = `https://api.servicetitan.io/jpm/v2/tenant/${tenant}/jobs/${jobId}`;
  const headers = await _stAuthHeaders();
  try {
    const res = await axios.patch(url, { jobTypeId: resolved.id }, { headers });
    return { ok: true, status: res.status, value: resolved.name, jobTypeId: resolved.id, data: res.data };
  } catch (err) {
    const status = err.response?.status;
    // 403 / 422 from ST on job type PATCHes usually means the tenant has
    // locked job-type changes behind a workflow gate. Flag this so the
    // caller can fall back to posting a note rather than treating it as a
    // bug.
    const reason = (status === 403 || status === 422) ? "locked-by-tenant" : "patch-failed";
    return { ok: false, reason, error: _stErrorMessage(err), value: resolved.name, jobTypeId: resolved.id };
  }
}

// Small helpers shared by the job PATCH wrappers above.
// _stAuthHeaders returns the bearer + ST-App-Key headers needed for any
// ST API call; _stErrorMessage normalizes ST's varied error response shapes
// down to a single string suitable for storing in our sync_error columns.
async function _stAuthHeaders() {
  const token = await getAccessToken();
  return {
    Authorization: `Bearer ${token}`,
    "ST-App-Key":  process.env.ST_APP_KEY,
    "Content-Type": "application/json",
  };
}

function _stErrorMessage(err) {
  const d = err?.response?.data;
  if (!d) return err?.message || "Unknown ST error";
  if (typeof d === "string") return d.slice(0, 500);
  return (d.title || d.detail || JSON.stringify(d)).toString().slice(0, 500);
}

module.exports = {
  getAccessToken,
  getCall,
  updateCallReasonOnST,
  getCallRecordingStream,
  searchCustomersByPhone,
  searchCustomersByName,
  searchContactsByPhone,
  getRecentJobsForCustomer,
  getJobsForCustomerInRange,
  searchLocationsByAddress,
  addJobNote,
  addCustomerNote,
  createMembership,
  applyTagToCustomer,
  findJobByNumber,
  getAppointments,
  getAllAppointmentsForDateRange,
  getJob,
  getJobs,
  getJobAppointments,
  getTechnicians,
  getTechnicianByName,
  listEmployees,
  createEmployeeTask,
  getCustomer,
  getCustomerContacts,
  getLocationById,
  getLocationsByCustomer,
  getInstalledEquipmentByLocation,
  createInstalledEquipment,
  getRecurringServicesForMembership,
  findReturnVisitJobs,
  getReturnVisitStatsByTechnician,
  getDailyAppointmentCounts,
  getInvoicesForJob,
  getPayment,
  getInvoicesByIds,
  getInvoicesByCustomer,
  getPurchaseOrdersForJob,
  getJobByNumber,
  findVendorByName,
  invalidateVendorCache,
  createPurchaseOrder,
  updateMaterial,
  updateEquipment,
  updateService,
  getPricebookItem,
  uploadPricebookImage,
  fetchPricebookImageBytes,
  attachPricebookImage,
  createMaterial,
  deactivateMaterial,
  searchPricebookServices,
  searchPricebookMaterials,
  searchPricebookEquipment,
  searchPricebookDiscountsAndFees,
  createEstimate,
  getJobLaborSplits,
  getJobTimesheets,
  getJobGrossPayItems,
  getTechniciansMap,
  updateJobStatus,
  updateJobType,
  resolveJobTypeId,
  fetchAllJobTypes,
  getJobTypeNamesById,
  createJobAttachment,
  appendJobSummary,
};
