/**
 * QA protocol — regime-specific "absolute state" contract tests.
 *
 * Companion to test/test-invariants.js (which covers config sign/bounds,
 * CONFIG_MAP consistency, degenScore bounds, and getDeterministicCloseRule's
 * rule precedence). This file locks in the market-regime feature's own
 * invariants: profile completeness and classifyRegime()'s return-domain
 * contract.
 *
 * NOTE: the `changes` maps checked here (in market-regime-profiles.json) are
 * legacy documentation only — they are no longer applied to live config. The
 * bounded, ratcheted overlay that actually runs lives in regime-overlay.js
 * and is covered by test/test-regime-overlay.js and test/test-regime-state.js.
 *
 * Offline, no network, no wallet.
 *
 * Run: node test/test-regime-invariants.js
 */

import { createSuite } from "./lib/test-kit.js";
import { config } from "../config.js";
import { CONFIG_MAP } from "../tools/executor.js";
import { classifyRegime } from "../market-regime.js";
import { listRegimeProfiles, getRegimeProfile } from "../market-regime-library.js";

const suite = createSuite("QA protocol — regime-specific invariants");
const { section, check } = suite;

// ─── 1. Config bound: regime cutoff ordering ─────────────────────
section("Regime cutoff bound");
check("regime.slowCutoff < regime.hotCutoff", config.regime.slowCutoff < config.regime.hotCutoff);

// ─── 2. Regime profile completeness ──────────────────────────────
section("Market regime profiles — structural completeness");
{
  const { regimes } = listRegimeProfiles();
  check("exactly 3 regimes (slow/normal/hot)", regimes.length === 3 && ["slow", "normal", "hot"].every((id) => regimes.some((r) => r.id === id)));

  const profiles = ["slow", "normal", "hot"].map((id) => getRegimeProfile({ id }));
  const keySets = profiles.map((p) => Object.keys(p.changes).sort().join(","));
  check("all 3 profiles define the exact same set of changed keys", keySets[0] === keySets[1] && keySets[1] === keySets[2]);

  let allKeysKnown = true;
  const unknownKeys = [];
  for (const p of profiles) {
    for (const key of Object.keys(p.changes)) {
      if (!CONFIG_MAP[key]) {
        allKeysKnown = false;
        unknownKeys.push(`${p.id}.${key}`);
      }
    }
  }
  check("every regime-profile key exists in CONFIG_MAP (no silent no-op on auto-apply)", allKeysKnown);
  if (!allKeysKnown) console.error("  unknown keys:", unknownKeys.join(", "));

  check("no regime ever uses 'curve' strategy", profiles.every((p) => p.changes.strategy !== "curve"));
  check("only bid_ask/spot strategies used", profiles.every((p) => ["bid_ask", "spot"].includes(p.changes.strategy)));

  const [slow, normal, hot] = profiles;
  check("stopLossPct ordering: slow tighter than normal tighter than hot", slow.changes.stopLossPct > normal.changes.stopLossPct && normal.changes.stopLossPct > hot.changes.stopLossPct);
  check("takeProfitPct ordering: slow < normal < hot", slow.changes.takeProfitPct < normal.changes.takeProfitPct && normal.changes.takeProfitPct < hot.changes.takeProfitPct);
  check("positionSizePct ordering: slow < normal < hot", slow.changes.positionSizePct < normal.changes.positionSizePct && normal.changes.positionSizePct < hot.changes.positionSizePct);
}

// ─── 3. classifyRegime return-domain ─────────────────────────────
section("classifyRegime() return-domain contract");
{
  const cases = [
    [],
    [{}],
    Array.from({ length: 10 }, () => ({})),
    Array.from({ length: 5 }, () => ({ active_tvl: NaN })),
    null,
    undefined,
  ];
  let allValid = true;
  for (const candidates of cases) {
    const result = classifyRegime(candidates);
    const validRegime = result.regime === null || ["slow", "normal", "hot"].includes(result.regime);
    const validScore = result.aggregateScore === null || (Number.isFinite(result.aggregateScore) && result.aggregateScore >= 0 && result.aggregateScore <= 100);
    const validSample = Number.isInteger(result.sampleSize) && result.sampleSize >= 0;
    if (!validRegime || !validScore || !validSample) allValid = false;
  }
  check("regime is always null/slow/normal/hot, score always null or [0,100], sampleSize always a non-negative int", allValid);
}

process.exit(suite.finish());
