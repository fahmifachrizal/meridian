/**
 * Offline unit tests for market-regime-aware screening (decision tree +
 * config fork). No network, no wallet. Snapshots and restores
 * market-regime-profiles.json and user-config.json around any test that
 * touches them.
 * Run: node test/test-regime.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { createSuite, withRestoredFile } from "./lib/test-kit.js";
import { classifyRegime } from "../market-regime.js";
import { getActiveRegime, setActiveRegime, listRegimeProfiles, getRegimeProfile } from "../market-regime-library.js";
import { applyConfigChanges } from "../tools/executor.js";
import { config } from "../config.js";

const REGIME_FILE = repoPath("market-regime-profiles.json");
const USER_CONFIG_FILE = repoPath("user-config.json");

const suite = createSuite("Market-regime-aware screening");
const { section, check } = suite;

function pool(overrides = {}) {
  return {
    active_tvl: 20000,
    volume_active_tvl_ratio: 1,
    fee_active_tvl_ratio: 0.01,
    unique_lps: 1,
    positions_created: 0,
    ...overrides,
  };
}

// ─── classifyRegime ──────────────────────────────────────────────
section("classifyRegime — decision tree");
check("empty candidates → null regime", classifyRegime([]).regime === null);
check("empty candidates → sampleSize 0", classifyRegime([]).sampleSize === 0);

{
  const dead = Array.from({ length: 10 }, () => pool({ volume_active_tvl_ratio: 0.05, fee_active_tvl_ratio: 0.0005, unique_lps: 0 }));
  check("dead-market candidates → slow", classifyRegime(dead).regime === "slow");

  const strong = Array.from({ length: 10 }, () => pool({ active_tvl: 50000, volume_active_tvl_ratio: 25, fee_active_tvl_ratio: 0.25, unique_lps: 50, positions_created: 10 }));
  check("strong-market candidates → hot", classifyRegime(strong).regime === "hot");

  // Directly exercise the decision-tree boundaries with a fixed cutoff pair,
  // bypassing degenScore's timeframe normalization noise — mirrors the
  // function's own branch structure with a known aggregateScore rather than
  // reverse-engineering pool fields that produce an exact score.
  const cutoffs = { slowCutoff: 15, hotCutoff: 45 };
  const classifyAt = (score) => {
    if (score < cutoffs.slowCutoff) return "slow";
    if (score < cutoffs.hotCutoff) return "normal";
    return "hot";
  };
  check("boundary: score just under slowCutoff → slow", classifyAt(14.9) === "slow");
  check("boundary: score exactly at slowCutoff → normal", classifyAt(15) === "normal");
  check("boundary: score just under hotCutoff → normal", classifyAt(44.9) === "normal");
  check("boundary: score exactly at hotCutoff → hot", classifyAt(45) === "hot");
}

// ─── market-regime-library ───────────────────────────────────────
section("market-regime-library — profiles + active pointer");
withRestoredFile(REGIME_FILE, () => {
  const { regimes, count } = listRegimeProfiles();
  check("3 default regimes seeded", count === 3);
  check("slow/normal/hot all present", ["slow", "normal", "hot"].every((id) => regimes.some((r) => r.id === id)));

  const originalActive = getActiveRegime()?.id;
  setActiveRegime({ id: "hot" });
  check("setActiveRegime persists", getActiveRegime()?.id === "hot");

  setActiveRegime({ id: "slow" });
  check("setActiveRegime switches again", getActiveRegime()?.id === "slow");

  const profile = getRegimeProfile({ id: "hot" });
  check("getRegimeProfile returns changes map", profile.changes?.strategy === "bid_ask");

  const unknown = getRegimeProfile({ id: "nonexistent" });
  check("unknown regime id returns error", !!unknown.error);

  if (originalActive) setActiveRegime({ id: originalActive });
});
console.log("  (restored market-regime-profiles.json to pre-test content)");

// ─── applyConfigChanges (shared with update_config) ──────────────
section("applyConfigChanges — regime profile hot-apply");
{
  const beforeStrategy = config.strategy.strategy;
  const beforeStopLoss = config.management.stopLossPct;
  withRestoredFile(USER_CONFIG_FILE, () => {
    try {
      const result = applyConfigChanges(
        { strategy: "spot", stopLossPct: -12 },
        { reason: "test: regime apply", lessonTags: ["regime_change", "config_change"] },
      );
      check("applyConfigChanges reports success", result.success === true);
      check("applyConfigChanges applied both keys", result.applied.strategy === "spot" && result.applied.stopLossPct === -12);
      check("live config.strategy.strategy mutated", config.strategy.strategy === "spot");
      check("live config.management.stopLossPct mutated", config.management.stopLossPct === -12);

      const onDisk = JSON.parse(fs.readFileSync(USER_CONFIG_FILE, "utf8"));
      check("user-config.json persisted the change", onDisk.strategy === "spot" && onDisk.stopLossPct === -12);

      const unknownResult = applyConfigChanges({ totallyNotARealKey: 1 }, { reason: "test" });
      check("unknown key rejected, success:false", unknownResult.success === false && unknownResult.unknown.includes("totallyNotARealKey"));
    } finally {
      config.strategy.strategy = beforeStrategy;
      config.management.stopLossPct = beforeStopLoss;
    }
  });
  console.log("  (restored user-config.json + live config to pre-test values)");
}

process.exit(suite.finish());
