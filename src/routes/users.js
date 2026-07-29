/**
 * src/routes/users.js
 *
 * User administration — list, create, reset-password, deactivate, delete.
 *
 * All routes require an authenticated session (already gated by the global
 * requireAuth middleware in src/index.js). Guard rails inside each handler:
 *   - You can't deactivate or delete yourself (would lock yourself out)
 *   - You can't delete the last active user (would lock everyone out)
 *   - New users are always created with must_change_pw=1 so the person who
 *     logs in is forced to rotate the starter password on first sign-in.
 */

const express = require("express");
const router = express.Router();
const userRepo = require("../db/userRepository");

// ── Helpers ──────────────────────────────────────────────────────────────────
function ipOf(req) {
  return req.ip || req.connection?.remoteAddress || "unknown";
}
function jsonError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

// ── requireAdmin — gate every route in this module ──────────────────────────
// Non-admins logged into the dashboard can do everything else, but can't see,
// add, or modify users. We re-check is_admin from the DB on every request
// (rather than trusting only the session) so demoting someone takes effect on
// their next API call without needing them to log out.
function requireAdmin(req, res, next) {
  const me = req.session?.userId ? userRepo.findById(req.session.userId) : null;
  if (!me || !me.is_admin || !me.active) {
    return jsonError(res, 403, "admin only");
  }
  req.adminUser = me;
  next();
}
router.use(requireAdmin);

// ── GET /api/users — list all users ──────────────────────────────────────────
router.get("/", (req, res) => {
  try {
    const rows = userRepo.listUsers();
    // Strip nothing here — listUsers already excludes password_hash.
    res.json({ ok: true, users: rows, currentUserId: req.session.userId });
  } catch (err) {
    console.error("[Users] list error:", err.message);
    return jsonError(res, 500, "failed to list users");
  }
});

// ── POST /api/users — create a new user ──────────────────────────────────────
router.post("/", express.json(), async (req, res) => {
  const { email, password, firstName, lastName, displayName } = req.body || {};
  if (!email || !password) return jsonError(res, 400, "email and password are required");
  if (password.length < 8) return jsonError(res, 400, "password must be at least 8 characters");
  if (userRepo.findByEmail(email)) {
    return jsonError(res, 409, `a user with email ${email} already exists`);
  }
  try {
    const u = await userRepo.createUser({
      email,
      password,
      firstName: firstName || null,
      lastName: lastName || null,
      displayName: displayName || null, // fallback label if no first name given
      mustChangePw: true,
    });
    console.log(`[Users] ${req.session.email} created user ${u.email} from ${ipOf(req)}`);
    res.json({ ok: true, user: u });
  } catch (err) {
    console.error("[Users] create error:", err.message);
    return jsonError(res, 500, err.message || "failed to create user");
  }
});

// ── PATCH /api/users/:id — edit display name and/or admin flag ──────────────
router.patch("/:id", express.json(), (req, res) => {
  const id = Number(req.params.id);
  const target = userRepo.findById(id);
  if (!target) return jsonError(res, 404, "user not found");

  const { firstName, lastName, displayName, isAdmin } = req.body || {};
  let didSomething = false;

  // First/last name update — keeps display_name in sync with the first name.
  if (typeof firstName !== "undefined" || typeof lastName !== "undefined") {
    userRepo.setName(id, firstName, lastName);
    didSomething = true;
  } else if (typeof displayName !== "undefined") {
    // Back-compat: a bare displayName edit still works.
    userRepo.updateDisplayName(id, displayName);
    didSomething = true;
  }

  // Admin flag toggle — guard against demoting the last admin.
  if (typeof isAdmin !== "undefined") {
    const wantAdmin = !!isAdmin;
    if (!wantAdmin && target.is_admin) {
      // Removing admin from this user — make sure another admin remains.
      const adminCount = userRepo.countAdmins();
      if (adminCount <= 1) {
        return jsonError(res, 400, "can't remove the last active admin");
      }
      // Also: don't let an admin demote themselves accidentally.
      if (id === req.session.userId) {
        return jsonError(res, 400, "you can't demote your own admin access — ask another admin to do it");
      }
    }
    userRepo.setAdmin(id, wantAdmin);
    didSomething = true;
  }

  if (!didSomething) return jsonError(res, 400, "no fields to update");

  console.log(`[Users] ${req.session.email} updated ${target.email}` +
    (typeof displayName !== "undefined" ? ` displayName="${displayName}"` : "") +
    (typeof isAdmin !== "undefined" ? ` isAdmin=${!!isAdmin}` : ""));
  res.json({ ok: true, user: userRepo.findById(id) });
});

// ── POST /api/users/:id/reset-password — admin password reset ────────────────
router.post("/:id/reset-password", express.json(), async (req, res) => {
  const id = Number(req.params.id);
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return jsonError(res, 400, "newPassword must be at least 8 characters");
  }
  const user = userRepo.findById(id);
  if (!user) return jsonError(res, 404, "user not found");
  try {
    await userRepo.updatePassword(id, newPassword);
    // Force them to rotate again on next login.
    require("../db/index").getDb()
      .prepare(`UPDATE users SET must_change_pw = 1 WHERE id = ?`)
      .run(id);
    console.log(`[Users] ${req.session.email} reset password for ${user.email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("[Users] reset-password error:", err.message);
    return jsonError(res, 500, err.message || "failed to reset password");
  }
});

// ── POST /api/users/:id/deactivate ───────────────────────────────────────────
router.post("/:id/deactivate", (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.userId) {
    return jsonError(res, 400, "you can't deactivate your own account");
  }
  const user = userRepo.findById(id);
  if (!user) return jsonError(res, 404, "user not found");

  // Refuse to deactivate the last active user.
  const allActive = userRepo.listUsers().filter((u) => u.active);
  if (allActive.length <= 1 && user.active) {
    return jsonError(res, 400, "can't deactivate the last active account");
  }

  userRepo.setActive(id, false);
  console.log(`[Users] ${req.session.email} deactivated ${user.email}`);
  res.json({ ok: true });
});

// ── POST /api/users/:id/activate ─────────────────────────────────────────────
router.post("/:id/activate", (req, res) => {
  const id = Number(req.params.id);
  const user = userRepo.findById(id);
  if (!user) return jsonError(res, 404, "user not found");
  userRepo.setActive(id, true);
  console.log(`[Users] ${req.session.email} reactivated ${user.email}`);
  res.json({ ok: true });
});

// ── DELETE /api/users/:id ────────────────────────────────────────────────────
router.delete("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.userId) {
    return jsonError(res, 400, "you can't delete your own account");
  }
  const user = userRepo.findById(id);
  if (!user) return jsonError(res, 404, "user not found");

  // Refuse to delete the last user (active or not — defensive).
  if (userRepo.listUsers().length <= 1) {
    return jsonError(res, 400, "can't delete the last user");
  }

  userRepo.deleteUser(id);
  console.log(`[Users] ${req.session.email} deleted ${user.email}`);
  res.json({ ok: true });
});

module.exports = router;
