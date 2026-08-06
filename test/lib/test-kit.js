/**
 * Shared test kit for this repo's offline test suite (test/test-*.js).
 *
 * Conventions:
 *   - Every test file is a plain node script (no framework/deps) that
 *     `import`s a Suite, runs check()/section() calls, then calls
 *     suite.finish() to print a summary and exit(0|1).
 *   - Any test that touches a real JSON store (pool-memory.json,
 *     market-regime-profiles.json, user-config.json, ...) MUST snapshot it
 *     with withRestoredFile()/snapshotFile() and restore it — tests must
 *     never leave a footprint in real trading/config data.
 */

import fs from "fs";
import { invalidateCache } from "../../state/json-store.js";

export function createSuite(title) {
  let failures = 0;
  let checks = 0;

  console.log(`\n${"=".repeat(3)} ${title} ${"=".repeat(3)}`);

  function section(name) {
    console.log(`\n--- ${name} ---`);
  }

  function check(name, condition) {
    checks++;
    if (condition) {
      console.log(`  ok — ${name}`);
    } else {
      console.error(`  FAIL — ${name}`);
      failures++;
    }
  }

  function finish() {
    console.log(`\n${failures === 0 ? `ALL PASSED (${checks} checks)` : `${failures}/${checks} FAILURE(S)`}`);
    return failures === 0 ? 0 : 1;
  }

  return { section, check, finish, get failures() { return failures; }, get checks() { return checks; } };
}

/**
 * Snapshot a JSON file's raw content (or null if it doesn't exist yet),
 * run `fn`, then restore the file to its exact pre-call content — even if
 * `fn` throws. Use this around anything that touches a real *.json store.
 */
export function withRestoredFile(filePath, fn) {
  const before = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  // state/json-store.js caches parsed JSON keyed by mtime+size. Restoring a
  // file behind its back can produce a same-size, same-millisecond write that
  // the cache would not notice, so invalidate explicitly rather than relying
  // on filesystem timestamp granularity.
  invalidateCache(filePath);
  try {
    return fn();
  } finally {
    if (before === null) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } else {
      fs.writeFileSync(filePath, before);
    }
    invalidateCache(filePath);
  }
}

/**
 * Assert a file is byte-identical to its snapshot taken before a block ran —
 * use as a final belt-and-suspenders check after withRestoredFile, or on its
 * own around a block that's expected to leave a file untouched.
 */
export function assertFileUnchanged(filePath, beforeContent) {
  const after = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  return after === beforeContent;
}
