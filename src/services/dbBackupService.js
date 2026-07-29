/**
 * dbBackupService.js
 *
 * Nightly on-volume backup of the SQLite database with rotation.
 *
 * This is a STOPGAP: the copies live on the same Railway /data volume as the
 * live DB, so they protect against accidental deletes, a bad migration, or table
 * corruption — but NOT against loss of the volume itself. The real fix is to
 * ship a copy off-volume (S3/Backblaze/etc.); this at least removes the
 * "one fat-finger and it's gone" exposure until that's set up.
 *
 * Uses better-sqlite3's online .backup() so it's safe to run against the live DB
 * (no locking / no partial-write risk from copying the file mid-write).
 */

const fs = require("fs");
const path = require("path");
const { getDb } = require("../db/index");

async function runDbBackup({ keep = 7 } = {}) {
  const dbPath = process.env.DB_PATH || "/tmp/calls.db";
  const backupDir = path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(backupDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(backupDir, `calls-${stamp}.db`);

  await getDb().backup(dest);

  // Rotate: keep only the newest `keep` backups.
  const files = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith("calls-") && f.endsWith(".db"))
    .sort(); // ISO timestamps sort chronologically
  const excess = files.length - keep;
  for (let i = 0; i < excess; i++) {
    try {
      fs.unlinkSync(path.join(backupDir, files[i]));
    } catch (_) {
      /* best-effort cleanup */
    }
  }

  return { dest, total: files.length, kept: Math.min(files.length, keep) };
}

module.exports = { runDbBackup };
