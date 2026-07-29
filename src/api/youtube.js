/**
 * src/api/youtube.js
 *
 * Dispatcher — live YouTube Data API client, or the demo mock.
 *
 * The videos page uploads job walkthrough videos to an unlisted YouTube
 * playlist. In demo mode nothing leaves the process: the mock accepts the
 * stream, drains it, and hands back a well-formed video id and watch URL so the
 * upload log and the page render exactly as they do in production.
 */

const DEMO = require("../demo/mode").IS_DEMO;

module.exports = DEMO
  ? require("../demo/youtube.mock")
  : require("./youtube.live");

module.exports.__isDemo = DEMO;
