/**
 * src/routes/auth.js
 *
 * Login, logout, current-user, change-password.
 *
 * All routes here are exempt from requireAuth except /change-password and
 * /me, which obviously need a logged-in session.
 */

const express = require("express");
const router = express.Router();
const path = require("path");
const userRepo = require("../db/userRepository");

// ── Helpers ──────────────────────────────────────────────────────────────────

function ipOf(req) {
  return req.ip || req.connection?.remoteAddress || "unknown";
}

function jsonError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

// ── Simple in-memory login throttle ───────────────────────────────────────────
// Single-instance app, so an in-process map is sufficient. Tracks recent FAILED
// attempts per IP and briefly locks the IP out after too many — stops online
// password guessing and the bcrypt-per-attempt CPU cost that comes with it.
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // rolling window for counting fails
const LOGIN_MAX_FAILS = 8;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const loginAttempts = new Map(); // ip -> { fails, first, lockedUntil }

function loginLockRemaining(ip) {
  const rec = loginAttempts.get(ip);
  if (rec?.lockedUntil && rec.lockedUntil > Date.now()) return rec.lockedUntil - Date.now();
  return 0;
}
function recordLoginFail(ip) {
  const now = Date.now();
  let rec = loginAttempts.get(ip);
  if (!rec || now - rec.first > LOGIN_WINDOW_MS) rec = { fails: 0, first: now, lockedUntil: 0 };
  rec.fails++;
  if (rec.fails >= LOGIN_MAX_FAILS) rec.lockedUntil = now + LOGIN_LOCKOUT_MS;
  loginAttempts.set(ip, rec);
}
function clearLoginFails(ip) {
  loginAttempts.delete(ip);
}

// ── GET /login — serve the login page ────────────────────────────────────────
router.get("/login", (req, res) => {
  // If already logged in, bounce to home.
  if (req.session?.userId) return res.redirect("/");
  res.sendFile(path.join(__dirname, "../../public/login.html"));
});

// ── POST /login — verify credentials, set session ────────────────────────────
router.post("/login", express.json(), async (req, res) => {
  const ip = ipOf(req);
  const lockMs = loginLockRemaining(ip);
  if (lockMs > 0) {
    return jsonError(res, 429, `too many attempts — try again in ${Math.ceil(lockMs / 60000)} minute(s)`);
  }

  const { email, password } = req.body || {};
  if (!email || !password) return jsonError(res, 400, "email and password are required");

  try {
    const user = await userRepo.verifyLogin(email, password);
    if (!user) {
      recordLoginFail(ip);
      console.warn(`[Auth] Failed login for ${email} from ${ip}`);
      return jsonError(res, 401, "invalid email or password");
    }

    // Regenerate the session ID after a successful login (prevents session
    // fixation: if an attacker had set the cookie before login, that ID is
    // now useless).
    req.session.regenerate((err) => {
      if (err) {
        console.error("[Auth] session regenerate failed:", err.message);
        return jsonError(res, 500, "session error");
      }
      req.session.userId = user.id;
      req.session.email = user.email;
      req.session.displayName = user.display_name;
      clearLoginFails(ip);
      userRepo.recordLogin(user.id);
      console.log(`[Auth] Login OK for ${user.email} from ${ip}`);
      res.json({
        ok: true,
        user: { email: user.email, displayName: user.display_name },
        mustChangePw: !!user.must_change_pw,
      });
    });
  } catch (err) {
    console.error("[Auth] login error:", err.message);
    return jsonError(res, 500, "login failed");
  }
});

// ── POST /logout — destroy session ───────────────────────────────────────────
router.post("/logout", (req, res) => {
  const email = req.session?.email;
  req.session.destroy((err) => {
    if (err) console.error("[Auth] logout error:", err.message);
    res.clearCookie("st_hl_sid");
    if (email) console.log(`[Auth] Logout for ${email}`);
    res.json({ ok: true });
  });
});

// ── GET /api/auth/me — who am I? ─────────────────────────────────────────────
router.get("/api/auth/me", (req, res) => {
  if (!req.session?.userId) return jsonError(res, 401, "not logged in");
  const user = userRepo.findById(req.session.userId);
  if (!user || !user.active) {
    req.session.destroy(() => {});
    return jsonError(res, 401, "user not found or inactive");
  }
  res.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      mustChangePw: !!user.must_change_pw,
      isAdmin: !!user.is_admin,
      lastLoginAt: user.last_login_at,
    },
  });
});

// ── POST /api/auth/change-password ───────────────────────────────────────────
router.post("/api/auth/change-password", express.json(), async (req, res) => {
  if (!req.session?.userId) return jsonError(res, 401, "not logged in");
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return jsonError(res, 400, "currentPassword and newPassword are required");
  }
  if (newPassword.length < 8) {
    return jsonError(res, 400, "new password must be at least 8 characters");
  }

  try {
    const user = userRepo.findById(req.session.userId);
    const ok = await userRepo.verifyLogin(user.email, currentPassword);
    if (!ok) return jsonError(res, 401, "current password is incorrect");

    await userRepo.updatePassword(user.id, newPassword);
    console.log(`[Auth] Password changed for ${user.email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("[Auth] change-password error:", err.message);
    return jsonError(res, 500, err.message || "password change failed");
  }
});

module.exports = router;
