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
 * meaningfully. A timeline that never trips 1/2/4 falls back to the
 * position's actual historical outcome. See test/test-benchmark-eval.js
 * and test/fixtures/README.md.
 *
 * Tier 1 extension (rules 3/5, the OOR rules): `timeline` alone can't
 * replay these — it has no active_bin/upper_bin. `deriveBinTimeline()`
 * reconstructs a per-minute active_bin series from the fixture's real
 * `price_ohlcv_1m` data instead, anchored on the fact that every one of
 * these single-sided-SOL deploys had `bins_above: 0` at deploy time — so
 * `bin_range.max` IS the active bin at the moment of deploy, no separate
 * price/bin anchor needed. Deploy time itself is derived from the first
 * timeline tick (`ts - age_minutes`), and active_bin at each later candle
 * is walked forward via the standard DLMM bin-price formula,
 * `price_ratio = (1 + bin_step/10000) ^ bin_delta`. This is still a
 * simplification, not a full replay: pnl_pct at each derived tick is
 * *interpolated* from the sparse recorded `timeline` (DLMM mark-to-market
 * isn't a pure function of spot price, so this doesn't recompute pnl from
 * bin composition) — good enough to answer "would this rule have fired
 * sooner/later," not to produce an independently-verified pnl curve.
 * `simulateExitWithPriceReplay()` uses this when a position has usable
 * `bin_step`/`price_ohlcv_1m` (7 of the 8 fixture positions; OGDOGE-SOL
 * has `bin_step: null` and falls back to `simulateExitUnderConfig`).
 *
 * Tier 2 (larger sample): the curated 8-position fixture is too small,
 * and too dominated by deploy-gate blocking, to show the headroom's
 * effect in an aggregate number (see CHANGELOG). `attachPriceOhlcv()`
 * merges real per-pool OHLCV — fetched separately by
 * scripts/fetch-pool-first-days-ohlcv.js into
 * scripts/data/pool-first-3days-ohlcv.json, covering each pool's first 3
 * days of life — onto test/fixtures/market-benchmark-positions.json's 316
 * positions, which don't ship with `price_ohlcv_1m` of their own. Every
 * position with a usable `bin_step` in that fixture also has
 * `pool_age_hours_at_deploy <= 72`, so the 3-day cache always covers its
 * deploy window — verified, not assumed (see scripts/evaluate-config.js's
 * `--fixture=market` path). `deriveBinTimeline()`'s anchor-distance guard
 * (below) is the runtime backstop for that assumption on any future
 * position where it doesn't hold.
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
 * Merges cached per-pool OHLCV (scripts/data/pool-first-3days-ohlcv.json's
 * shape: `{ [poolAddress]: { candles: [{ts, close, volume}], error? } }`)
 * onto a positions array as `price_ohlcv_1m`, non-destructively (returns
 * new position objects; the cache and input array are untouched). Positions
 * with no cache entry, an errored entry, or an empty candle list are
 * returned unchanged — deriveBinTimeline()'s own guards handle the
 * resulting missing/insufficient `price_ohlcv_1m` the same way as any
 * other fixture position that never had it.
 */
export function attachPriceOhlcv(positions, ohlcvCache) {
  return positions.map((p) => {
    const entry = ohlcvCache[p.pool];
    if (!entry || entry.error || !Array.isArray(entry.candles) || entry.candles.length === 0) return p;
    return { ...p, price_ohlcv_1m: entry.candles };
  });
}

/**
 * Reconstructs a per-minute active_bin series for `position` from its real
 * `price_ohlcv_1m` candles, anchored on `bin_range.max` == the active bin
 * at deploy time (true for every fixture position: `bins_above: 0`
 * historically). Returns null when the position lacks the data needed
 * (`bin_step`, a non-empty `price_ohlcv_1m`, or a `timeline` to derive the
 * deploy timestamp from) — callers should fall back to
 * `simulateExitUnderConfig` in that case.
 *
 * `binsAboveOverride`, when given, replaces the position's historical
 * `bin_range.bins_above` (always 0 in this fixture) — this is how a
 * candidate config's headroom (e.g. the 10% top headroom added in
 * tools/dlmm.js) gets tested against real price paths: it shifts
 * `upper_bin` without changing anything else about the replay.
 */
/**
 * Deploy timestamp derived from the first recorded timeline tick
 * (`ts - age_minutes`) — the same derivation deriveBinTimeline() uses
 * internally, factored out so callers that need "minutes held" (e.g. the
 * OOR-tightening backtest) don't duplicate it.
 */
export function getDeployTimestamp(position) {
  const firstTick = position.timeline?.[0];
  if (!firstTick) return null;
  return new Date(firstTick.ts).getTime() - (firstTick.age_minutes ?? 0) * 60_000;
}

export function deriveBinTimeline(position, { binsAboveOverride } = {}) {
  const binStep = position.bin_step;
  const binRange = position.bin_range;
  const candles = position.price_ohlcv_1m;
  const timeline = position.timeline;
  if (!binStep || !binRange || !Array.isArray(candles) || candles.length === 0 || !Array.isArray(timeline) || timeline.length === 0) {
    return null;
  }

  const deployTs = getDeployTimestamp(position);

  let anchorCandle = candles[0];
  let anchorDiff = Math.abs(candles[0].ts - deployTs);
  for (const c of candles) {
    const diff = Math.abs(c.ts - deployTs);
    if (diff < anchorDiff) {
      anchorCandle = c;
      anchorDiff = diff;
    }
  }
  // The anchor assumes `bin_range.max` was the active bin AT deploy time —
  // only true if a candle actually exists near deploy_ts. A candle set
  // that doesn't cover the deploy window (e.g. only a pool's first 3 days
  // fetched, but this position's deploy_sequence put its actual deploy
  // later) would silently anchor on a stale/irrelevant price and produce
  // a meaningless active_bin series. Bail rather than guess.
  const ANCHOR_TOLERANCE_MS = 30 * 60_000;
  if (anchorDiff > ANCHOR_TOLERANCE_MS) return null;
  const priceAtDeploy = anchorCandle.close;
  if (!priceAtDeploy || priceAtDeploy <= 0) return null;

  const logStep = Math.log(1 + binStep / 10_000);
  const upperBin = binRange.max + (binsAboveOverride ?? binRange.bins_above ?? 0);

  let outOfRangeSinceTs = null;
  const ticks = [];
  for (const c of candles) {
    if (c.ts < deployTs) continue;
    const price = c.close;
    if (!price || price <= 0) continue;
    const activeBin = binRange.max + Math.round(Math.log(price / priceAtDeploy) / logStep);
    const inRange = activeBin <= upperBin;
    if (!inRange) {
      if (outOfRangeSinceTs == null) outOfRangeSinceTs = c.ts;
    } else {
      outOfRangeSinceTs = null;
    }
    const minutesOutOfRange = outOfRangeSinceTs != null ? (c.ts - outOfRangeSinceTs) / 60_000 : 0;
    ticks.push({ ts: c.ts, active_bin: activeBin, upper_bin: upperBin, in_range: inRange, minutes_out_of_range: minutesOutOfRange });
  }
  return ticks;
}

// Linear interpolation of the sparse recorded pnl_pct timeline onto an
// arbitrary timestamp — clamped to the first/last recorded value outside
// the recorded range.
function interpolatePnlPct(pnlTimeline, ts) {
  if (!pnlTimeline || pnlTimeline.length === 0) return null;
  const points = pnlTimeline.map((t) => ({ t: new Date(t.ts).getTime(), pnl_pct: t.pnl_pct }));
  if (ts <= points[0].t) return points[0].pnl_pct;
  const last = points[points.length - 1];
  if (ts >= last.t) return last.pnl_pct;
  for (let i = 0; i < points.length - 1; i++) {
    if (ts >= points[i].t && ts <= points[i + 1].t) {
      const span = points[i + 1].t - points[i].t;
      const frac = span > 0 ? (ts - points[i].t) / span : 0;
      return points[i].pnl_pct + frac * (points[i + 1].pnl_pct - points[i].pnl_pct);
    }
  }
  return last.pnl_pct;
}

/**
 * Exit replay using the derived per-minute active_bin series (rules
 * 1/2/3/4/5 all reachable) when the position has usable price/bin data;
 * falls back to `simulateExitUnderConfig` (rules 1/2/4 only, off the
 * coarse recorded `timeline`) otherwise.
 *
 * `outOfRangeBinsToCloseOverride`, when given, replaces
 * `mgmtConfig.outOfRangeBinsToClose` for this replay only (the live config
 * object is never mutated) — this is how the volatility-tiered
 * OOR-tightening backtest tests a tighter rule-3 buffer for specific
 * positions without changing every other position's evaluation.
 *
 * Every result also carries `minutes_held`: for a `price_replay` exit,
 * the real elapsed time from deploy to the triggering candle
 * (`(tick.ts - deployTs) / 60000`) — the actual metric a capital-velocity
 * comparison needs. Falls back to the position's real recorded
 * `minutes_held` for a historical-fallback result, since nothing new was
 * detected in that case.
 */
export function simulateExitWithPriceReplay(mgmtConfig, position, stopLossOverride, { binsAboveOverride, outOfRangeBinsToCloseOverride } = {}) {
  const effectiveConfig = outOfRangeBinsToCloseOverride != null
    ? { ...mgmtConfig, outOfRangeBinsToClose: outOfRangeBinsToCloseOverride }
    : mgmtConfig;

  const binTicks = deriveBinTimeline(position, { binsAboveOverride });
  if (!binTicks || binTicks.length === 0) {
    const fallback = simulateExitUnderConfig(effectiveConfig, position, stopLossOverride);
    return { ...fallback, minutes_held: fallback.tick?.age_minutes ?? position.outcome.minutes_held };
  }

  const deployTs = getDeployTimestamp(position);
  for (const tick of binTicks) {
    const pnlPct = interpolatePnlPct(position.timeline, tick.ts);
    const fakePosition = {
      pnl_pct: pnlPct,
      in_range: tick.in_range,
      minutes_out_of_range: tick.minutes_out_of_range,
      active_bin: tick.active_bin,
      upper_bin: tick.upper_bin,
      fee_per_tvl_24h: null,
      stop_loss_pct_override: stopLossOverride ?? null,
    };
    const result = getDeterministicCloseRule(fakePosition, effectiveConfig);
    if (result && [1, 2, 3, 4, 5].includes(result.rule)) {
      const minutesHeld = deployTs != null ? (tick.ts - deployTs) / 60_000 : position.outcome.minutes_held;
      return { pnl_pct: pnlPct, rule: result.rule, reason: result.reason, tick, source: "price_replay", minutes_held: minutesHeld };
    }
  }
  return {
    pnl_pct: position.outcome.pnl_pct,
    rule: null,
    reason: position.outcome.close_reason,
    tick: null,
    source: "historical_fallback",
    minutes_held: position.outcome.minutes_held,
  };
}

/**
 * Full pipeline for one position: deploy gate -> exit replay -> SOL/USD
 * conversion. If the deploy would be blocked, contributes zero pnl (capital
 * never at risk).
 *
 * `opts.applyHeadroom: true` computes the candidate config's 10% top
 * headroom (tools/dlmm.js: bins_above = round(round(bins_below*1.10)*0.10))
 * from the position's historical `bin_range.bins_below` and passes it into
 * the price replay as `binsAboveOverride` — the only way to test that
 * change against real price paths, since it's a hardcoded deploy-time
 * calculation, not a config key.
 *
 * `opts.oorTighten: { volatilityThreshold, tightenedBins }` — for a
 * position whose recorded `entry.volatility` exceeds `volatilityThreshold`,
 * replays rule 3 with `outOfRangeBinsToClose` set to `tightenedBins`
 * instead of the config's own value. Stays entirely within single-sided-SOL
 * (no bins_above/token-exposure change) — this only affects how soon an
 * already-out-of-range position's exit fires. See CHANGELOG's OOR
 * pumped-above-range analysis for why this is scoped to high-volatility
 * candidates specifically, not applied globally.
 */
export function evaluatePosition(cfg, position, poolMemory, opts = {}) {
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
      minutes_held: null,
    };
  }

  let binsAboveOverride;
  if (opts.applyHeadroom && position.bin_range?.bins_below != null) {
    const paddedBinsBelow = Math.round(position.bin_range.bins_below * 1.1);
    binsAboveOverride = Math.round(paddedBinsBelow * 0.1);
  }

  let outOfRangeBinsToCloseOverride;
  if (opts.oorTighten) {
    const volatility = Number(position.entry?.volatility);
    if (Number.isFinite(volatility) && volatility > opts.oorTighten.volatilityThreshold) {
      outOfRangeBinsToCloseOverride = opts.oorTighten.tightenedBins;
    }
  }

  const exitResult = simulateExitWithPriceReplay(cfg.management, position, deployResult.stopLossOverride, { binsAboveOverride, outOfRangeBinsToCloseOverride });
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
    minutes_held: exitResult.minutes_held,
    tightened: outOfRangeBinsToCloseOverride != null,
  };
}

/**
 * Aggregate metric across the whole benchmark: total pnl in SOL/USD, win
 * rate, and a comparison against what actually happened historically.
 *
 * `opts.applyHeadroom: true` — see evaluatePosition().
 */
export function evaluateConfig(cfg, positions, poolMemory, opts = {}) {
  const validPositions = positions.filter((p) => !p.error);
  const results = validPositions.map((p) => evaluatePosition(cfg, p, poolMemory, opts));

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
      avg_minutes_held: (() => {
        const withHold = deployedResults.filter((r) => Number.isFinite(r.minutes_held));
        return withHold.length > 0 ? withHold.reduce((s, r) => s + r.minutes_held, 0) / withHold.length : null;
      })(),
    },
    comparisonToActual: {
      actual_total_pnl_usd: actualTotalPnlUsd,
      actual_total_pnl_sol: actualTotalPnlSol,
      delta_pnl_usd: totalPnlUsd - actualTotalPnlUsd,
      delta_pnl_sol: totalPnlSol - actualTotalPnlSol,
    },
  };
}
