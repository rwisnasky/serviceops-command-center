# YouTube Upload — One-Time Setup

This feature lets you type a ServiceTitan job number on the dashboard and
automatically upload the most recent video attachment on that job to YouTube
(unlisted, with the street address as the title).

The upload happens from the server on behalf of **one** YouTube account —
the one you sign in with during step 3 below.

---

## What you'll need

- A Google account (a regular Gmail works — no Google Workspace required)
- Access to the project's Railway environment (to add env vars)
- About 15 minutes

---

## Step 1 — Create the Google Cloud project

1. Go to https://console.cloud.google.com and sign in with the Google account
   that owns (or should own) the YouTube channel you want videos uploaded to.
2. Top-left, click the project dropdown → **New Project**.
   Name it something like `grounded-youtube-uploads`. Click **Create**.
3. Wait a few seconds for it to create, then select that project.

## Step 2 — Enable the YouTube Data API v3

1. In the left menu: **APIs & Services → Library**.
2. Search for **YouTube Data API v3** and click it.
3. Click **Enable**.

## Step 3 — Configure the OAuth consent screen

This is the permission dialog you'll see when you click "Allow" in step 4.

1. **APIs & Services → OAuth consent screen**.
2. User type: **External**. Click **Create**.
3. Fill out the minimum:
   - App name: `ST-HL Video Uploader` (anything works)
   - User support email: your email
   - Developer contact: your email
   - Skip logo, app domain, etc. — leave blank.
4. **Save and Continue**.
5. **Scopes** step — click **Add or Remove Scopes**, search for
   `youtube.upload`, check `.../auth/youtube.upload`, click **Update**.
6. **Save and Continue**.
7. **Test users** step — click **Add Users** and add the Gmail of the
   account whose YouTube channel will receive the uploads. **Save**.
8. **Save and Continue** → **Back to Dashboard**.

> The app will show as "unverified" which is fine — only the test user
> you added can use it. You do NOT need to publish the app to make this
> work, BUT: while the app is in Testing mode, Google expires refresh
> tokens after **7 days**, which means uploads will break weekly with an
> `invalid_grant` error. To avoid that, after step 7 below come back to
> **OAuth consent screen** and click **Publish App** (it stays unverified
> — that's only a sign-in-time warning, and the server never sees it).
> See the troubleshooting note on `invalid_grant` at the bottom.

## Step 4 — Create the OAuth Client ID

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Desktop app**. Name it `ST-HL Video Uploader`.
3. Click **Create**. You'll see a dialog with a **Client ID** and
   **Client secret** — copy both.

## Step 5 — Add client ID/secret to your local .env

In `serviceops-command-center/.env`:

```
YOUTUBE_CLIENT_ID=<paste client ID>
YOUTUBE_CLIENT_SECRET=<paste client secret>
```

(Leave `YOUTUBE_REFRESH_TOKEN=` blank for now — step 6 fills that in.)

## Step 6 — Generate the refresh token

From the `serviceops-command-center` directory:

```
npm install            # installs googleapis if you haven't yet
node scripts/get-youtube-token.js
```

This opens a browser window.

1. Sign in with the **same Google account you added as a test user** in step 3.
2. You'll see a "Google hasn't verified this app" warning — click
   **Advanced → Go to ST-HL Video Uploader (unsafe)**. (It's your own app,
   so this warning is expected and safe to bypass.)
3. Click **Allow**.
4. The page will say "Success — refresh token captured" and the script
   will print a line like:

   ```
   YOUTUBE_REFRESH_TOKEN=1//0<the rest of your token>
   ```

   Treat that value like a password — it grants ongoing access to the
   YouTube account. Put it in `.env` (which is gitignored) and nowhere else.

5. Paste that line into your local `.env`.

## Step 7 — Add the three variables to Railway

In the Railway dashboard → your project → **Variables**, add:

- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `YOUTUBE_REFRESH_TOKEN`

…with the same values you put in `.env`. Redeploy.

---

## You're done

On the dashboard, the **Upload Job Video to YouTube** panel will now work:
type a job number, click upload, and after a minute or so you'll get a
YouTube link that's unlisted and titled with the job's street address. A
record of every upload is kept under **Recent Uploads**.

---

## Quota limits

Default YouTube Data API quota is **10,000 units/day**. An upload costs
~1,600 units, so out of the box you get roughly **6 uploads/day**.

If you need more:
- Google Cloud Console → **APIs & Services → YouTube Data API v3 → Quotas**
- Request an increase. It's free; Google just asks you to describe the use
  case. Approval is usually a few business days.

## Video length

If the YouTube account hasn't been phone-verified, uploads are capped at
**15 minutes**. Verify once at https://www.youtube.com/verify.

## Revoking access

To rotate credentials, either:
- Revoke the refresh token at https://myaccount.google.com/permissions and
  re-run `scripts/get-youtube-token.js`, or
- Delete the OAuth Client ID in Google Cloud Console and create a new one.

## Troubleshooting

**"invalid_grant" on upload** — the refresh token is no longer valid.
Common causes, in order of likelihood:

1. **OAuth consent screen is still in Testing mode.** Google expires
   refresh tokens after 7 days while the app is unpublished. Fix: Google
   Cloud Console → **APIs & Services → OAuth consent screen** → **Publish
   App**. It stays "unverified" — that's only a sign-in-time warning,
   which the server never sees because it uses the refresh token directly.
2. **Refresh token was revoked manually** at
   https://myaccount.google.com/permissions, or the Google account's
   password changed.
3. **Client ID / Client Secret got rotated** in Google Cloud Console, so
   the existing refresh token doesn't match the new client.
4. **Refresh token unused for ~6 months** (rare for this app).

Recovery in any case: re-run `node scripts/get-youtube-token.js`, paste
the new `YOUTUBE_REFRESH_TOKEN` into Railway → Variables, redeploy. If
the script prints "No refresh token returned," remove the app at
https://myaccount.google.com/permissions and run it again. To stop this
from recurring, do step 1 above.

**"quotaExceeded"** — hit the 10k daily limit. Either wait until tomorrow
(Pacific time) or request a quota increase (see above).

**"No video attachments found on job X"** — the job exists but has no
files ending in `.mp4`, `.mov`, etc. attached. Confirm the tech uploaded a
video file (not a still photo) to that job in ServiceTitan.
