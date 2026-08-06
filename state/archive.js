/**
 * Dated, append-only archives for the agent's historical records.
 *
 * WHY THIS EXISTS
 * ---------------
 * The active JSON stores are working state, not history, and two of them
 * lose data by design:
 *   - decision-log.json hard-caps at 100 entries. Real volume is ~100
 *     decisions PER DAY, so roughly a day of decision history is destroyed
 *     every day.
 *   - state.json keeps every position forever (100% of its entries were
 *     closed at last measurement), which is why it grew to ~1MB of dead
 *     weight that every read had to parse.
 *
 * The fix is not to shard the active stores by date — pool-memory.js does
 * cross-key Object.values() scans for base-mint cooldowns and state.js looks
 * positions up by address, so a position opened Monday and closed Wednesday
 * would land in the wrong shard. Instead each store keeps ONE complete active
 * file (nothing downstream changes) and additionally writes here.
 *
 * FORMAT: JSONL, one record per line, at logs/archive/<stream>-YYYYMMDD.jsonl.
 * JSONL because appending is a pure fs.appendFileSync — appending to a JSON
 * *array* would need read-parse-modify-write, which is the exact cost this
 * whole effort removes. The date is computed per write (not cached at module
 * load) so a long-lived PM2 process rolls over correctly at UTC midnight,
 * matching logger.js's daily-rotation idiom.
 *
 * Measured volume across the live 34-day history: ~98 KB/day total across all
 * four streams, ≈35 MB/year.
 */

import fs from "fs";
import path from "path";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";

export const ARCHIVE_DIR = repoPath("logs", "archive");

export const STREAMS = ["decisions", "performance", "lessons", "positions"];

/**
 * Archiving is suppressed under test so test/lib/test-kit.js's
 * withRestoredFile (which snapshots exactly ONE path) can't leak synthetic
 * records into real archive shards — those appends would be permanent, since
 * nothing restores them.
 */
function isEnabled() {
  if (process.env.MERIDIAN_ARCHIVE === "off") return false;
  if (process.env.NODE_ENV === "test") return false;
  return true;
}

/** UTC YYYYMMDD, per the operator's requested prefix format. */
export function archiveDateKey(date = new Date()) {
  // toISOString() is UTC by construction: "2026-08-06T11:43:54.708Z"
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

export function archivePath(stream, date = new Date()) {
  return path.join(ARCHIVE_DIR, `${stream}-${archiveDateKey(date)}.jsonl`);
}

/**
 * Append one record to a stream's archive for today (UTC).
 *
 * Deliberately swallows every error: an archive is a secondary record, and a
 * full disk or a permissions problem must never break a deploy or a close.
 *
 * @param {string} stream - one of STREAMS
 * @param {object} entry
 * @param {Date} [when] - bucket date; defaults to now. Used by the backfill
 *   script to place historical records in their original day.
 */
export function archiveAppend(stream, entry, when = new Date()) {
  if (!isEnabled() || !entry) return false;
  try {
    if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    fs.appendFileSync(archivePath(stream, when), JSON.stringify(entry) + "\n");
    return true;
  } catch (error) {
    log("archive_warn", `Failed to archive ${stream}: ${error.message}`);
    return false;
  }
}

/**
 * Read a stream's records back, merged across dated shards in date order.
 * For analysis/backtest scripts — the running agent never needs this.
 *
 * @param {string} stream
 * @param {{from?: string, to?: string}} [range] - inclusive YYYYMMDD bounds
 */
export function readArchive(stream, { from, to } = {}) {
  if (!fs.existsSync(ARCHIVE_DIR)) return [];
  const prefix = `${stream}-`;
  const files = fs.readdirSync(ARCHIVE_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl"))
    .map((f) => ({ file: f, key: f.slice(prefix.length, -".jsonl".length) }))
    .filter(({ key }) => (!from || key >= from) && (!to || key <= to))
    .sort((a, b) => a.key.localeCompare(b.key));

  const out = [];
  for (const { file } of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(ARCHIVE_DIR, file), "utf8");
    } catch (error) {
      log("archive_warn", `Failed to read ${file}: ${error.message}`);
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      // One malformed line must not discard the rest of the shard.
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return out;
}

/** Per-stream record counts and byte sizes, for reporting/verification. */
export function archiveStats() {
  if (!fs.existsSync(ARCHIVE_DIR)) return {};
  const stats = {};
  for (const file of fs.readdirSync(ARCHIVE_DIR)) {
    const m = file.match(/^(.+)-(\d{8})\.jsonl$/);
    if (!m) continue;
    const [, stream, key] = m;
    const full = path.join(ARCHIVE_DIR, file);
    const size = fs.statSync(full).size;
    const lines = fs.readFileSync(full, "utf8").split("\n").filter((l) => l.trim()).length;
    const s = (stats[stream] ||= { days: 0, records: 0, bytes: 0, first: key, last: key });
    s.days += 1;
    s.records += lines;
    s.bytes += size;
    if (key < s.first) s.first = key;
    if (key > s.last) s.last = key;
  }
  return stats;
}
