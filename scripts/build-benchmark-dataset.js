/**
 * One-off script: assembles a curated benchmark dataset of real historical
 * positions (3 known big losses + 5 diverse other outcomes) from this repo's
 * own recorded data (lessons.json, pool-memory.json, decision-log.json).
 *
 * This step does NOT include price OHLCV — Meteora's own pool OHLCV API
 * (dlmm.datapi.meteora.ag/pools/{pool}/ohlcv) only serves the current ~10
 * most-recent candles regardless of timeframe or start_time/end_time params,
 * so it can't reconstruct a past window on its own. Run
 * `node scripts/fetch-benchmark-ohlcv.js` afterward — it sources real
 * minute-level historical OHLCV from GeckoTerminal's public API instead
 * (verified to genuinely page into history via `before_timestamp`, unlike
 * Meteora's endpoint) and merges it into each position as `price_ohlcv_1m`.
 *
 * Also included per position regardless: the *actual* per-tick snapshots
 * this repo recorded live during each position's lifetime (pnl_pct /
 * in_range / unclaimed_fees_usd / minutes_out_of_range / age at ~10min
 * intervals) — already in the exact shape the deterministic close rules
 * consume, a useful complement to raw price for backtesting exit logic.
 *
 * Run: node scripts/build-benchmark-dataset.js
 * Output: test/fixtures/benchmark-positions.json
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";

const lessons = JSON.parse(fs.readFileSync(repoPath("lessons.json"), "utf8"));
const poolMemory = JSON.parse(fs.readFileSync(repoPath("pool-memory.json"), "utf8"));
const decisionLog = JSON.parse(fs.readFileSync(repoPath("decision-log.json"), "utf8"));

// position addresses to include, in priority order (3 big losses first)
const SELECTED = [
  { position: "64TJffd543owVv3nQqfuyCE5gTfiY6CS8m4QJMoJS2Qu", tag: "big_loss", note: "SalaryCat-SOL — 3rd same-day deploy, stop-loss" },
  { position: "4WGdh1UM7YPqJDicDPfNWL1GkEvQZcCGThhR1qTaG2Jn", tag: "big_loss", note: "WORM-SOL — 3rd same-day deploy, OOR crash" },
  { position: "Htg3cmNyCUod6uHJcypkdZ4UXN4UJU2XmHVyxFgLvzJq", tag: "big_loss", note: "Agamemnon-SOL — 2nd deploy, pool already past early window" },
  { position: "Fm9dXoH8uS7meXzNjTpji2QKTjqxoT7pzByQuZGZEPWB", tag: "win_pumped_above_range", note: "clean win, price ran away from range" },
  { position: "DC9YiyhgNLppAfTzkzJ3LZ4qaHeWrUDErwiM1iD691Xn", tag: "win_take_profit", note: "clean take-profit exit" },
  { position: "4LLYnCfc7R4fMRZbuCzGmwtNTcF7mhSZqnYombWtoAAy", tag: "win_trailing_tp", note: "trailing take-profit, high volatility pool" },
  { position: "2xeGPxdQiv2Rm9UZiYKTBeNzADtvJNwQ2GNMxwk9Ke31", tag: "small_loss_low_yield", note: "long hold, fee/TVL never cleared the floor" },
  { position: "AumGFFq81SzroEeQpkBQVKjBSz928QEv1F76sCKh97EA", tag: "small_loss_agent_decision", note: "closed by LLM judgment call, not a deterministic rule" },
];

const performanceByPosition = new Map(lessons.performance.map((p) => [p.position, p]));

function findPoolMemorySnapshots(poolAddress, positionAddress) {
  const entry = poolMemory[poolAddress];
  if (!entry?.snapshots) return [];
  return entry.snapshots.filter((s) => s.position === positionAddress);
}

function findDecisionLogEntries(positionAddress) {
  return decisionLog.decisions.filter((d) => d.position === positionAddress);
}

const benchmark = SELECTED.map(({ position, tag, note }) => {
  const perf = performanceByPosition.get(position);
  if (!perf) {
    console.warn(`WARNING: no performance record found for ${position}`);
    return { position, tag, note, error: "not found in lessons.json performance" };
  }
  const snapshots = findPoolMemorySnapshots(perf.pool, position);
  const decisions = findDecisionLogEntries(position);
  return {
    tag,
    note,
    position: perf.position,
    pool: perf.pool,
    pool_name: perf.pool_name,
    base_mint: perf.base_mint,
    strategy: perf.strategy,
    bin_range: perf.bin_range,
    bin_step: perf.bin_step,
    amount_sol: perf.amount_sol,
    entry: {
      mcap: perf.entry_mcap,
      tvl: perf.entry_tvl,
      volume: perf.entry_volume,
      holders: perf.entry_holders,
      volatility: perf.volatility,
      fee_tvl_ratio: perf.fee_tvl_ratio,
      organic_score: perf.organic_score,
    },
    exit: {
      mcap: perf.exit_mcap,
      tvl: perf.exit_tvl,
      volume: perf.exit_volume,
    },
    outcome: {
      pnl_pct: perf.pnl_pct,
      pnl_usd: perf.pnl_usd,
      // initial/final_value_usd let a config simulator convert a *replayed*
      // pnl_pct (under a different, hypothetical config) back into
      // pnl_usd/pnl_sol — see test/lib/benchmark-eval.js.
      initial_value_usd: perf.initial_value_usd,
      final_value_usd: perf.final_value_usd,
      fees_earned_usd: perf.fees_earned_usd,
      range_efficiency: perf.range_efficiency,
      minutes_held: perf.minutes_held,
      minutes_in_range: perf.minutes_in_range,
      close_reason: perf.close_reason,
      recorded_at: perf.recorded_at,
    },
    // Per-tick timeline as actually recorded live by the management cycle
    // (pnl_pct / in_range / unclaimed_fees_usd / minutes_out_of_range / age_minutes,
    // ~10min cadence) — complements price_ohlcv_1m (added by
    // fetch-benchmark-ohlcv.js) with the exact shape the deterministic
    // close rules consume.
    timeline: snapshots,
    // Matching deploy/close decision-log entries, where still retained
    // (decision-log.json is a rolling 100-entry log, so older positions
    // may have aged out).
    decisions,
  };
});

const outPath = repoPath("test/fixtures/benchmark-positions.json");
fs.mkdirSync(repoPath("test/fixtures"), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({
  generated_at: new Date().toISOString(),
  source_repo_files: ["lessons.json", "pool-memory.json", "decision-log.json"],
  note: "Run scripts/fetch-benchmark-ohlcv.js after this to add real minute-level price OHLCV (price_ohlcv_1m) from GeckoTerminal. `timeline` is the real per-tick pnl/in-range data this repo recorded live during each position's life.",
  positions: benchmark,
}, null, 2));

console.log(`Wrote ${benchmark.length} positions to ${outPath}`);
for (const b of benchmark) {
  console.log(`  ${b.tag}: ${b.pool_name} — pnl ${b.outcome?.pnl_pct}%, ${b.timeline?.length ?? 0} timeline ticks, ${b.decisions?.length ?? 0} decision-log entries`);
}
