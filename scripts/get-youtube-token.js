/**
 * scripts/get-youtube-token.js
 *
 * One-time helper to generate a YouTube OAuth refresh token.
 *
 * HOW TO USE:
 *   1. In your Google Cloud project, create an OAuth 2.0 Client ID of type
 *      "Desktop app". Copy the Client ID and Client Secret.
 *   2. Put them in your local .env:
 *         YOUTUBE_CLIENT_ID=...
 *         YOUTUBE_CLIENT_SECRET=...
 *   3. Run:  node scripts/get-youtube-token.js
 *   4. A browser tab opens. Log in with the YouTube account you want to
 *      upload videos to, and grant permission.
 *   5. The script prints a refresh token. Paste it into .env (locally and
 *      on Railway) as YOUTUBE_REFRESH_TOKEN.
 *
 * You only need to do this once per YouTube account. The refresh token
 * does not expire as long as you keep using it (Google rotates refresh
 * tokens if unused for ~6 months).
 */

require("dotenv").config();
const http = require("http");
const { google } = require("googleapis");

const SCOPES = ["https://www.googleapis.com/auth/youtube.upload"];
const REDIRECT_PORT = 53682; // Arbitrary local port
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

function ensureEnv() {
  const missing = [];
  if (!process.env.YOUTUBE_CLIENT_ID) missing.push("YOUTUBE_CLIENT_ID");
  if (!process.env.YOUTUBE_CLIENT_SECRET) missing.push("YOUTUBE_CLIENT_SECRET");
  if (missing.length) {
    console.error(
      `\nMissing env vars: ${missing.join(", ")}\n\nAdd them to .env first.\n`
    );
    process.exit(1);
  }
}

async function openBrowser(url) {
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" :
    platform === "win32"  ? "start" :
                            "xdg-open";
  const { spawn } = require("child_process");
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch (_) {
    // ignore — user can click the URL manually
  }
}

async function main() {
  ensureEnv();

  const oauth = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
    REDIRECT_URI
  );

  const authUrl = oauth.generateAuthUrl({
    access_type: "offline",  // required to get a refresh token
    prompt: "consent",       // forces refresh token on every run
    scope: SCOPES,
  });

  console.log("\nOpening browser for Google login...");
  console.log("If it doesn't open automatically, paste this into your browser:\n");
  console.log(authUrl + "\n");
  openBrowser(authUrl);

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
        if (url.pathname !== "/oauth2callback") {
          res.writeHead(404);
          res.end();
          return;
        }
        const code = url.searchParams.get("code");
        const err = url.searchParams.get("error");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          err
            ? `<h2>Error: ${err}</h2><p>You can close this window.</p>`
            : "<h2>Success — refresh token captured</h2><p>You can close this window.</p>"
        );
        server.close();
        if (err) return reject(new Error(err));
        if (!code) return reject(new Error("No authorization code in callback"));
        resolve(code);
      } catch (e) {
        reject(e);
      }
    });
    server.listen(REDIRECT_PORT, () => {
      console.log(`Waiting for callback on ${REDIRECT_URI} ...`);
    });
  });

  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) {
    console.error(
      "\nNo refresh token returned. This usually means you already granted " +
      "permission and Google remembered it. Revoke access at " +
      "https://myaccount.google.com/permissions and re-run this script.\n"
    );
    process.exit(1);
  }

  console.log("\n" + "━".repeat(68));
  console.log("SUCCESS — paste this into your .env (locally AND on Railway):\n");
  console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log("━".repeat(68) + "\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nError:", err.message, "\n");
  process.exit(1);
});
