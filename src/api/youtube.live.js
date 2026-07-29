/**
 * src/api/youtube.js
 *
 * YouTube Data API v3 client — handles OAuth refresh + resumable uploads.
 *
 * Required env vars:
 *   YOUTUBE_CLIENT_ID       — OAuth client ID from Google Cloud Console
 *   YOUTUBE_CLIENT_SECRET   — OAuth client secret
 *   YOUTUBE_REFRESH_TOKEN   — generated one time via scripts/get-youtube-token.js
 *
 * See docs/YOUTUBE_SETUP.md for setup instructions.
 */

const { google } = require("googleapis");

function getOAuthClient() {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "YouTube credentials missing. Set YOUTUBE_CLIENT_ID, " +
        "YOUTUBE_CLIENT_SECRET, and YOUTUBE_REFRESH_TOKEN in your environment. " +
        "See docs/YOUTUBE_SETUP.md."
    );
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

/**
 * Upload a video to YouTube.
 *
 * @param {Object} opts
 * @param {Readable|Buffer} opts.mediaStream — the video data (stream preferred)
 * @param {string} opts.title                — video title (shown on YouTube)
 * @param {string} [opts.description]        — video description
 * @param {"private"|"unlisted"|"public"} [opts.privacyStatus="unlisted"]
 *
 * @returns {Promise<{ id: string, url: string }>} YouTube video ID and watch URL
 */
async function uploadVideo({
  mediaStream,
  title,
  description = "",
  privacyStatus = "unlisted",
}) {
  if (!mediaStream) throw new Error("uploadVideo: mediaStream is required");
  if (!title) throw new Error("uploadVideo: title is required");

  const auth = getOAuthClient();
  const youtube = google.youtube({ version: "v3", auth });

  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: title.slice(0, 100), // YouTube title hard limit = 100 chars
        description,
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: mediaStream,
    },
  });

  const id = res.data.id;
  return {
    id,
    url: `https://youtu.be/${id}`,
  };
}

module.exports = { uploadVideo, getOAuthClient };
