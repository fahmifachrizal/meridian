/**
 * Config backtester — evaluates a candidate config against
 * test/fixtures/benchmark-positions.json's real historical positions and
 * reports what would have happened in pnl_sol / pnl_usd / pnl_pct.
 *
 * Scope: replays guard #1 (token-age window), guard #2 (repeat-deploy
 * cooldown), and guard #5 (repeat-deploy size taper + tightened stop-loss)
 * for the deploy-gate decision, and rules 1/2/4 of
 * getDeterministicCloseRule for the exit (via each position's recorded
 * `timeline`). Guards #3/#4/#7 are NOT replayed — they need
 * rejection/TVL-snapshot/pool-average history this fixture doesn't carry
 * meaningfully, and rules 3/5/6 can't fire from `timeline` (it lacks
 * active_bin/upper_bin/fee_per_tvl_24h) — a timeline that never trips
 * 1/2/4 falls back to the position's actual historical outcome. See
 * test/test-benchmark-eval.js and test/fixtures/README.md.
 */

import { getTokenAgeWindowRejectReason } from "../../guards/01-token-age-window.js";
import { getDeterministicCloseRule } from "../../index.js";

// Mirrors pool-memory.js's isFeeGeneratingDeploy — reimplemented here so
// this evaluator stays decoupled from that module's internals (same
// pattern used in test/test-benchmark.js).
function isFeeGenerating(deploy, minFeeEarnedPct) {
  const feesUsd = Number(deploy.fees_earned_usd ?? 0);
  const feesSol = Number(deploy.fees_earned_sol ?? 0);
  const hasFees = feesUsd > 0 || feesSol > 0;
  if (!hasFees) return false;
  return Number(deploy.fee_earned_pct ?? 0) >= minFeeEarnedPct;
}

/**
 * Would this position's deploy have been allowed under `cfg`, and at what
 * size / stop-loss? Replays guards #1, #2, #5.
 *
 * @returns {{ deploy: boolean, blockedBy: string[], sizeSol: number, stopLossOverride: number|null }}
 */
export function wouldDeployUnderConfig(cfg, position, poolMemory) {
  const blockedBy = [];

  // Guard #2 — repeat-deploy cooldown
  if (cfg.management.repeatDeployCooldownEnabled && position.deploy_sequence != null) {
    const triggerCount = cfg.management.repeatDeployCooldownTriggerCount;
    if (position.deploy_sequence > triggerCount) {
      const entry = poolMemory[position.pool];
      const priorDeploys = entry?.deploys?.slice(position.deploy_sequence - 1 - triggerCount, position.deploy_sequence - 1) ?? [];
      const minFeeEarnedPct = cfg.management.repeatDeployCooldownMinFeeEarnedPct ?? 0;
      if (priorDeploys.length >= triggerCount && priorDeploys.every((d) => isFeeGenerating(d, minFeeEarnedPct))) {
        blockedBy.push("repeat_deploy_cooldown");
      }
    }
  }

  // Guard #1 — token-age window
  if (position.pool_age_hours_at_deploy != null) {
    const fakeCreatedAt = Date.now() - position.pool_age_hours_at_deploy * 3_600_000;
    if (getTokenAgeWindowRejectReason(fakeCreatedAt, cfg.screening) !== null) {
      blockedBy.push("token_age_window");
    }
  }

  if (blockedBy.length > 0) {
    return { deploy: false, blockedBy, sizeSol: 0, stopLossOverride: null };
  }

  // Guard #5 — size taper + tightened stop-loss (only reached if not blocked)
  let sizeSol = position.amount_sol;
  let stopLossOverride = null;
  if (cfg.management.repeatDeploySizeTaperEnabled && position.pool_age_hours_at_deploy != null) {
    const earlyWindowHours = cfg.screening.tokenEarlyWindowMaxHours ?? 6;
    const priorDeployCount = (position.deploy_sequence ?? 1) - 1;
    if (priorDeployCount >= 1 && position.pool_age_hours_at_deploy <= earlyWindowHours) {
      const taperPct = cfg.management.repeatDeploySizeTaperPct ?? [0.6, 0.4];
      const taperIndex = Math.min(priorDeployCount - 1, taperPct.length - 1);
      const taperMultiplier = Number(taperPct[taperIndex] ?? taperPct[taperPct.length - 1]);
      const taperSizeCap = Math.max(0.1, cfg.management.deployAmountSol * taperMultiplier);
      if (sizeSol > taperSizeCap) sizeSol = taperSizeCap;
      stopLossOverride = cfg.management.stopLossPct * (cfg.management.repeatDeployStopLossFraction ?? 0.5);
    }
  }

  return { deploy: true, blockedBy: [], sizeSol, stopLossOverride };
}

/**
 * Replays a position's recorded `timeline` through getDeterministicCloseRule
 * using `mgmtConfig`. Only rules 1 (stop-loss), 2 (take-profit), and 4
 * (fast-exit) can ever fire — see file header. Falls back to the position's
 * actual historical outcome if nothing in the timeline trips a rule.
 *
 * @returns {{ pnl_pct: number, rule: number|null, reason: string, tick: object|null, source: "replay"|"historical_fallback" }}
 */
export function simulateExitUnderConfig(mgmtConfig, position, stopLossOverride) {
  for (const tick of position.timeline ?? []) {
    const fakePosition = {
      pnl_pct: tick.pnl_pct,
      in_range: tick.in_range,
      minutes_out_of_range: tick.minutes_out_of_range,
      active_bin: null,
      upper_bin: null,
      fee_per_tvl_24h: null,
      stop_loss_pct_override: stopLossOverride ?? null,
    };
    const result = getDeterministicCloseRule(fakePosition, mgmtConfig);
    if (result && [1, 2, 4].includes(result.rule)) {
      return { pnl_pct: tick.pnl_pct, rule: result.rule, reason: result.reason, tick, source: "replay" };
    }
  }
  return {
    pnl_pct: position.outcome.pnl_pct,
    rule: null,
    reason: position.outcome.close_reason,
    tick: null,
    source: "historical_fallback",
  };
}

/**
 * Full pipeline for one position: deploy gate -> exit replay -> SOL/USD
 * conversion. If the deploy would be blocked, contributes zero pnl (capital
 * never at risk).
 */
export function evaluatePosition(cfg, position, poolMemory) {
  const deployResult = wouldDeployUnderConfig(cfg, position, poolMemory);

  if (!deployResult.deploy) {
    return {
      pool_name: position.pool_name,
      tag: position.tag,
      deployed: false,
      blockedBy: deployResult.blockedBy,
      sizeSol: 0,
      pnl_pct: null,
      pnl_usd: 0,
      pnl_sol: 0,
      rule: null,
      source: "blocked",
    };
  }

  const exitResult = simulateExitUnderConfig(cfg.management, position, deployResult.stopLossOverride);
  const solPriceAtEntry = position.outcome.initial_value_usd / position.amount_sol;
  const scaledInitialValueUsd = position.outcome.initial_value_usd * (deployResult.sizeSol / position.amount_sol);
  const pnlUsd = (exitResult.pnl_pct / 100) * scaledInitialValueUsd;
  const pnlSol = pnlUsd / solPriceAtEntry;

  return {
    pool_name: position.pool_name,
    tag: position.tag,
    deployed: true,
    blockedBy: [],
    sizeSol: deployResult.sizeSol,
    pnl_pct: exitResult.pnl_pct,
    pnl_usd: pnlUsd,
    pnl_sol: pnlSol,
    rule: exitResult.rule,
    source: exitResult.source,
  };
}

/**
 * Aggregate metric across the whole benchmark: total pnl in SOL/USD, win
 * rate, and a comparison against what actually happened historically.
 */
export function evaluateConfig(cfg, positions, poolMemory) {
  const validPositions = positions.filter((p) => !p.error);
  const results = validPositions.map((p) => evaluatePosition(cfg, p, poolMemory));

  const deployedResults = results.filter((r) => r.deployed);
  const totalPnlSol = results.reduce((s, r) => s + r.pnl_sol, 0);
  const totalPnlUsd = results.reduce((s, r) => s + r.pnl_usd, 0);
  const wins = deployedResults.filter((r) => r.pnl_pct > 0).length;

  const actualTotalPnlUsd = validPositions.reduce((s, p) => s + p.outcome.pnl_usd, 0);
  const actualTotalPnlSol = validPositions.reduce((s, p) => {
    const solPrice = p.outcome.initial_value_usd / p.amount_sol;
    return s + p.outcome.pnl_usd / solPrice;
  }, 0);

  return {
    positions: results,
    totals: {
      total_pnl_sol: totalPnlSol,
      total_pnl_usd: totalPnlUsd,
      deployed_count: deployedResults.length,
      blocked_count: results.length - deployedResults.length,
      win_rate: deployedResults.length > 0 ? wins / deployedResults.length : 0,
      avg_pnl_pct: deployedResults.length > 0 ? deployedResults.reduce((s, r) => s + r.pnl_pct, 0) / deployedResults.length : 0,
    },
    comparisonToActual: {
      actual_total_pnl_usd: actualTotalPnlUsd,
      actual_total_pnl_sol: actualTotalPnlSol,
      delta_pnl_usd: totalPnlUsd - actualTotalPnlUsd,
      delta_pnl_sol: totalPnlSol - actualTotalPnlSol,
    },
  };
}
