#!/usr/bin/env node
/**
 * scripts/reset-password.js  —  reset a user's password (admin recovery path).
 *
 *   npm run reset-password -- you@x.com NewPassword!
 *
 * The user is flagged must_change_pw=1, so they're forced to rotate again on
 * their next login.
 */

require("dotenv").config();
const { initSchema, getDb } = require("../src/db/index");
const { findByEmail, updatePassword } = require("../src/db/userRepository");

initSchema();

const [email, newPw] = process.argv.slice(2);
if (!email || !newPw) {
  console.error("Usage: npm run reset-password -- <email> <new-password>");
  process.exit(1);
}

const user = findByEmail(email);
if (!user) {
  console.error(`✗ no user found with email: ${email}`);
  process.exit(1);
}

(async () => {
  await updatePassword(user.id, newPw);
  // Re-flag must_change_pw so they have to rotate again themselves.
  getDb().prepare(`UPDATE users SET must_change_pw = 1 WHERE id = ?`).run(user.id);
  console.log(`✓ Password reset for ${user.email}. They'll be forced to rotate on next login.`);
  process.exit(0);
})().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
