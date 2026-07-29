/**
 * src/api/openaiClient.js
 *
 * One place that decides which OpenAI client the app gets. Same seam as
 * api/servicetitan.js: every service asks for a client here instead of
 * constructing its own, so demo mode is a single switch rather than nine.
 *
 * Resolution order:
 *   1. Not demo mode                  -> real SDK client (throws without a key,
 *                                        which is the behaviour every caller
 *                                        already expects in production).
 *   2. DEMO_MODE=true + DEMO_AI=live
 *      + OPENAI_API_KEY set           -> real SDK client. Lets the demo run
 *                                        against the actual models when someone
 *                                        wants to show live inference.
 *   3. Anything else in demo mode     -> the canned shim in
 *                                        ../demo/openai.mock.js.
 *
 * The client is built once and cached, matching the lazy-init pattern the
 * services used before this file existed (constructing eagerly at require time
 * throws when the key is missing and takes the whole router down).
 */

const DEMO = require("../demo/mode").IS_DEMO;
const LIVE_AI = String(process.env.DEMO_AI).toLowerCase() === "live";

let _client = null;

/** True when a call would hit the real API rather than the canned shim. */
function isLiveAI() {
  if (!DEMO) return true;
  return LIVE_AI && !!process.env.OPENAI_API_KEY;
}

/**
 * True when an AI call can be made at all — i.e. either a real key is present
 * or we're in demo mode with the shim available. Services that guard on
 * `process.env.OPENAI_API_KEY` before doing work should guard on this instead,
 * so the guard doesn't fire in front of the shim.
 */
function aiAvailable() {
  return !!process.env.OPENAI_API_KEY || DEMO;
}

function getClient() {
  if (_client) return _client;

  if (isLiveAI()) {
    if (!process.env.OPENAI_API_KEY) {
      // Unchanged from the per-service guards this replaced.
      throw new Error("OPENAI_API_KEY is not set");
    }
    const OpenAI = require("openai");
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    if (DEMO) {
      console.log("[demo] OpenAI: LIVE mode (DEMO_AI=live) — real API calls will be billed");
    }
    return _client;
  }

  if (LIVE_AI) {
    console.warn(
      "[demo] OpenAI: DEMO_AI=live was requested but OPENAI_API_KEY is not set — falling back to canned mode"
    );
  }
  _client = require("../demo/openai.mock").createClient();
  return _client;
}

/** Test/reset hook — drops the cached client so env changes take effect. */
function resetClient() {
  _client = null;
}

module.exports = { getClient, isLiveAI, aiAvailable, resetClient };
