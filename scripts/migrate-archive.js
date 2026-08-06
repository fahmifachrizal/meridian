#!/usr/bin/env node
/**
 * Backfill existing history into dated archive shards, then prune the active
 * JSON stores — OPERATOR ACTION ONLY, run once.
 *
 * The agent never calls this. It exists because the archive layer only starts
 * capturing records from the moment it ships; everything already sitting in
 * decision-log.json / lessons.json / state.json predates it.
 *
 * Each record is bucketed into the shard for ITS OWN timestamp (ts /
 * recorded_at / created_at / deployed_at), not today, so the archive
 * reconstructs real history rather than collapsing it into one day.
 *
 * PRUNING is the part that shrinks the active files, and it is deliberately
 * conservative:
 *   - state.json      drop closed positions older than --position-days (7).
 *                     Open positions are NEVER pruned regardless of age.
 *   - pool-memory.json drop pools untouched for longer than --pool-days (30).
 *   - lessons.json    performance[] is pruned only below darwinWindowDays,
 *                     because signal-weights.js filters that array by that
 *                     window — cutting deeper would silently degrade Darwin
 *                     signal weighting. lessons[] is never pruned.
 *   - decision-log.json untouched; its 100-entry cap is already the intended
 *                     runtime behavior.
 *
 * Run: node scripts/migrate-archive.js [--yes] [--position-days N] [--pool-days N]
 * Dry-run by default — prints exactly what it would write and drop.
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { archiveAppend, archiveStats, ARCHIVE_DIR } from "../state/archive.js";
import { config } from "../core/config.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--yes");
const numArg = (flag, dflt) => {
  const i = args.indexOf(flag);
  if (i === -1) return dflt;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
const POSITION_DAYS = numArg("--position-days", 7);
const POOL_DAYS = numArg("--pool-days", 30);
const DARWIN_DAYS = config.darwin?.windowDays ?? 60;

const DAY = 86_400_000;
const now = Date.now();
const KB = (b) => `${(b / 1024).toFixed(1)} KB`;
const sizeOf = (o) => Buffer.byteLength(JSON.stringify(o, null, 2));

function readJson(file, fallback) {
  const p = repoPath(file);
  if (!fs.existsSync(p)) return { path: p, data: fallback, missing: true };
  try {
    return { path: p, data: JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch (e) {
    console.error(`  ! ${file} is unreadable (${e.message}) — skipping`);
    return { path: p, data: fallback, missing: true };
  }
}

function whenOf(rec) {
  const raw = rec?.ts || rec?.recorded_at || rec?.created_at || rec?.closed_at || rec?.deployed_at;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? new Date(t) : null;
}

console.log(`\n${APPLY ? "APPLYING" : "DRY RUN"} — archive backfill + active-store prune`);
console.log(`  archive dir      : ${ARCHIVE_DIR}`);
console.log(`  closed positions : keep ${POSITION_DAYS}d in active file`);
console.log(`  pool memory      : keep pools touched within ${POOL_DAYS}d`);
console.log(`  performance      : keep ${DARWIN_DAYS}d (darwinWindowDays — Darwin's floor)\n`);

// Archiving is suppressed under NODE_ENV=test / MERIDIAN_ARCHIVE=off; this
// script is useless in that state, so fail loudly rather than silently no-op.
if (process.env.NODE_ENV === "test" || process.env.MERIDIAN_ARCHIVE === "off") {
  console.error("Archiving is disabled via NODE_ENV=test or MERIDIAN_ARCHIVE=off — aborting.");
  process.exit(1);
}

let archived = 0;
const archiveAll = (stream, records) => {
  let n = 0, undated = 0;
  for (const rec of records) {
    const when = whenOf(rec);
    if (!when) undated++;
    if (APPLY) archiveAppend(stream, rec, when || new Date());
    n++;
  }
  archived += n;
  console.log(`  ${stream.padEnd(12)} ${String(n).padStart(5)} records${undated ? `  (${undated} undated → today)` : ""}`);
  return n;
};

// ─── 1. Backfill ────────────────────────────────────────────────
console.log("BACKFILL");
const decisions = readJson("decision-log.json", { decisions: [] });
archiveAll("decisions", decisions.data.decisions || []);

const lessons = readJson("lessons.json", { lessons: [], performance: [] });
archiveAll("performance", lessons.data.performance || []);
archiveAll("lessons", lessons.data.lessons || []);

const state = readJson("state.json", { positions: {} });
const allPositions = Object.entries(state.data.positions || {}).map(([position, p]) => ({ position, ...p }));
archiveAll("positions", allPositions.filter((p) => p.closed));

// ─── 2. Prune ───────────────────────────────────────────────────
console.log("\nPRUNE");

// state.json — closed positions only; open ones stay no matter how old.
{
  const before = sizeOf(state.data);
  const kept = {};
  let dropped = 0;
  for (const [addr, p] of Object.entries(state.data.positions || {})) {
    const closedAt = Date.parse(p.closed_at || 0) || 0;
    const isOld = p.closed && closedAt && (now - closedAt) > POSITION_DAYS * DAY;
    // A closed position with no parseable closed_at is treated as old — it
    // is archived above either way, so this cannot lose data.
    const isUndatedClosed = p.closed && !closedAt;
    if (isOld || isUndatedClosed) { dropped++; continue; }
    kept[addr] = p;
  }
  state.data.positions = kept;
  const after = sizeOf(state.data);
  console.log(`  state.json        ${KB(before)} → ${KB(after)}  (dropped ${dropped} closed, kept ${Object.keys(kept).length})`);
  if (APPLY) fs.writeFileSync(state.path, JSON.stringify(state.data, null, 2));
}

// pool-memory.json — whole pools untouched beyond the window.
{
  const pm = readJson("pool-memory.json", {});
  const before = sizeOf(pm.data);
  const kept = {};
  let dropped = 0;
  for (const [addr, entry] of Object.entries(pm.data)) {
    const last = Date.parse(entry?.last_deployed_at || 0) || 0;
    // Never drop a pool still under an active cooldown — the guards read it.
    const cooling = Date.parse(entry?.cooldown_until || 0) > now
      || Date.parse(entry?.base_mint_cooldown_until || 0) > now;
    if (!cooling && last && (now - last) > POOL_DAYS * DAY) { dropped++; continue; }
    kept[addr] = entry;
  }
  const after = sizeOf(kept);
  console.log(`  pool-memory.json  ${KB(before)} → ${KB(after)}  (dropped ${dropped} stale pools, kept ${Object.keys(kept).length})`);
  if (APPLY) fs.writeFileSync(pm.path, JSON.stringify(kept, null, 2));
}

// lessons.json — performance only, and never below Darwin's window.
{
  const before = sizeOf(lessons.data);
  const cutoff = now - DARWIN_DAYS * DAY;
  const perf = lessons.data.performance || [];
  const kept = perf.filter((p) => {
    const t = Date.parse(p.recorded_at || 0) || 0;
    return !t || t >= cutoff; // undated records are kept, never guessed away
  });
  const dropped = perf.length - kept.length;
  lessons.data.performance = kept;
  const after = sizeOf(lessons.data);
  console.log(`  lessons.json      ${KB(before)} → ${KB(after)}  (dropped ${dropped} perf records beyond ${DARWIN_DAYS}d, kept ${kept.length}; lessons[] untouched)`);
  if (APPLY) fs.writeFileSync(lessons.path, JSON.stringify(lessons.data, null, 2));
}

console.log(`\n${APPLY ? "Archived" : "Would archive"} ${archived} records total.`);

if (APPLY) {
  const stats = archiveStats();
  console.log("\nARCHIVE ON DISK");
  for (const [stream, s] of Object.entries(stats)) {
    console.log(`  ${stream.padEnd(12)} ${String(s.records).padStart(5)} records  ${KB(s.bytes).padStart(10)}  ${s.days}d  [${s.first}..${s.last}]`);
  }
} else {
  console.log("Re-run with --yes to write. Back up your *.json first.");
}
