/**
 * TDD spec for test/lib/benchmark-eval.js — the config backtester that
 * answers "how would a candidate config have performed against these real
 * historical positions?" in pnl_sol / pnl_usd / pnl_pct.
 *
 * Written BEFORE the implementation exists (red phase) — every expected
 * number here was hand-computed from test/fixtures/benchmark-positions.json
 * and the live config's actual defaults, not reverse-engineered from
 * whatever the implementation happens to produce.
 *
 * Scope (documented, not hidden): the evaluator replays guard #1
 * (repeat-deploy cooldown), guard #6 (token-age window), and guard #7
 * (repeat-deploy size taper + tightened stop-loss) for the deploy-gate
 * decision, and rules 1/2/6 of getDeterministicCloseRule for the exit
 * (via each position's recorded `timeline` — rules 3/4/5 need
 * active_bin/upper_bin/fee_per_tvl_24h, not captured historically, so a
 * timeline that never trips 1/2/6 falls back to the position's actual
 * historical pnl_pct/close_reason). Guards #2/#3/#5 are NOT replayed —
 * they need rejection/TVL-snapshot/pool-average history this fixture
 * doesn't carry meaningfully. This is intentionally the same fidelity
 * ceiling documented for test/test-benchmark.js.
 *
 * Run: node test/test-benchmark-eval.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { createSuite } from "./lib/test-kit.js";
import { config as liveConfig } from "../config.js";
import {
  wouldDeployUnderConfig,
  simulateExitUnderConfig,
  evaluatePosition,
  evaluateConfig,
} from "./lib/benchmark-eval.js";

const fixture = JSON.parse(fs.readFileSync(repoPath("test/fixtures/benchmark-positions.json"), "utf8"));
const poolMemory = JSON.parse(fs.readFileSync(repoPath("pool-memory.json"), "utf8"));
const positionByPool = (name) => fixture.positions.find((p) => p.pool_name === name);

const suite = createSuite("Benchmark config evaluator (TDD spec)");
const { section, check } = suite;

function approx(a, b, tolerance = 0.01) {
  return Math.abs(a - b) <= tolerance;
}

/**
 * PINNED config for the per-rule logic assertions below.
 *
 * These expectations are hand-computed arithmetic on specific thresholds
 * (e.g. "guard #7 halves the stop-loss" → -35 × 0.5 = -17.5). Reading those
 * thresholds from the LIVE config made the suite fail every time the operator
 * legitimately retuned their risk settings — a false alarm that says nothing
 * about whether the evaluator's logic is correct. Pinning them here keeps
 * these tests measuring behaviour instead of current preference.
 *
 * Whether the operator's ACTUAL live config is safe is a separate question,
 * asserted value-independently by the comparisonToActual section at the end,
 * which still runs against liveConfig.
 */
const BENCH_CONFIG = {
  ...liveConfig,
  management: {
    ...liveConfig.management,
    deployAmountSol: 0.6,
    stopLossPct: -35,
    repeatDeployCooldownEnabled: true,
    repeatDeployCooldownTriggerCount: 2,
    repeatDeployCooldownHours: 12,
    repeatDeploySizeTaperEnabled: true,
    repeatDeploySizeTaperPct: [0.6, 0.4],
    repeatDeployStopLossFraction: 0.5,
    fastExitOnOorEnabled: true,
    fastExitStopLossFraction: 0.5,
  },
  screening: {
    ...liveConfig.screening,
    tokenAgeWindowEnabled: true,
    tokenEarlyWindowMaxHours: 6,
    tokenCooldownHours: 24,
  },
};

// ─── wouldDeployUnderConfig ───────────────────────────────────────
section("wouldDeployUnderConfig — deploy gate (guards #1/#6/#7)");
{
  const salaryCat = positionByPool("SalaryCat-SOL");

  const currentResult = wouldDeployUnderConfig(BENCH_CONFIG, salaryCat, poolMemory);
  check("SalaryCat blocked under current config", currentResult.deploy === false);
  check("blockedBy includes repeat_deploy_cooldown", currentResult.blockedBy.includes("repeat_deploy_cooldown"));
  check("blockedBy includes token_age_window", currentResult.blockedBy.includes("token_age_window"));
  check("sizeSol is 0 when blocked", currentResult.sizeSol === 0);

  const permissiveConfig = {
    ...BENCH_CONFIG,
    management: { ...BENCH_CONFIG.management, repeatDeployCooldownEnabled: false, repeatDeploySizeTaperEnabled: false },
    screening: { ...BENCH_CONFIG.screening, tokenAgeWindowEnabled: false },
  };
  const permissiveResult = wouldDeployUnderConfig(permissiveConfig, salaryCat, poolMemory);
  check("SalaryCat allowed when all 3 guards disabled", permissiveResult.deploy === true);
  check("blockedBy is empty when allowed", permissiveResult.blockedBy.length === 0);
  check("sizeSol unchanged (0.6) with taper disabled", permissiveResult.sizeSol === 0.6);
  check("stopLossOverride is null with taper disabled", permissiveResult.stopLossOverride == null);

  const rako = positionByPool("RAKO-SOL");
  const rakoResult = wouldDeployUnderConfig(BENCH_CONFIG, rako, poolMemory);
  check("RAKO (seq=2, pool age 5.11h) not blocked by guard #1 or #6", rakoResult.deploy === true && rakoResult.blockedBy.length === 0);
  check("RAKO size tapered to 0.36 SOL by guard #7 (2nd deploy, still in early window)", approx(rakoResult.sizeSol, 0.36, 0.001));
  check("RAKO stop-loss tightened to -17.5% by guard #7", approx(rakoResult.stopLossOverride, -17.5, 0.001));
}

// ─── simulateExitUnderConfig ──────────────────────────────────────
section("simulateExitUnderConfig — exit replay via timeline");
{
  const worm = positionByPool("WORM-SOL");
  const wormExit = simulateExitUnderConfig(BENCH_CONFIG.management, worm, null);
  check("WORM replay fires rule 6 (fast-exit)", wormExit.rule === 6);
  check("WORM replay source is 'replay', not fallback", wormExit.source === "replay");
  check("WORM replay pnl_pct matches the -29.7% tick", approx(wormExit.pnl_pct, -29.7, 0.01));
  check("WORM replay fires at age 29m — 16 minutes before the real -44.21% close", wormExit.tick.age_minutes === 29);

  const rako = positionByPool("RAKO-SOL");
  const rakoExit = simulateExitUnderConfig(BENCH_CONFIG.management, rako, null);
  check("RAKO timeline never crosses a replayable rule — falls back to historical", rakoExit.source === "historical_fallback");
  check("RAKO fallback pnl_pct matches actual recorded outcome", approx(rakoExit.pnl_pct, 5.94, 0.01));
}

// ─── evaluatePosition — full per-position pipeline, pnl_sol/pnl_usd ──
section("evaluatePosition — deploy + exit + SOL/USD conversion");
{
  const worm = positionByPool("WORM-SOL");
  // Isolate the exit-replay improvement from the deploy-gate: guard #1
  // would otherwise block WORM's 3rd deploy entirely (pnl=0). Disabling it
  // here demonstrates guard #4 (fast-exit)'s benefit specifically, in
  // dollar terms — not just direction.
  const guard4OnlyConfig = {
    ...BENCH_CONFIG,
    management: { ...BENCH_CONFIG.management, repeatDeployCooldownEnabled: false, repeatDeploySizeTaperEnabled: false },
  };
  const wormEval = evaluatePosition(guard4OnlyConfig, worm, poolMemory);
  check("WORM deployed under guard-4-only config", wormEval.deployed === true);
  check("WORM simulated pnl_usd ≈ -13.16 (vs actual -19.60)", approx(wormEval.pnl_usd, -13.163, 0.01));
  check("WORM simulated pnl_sol ≈ -0.178", approx(wormEval.pnl_sol, -0.1782, 0.001));
  check("WORM simulation is a real improvement over actual history", wormEval.pnl_usd > worm.outcome.pnl_usd);

  const rako = positionByPool("RAKO-SOL");
  const rakoEval = evaluatePosition(BENCH_CONFIG, rako, poolMemory);
  check("RAKO deployed at tapered size under current config", rakoEval.deployed === true && approx(rakoEval.sizeSol, 0.36, 0.001));
  check("RAKO simulated pnl_usd ≈ 1.58 (scaled down from actual 2.63 by the taper)", approx(rakoEval.pnl_usd, 1.5802, 0.01));
  check("RAKO simulated pnl_sol ≈ 0.0214", approx(rakoEval.pnl_sol, 0.021384, 0.001));

  const salaryCat = positionByPool("SalaryCat-SOL");
  const salaryCatEval = evaluatePosition(BENCH_CONFIG, salaryCat, poolMemory);
  check("SalaryCat blocked under current config -> zero pnl, capital never at risk", salaryCatEval.deployed === false && salaryCatEval.pnl_usd === 0 && salaryCatEval.pnl_sol === 0);
}

// ─── evaluateConfig — aggregate metric across the whole benchmark ───
section("evaluateConfig — aggregate metrics + comparison to real history");
{
  const result = evaluateConfig(liveConfig, fixture.positions, poolMemory);
  check("returns one result per non-error position", result.positions.length === fixture.positions.filter((p) => !p.error).length);
  check("totals include total_pnl_sol", Number.isFinite(result.totals.total_pnl_sol));
  check("totals include total_pnl_usd", Number.isFinite(result.totals.total_pnl_usd));
  check("totals include deployed_count and blocked_count summing to total", result.totals.deployed_count + result.totals.blocked_count === result.positions.length);
  check("totals include win_rate as a 0..1 fraction", result.totals.win_rate >= 0 && result.totals.win_rate <= 1);
  check("comparisonToActual reports actual_total_pnl_usd from real history", Number.isFinite(result.comparisonToActual.actual_total_pnl_usd));
  check(
    "the 3 known big losses are blocked/mitigated -> current config's total_pnl_usd beats actual real-world history",
    result.totals.total_pnl_usd > result.comparisonToActual.actual_total_pnl_usd,
  );
}

process.exit(suite.finish());
