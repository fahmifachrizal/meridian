/**
 * Cached JSON load/save for the persistent state stores.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every state module used to do `JSON.parse(fs.readFileSync(...))` on every
 * single read. pool-memory.json is 1.4MB and costs ~1.8ms to parse, and it
 * has 12 separate read call sites — several of which fire once per candidate
 * inside the screening recon loop. state.json and lessons.json are ~1MB each
 * with the same pattern. That is pure waste: the process is the only writer,
 * so the parsed object is valid until we (or an external process) change the
 * file on disk.
 *
 * loadCached() keeps the parsed object and re-parses only when the file's
 * mtime/size changes. That makes repeat reads free while staying correct if
 * `cli.js` or an operator edits a file underneath a running daemon.
 *
 * Defensive copying was measured and deliberately rejected: structuredClone
 * of pool-memory.json costs 2.26ms — MORE than the 1.86ms parse it would be
 * replacing. So callers get a shared reference, under this contract:
 *
 *   ⚠️ THE RETURNED OBJECT IS SHARED AND MUTABLE.
 *   Mutate it only if you then call saveJson() with it. Never mutate and
 *   abandon — the mutation would stay in the cache and be handed to the next
 *   reader as if it had been persisted. Every current mutator in
 *   state/{pool-memory,lessons,state,decision-log}.js follows load→mutate→save
 *   with no early return in between; keep it that way.
 */

import fs from "fs";
import { log } from "../logger.js";

// path -> { data, mtimeMs, size }
const _cache = new Map();

function statOf(filePath) {
  try {
    const s = fs.statSync(filePath);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/**
 * Read + parse `filePath`, reusing the cached parse when the file is unchanged.
 *
 * @param {string} filePath
 * @param {Function} makeEmpty - returns the value for a missing/corrupt file.
 *   Called fresh each time so callers can't share a mutable default.
 * @param {string} [label] - store name, for log lines on corrupt JSON.
 */
export function loadCached(filePath, makeEmpty, label = "json_store") {
  const stat = statOf(filePath);
  if (!stat) {
    // Missing file — don't cache the empty value; the file may appear at any
    // time and a cached miss would hide it until the process restarted.
    _cache.delete(filePath);
    return makeEmpty();
  }

  const hit = _cache.get(filePath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return hit.data;
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    _cache.set(filePath, { data, mtimeMs: stat.mtimeMs, size: stat.size });
    return data;
  } catch (error) {
    log(`${label}_warn`, `Invalid JSON in ${filePath}: ${error.message}`);
    _cache.delete(filePath);
    return makeEmpty();
  }
}

/**
 * Write `data` to `filePath` and refresh the cache entry, so the next
 * loadCached() is a free hit rather than an immediate re-parse.
 */
export function saveJson(filePath, data, label = "json_store") {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    const stat = statOf(filePath);
    if (stat) _cache.set(filePath, { data, mtimeMs: stat.mtimeMs, size: stat.size });
    return true;
  } catch (error) {
    log(`${label}_error`, `Failed to write ${filePath}: ${error.message}`);
    // Drop the cache entry: we no longer know what is on disk.
    _cache.delete(filePath);
    return false;
  }
}

/**
 * Forget a cached parse. Tests that restore a file behind our back (see
 * test/lib/test-kit.js's withRestoredFile) call this so the next read hits
 * the real file.
 */
export function invalidateCache(filePath) {
  if (filePath) _cache.delete(filePath);
  else _cache.clear();
}
