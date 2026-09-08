/**
 * Offline unit tests for state/archive.js — the dated append-only archives.
 *
 * Two properties matter most:
 *   1. SUPPRESSION UNDER TEST. Archive appends are the one write in this repo
 *      that test-kit's withRestoredFile cannot undo (it snapshots exactly one
 *      path, and appends land in logs/archive/<stream>-YYYYMMDD.jsonl). If
 *      suppression ever regresses, every `npm test` run permanently pollutes
 *      real archives — e.g. any test calling applyConfigChanges also calls
 *      addLesson, which archives a lesson.
 *   2. UTC DATE BUCKETING. Records must land in the shard for their own
 *      timestamp, including across a midnight boundary, or the backfill
 *      collapses real history into one day.
 *
 * Run: NODE_ENV=test node test/test-archive.js
 */

import fs from "fs";
import path from "path";
import { createSuite } from "./lib/test-kit.js";
import {
  archiveAppend,
  readArchive,
  archiveDateKey,
  archivePath,
  ARCHIVE_DIR,
  STREAMS,
} from "../state/archive.js";

const suite = createSuite("archive — dated append-only history");
const { section, check, finish } = suite;

// Fake stream name so a leaked file is obvious and grep-able, and can never
// collide with a real one.
const STREAM = "TEST_ARCHIVE_STREAM_DO_NOT_USE";

function shardFiles() {
  if (!fs.existsSync(ARCHIVE_DIR)) return [];
  return fs.readdirSync(ARCHIVE_DIR).filter((f) => f.startsWith(`${STREAM}-`));
}

function cleanup() {
  for (const f of shardFiles()) {
    try { fs.unlinkSync(path.join(ARCHIVE_DIR, f)); } catch { /* ignore */ }
  }
}

cleanup();

try {
  // ─── 1. Suppression under test ────────────────────────────────
  section("Suppression — archives must not be written during tests");
  {
    // package.json sets NODE_ENV=test for every test script.
    check("NODE_ENV is 'test' (the suite's own precondition)", process.env.NODE_ENV === "test");

    const wrote = archiveAppend(STREAM, { hello: "world" });
    check("archiveAppend reports it did not write", wrote === false);
    check("no shard file was created", shardFiles().length === 0);

    const off = process.env.MERIDIAN_ARCHIVE;
    process.env.MERIDIAN_ARCHIVE = "off";
    check("MERIDIAN_ARCHIVE=off also suppresses", archiveAppend(STREAM, { a: 1 }) === false);
    if (off === undefined) delete process.env.MERIDIAN_ARCHIVE; else process.env.MERIDIAN_ARCHIVE = off;
  }

  // ─── 2. Behaviour with archiving enabled ──────────────────────
  // Temporarily lift suppression to exercise the real write path, then put it
  // back. Everything written here uses the fake stream and is deleted below.
  section("Append + read round-trip (suppression lifted)");
  const savedEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    check("append succeeds when enabled", archiveAppend(STREAM, { id: 1, note: "first" }) === true);
    archiveAppend(STREAM, { id: 2, note: "second" });

    const all = readArchive(STREAM);
    check("both records read back", all.length === 2);
    check("content round-trips intact", all[0].note === "first" && all[1].note === "second");
    check("append order is preserved", all[0].id === 1 && all[1].id === 2);

    section("UTC date bucketing");
    {
      // Two instants either side of a UTC midnight must land in different
      // shards, keyed by their own date rather than "today".
      const before = new Date("2026-03-14T23:59:59.000Z");
      const after = new Date("2026-03-15T00:00:01.000Z");
      check("archiveDateKey is YYYYMMDD", archiveDateKey(before) === "20260314");
      check("key rolls at UTC midnight", archiveDateKey(after) === "20260315");

      archiveAppend(STREAM, { id: 3, side: "before-midnight" }, before);
      archiveAppend(STREAM, { id: 4, side: "after-midnight" }, after);
      check("shard filename carries the date", archivePath(STREAM, before).endsWith(`${STREAM}-20260314.jsonl`));
      check("the two records went to different shards", fs.existsSync(archivePath(STREAM, before)) && fs.existsSync(archivePath(STREAM, after)));

      // A late-evening local time that is already the NEXT day in UTC must
      // bucket by UTC, not local — this is what makes shards stable across
      // the operator's machine and the VPS.
      check("bucketing is UTC, not local time", archiveDateKey(new Date(Date.UTC(2026, 2, 15, 0, 30))) === "20260315");
    }

    section("readArchive merges shards in date order and filters by range");
    {
      const merged = readArchive(STREAM);
      const ids = merged.map((r) => r.id);
      // 20260314 and 20260315 sort before today's shard.
      check("older shards come first", ids.indexOf(3) < ids.indexOf(1) && ids.indexOf(4) < ids.indexOf(1));
      check("all four records present", merged.length === 4);

      const only14 = readArchive(STREAM, { from: "20260314", to: "20260314" });
      check("range filter selects one shard", only14.length === 1 && only14[0].id === 3);

      const from15 = readArchive(STREAM, { from: "20260315" });
      check("open-ended 'from' includes later shards", from15.length === 3 && !from15.some((r) => r.id === 3));
    }

    section("Malformed lines degrade gracefully");
    {
      const p = archivePath(STREAM, new Date("2026-03-14T12:00:00.000Z"));
      fs.appendFileSync(p, "{ this is not json\n");
      fs.appendFileSync(p, JSON.stringify({ id: 5, note: "after the bad line" }) + "\n");
      const recs = readArchive(STREAM, { from: "20260314", to: "20260314" });
      check("bad line is skipped, good lines survive", recs.length === 2 && recs.some((r) => r.id === 5));
    }

    section("Never throws on bad input");
    {
      check("null entry is a no-op, not a crash", archiveAppend(STREAM, null) === false);
      check("unknown stream still reads as empty", readArchive("NO_SUCH_STREAM_DO_NOT_USE").length === 0);
    }
  } finally {
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
  }

  section("Stream registry");
  {
    check("STREAMS lists the four wired streams",
      ["decisions", "performance", "lessons", "positions"].every((s) => STREAMS.includes(s)));
  }
} finally {
  cleanup();
  console.log("  (removed test archive shards)");
}

process.exit(finish());
