/**
 * src/routes/fleet.js
 *
 * Fleet Tracking — off-hours trip analysis.
 *
 * Upload a Fleet Pro trip CSV + ServiceTitan timesheet XLSX,
 * filters out on-the-clock trips (with configurable buffer),
 * tags remaining trips against the known-addresses DB,
 * and returns a printable report.
 */

const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");
const { getDb } = require("../db/index");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeAddr(a) {
  return (a || "")
    .toLowerCase()
    .replace(/[,.]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\busa\b/g, "")
    .trim();
}

function parseIgnTime(ts) {
  // "03/01/2026 09:05 AM GMT-06"
  const m = ts.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s+(AM|PM)/i);
  if (!m) return null;
  let [, mo, day, yr, hr, min, ampm] = m;
  hr = parseInt(hr);
  min = parseInt(min);
  if (ampm.toUpperCase() === "PM" && hr !== 12) hr += 12;
  if (ampm.toUpperCase() === "AM" && hr === 12) hr = 0;
  return new Date(parseInt(yr), parseInt(mo) - 1, parseInt(day), hr, min);
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Pull Y/M/D from a SheetJS date cell or date-like string.
// SheetJS with cellDates: true returns date-only cells as UTC midnight, so we
// read the UTC components and treat them as local-calendar values.
function extractYMD(val) {
  if (val instanceof Date && !isNaN(val)) {
    return { y: val.getUTCFullYear(), m: val.getUTCMonth(), d: val.getUTCDate() };
  }
  if (typeof val === "string") {
    const iso = val.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return { y: +iso[1], m: +iso[2] - 1, d: +iso[3] };
    const us = val.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (us) return { y: +us[3], m: +us[1] - 1, d: +us[2] };
  }
  return null;
}

// Parse a time cell that may be "HH:MM", "HH:MM:SS", "H:MM AM/PM",
// a Date object (1899/1900 epoch + time), or an Excel fractional day.
function extractHMS(val) {
  if (val instanceof Date && !isNaN(val)) {
    return { h: val.getUTCHours(), mi: val.getUTCMinutes(), s: val.getUTCSeconds() };
  }
  if (typeof val === "string") {
    const m = val.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
    if (!m) return null;
    let h = +m[1];
    const mi = +m[2];
    const s = m[3] ? +m[3] : 0;
    if (m[4]) {
      const ap = m[4].toUpperCase();
      if (ap === "PM" && h !== 12) h += 12;
      if (ap === "AM" && h === 12) h = 0;
    }
    return { h, mi, s };
  }
  if (typeof val === "number") {
    const total = Math.round(val * 86400);
    return { h: Math.floor(total / 3600) % 24, mi: Math.floor((total % 3600) / 60), s: total % 60 };
  }
  return null;
}

function parseTimesheetXLSX(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  const intervals = [];
  for (const r of rows) {
    let localStart = null;
    let localEnd = null;

    // Current ServiceTitan export: separate "Timesheet Activity Date" + "Start Time" / "End Time"
    const actDate = r["Timesheet Activity Date"];
    const startT = r["Start Time"];
    const endT = r["End Time"];
    if (actDate && startT && endT) {
      const ymd = extractYMD(actDate);
      const sh = extractHMS(startT);
      const eh = extractHMS(endT);
      if (ymd && sh && eh) {
        localStart = new Date(ymd.y, ymd.m, ymd.d, sh.h, sh.mi, sh.s);
        localEnd = new Date(ymd.y, ymd.m, ymd.d, eh.h, eh.mi, eh.s);
        // Handle shifts that cross midnight
        if (localEnd < localStart) localEnd = new Date(localEnd.getTime() + 86400 * 1000);
      }
    } else {
      // Legacy export format: combined date+time columns
      const s = r["Start Date Time"];
      const e = r["End Date Time"];
      if (!s || !e) continue;
      const sd = s instanceof Date ? s : new Date(s);
      const ed = e instanceof Date ? e : new Date(e);
      if (isNaN(sd) || isNaN(ed)) continue;
      // SheetJS cellDates interprets Excel dates as UTC, but the values are
      // actually local time (same timezone as the trip CSV). Re-interpret the
      // UTC components as local so both sides of the comparison align.
      localStart = new Date(sd.getUTCFullYear(), sd.getUTCMonth(), sd.getUTCDate(), sd.getUTCHours(), sd.getUTCMinutes());
      localEnd = new Date(ed.getUTCFullYear(), ed.getUTCMonth(), ed.getUTCDate(), ed.getUTCHours(), ed.getUTCMinutes());
    }

    if (!localStart || !localEnd || isNaN(localStart) || isNaN(localEnd)) continue;
    intervals.push({ start: localStart, end: localEnd });
  }
  return intervals;
}

function parseTripCSV(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // First line may be "sep=;"
  let startIdx = 0;
  if (lines[0].startsWith("sep=")) startIdx = 1;
  const header = lines[startIdx].split(";");
  const rows = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const parts = lines[i].split(";");
    const row = {};
    header.forEach((h, idx) => { row[h.trim()] = (parts[idx] || "").trim(); });
    rows.push(row);
  }
  return { header: header.map(h => h.trim()), rows };
}

// Build one work interval per weekday (Mon–Fri) in [startDate, endDate],
// using the supplied {h, mi, s} start/end times. Used as a fallback when
// no ServiceTitan timesheet is uploaded.
function synthesizeWeekdayIntervals(startDate, endDate, startHMS, endHMS) {
  const intervals = [];
  // Walk day-by-day in local time
  const cur = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const last = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  while (cur <= last) {
    const dow = cur.getDay(); // 0=Sun..6=Sat
    if (dow >= 1 && dow <= 5) {
      const s = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), startHMS.h, startHMS.mi, startHMS.s);
      let e = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), endHMS.h, endHMS.mi, endHMS.s);
      if (e <= s) e = new Date(e.getTime() + 86400 * 1000); // overnight shift
      intervals.push({ start: s, end: e });
    }
    cur.setDate(cur.getDate() + 1);
  }
  return intervals;
}

function buildPaddedWindows(intervals, bufferMin, offDayThresholdHrs) {
  const PAD_MS = bufferMin * 60 * 1000;
  const THRESHOLD_MS = offDayThresholdHrs * 3600 * 1000;

  // Group by day
  const byDay = {};
  for (const seg of intervals) {
    const dk = dateKey(seg.start);
    if (!byDay[dk]) byDay[dk] = [];
    byDay[dk].push(seg);
  }

  const allWindows = [];
  const offDays = [];
  for (const [day, segs] of Object.entries(byDay)) {
    const total = segs.reduce((sum, s) => sum + (s.end - s.start), 0);
    if (total < THRESHOLD_MS) {
      offDays.push(day);
      for (const s of segs) allWindows.push({ start: s.start, end: s.end });
    } else {
      for (const s of segs) {
        allWindows.push({
          start: new Date(s.start.getTime() - PAD_MS),
          end: new Date(s.end.getTime() + PAD_MS),
        });
      }
    }
  }

  // Merge overlapping
  allWindows.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const w of allWindows) {
    if (merged.length && w.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = new Date(Math.max(merged[merged.length - 1].end, w.end));
    } else {
      merged.push({ start: new Date(w.start), end: new Date(w.end) });
    }
  }

  return { windows: merged, offDays };
}

// ── Address DB helpers ──────────────────────────────────────────────────────

function getAddrLookup() {
  const db = getDb();
  const rows = db.prepare("SELECT normalized, label FROM known_addresses WHERE label != '' AND label IS NOT NULL").all();
  const map = {};
  for (const r of rows) map[r.normalized] = r.label;
  return map;
}

function upsertAddress(address, normalized, truckNumber, sampleVisit) {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM known_addresses WHERE normalized = ?").get(normalized);
  if (!existing) {
    db.prepare(
      "INSERT INTO known_addresses (address, normalized, truck_number, sample_visit) VALUES (?, ?, ?, ?)"
    ).run(address, normalized, truckNumber || null, sampleVisit || null);
    return true; // new
  }
  return false; // already existed
}

// ── Routes ──────────────────────────────────────────────────────────────────

// Process trip report
router.post(
  "/process",
  upload.fields([
    { name: "tripFile", maxCount: 1 },
    { name: "timesheetFile", maxCount: 1 },
  ]),
  (req, res) => {
    try {
      const tripBuf = req.files.tripFile?.[0]?.buffer;
      const tsBuf = req.files.timesheetFile?.[0]?.buffer;
      if (!tripBuf) return res.status(400).json({ error: "Trip CSV is required" });

      const bufferMin = parseInt(req.body.bufferMin) || 30;
      const offDayHrs = parseFloat(req.body.offDayHrs) || 4;
      const truckNumber = req.body.truckNumber || "";
      const manualStart = (req.body.manualStart || "").trim(); // "HH:MM"
      const manualEnd = (req.body.manualEnd || "").trim();

      // Source of truth for work intervals: timesheet if uploaded, otherwise
      // synthesized from manual weekday window.
      let intervals;
      if (tsBuf) {
        intervals = parseTimesheetXLSX(tsBuf);
        if (!intervals.length) return res.status(400).json({ error: "No time intervals found in timesheet" });
      } else if (manualStart && manualEnd) {
        // Validate HH:MM
        const sh = extractHMS(manualStart);
        const eh = extractHMS(manualEnd);
        if (!sh || !eh) return res.status(400).json({ error: "Manual start/end must be HH:MM (24h)" });
        // We need the trip date range to know which weekdays to generate
        // intervals for. Parse the trip CSV first in this branch.
        var earlyTripParse = parseTripCSV(tripBuf.toString("utf-8"));
        if (!earlyTripParse.rows.length) return res.status(400).json({ error: "No trip rows found in CSV" });
        let minD = null, maxD = null;
        for (const row of earlyTripParse.rows) {
          const dt = parseIgnTime(row["Ignition On/Trip Start"] || "");
          if (!dt) continue;
          if (!minD || dt < minD) minD = dt;
          if (!maxD || dt > maxD) maxD = dt;
        }
        if (!minD || !maxD) return res.status(400).json({ error: "Could not determine trip date range from CSV" });
        intervals = synthesizeWeekdayIntervals(minD, maxD, sh, eh);
        if (!intervals.length) return res.status(400).json({ error: "Trip date range contains no weekdays" });
      } else {
        return res.status(400).json({ error: "Upload a timesheet XLSX or provide manual start/end times" });
      }

      const { header, rows: tripRows } = (typeof earlyTripParse !== "undefined" && earlyTripParse)
        ? earlyTripParse
        : parseTripCSV(tripBuf.toString("utf-8"));
      if (!tripRows.length) return res.status(400).json({ error: "No trip rows found in CSV" });

      // Build padded work windows
      const { windows, offDays } = buildPaddedWindows(intervals, bufferMin, offDayHrs);

      // Filter trips
      const kept = [];
      let removed = 0;
      for (const row of tripRows) {
        const ts = row["Ignition On/Trip Start"];
        const dt = ts ? parseIgnTime(ts) : null;
        if (!dt) { kept.push(row); continue; }

        let inWork = false;
        for (const w of windows) {
          if (dt >= w.start && dt <= w.end) { inWork = true; break; }
          if (w.start > dt) break;
        }
        if (inWork) removed++;
        else kept.push(row);
      }

      // Tag against known addresses
      const lookup = getAddrLookup();
      let newAddresses = 0;

      const taggedRows = kept.map((row) => {
        const dep = row["Depart"] || "";
        const arr = row["Arrive"] || "";
        const depN = normalizeAddr(dep);
        const arrN = normalizeAddr(arr);
        const depLabel = lookup[depN] || "";
        const arrLabel = lookup[arrN] || "";

        // Collect sample visit for address DB
        const ignTs = (row["Ignition On/Trip Start"] || "").replace(/\s+GMT[-+]\d+$/, "");
        const offTs = (row["Ignition Off/Trip End"] || "").replace(/\s+GMT[-+]\d+$/, "");

        if (dep && depN) { if (upsertAddress(dep, depN, truckNumber, ignTs)) newAddresses++; }
        if (arr && arrN) { if (upsertAddress(arr, arrN, truckNumber, offTs)) newAddresses++; }

        return {
          ignitionOn: row["Ignition On/Trip Start"] || "",
          depart: dep,
          departLabel: depLabel,
          ignitionOff: row["Ignition Off/Trip End"] || "",
          arrive: arr,
          arriveLabel: arrLabel,
          miles: row["Distance Traveled (Miles)"] || "0",
          hardBraking: parseInt(row["Hard Braking Events"]) || 0,
          hardCornering: parseInt(row["Cornering Events"]) || 0,
        };
      });

      const totalMiles = taggedRows.reduce((sum, r) => sum + (parseFloat(r.miles) || 0), 0);
      const taggedDep = taggedRows.filter((r) => r.departLabel).length;
      const taggedArr = taggedRows.filter((r) => r.arriveLabel).length;

      // Determine date range from trip data
      let minDate = null, maxDate = null;
      for (const row of tripRows) {
        const dt = parseIgnTime(row["Ignition On/Trip Start"] || "");
        if (!dt) continue;
        if (!minDate || dt < minDate) minDate = dt;
        if (!maxDate || dt > maxDate) maxDate = dt;
      }
      const fmtRange = (d) => {
        if (!d) return "";
        const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        return `${mo[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
      };
      const dateRange = minDate && maxDate ? `${fmtRange(minDate)} – ${fmtRange(maxDate)}` : "";

      res.json({
        summary: {
          totalTrips: tripRows.length,
          removed,
          kept: kept.length,
          taggedDepart: taggedDep,
          taggedArrive: taggedArr,
          newAddresses,
          totalMiles: totalMiles.toFixed(2),
          offDays,
          windowCount: windows.length,
          buffer: bufferMin,
          offDayThreshold: offDayHrs,
          dateRange,
        },
        rows: taggedRows,
      });
    } catch (err) {
      console.error("[Fleet] Process error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ── Address CRUD ────────────────────────────────────────────────────────────

router.get("/addresses", (req, res) => {
  const db = getDb();
  const search = req.query.search || "";
  let rows;
  if (search) {
    rows = db.prepare(
      "SELECT * FROM known_addresses WHERE address LIKE ? OR label LIKE ? ORDER BY label = '' ASC, label ASC, address ASC"
    ).all(`%${search}%`, `%${search}%`);
  } else {
    rows = db.prepare(
      "SELECT * FROM known_addresses ORDER BY label = '' ASC, label ASC, address ASC"
    ).all();
  }
  res.json({ addresses: rows, total: rows.length, unlabeled: rows.filter((r) => !r.label).length });
});

router.put("/addresses/:id", (req, res) => {
  const db = getDb();
  const { label } = req.body;
  if (label === undefined) return res.status(400).json({ error: "label is required" });
  db.prepare("UPDATE known_addresses SET label = ?, updated_at = datetime('now') WHERE id = ?").run(label, req.params.id);
  res.json({ ok: true });
});

router.delete("/addresses/:id", (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM known_addresses WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Bulk label update (for same-street propagation or batch edits)
router.post("/addresses/propagate", (req, res) => {
  const db = getDb();
  const labeled = db.prepare(
    "SELECT address, normalized, label FROM known_addresses WHERE label != '' AND label IS NOT NULL"
  ).all();

  // Build street key → label map
  function streetKey(addr) {
    const parts = addr.split(",").map((p) => p.trim()).filter((p) => p && p.toLowerCase() !== "usa");
    const zipMatch = addr.match(/\b(\d{5})\b/);
    const zip = zipMatch ? zipMatch[1] : "";
    let zipIdx = parts.findIndex((p) => p.includes(zip));
    if (zipIdx < 0) zipIdx = parts.length;
    const before = parts.slice(0, zipIdx);
    // Check if state+zip are combined
    const stateInZip = /^[A-Z]{2}\s+\d{5}/.test(parts[zipIdx] || "");
    let city, streetParts;
    if (stateInZip) {
      city = before.length ? before[before.length - 1] : "";
      streetParts = before.slice(0, -1);
    } else {
      city = before.length >= 2 ? before[before.length - 2] : "";
      streetParts = before.slice(0, Math.max(0, before.length - 2));
    }
    let street = streetParts.join(" ").replace(/^[\d\-]+\s+/, "").replace(/\s+/g, " ").toLowerCase().trim();
    return street && city ? `${street}|${city.toLowerCase().trim()}|${zip}` : null;
  }

  const keyMap = {};
  for (const r of labeled) {
    const k = streetKey(r.address);
    if (k && !keyMap[k]) keyMap[k] = r.label;
  }

  const unlabeled = db.prepare(
    "SELECT id, address FROM known_addresses WHERE label = '' OR label IS NULL"
  ).all();

  let propagated = 0;
  const updates = [];
  for (const r of unlabeled) {
    const k = streetKey(r.address);
    if (k && keyMap[k]) {
      db.prepare("UPDATE known_addresses SET label = ?, updated_at = datetime('now') WHERE id = ?").run(keyMap[k], r.id);
      updates.push({ id: r.id, address: r.address, label: keyMap[k] });
      propagated++;
    }
  }

  res.json({ propagated, updates });
});

// ── Technician / Truck mapping ──────────────────────────────────────────────

router.get("/technicians", (req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM fleet_technicians WHERE active = 1 ORDER BY truck_number ASC").all();
  res.json({ technicians: rows });
});

router.post("/technicians", (req, res) => {
  const db = getDb();
  const { truckNumber, techName, groupName } = req.body;
  if (!truckNumber || !techName) return res.status(400).json({ error: "truckNumber and techName are required" });
  try {
    db.prepare(
      "INSERT INTO fleet_technicians (truck_number, tech_name, group_name) VALUES (?, ?, ?) ON CONFLICT(truck_number) DO UPDATE SET tech_name = ?, group_name = ?, updated_at = datetime('now')"
    ).run(truckNumber, techName, groupName || null, techName, groupName || null);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/technicians/:id", (req, res) => {
  const db = getDb();
  db.prepare("UPDATE fleet_technicians SET active = 0, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Import addresses from uploaded XLSX (known-addresses.xlsx migration)
router.post(
  "/addresses/import",
  upload.single("file"),
  (req, res) => {
    try {
      const buf = req.file?.buffer;
      if (!buf) return res.status(400).json({ error: "XLSX file required" });

      const wb = XLSX.read(buf, { type: "buffer" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

      const db = getDb();
      let imported = 0;
      let skipped = 0;
      for (const r of rows) {
        const address = r["Address"] || "";
        const label = r["Label"] || "";
        const truck = r["Truck"] ? String(r["Truck"]) : "";
        const sample = r["Sample Visit"] || "";
        if (!address) continue;

        const norm = normalizeAddr(address);
        const existing = db.prepare("SELECT id FROM known_addresses WHERE normalized = ?").get(norm);
        if (existing) {
          // Update label if the import has one and existing doesn't
          if (label) {
            db.prepare("UPDATE known_addresses SET label = ?, updated_at = datetime('now') WHERE id = ? AND (label = '' OR label IS NULL)").run(label, existing.id);
          }
          skipped++;
        } else {
          db.prepare(
            "INSERT INTO known_addresses (address, normalized, label, truck_number, sample_visit) VALUES (?, ?, ?, ?, ?)"
          ).run(address, norm, label, truck || null, sample || null);
          imported++;
        }
      }

      res.json({ imported, skipped, total: rows.length });
    } catch (err) {
      console.error("[Fleet] Import error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Seed initial data (one-time convenience)
router.post("/seed", (req, res) => {
  const db = getDb();
  const seeds = [
    { truck: "21", name: "Wes Calloway",  group: "Plumbing Techs" },
    { truck: "12", name: "Marcus Ellery", group: "HVAC Techs" },
  ];
  for (const s of seeds) {
    db.prepare(
      "INSERT OR IGNORE INTO fleet_technicians (truck_number, tech_name, group_name) VALUES (?, ?, ?)"
    ).run(s.truck, s.name, s.group);
  }
  res.json({ ok: true, seeded: seeds.length });
});

module.exports = router;
