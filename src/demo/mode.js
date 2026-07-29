/**
 * src/demo/mode.js
 *
 * The single source of truth for "are we in demo mode?".
 *
 * **It fails safe.** Demo mode is the default; you have to opt *out* of it by
 * setting DEMO_MODE=false explicitly. The earlier version read
 * `DEMO_MODE === "true"`, which meant that cloning the repo and running
 * `npm start` without first copying `.env.example` put the app in live mode
 * with the outbound network guard disabled. It would then have failed on
 * missing credentials rather than done any damage — but "the safety net is off
 * unless you remember to turn it on" is the wrong default for a public repo.
 *
 * Now: unset → demo. Anything other than an explicit `false`/`0`/`off` → demo.
 * Running against real systems is a deliberate act.
 */

const raw = process.env.DEMO_MODE;

const OPT_OUT = new Set(["false", "0", "no", "off"]);

const IS_DEMO = raw === undefined || raw === null || raw === ""
  ? true
  : !OPT_OUT.has(String(raw).trim().toLowerCase());

if (!IS_DEMO && !process.env.DEMO_MODE_QUIET) {
  console.log("[mode] DEMO_MODE=false — running against live external systems.");
}

module.exports = { IS_DEMO };
