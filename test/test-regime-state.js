/**
 * QA protocol — regime state machine: relax + loopback suppression.
 *
 * The relax mechanism alone creates a new failure mode: relax back to normal,
 * immediately re-detect the same regime, tighten again, starve again, relax
 * again — an infinite oscillation that burns cycles and never deploys. These
 * tests lock in the suppression window that breaks that loop.
 *
 * Touches market-regime-profiles.json — snapshotted and restored.
 * Run: node test/test-regime-state.js
 */

import { createSuite, withRestoredFile } from "./lib/test-kit.js";
import { repoPath } from "../repo-root.js";
import {
  recordScreeningOutcome,
  getConsecutiveFails,
  resetConsecutiveFails,
  noteRegimeRelax,
  isRegimeSuppressed,
  clearRegimeSuppression,
} from "../market-regime-library.js";

const suite = createSuite("QA protocol — regime state machine");
const { section, check } = suite;
const PROFILES = repoPath("market-regime-profiles.json");

withRestoredFile(PROFILES, () => {
  // ─── 1. Fail counter ───────────────────────────────────────────
  section("Consecutive-fail counter");
  resetConsecutiveFails();
  clearRegimeSuppression();
  check("starts at 0", getConsecutiveFails() === 0);
  check("first no-deploy → 1", recordScreeningOutcome({ deployed: false }) === 1);
  check("second no-deploy → 2", recordScreeningOutcome({ deployed: false }) === 2);
  check("third no-deploy → 3", recordScreeningOutcome({ deployed: false }) === 3);
  check("a successful deploy resets to 0", recordScreeningOutcome({ deployed: true }) === 0);
  check("counter is 0 after reset", getConsecutiveFails() === 0);

  // ─── 2. Suppression window ─────────────────────────────────────
  section("Loopback suppression after a relax");
  clearRegimeSuppression();
  check("nothing suppressed initially", !isRegimeSuppressed("slow") && !isRegimeSuppressed("hot"));

  noteRegimeRelax("hot", 60_000);
  check("the regime we just relaxed OUT of is suppressed", isRegimeSuppressed("hot"));
  check("a DIFFERENT regime stays available (adaptation not frozen)", !isRegimeSuppressed("slow"));
  check("normal is never suppressed (always a legal target)", !isRegimeSuppressed("normal"));

  // ─── 3. Expiry ─────────────────────────────────────────────────
  section("Suppression expires");
  noteRegimeRelax("slow", -1000); // already-elapsed window
  check("an expired suppression no longer blocks", !isRegimeSuppressed("slow"));

  // ─── 4. Explicit clear ─────────────────────────────────────────
  section("Suppression can be cleared");
  noteRegimeRelax("hot", 60_000);
  check("suppressed before clear", isRegimeSuppressed("hot"));
  clearRegimeSuppression();
  check("cleared", !isRegimeSuppressed("hot"));

  // ─── 5. Relax resets the fail counter ──────────────────────────
  section("Relax resets the counter so it does not immediately re-fire");
  resetConsecutiveFails();
  recordScreeningOutcome({ deployed: false });
  recordScreeningOutcome({ deployed: false });
  recordScreeningOutcome({ deployed: false });
  check("3 fails accumulated", getConsecutiveFails() === 3);
  noteRegimeRelax("hot", 60_000);
  check("noteRegimeRelax zeroes the counter", getConsecutiveFails() === 0);
});

console.log("  (restored market-regime-profiles.json to pre-test content)");
process.exit(suite.finish());
