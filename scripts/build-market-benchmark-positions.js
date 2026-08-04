/**
 * Builds test/fixtures/market-benchmark-positions.json — a much larger
 * companion to test/fixtures/benchmark-positions.json (8 hand-picked
 * positions) built from EVERY historical deploy this agent has ever made
 * (lessons.json's performance[]) that falls inside the pool's first 72h,
 * cross-referenced against the real continuous 1-minute price history
 * fetched into scripts/data/pool-first-3days-ohlcv.json.
 *
 * Unlike the original fixture (which stores each position's *actual*
 * recorded per-tick timeline from when the agent was really watching it),
 * this one *synthesizes* a timeline by walking the real market's price
 * candles forward from the reconstructed deploy point, at 10-minute steps
 * (matching config.schedule.managementIntervalMin's default), computing:
 *
 *   pnl_pct = (candle.close / entryClose - 1) * 100
 *   in_range = bin_step && bins_below known
 *       ? entryClose*(1+bin_step/10000)^-bins_below <= candle.close <= entryClose
 *       : null   (bins_above is always 0 for this agent's single-sided-SOL
 *                 deploys — see CLAUDE.md — so the position's upper bound
 *                 is always exactly the entry price)
 *
 * Same scope ceiling as the original fixture: only rules 1 (stop-loss), 2
 * (take-profit), and 4 (fast-exit) can ever fire from this synthetic
 * timeline (active_bin/upper_bin/fee_per_tvl_24h are unknowable from price
 * alone, so rules 3/5/6 never trip) — evaluateConfig() falls back to the
 * position's real historical outcome otherwise, exactly like the original.
 *
 * Run: node scripts/build-market-benchmark-positions.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";

const LESSONS_PATH = repoPath("lessons.json");
const POOL_MEMORY_PATH = repoPath("pool-memory.json");
const MARKET_DATA_PATH = repoPath("scripts/data/pool-first-3days-ohlcv.json");
const OUT_PATH = repoPath("test/fixtures/market-benchmark-positions.json");

const TICK_MINUTES = 10; // matches config.schedule.managementIntervalMin default
const ENTRY_CANDLE_TOLERANCE_MS = 20 * 60_000; // deploy must land within 20min of a real candle

function computeDeploySequence(poolMemory, poolAddress, closedAtIso) {
  const entry = poolMemory[poolAddress];
  if (!entry?.deploys) return null;
  const idx = entry.deploys.findIndex((d) => d.closed_at === closedAtIso);
  return idx === -1 ? null : idx + 1;
}

function nearestCandle(candles, targetMs) {
  let best = null, bestDiff = Infinity;
  for (const c of candles) {
    const diff = Math.abs(c.ts - targetMs);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  }
  return bestDiff <= ENTRY_CANDLE_TOLERANCE_MS ? best : null;
}

function buildTimeline(candles, deployedAtMs, entryClose, lowerPrice) {
  const horizonMs = deployedAtMs + 72 * 3600_000;
  const lastCandleMs = candles[candles.length - 1].ts;
  const endMs = Math.min(horizonMs, lastCandleMs);

  const timeline = [];
  let minutesOutOfRange = 0;
  for (let t = deployedAtMs; t <= endMs; t += TICK_MINUTES * 60_000) {
    const c = nearestCandle(candles, t);
    if (!c) continue;
    const pnlPct = ((c.close / entryClose) - 1) * 100;
    let inRange = null;
    if (lowerPrice != null) {
      inRange = c.close <= entryClose && c.close >= lowerPrice;
      minutesOutOfRange = inRange ? 0 : minutesOutOfRange + TICK_MINUTES;
    }
    timeline.push({
      ts: new Date(t).toISOString(),
      pnl_pct: Number(pnlPct.toFixed(4)),
      in_range: inRange,
      minutes_out_of_range: lowerPrice != null ? minutesOutOfRange : null,
      age_minutes: Math.round((t - deployedAtMs) / 60_000),
    });
  }
  return timeline;
}

function main() {
  const lessons = JSON.parse(fs.readFileSync(LESSONS_PATH, "utf8"));
  const poolMemory = JSON.parse(fs.readFileSync(POOL_MEMORY_PATH, "utf8"));
  const marketData = JSON.parse(fs.readFileSync(MARKET_DATA_PATH, "utf8"));
  const perf = lessons.performance || [];

  const positions = [];
  let skippedNoMarketData = 0, skippedNoEntryCandle = 0, skippedNoMinutesHeld = 0, skippedDegenerateValue = 0;

  for (const p of perf) {
    if (!p.minutes_held || p.minutes_held <= 0) { skippedNoMinutesHeld++; continue; }
    // A handful of historical rows recorded initial_value_usd:0 (a read
    // glitch on near-instant closes) — undefined to scale/divide by, so
    // exclude rather than let it propagate as NaN through evaluateConfig.
    if (!p.amount_sol || !p.initial_value_usd || p.initial_value_usd <= 0) { skippedDegenerateValue++; continue; }
    const market = marketData[p.pool];
    if (!market || market.error || !market.candles?.length) { skippedNoMarketData++; continue; }

    const deployedAtMs = new Date(p.recorded_at).getTime() - p.minutes_held * 60_000;
    const entryCandle = nearestCandle(market.candles, deployedAtMs);
    if (!entryCandle) { skippedNoEntryCandle++; continue; }

    const entryClose = entryCandle.close;
    const binStep = p.bin_step;
    const binsBelow = p.bin_range?.bins_below;
    const lowerPrice = binStep != null && binsBelow != null
      ? entryClose * Math.pow(1 + binStep / 10000, -binsBelow)
      : null;

    const timeline = buildTimeline(market.candles, deployedAtMs, entryClose, lowerPrice);
    const poolAgeHoursAtDeploy = market.pool_created_at != null ? (deployedAtMs - market.pool_created_at) / 3_600_000 : null;

    positions.push({
      tag: `market_${positions.length + 1}`,
      note: `${p.pool_name} — real market replay, actual outcome was ${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct}% (${p.close_reason})`,
      position: p.position,
      pool: p.pool,
      pool_name: p.pool_name,
      base_mint: p.base_mint,
      strategy: p.strategy,
      bin_range: p.bin_range ?? null,
      bin_step: binStep ?? null,
      amount_sol: p.amount_sol,
      entry: {
        mcap: p.entry_mcap,
        tvl: p.entry_tvl,
        volume: p.entry_volume,
        holders: p.entry_holders ?? null,
        volatility: p.volatility,
        fee_tvl_ratio: p.fee_tvl_ratio,
        organic_score: p.organic_score,
      },
      exit: {
        mcap: p.exit_mcap,
        tvl: p.exit_tvl,
        volume: p.exit_volume,
      },
      outcome: {
        pnl_pct: p.pnl_pct,
        pnl_usd: p.pnl_usd,
        initial_value_usd: p.initial_value_usd,
        final_value_usd: p.final_value_usd,
        fees_earned_usd: p.fees_earned_usd,
        range_efficiency: p.range_efficiency,
        minutes_held: p.minutes_held,
        close_reason: p.close_reason,
        recorded_at: p.recorded_at,
      },
      timeline,
      pool_created_at: market.pool_created_at,
      pool_age_hours_at_deploy: poolAgeHoursAtDeploy,
      deploy_sequence: computeDeploySequence(poolMemory, p.pool, p.recorded_at),
    });
  }

  const out = {
    generated_at: new Date().toISOString(),
    source_repo_files: ["lessons.json", "pool-memory.json", "scripts/data/pool-first-3days-ohlcv.json"],
    note:
      "Synthetic market-replay benchmark: every historical deploy (lessons.json performance[]) whose pool has real " +
      "GeckoTerminal 1-minute OHLCV covering the deploy point, walked forward at 10-minute steps. Unlike " +
      "benchmark-positions.json's 8 hand-picked positions with real recorded per-tick state, `timeline` here is " +
      "reconstructed from price alone — only rules 1/2/4 are replayable (see file header of " +
      "scripts/build-market-benchmark-positions.js). Use alongside, not instead of, benchmark-positions.json.",
    coverage: {
      total_performance_rows: perf.length,
      included: positions.length,
      skipped_no_minutes_held: skippedNoMinutesHeld,
      skipped_degenerate_value: skippedDegenerateValue,
      skipped_no_market_data: skippedNoMarketData,
      skipped_no_entry_candle: skippedNoEntryCandle,
    },
    positions,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`${positions.length}/${perf.length} performance rows included (skipped: ${skippedNoMinutesHeld} no minutes_held, ${skippedDegenerateValue} degenerate value, ${skippedNoMarketData} no market data, ${skippedNoEntryCandle} no entry candle within tolerance)`);
}

main();
