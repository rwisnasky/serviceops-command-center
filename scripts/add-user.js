#!/usr/bin/env node
/**
 * scripts/add-user.js
 *
 * Add a new dashboard user. Run interactively:
 *
 *   npm run add-user                    # prompts for email + password
 *   npm run add-user -- you@x.com pw    # one-shot, useful in Railway shell
 *
 * The user is created with must_change_pw=1, so they're forced to rotate
 * the password on their first login.
 */

require("dotenv").config();
const readline = require("readline");
const { initSchema } = require("../src/db/index");
const { createUser, findByEmail } = require("../src/db/userRepository");

initSchema();

function prompt(q, { silent = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (silent) {
      // Mute echo for password entry.
      const stdin = process.openStdin();
      const onData = (c) => {
        const s = c + "";
        if (s === "\n" || s === "\r" || s === "\r\n" || s.charCodeAt(0) === 4) {
          stdin.removeListener("data", onData);
        } else {
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
          process.stdout.write(q + Array(rl.line.length + 1).join("*"));
        }
      };
      stdin.on("data", onData);
    }
    rl.question(q, (ans) => { rl.close(); resolve(ans); });
  });
}

(async () => {
  const [argEmail, argPw, argName] = process.argv.slice(2);
  const email = argEmail || (await prompt("Email: ")).trim();
  const password = argPw || (await prompt("Password (min 8 chars): ", { silent: true }));
  const displayName = argName || (await prompt("Display name (optional): ")).trim() || null;

  if (!email || !password) {
    console.error("\n✗ email and password are required");
    process.exit(1);
  }
  if (findByEmail(email)) {
    console.error(`\n✗ a user already exists with email: ${email}`);
    process.exit(1);
  }

  try {
    const user = await createUser({ email, password, displayName, mustChangePw: true });
    console.log(`\n✓ Created user #${user.id} (${user.email})`);
    console.log(`  They'll be forced to rotate the password on first login.`);
  } catch (err) {
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
})();
