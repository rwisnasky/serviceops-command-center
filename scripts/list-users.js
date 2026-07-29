#!/usr/bin/env node
/**
 * scripts/list-users.js  —  print all dashboard users.
 *
 *   npm run list-users
 */

require("dotenv").config();
const { initSchema } = require("../src/db/index");
const { listUsers } = require("../src/db/userRepository");

initSchema();

const users = listUsers();
if (!users.length) {
  console.log("(no users yet — run `npm run add-user`)");
  process.exit(0);
}

const pad = (s, n) => String(s ?? "").padEnd(n);
console.log(pad("ID", 4), pad("EMAIL", 36), pad("NAME", 18), pad("ACTIVE", 7), pad("MUST_CHG", 9), "LAST LOGIN");
console.log("─".repeat(100));
for (const u of users) {
  console.log(
    pad(u.id, 4),
    pad(u.email, 36),
    pad(u.display_name || "—", 18),
    pad(u.active ? "yes" : "no", 7),
    pad(u.must_change_pw ? "yes" : "no", 9),
    u.last_login_at || "(never)"
  );
}
process.exit(0);
