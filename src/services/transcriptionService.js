/**
 * transcriptionService.js
 *
 * Provider-abstracted transcription service.
 * Current providers: openai (OpenAI /audio/transcriptions)
 *
 * To add a new provider (e.g. Deepgram, AssemblyAI):
 *   1. Create a function transcribeWith<Provider>(filePath)
 *   2. Add it to PROVIDERS below
 *   3. Set TRANSCRIPTION_PROVIDER=<name> in your .env
 *
 * Env vars:
 *   TRANSCRIPTION_PROVIDER — which provider to use (default: "openai")
 *   TRANSCRIPTION_MODEL    — OpenAI transcription model (default: "gpt-4o-transcribe").
 *                            Options, best → cheapest:
 *                              gpt-4o-transcribe       — highest accuracy (~4.1% WER)
 *                              gpt-4o-mini-transcribe  — cheaper, still beats whisper
 *                              whisper-1               — legacy, least accurate (~5.3% WER)
 *   OPENAI_API_KEY         — required when provider is "openai"
 *   TRANSCRIPTION_PROMPT   — optional vocabulary hint so the model spells proper
 *                            nouns correctly (e.g. "Grounded"). Max ~224 tokens /
 *                            ~180 words. If unset, DEFAULT_PROMPT below is used.
 *
 * Long-recording handling (NEW):
 *   OpenAI's transcription endpoint rejects files over 25 MB, and the gpt-4o
 *   transcription models additionally cap a single request at ~1500 s (25 min).
 *   Whisper used to silently fail on the size limit — long calls came back with
 *   an EMPTY transcript. This service now transparently compresses and/or
 *   time-segments oversized or over-long recordings (via ffmpeg) so those calls
 *   transcribe instead of dropping. Requires ffmpeg on the host (added to
 *   nixpacks.toml). If ffmpeg is missing, an oversized file throws a clear error
 *   rather than failing silently.
 *
 * Returns: { text: string, metadata: object }
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

// ── Limits ──────────────────────────────────────────────────────────────────
// OpenAI hard-rejects uploads over 25 MB; stay comfortably under it.
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
// gpt-4o-transcribe / gpt-4o-mini-transcribe cap a request at ~1500 s. whisper-1
// has no length limit (size only). Trigger segmentation a bit early for safety.
const LENGTH_LIMIT_SECONDS = 1400; // ~23.3 min
// When we must split, cut into pieces this long. 20 min of mono 32 kbps mp3 is
// ~4.6 MB — well under both the size and length ceilings.
const SEGMENT_SECONDS = 1200; // 20 min
const DEFAULT_MODEL = "gpt-4o-transcribe";

// ── Whisper / gpt-4o vocabulary hint ───────────────────────────────────────────
// The `prompt` parameter nudges the model toward the spellings and domain words
// in this text. Written as a plain sentence (not a keyword list) — that's what
// the OpenAI docs recommend and what works best in practice.
//
// Keep this focused on proper nouns the model reliably mangles. Common HVAC /
// plumbing terms are already well-covered by the base model; loading this up
// with every jargon word can actually hurt accuracy.
const DEFAULT_PROMPT =
  "Thank you for calling Grounded Home Services, plumbing, heating and cooling. " +
  "This call is about a Grounded technician visit, a scheduled appointment, " +
  "a service call, an estimate, a membership, a warranty, or a billing question.";

// ── Post-transcript cleanup ────────────────────────────────────────────────────
// The model sometimes still mangles "Grounded" even with a prompt — on a
// compressed phone recording the trailing "-ed" drops out and it comes back as
// Grounding, Grounder, Ground It, Round, etc. This pass only fires on the
// *call-open phrase* so we don't accidentally rewrite customer words that
// legitimately sound similar (e.g. a tech explaining that a unit isn't grounded).
const COMPANY_NAME_FIXUPS = [
  // "Thank you for calling <misheard>" → "Thank you for calling Grounded"
  {
    re: /\b(thank(s|\s*you)? for calling)\s+(grounding|grounder|grounders|grounds|ground it|groundit|ground|round it|rounded|round)\b/gi,
    to: "$1 Grounded",
  },
  // "calling <misheard> home services" — the longer company-name variant
  {
    re: /\b(calling)\s+(grounding|grounder|grounders|grounds|ground it|groundit|ground|round it|rounded|round)\s+(home services|home service|plumbing|heating|hvac)\b/gi,
    to: "$1 Grounded $3",
  },
];

function applyCompanyNameFixups(text) {
  if (!text) return text;
  let out = text;
  for (const f of COMPANY_NAME_FIXUPS) out = out.replace(f.re, f.to);
  return out;
}

/**
 * The vocabulary hint currently in effect. Priority:
 *   1. saved override from the AI Instructions popup (app setting)
 *   2. TRANSCRIPTION_PROMPT env var
 *   3. built-in DEFAULT_PROMPT
 */
function getEffectiveTranscriptionPrompt() {
  try {
    const { getSetting } = require("../db");
    const saved = getSetting("transcription_prompt", null);
    if (saved) return saved;
  } catch (err) {
    console.warn("[Transcription] Could not read saved prompt, using env/default:", err.message);
  }
  return process.env.TRANSCRIPTION_PROMPT || DEFAULT_PROMPT;
}

// ── ffmpeg helpers ──────────────────────────────────────────────────────────

let _ffmpegChecked = false;
let _ffmpegAvailable = false;

async function ffmpegAvailable() {
  if (_ffmpegChecked) return _ffmpegAvailable;
  _ffmpegChecked = true;
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    _ffmpegAvailable = true;
  } catch (_) {
    _ffmpegAvailable = false;
  }
  return _ffmpegAvailable;
}

/** Probe audio duration in seconds (via ffprobe). Returns null on failure. */
async function getDurationSeconds(filePath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    const secs = parseFloat(String(stdout).trim());
    return Number.isFinite(secs) ? secs : null;
  } catch (_) {
    return null;
  }
}

/**
 * Compress + time-segment a recording into mono 32 kbps mp3 chunks of
 * SEGMENT_SECONDS each. Returns { dir, files } — caller must clean up `dir`.
 * A short recording produces a single (compressed) chunk.
 */
async function segmentAudio(filePath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "callseg-"));
  const pattern = path.join(dir, "chunk_%03d.mp3");
  await execFileAsync("ffmpeg", [
    "-y",
    "-i", filePath,
    "-ac", "1",            // mono
    "-b:a", "32k",         // 32 kbps — plenty for speech
    "-f", "segment",
    "-segment_time", String(SEGMENT_SECONDS),
    "-reset_timestamps", "1",
    pattern,
  ], { maxBuffer: 32 * 1024 * 1024 });

  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".mp3"))
    .sort()
    .map((f) => path.join(dir, f));

  return { dir, files };
}

function rmDirRecursive(dir) {
  try {
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    }
    fs.rmdirSync(dir);
  } catch (_) {}
}

// ── Provider: OpenAI ───────────────────────────────────────────────────────────

/** Send one file to OpenAI /audio/transcriptions and return the raw response. */
async function transcribeOneFile(client, filePath, model, prompt) {
  // Only whisper-1 supports verbose_json (word/segment timing + language +
  // duration). The gpt-4o transcription models support json | text only.
  const response_format = model === "whisper-1" ? "verbose_json" : "json";

  return client.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model,
    response_format,
    language: "en",
    prompt, // vocabulary hint — helps spell "Grounded" correctly
  });
}

async function transcribeWithOpenAI(filePath) {
  // Lazy-require so the app starts even if OPENAI_API_KEY is not set yet.
  // Under DEMO_MODE this is the canned shim, which returns a generated
  // Grounded Home Services call transcript instead of hitting the API.
  const { getClient } = require("../api/openaiClient");
  const client = getClient();

  const model = process.env.TRANSCRIPTION_MODEL || DEFAULT_MODEL;
  const prompt = getEffectiveTranscriptionPrompt();
  const hasLengthLimit = model !== "whisper-1";

  const sizeBytes = fs.statSync(filePath).size;
  const sizeMB = sizeBytes / 1024 / 1024;

  console.log(
    `[Transcription] Sending ${filePath} to OpenAI ${model} ` +
    `(${sizeMB.toFixed(1)}MB, prompt: ${prompt.length} chars)`
  );

  // Decide whether we need ffmpeg pre-processing.
  const canFfmpeg = await ffmpegAvailable();
  let duration = null;
  if (canFfmpeg) duration = await getDurationSeconds(filePath);

  const tooBig = sizeBytes > MAX_UPLOAD_BYTES;
  const tooLong = hasLengthLimit && duration != null && duration > LENGTH_LIMIT_SECONDS;

  let rawText = "";
  const extraMeta = {};

  if (tooBig || tooLong) {
    if (!canFfmpeg) {
      throw new Error(
        `Recording is ${sizeMB.toFixed(1)}MB` +
        (duration ? ` / ${Math.round(duration)}s` : "") +
        ` — over OpenAI's limits for ${model} — and ffmpeg is not available to ` +
        `compress/segment it. Install ffmpeg (see nixpacks.toml) to transcribe long calls.`
      );
    }

    console.log(
      `[Transcription] Recording exceeds limits ` +
      `(${sizeMB.toFixed(1)}MB${duration ? `, ${Math.round(duration)}s` : ""}) ` +
      `— compressing/segmenting before upload`
    );

    const { dir, files } = await segmentAudio(filePath);
    try {
      const parts = [];
      for (let i = 0; i < files.length; i++) {
        console.log(`[Transcription] Chunk ${i + 1}/${files.length}`);
        const r = await transcribeOneFile(client, files[i], model, prompt);
        parts.push((r.text || "").trim());
      }
      rawText = parts.filter(Boolean).join(" ");
      extraMeta.chunked = files.length > 1;
      extraMeta.chunks = files.length;
    } finally {
      rmDirRecursive(dir);
    }
  } else {
    // Common path: short call, upload as-is.
    let response;
    try {
      response = await transcribeOneFile(client, filePath, model, prompt);
    } catch (err) {
      // Safety net: if the model rejects the request for length/size reasons
      // (e.g. duration couldn't be probed), fall back to segmentation.
      const msg = String(err?.message || "").toLowerCase();
      const lengthOrSize =
        msg.includes("maximum") || msg.includes("too large") ||
        msg.includes("duration") || msg.includes("length") ||
        err?.status === 413;
      if (canFfmpeg && lengthOrSize) {
        console.warn(`[Transcription] Direct upload failed (${err.message}) — retrying with segmentation`);
        const { dir, files } = await segmentAudio(filePath);
        try {
          const parts = [];
          for (let i = 0; i < files.length; i++) {
            const r = await transcribeOneFile(client, files[i], model, prompt);
            parts.push((r.text || "").trim());
          }
          rawText = parts.filter(Boolean).join(" ");
          extraMeta.chunked = files.length > 1;
          extraMeta.chunks = files.length;
        } finally {
          rmDirRecursive(dir);
        }
      } else {
        throw err;
      }
    }

    if (response) {
      rawText = response.text || "";
      // verbose_json (whisper-1) carries these; gpt-4o json does not.
      if (response.language) extraMeta.language = response.language;
      if (response.duration) extraMeta.duration = response.duration;
      if (response.segments) extraMeta.segments = response.segments.length;
    }
  }

  const fixedText = applyCompanyNameFixups(rawText);
  if (fixedText !== rawText) {
    console.log(`[Transcription] Applied company-name fixup (Grounded) to transcript`);
  }

  return {
    text: fixedText,
    metadata: {
      provider: `openai-${model}`,
      model,
      promptLength: prompt.length,
      companyNameFixupApplied: fixedText !== rawText,
      ...extraMeta,
    },
  };
}

// ── Provider: Stub (testing / no API key) ─────────────────────────────────────

async function transcribeWithStub(filePath) {
  console.warn(`[Transcription] Using STUB provider — file ${filePath} not actually transcribed`);
  return {
    text: "[STUB TRANSCRIPT] This is a placeholder. Set TRANSCRIPTION_PROVIDER=openai and OPENAI_API_KEY to enable real transcription.",
    metadata: { provider: "stub" },
  };
}

// ── Registry ───────────────────────────────────────────────────────────────────

const PROVIDERS = {
  openai: transcribeWithOpenAI,
  stub: transcribeWithStub,
};

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Transcribe a call recording file.
 *
 * @param {string} filePath - Local path to audio file (mp3, mp4, wav, m4a, etc.)
 * @returns {Promise<{ text: string, metadata: object }>}
 */
async function transcribeCallRecording(filePath) {
  const provider = (process.env.TRANSCRIPTION_PROVIDER || "openai").toLowerCase();

  if (!PROVIDERS[provider]) {
    throw new Error(
      `Unknown transcription provider "${provider}". Valid options: ${Object.keys(PROVIDERS).join(", ")}`
    );
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`Transcription failed: file not found at ${filePath}`);
  }

  console.log(`[Transcription] Using provider: ${provider}`);
  const result = await PROVIDERS[provider](filePath);

  console.log(
    `[Transcription] Complete — ${result.text.length} chars` +
    (result.metadata?.duration ? ` | ${result.metadata.duration.toFixed(1)}s` : "") +
    (result.metadata?.chunks ? ` | ${result.metadata.chunks} chunk(s)` : "")
  );

  return result;
}

module.exports = {
  transcribeCallRecording,
  DEFAULT_PROMPT,
  getEffectiveTranscriptionPrompt,
};
