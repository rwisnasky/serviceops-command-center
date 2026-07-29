/**
 * src/api/servicetitan.js
 *
 * Dispatcher. Chooses the live ServiceTitan client or the demo mock.
 *
 * The live client (`servicetitan.live.js`) is the real thing — OAuth token
 * cache, retry/backoff, pagination, the whole 68-function surface. It is kept
 * in the repo intentionally: it is the interesting code. It simply cannot run
 * without a ServiceTitan tenant.
 *
 * `DEMO_MODE=true` swaps in `../demo/servicetitan.mock.js`, which implements
 * the identical surface against a generated in-memory dataset. No other file in
 * the app knows the difference — every route and service requires this module
 * and gets whichever implementation is configured.
 *
 * This is the seam that makes the whole app demoable. Everything else about
 * demo mode is a consequence of it.
 */

const DEMO = require("../demo/mode").IS_DEMO;

module.exports = DEMO
  ? require("../demo/servicetitan.mock")
  : require("./servicetitan.live");

module.exports.__isDemo = DEMO;
