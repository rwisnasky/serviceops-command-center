/**
 * src/api/gohighlevel.js
 *
 * Dispatcher — live GoHighLevel client, or the demo mock.
 *
 * GHL calls are almost all outbound writes into a live marketing automation
 * account: contacts, tags, pipeline opportunities, workflow enrollments. There
 * is no safe way to point a public demo at a real location id, so demo mode
 * swaps in an in-memory CRM with identical semantics.
 */

const DEMO = require("../demo/mode").IS_DEMO;

module.exports = DEMO
  ? require("../demo/gohighlevel.mock")
  : require("./gohighlevel.live");

module.exports.__isDemo = DEMO;
