/**
 * src/demo/youtube.mock.js
 *
 * Drop-in replacement for src/api/youtube.js.
 *
 * Uploads are drained and discarded. The returned id is an 11-character
 * YouTube-shaped string derived deterministically from the title, so the same
 * video always "uploads" to the same URL and the upload log stays stable across
 * restarts. The URL does not resolve — that is the point.
 */

const { Rng, hashString } = require("./rng");

const LATENCY = Number(process.env.DEMO_LATENCY_MS) || 0;

function getOAuthClient() {
  // The live client throws here when credentials are missing. In demo mode
  // there is nothing to authenticate against, so hand back an inert stub.
  return { credentials: { refresh_token: "demo-refresh-token" }, __demo: true };
}

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function fakeVideoId(seedText) {
  const rng = new Rng(hashString(seedText));
  return Array.from({ length: 11 }, () => ID_ALPHABET[rng.int(0, ID_ALPHABET.length - 1)]).join("");
}

/** Drain a stream (or accept a Buffer) so the caller's temp file logic is exercised. */
async function drain(mediaStream) {
  if (!mediaStream) return 0;
  if (Buffer.isBuffer(mediaStream)) return mediaStream.length;
  if (typeof mediaStream.on !== "function") return 0;
  return new Promise((resolve, reject) => {
    let bytes = 0;
    mediaStream.on("data", (c) => (bytes += c.length));
    mediaStream.on("end", () => resolve(bytes));
    mediaStream.on("error", reject);
  });
}

async function uploadVideo({ mediaStream, title, description = "", privacyStatus = "unlisted" } = {}) {
  if (!mediaStream) throw new Error("uploadVideo: mediaStream is required");
  if (!title) throw new Error("uploadVideo: title is required");

  const bytes = await drain(mediaStream);
  if (LATENCY) await new Promise((r) => setTimeout(r, LATENCY));

  const id = fakeVideoId(`${title}|${bytes}`);
  console.log(`[demo] YouTube upload simulated — "${title.slice(0, 60)}" (${bytes} bytes, ${privacyStatus})`);
  return { id, url: `https://youtu.be/${id}` };
}

module.exports = { uploadVideo, getOAuthClient };
