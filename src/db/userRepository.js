/**
 * src/db/userRepository.js
 *
 * Auth — user CRUD + password hashing.
 *
 * All passwords are bcrypt-hashed (cost 12) before they touch the DB. The
 * plaintext never gets stored or logged. Email lookups are case-insensitive
 * (the column uses COLLATE NOCASE).
 *
 * The first user is seeded on first boot from FIRST_USER_EMAIL +
 * FIRST_USER_PASSWORD env vars (see seedFirstUserIfEmpty below).
 */

const bcrypt = require("bcrypt");
const { getDb } = require("./index");

const BCRYPT_COST = 12;

/** Normalize email to lowercase + trim — emails are case-insensitive in practice. */
function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/** Look up a user by email. Returns the row or undefined. Does not include the password hash check. */
function findByEmail(email) {
  const db = getDb();
  return db
    .prepare(`SELECT id, email, password_hash, display_name, first_name, last_name, active, must_change_pw, is_admin, created_at, last_login_at
              FROM users WHERE email = ?`)
    .get(normEmail(email));
}

function findById(id) {
  const db = getDb();
  return db
    .prepare(`SELECT id, email, display_name, first_name, last_name, active, must_change_pw, is_admin, created_at, last_login_at
              FROM users WHERE id = ?`)
    .get(id);
}

function listUsers() {
  const db = getDb();
  return db
    .prepare(`SELECT id, email, display_name, first_name, last_name, active, must_change_pw, is_admin, created_at, last_login_at
              FROM users ORDER BY created_at ASC`)
    .all();
}

/**
 * The full name for a user: "First Last" when we have name parts, else the
 * display name, else a best-effort guess from the email local part. Used
 * where the whole name matters (the timesheet) — as opposed to the casual
 * first-name display_name shown in the nav.
 */
function fullName(user) {
  if (!user) return "";
  const parts = [user.first_name, user.last_name].map((s) => (s || "").trim()).filter(Boolean);
  if (parts.length) return parts.join(" ");
  if (user.display_name && user.display_name.trim()) return user.display_name.trim();
  const local = String(user.email || "").split("@")[0];
  const toks = local.split(/[._\-]+/).filter(Boolean);
  return toks.length ? toks.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ") : (user.email || "");
}

function countAdmins() {
  const db = getDb();
  return db.prepare(`SELECT COUNT(*) AS c FROM users WHERE is_admin = 1 AND active = 1`).get().c;
}

/**
 * Create a new user. Throws if email already exists (UNIQUE constraint).
 * Returns the created user (without the password hash).
 */
async function createUser({ email, password, firstName, lastName, displayName, mustChangePw = false, isAdmin = false }) {
  if (!email) throw new Error("email is required");
  if (!password || password.length < 8) {
    throw new Error("password is required and must be at least 8 characters");
  }
  const first = (firstName || "").trim() || null;
  const last = (lastName || "").trim() || null;
  // Display name (the casual nav label) defaults to the first name; falls back
  // to an explicit displayName for callers that don't pass name parts.
  const display = first || (displayName || "").trim() || null;
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  const db = getDb();
  const result = db
    .prepare(`INSERT INTO users (email, password_hash, display_name, first_name, last_name, must_change_pw, is_admin)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(normEmail(email), hash, display, first, last, mustChangePw ? 1 : 0, isAdmin ? 1 : 0);
  return findById(result.lastInsertRowid);
}

/**
 * Set a user's first/last name. Keeps display_name in sync with the first
 * name so the nav's casual label updates too. Passing an empty string clears
 * a part; undefined leaves it untouched.
 */
function setName(userId, firstName, lastName) {
  const db = getDb();
  const cur = findById(userId);
  if (!cur) throw new Error("user not found");
  const first = firstName === undefined ? cur.first_name : ((firstName || "").trim() || null);
  const last = lastName === undefined ? cur.last_name : ((lastName || "").trim() || null);
  const display = first || null; // nav shows the first name
  db.prepare(`UPDATE users SET first_name = ?, last_name = ?, display_name = ? WHERE id = ?`)
    .run(first, last, display, userId);
  return findById(userId);
}

/**
 * Verify a login attempt. Returns the user row on success, or null on bad
 * email / bad password / inactive account. Always runs bcrypt.compare even
 * on a missing user — keeps response time roughly constant so an attacker
 * can't enumerate emails by timing.
 */
async function verifyLogin(email, password) {
  const user = findByEmail(email);
  // Dummy hash for timing safety when the user doesn't exist.
  const hash = user
    ? user.password_hash
    : "$2b$12$abcdefghijklmnopqrstuuvCmS9o.YbJ.nQ7bF8vP2k7P8m6.q9G3b6";
  const ok = await bcrypt.compare(password, hash);
  if (!user || !user.active || !ok) return null;
  return findById(user.id);
}

async function updatePassword(userId, newPassword) {
  if (!newPassword || newPassword.length < 8) {
    throw new Error("password must be at least 8 characters");
  }
  const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
  const db = getDb();
  db.prepare(`UPDATE users SET password_hash = ?, must_change_pw = 0 WHERE id = ?`)
    .run(hash, userId);
}

function recordLogin(userId) {
  const db = getDb();
  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(userId);
}

function setActive(userId, active) {
  const db = getDb();
  db.prepare(`UPDATE users SET active = ? WHERE id = ?`).run(active ? 1 : 0, userId);
}

function setAdmin(userId, isAdmin) {
  const db = getDb();
  db.prepare(`UPDATE users SET is_admin = ? WHERE id = ?`).run(isAdmin ? 1 : 0, userId);
}

function updateDisplayName(userId, displayName) {
  const db = getDb();
  db.prepare(`UPDATE users SET display_name = ? WHERE id = ?`)
    .run(displayName ? String(displayName).trim() || null : null, userId);
}

function deleteUser(userId) {
  const db = getDb();
  db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
}

/**
 * If the users table is empty, seed the first user from env vars
 * FIRST_USER_EMAIL + FIRST_USER_PASSWORD. Marks `must_change_pw=1` so
 * the first login forces a rotation.
 *
 * Idempotent — exits silently after the first user exists. Safe to call
 * on every boot.
 */
async function seedFirstUserIfEmpty() {
  const db = getDb();
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM users`).get();
  if (count > 0) return { seeded: false, reason: "users already exist" };

  const email = process.env.FIRST_USER_EMAIL;
  const password = process.env.FIRST_USER_PASSWORD;
  if (!email || !password) {
    return { seeded: false, reason: "FIRST_USER_EMAIL/FIRST_USER_PASSWORD not set" };
  }

  await createUser({
    email,
    password,
    displayName: process.env.FIRST_USER_DISPLAY_NAME || null,
    mustChangePw: true,
    isAdmin: true, // first user is always an admin so they can manage others
  });
  console.log(`[Auth] Seeded first user: ${normEmail(email)} (must change password on first login)`);
  return { seeded: true, email: normEmail(email) };
}

module.exports = {
  findByEmail,
  findById,
  listUsers,
  fullName,
  countAdmins,
  createUser,
  verifyLogin,
  updatePassword,
  recordLogin,
  setActive,
  setAdmin,
  updateDisplayName,
  setName,
  deleteUser,
  seedFirstUserIfEmpty,
};
