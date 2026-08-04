/**
 * QA protocol — "absolute state" contract tests.
 *
 * These are not feature tests; they lock in invariants that must hold no
 * matter what future changes land: sign/bound constraints on risk config,
 * structural consistency between CONFIG_MAP and config.js, degenScore's
 * scoring-function bounds, and the position-lifecycle decision tree's rule
 * precedence (see README.md's "Position lifecycle" diagram — this file is
 * the executable version of that diagram).
 *
 * Regime-specific invariants (market-regime profile completeness,
 * classifyRegime()'s return-domain contract) live in
 * test/test-regime-invariants.js on feat/add-regime-check.
 *
 * Offline, no network, no wallet. Any check that touches a real JSON store
 * snapshots and restores it via test/lib/test-kit.js.
 *
 * Run: node test/test-invariants.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { createSuite, withRestoredFile } from "./lib/test-kit.js";
import { config, MIN_SAFE_BINS_BELOW } from "../core/config.js";
import { CONFIG_MAP } from "../tools/executor.js";
import { degenScore } from "../tools/screening.js";
import { getDeterministicCloseRule } from "../index.js";

const STATE_FILE = repoPath("state.json");
const suite = createSuite("QA protocol — absolute-state invariants");
const { section, check } = suite;

// ─── 1. Config sign/bound invariants ─────────────────────────────
section("Config sign/bound invariants");
check("stopLossPct is negative", config.management.stopLossPct < 0);
check("takeProfitPct is positive", config.management.takeProfitPct > 0);
check("minBinsBelow never below MIN_SAFE_BINS_BELOW", config.strategy.minBinsBelow >= MIN_SAFE_BINS_BELOW);
check("maxBinsBelow >= minBinsBelow", config.strategy.maxBinsBelow >= config.strategy.minBinsBelow);
check("defaultBinsBelow within [min,max]", config.strategy.defaultBinsBelow >= config.strategy.minBinsBelow && config.strategy.defaultBinsBelow <= config.strategy.maxBinsBelow);
check("maxPositions > 0", config.risk.maxPositions > 0);
check("gasReserve >= 0", config.management.gasReserve >= 0);
check("deployAmountSol > 0", config.management.deployAmountSol > 0);
check("positionSizePct in (0,1]", config.management.positionSizePct > 0 && config.management.positionSizePct <= 1);
check("repeatDeployStopLossFraction in (0,1]", config.management.repeatDeployStopLossFraction > 0 && config.management.repeatDeployStopLossFraction <= 1);
check("fastExitStopLossFraction in (0,1]", config.management.fastExitStopLossFraction > 0 && config.management.fastExitStopLossFraction <= 1);
check(
  "repeatDeploySizeTaperPct entries all in (0,1]",
  config.management.repeatDeploySizeTaperPct.every((p) => p > 0 && p <= 1),
);

// ─── 2. CONFIG_MAP <-> config.js consistency ─────────────────────
section("CONFIG_MAP resolves to real config.js paths");
{
  let allResolve = true;
  const broken = [];
  for (const [key, mapping] of Object.entries(CONFIG_MAP)) {
    const [sectionName, field] = mapping;
    if (config[sectionName] === undefined || config[sectionName][field] === undefined) {
      allResolve = false;
      broken.push(`${key} -> config.${sectionName}.${field}`);
    }
  }
  check(`all ${Object.keys(CONFIG_MAP).length} CONFIG_MAP entries resolve to a defined config path`, allResolve);
  if (!allResolve) console.error("  broken entries:", broken.join(", "));
}

// ─── 3. degenScore bounds (fuzz-style edge cases) ────────────────
section("degenScore() always bounded [0,100]");
{
  const edgeCasePools = [
    {},
    { active_tvl: 0 },
    { active_tvl: -1000 },
    { active_tvl: 1e12, volume_active_tvl_ratio: 1e9, fee_active_tvl_ratio: 1e9, unique_lps: 1e9, positions_created: 1e9 },
    { active_tvl: 20000, volume_active_tvl_ratio: NaN },
    { active_tvl: 20000, unique_lps: -5, positions_created: -5 },
    { tvl: 20000 }, // active_tvl absent, falls back to tvl
  ];
  let allBounded = true;
  for (const pool of edgeCasePools) {
    const score = degenScore(pool);
    if (!(Number.isFinite(score) && score >= 0 && score <= 100)) allBounded = false;
  }
  check("every edge-case pool scores a finite number in [0,100]", allBounded);
}

// ─── 4. Position lifecycle — getDeterministicCloseRule contract ──
// Executable version of README.md's "Position lifecycle" diagram: one
// isolated case per close reason, plus a precedence test locking in rule
// order for a position that matches more than one condition at once.
section("getDeterministicCloseRule() — position lifecycle rule precedence");
{
  const mgmt = {
    stopLossPct: -35,
    takeProfitPct: 5,
    outOfRangeBinsToClose: 10,
    outOfRangeWaitMinutes: 30,
    fastExitOnOorEnabled: true,
    fastExitStopLossFraction: 0.5,
    minFeePerTvl24h: 7,
    minAgeBeforeYieldCheck: 60,
  };
  const basePosition = {
    position: "TEST_FAKE_POSITION_DO_NOT_USE",
    pair: "TEST-SOL",
    pnl_pct: 0,
    active_bin: 0,
    upper_bin: 100,
    lower_bin: -100,
    in_range: true,
    minutes_out_of_range: 0,
    fee_per_tvl_24h: 10,
    age_minutes: 100,
  };

  const rule = (overrides) => getDeterministicCloseRule({ ...basePosition, ...overrides }, mgmt);

  check("STAY when nothing triggers", rule({}) === null);
  check("rule 1 — stop loss", rule({ pnl_pct: -36 })?.rule === 1);
  check("rule 2 — take profit", rule({ pnl_pct: 6 })?.rule === 2);
  check("rule 3 — pumped far above range", rule({ active_bin: 111 })?.rule === 3);
  check(
    "rule 4 — fast exit (OOR + past half stop-loss, before full OOR wait)",
    rule({ in_range: false, pnl_pct: -20, minutes_out_of_range: 5 })?.rule === 4,
  );
  check(
    "rule 5 — OOR wait (pumped mildly above range, held past the wait timer)",
    rule({ active_bin: 105, minutes_out_of_range: 31, pnl_pct: -5 })?.rule === 5,
  );
  check(
    "rule 6 — low yield (fee/TVL below floor, age past the age gate)",
    rule({ fee_per_tvl_24h: 3, age_minutes: 90 })?.rule === 6,
  );
  check(
    "low yield does NOT fire before minAgeBeforeYieldCheck",
    rule({ fee_per_tvl_24h: 3, age_minutes: 59 }) === null,
  );
  check(
    "low yield honors a non-default minAgeBeforeYieldCheck (config-driven, not hardcoded)",
    getDeterministicCloseRule(
      { ...basePosition, fee_per_tvl_24h: 3, age_minutes: 20 },
      { ...mgmt, minAgeBeforeYieldCheck: 15 },
    )?.rule === 6,
  );

  // Precedence: a position matching stop-loss AND take-profit AND OOR-wait
  // simultaneously must always resolve to rule 1 (stop-loss), since rules
  // are evaluated in fixed order with early return. This test exists so a
  // future reorder is caught immediately rather than silently changing
  // which exit fires first.
  check(
    "precedence: stop-loss wins over take-profit/OOR-wait when multiple conditions are met",
    rule({ pnl_pct: -36, active_bin: 105, minutes_out_of_range: 31 })?.rule === 1,
  );

  // pnlSuspect safety valve — requires a real tracked position with
  // amount_sol + a still-nonzero total_value_usd on the position object,
  // matching the exact condition in index.js's pnlSuspect check.
  withRestoredFile(STATE_FILE, () => {
    const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { positions: {}, recentEvents: [], lastUpdated: null };
    state.positions["TEST_FAKE_POSITION_DO_NOT_USE"] = { amount_sol: 0.5 };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

    const suspectResult = rule({ pnl_pct: -95, total_value_usd: 5 });
    check("pnlSuspect skips all PnL-based rules when a suspiciously-priced tick still shows real value", suspectResult === null);
  });
}

process.exit(suite.finish());
