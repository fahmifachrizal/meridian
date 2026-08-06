/**
 * Offline unit tests for state/json-store.js — the mtime-invalidated cache
 * behind every persistent JSON store.
 *
 * The whole point of this module is to skip re-parsing unchanged files, so
 * the tests that matter most are the INVALIDATION ones: if the cache ever
 * serves a stale object after the file changed on disk, the agent silently
 * acts on wrong cooldowns / positions / lessons. These use a scratch file in
 * the OS temp dir and never touch a real store.
 *
 * Run: node test/test-json-store.js
 */

import fs from "fs";
import os from "os";
import path from "path";
import { createSuite } from "./lib/test-kit.js";
import { loadCached, saveJson, invalidateCache } from "../state/json-store.js";

const suite = createSuite("json-store — cached JSON load/save");
const { section, check, finish } = suite;

const TMP = path.join(os.tmpdir(), `meridian-json-store-test-${process.pid}.json`);
const empty = () => ({ v: 0, marker: "EMPTY" });

function cleanup() {
  try { if (fs.existsSync(TMP)) fs.unlinkSync(TMP); } catch { /* ignore */ }
  invalidateCache(TMP);
}

try {
  section("Basic read + cache hit");
  {
    fs.writeFileSync(TMP, JSON.stringify({ v: 1 }));
    invalidateCache(TMP);
    check("reads parsed content", loadCached(TMP, empty).v === 1);

    const a = loadCached(TMP, empty);
    const b = loadCached(TMP, empty);
    check("repeat read returns the SAME object (no re-parse)", a === b);
  }

  section("Invalidation — the correctness-critical cases");
  {
    // An external writer (cli.js against a live daemon, or an operator edit)
    // must be picked up, or the agent acts on stale state.
    fs.writeFileSync(TMP, JSON.stringify({ v: 999 }));
    check("external write with different size is detected", loadCached(TMP, empty).v === 999);

    // The nastiest case: same byte length, so only mtime can distinguish it.
    const before = fs.statSync(TMP).size;
    fs.writeFileSync(TMP, JSON.stringify({ v: 888 }));
    check("rewrite is same size (test is actually exercising the hard case)", fs.statSync(TMP).size === before);
    check("external write with IDENTICAL size is detected", loadCached(TMP, empty).v === 888);
  }

  section("saveJson keeps cache and disk in agreement");
  {
    saveJson(TMP, { v: 42 });
    check("next read sees the saved value", loadCached(TMP, empty).v === 42);
    check("on-disk content matches", JSON.parse(fs.readFileSync(TMP, "utf8")).v === 42);
  }

  section("Missing / corrupt files fail open");
  {
    fs.unlinkSync(TMP);
    check("missing file returns the empty value", loadCached(TMP, empty).marker === "EMPTY");

    // A missing file must NOT be cached as a miss — the file can appear at
    // any time (first deploy writes it) and a cached miss would hide it
    // until the process restarted.
    fs.writeFileSync(TMP, JSON.stringify({ v: 7 }));
    check("a file that appears later is picked up", loadCached(TMP, empty).v === 7);

    fs.writeFileSync(TMP, "{ this is not json");
    const corrupt = loadCached(TMP, empty);
    check("corrupt JSON returns empty value instead of throwing", corrupt.marker === "EMPTY");

    // Each caller must get its own empty object, or two callers mutating
    // "the default" would corrupt each other.
    fs.unlinkSync(TMP);
    const e1 = loadCached(TMP, empty);
    const e2 = loadCached(TMP, empty);
    check("empty values are distinct objects, not a shared default", e1 !== e2);
  }

  section("invalidateCache");
  {
    fs.writeFileSync(TMP, JSON.stringify({ v: 100 }));
    const first = loadCached(TMP, empty);
    invalidateCache(TMP);
    const second = loadCached(TMP, empty);
    check("forces a fresh parse (new object identity)", first !== second);
    check("value is still correct after invalidation", second.v === 100);
  }
} finally {
  cleanup();
}

process.exit(finish());
