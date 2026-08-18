#!/usr/bin/env node
/**
 * CLI report: evaluates a config against test/fixtures/benchmark-positions.json
 * and prints pnl_sol/pnl_usd metrics per position + aggregate, compared to
 * what actually happened historically.
 *
 * Usage:
 *   node scripts/evaluate-config.js                          # evaluates the live config, 8-position curated fixture
 *   node scripts/evaluate-config.js path/to/cfg.json          # candidate config — merges onto the live
 *                                                              # config's screening/management sections (partial override)
 *   node scripts/evaluate-config.js --fixture=market          # same live config, against the ~300-position
 *                                                              # real-market-replay fixture instead (see
 *                                                              # scripts/build-market-benchmark-positions.js)
 *   node scripts/evaluate-config.js path/to/cfg.json --fixture=market   # both together
 *   node scripts/evaluate-config.js --headroom                # also applies the hardcoded
 *                                                                10% top-headroom (tools/dlmm.js)
 *                                                                to the price-replay exit
 *   node scripts/evaluate-config.js --fixture=market --compare-headroom
 *                                                              # runs the market fixture with AND
 *                                                              # without headroom, prints the diff —
 *                                                              # the Tier-2 cross-check (see
 *                                                              # test/lib/benchmark-eval.js's file
 *                                                              # header and CHANGELOG)
 *
 * The market fixture doesn't ship its own price_ohlcv_1m — it's merged in
 * here at runtime from scripts/data/pool-first-3days-ohlcv.json (built by
 * scripts/fetch-pool-first-days-ohlcv.js), which covers each pool's first
 * 3 days of life. Skipped automatically if that cache file isn't present.
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { config as liveConfig } from "../core/config.js";
import { evaluateConfig, attachPriceOhlcv } from "../test/lib/benchmark-eval.js";

const args = process.argv.slice(2);
const fixtureArg = args.find((a) => a.startsWith("--fixture="))?.split("=")[1];
const candidatePath = args.find((a) => !a.startsWith("--"));
const applyHeadroom = args.includes("--headroom");
const compareHeadroom = args.includes("--compare-headroom");

const FIXTURE_FILES = {
  default: "test/fixtures/benchmark-positions.json",
  market: "test/fixtures/market-benchmark-positions.json",
};
const fixturePath = FIXTURE_FILES[fixtureArg ?? "default"];
if (!fixturePath) {
  console.error(`Unknown --fixture value "${fixtureArg}" — expected one of: ${Object.keys(FIXTURE_FILES).join(", ")}`);
  process.exit(1);
}

let cfg = liveConfig;
if (candidatePath) {
  const overrides = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
  cfg = {
    ...liveConfig,
    screening: { ...liveConfig.screening, ...(overrides.screening ?? {}) },
    management: { ...liveConfig.management, ...(overrides.management ?? {}) },
  };
  console.log(`Evaluating candidate config: ${candidatePath}\n`);
} else {
  console.log("Evaluating the live config (user-config.json + defaults)\n");
}
console.log(`Fixture: ${fixturePath}\n`);

let positions = JSON.parse(fs.readFileSync(repoPath(fixturePath), "utf8")).positions;
const poolMemory = JSON.parse(fs.readFileSync(repoPath("pool-memory.json"), "utf8"));

const ohlcvCachePath = repoPath("scripts/data/pool-first-3days-ohlcv.json");
if (fs.existsSync(ohlcvCachePath)) {
  const ohlcvCache = JSON.parse(fs.readFileSync(ohlcvCachePath, "utf8"));
  const before = positions.filter((p) => p.price_ohlcv_1m).length;
  positions = attachPriceOhlcv(positions, ohlcvCache);
  const after = positions.filter((p) => p.price_ohlcv_1m).length;
  if (after > before) console.log(`Merged OHLCV cache: ${after - before} positions gained price_ohlcv_1m (${after}/${positions.length} total)\n`);
}

const fmt = (n, decimals = 4) => (n >= 0 ? "+" : "") + n.toFixed(decimals);

function printReport(result, label) {
  console.log(`Per-position${label ? ` (${label})` : ""}:`);
  const verbose = positions.length <= 20;
  if (verbose) {
    for (const r of result.positions) {
      const status = r.deployed
        ? `deployed @ ${r.sizeSol.toFixed(2)} SOL, pnl ${fmt(r.pnl_pct, 2)}% (${r.source}${r.rule ? ` rule ${r.rule}` : ""})`
        : `BLOCKED (${r.blockedBy.join(", ")})`;
      console.log(`  ${r.tag.padEnd(28)} ${r.pool_name.padEnd(18)} ${status.padEnd(55)} pnl_sol=${fmt(r.pnl_sol)} pnl_usd=$${fmt(r.pnl_usd, 2)}`);
    }
  } else {
    const bySource = {};
    for (const r of result.positions) {
      const key = r.deployed ? r.source : "blocked";
      bySource[key] = (bySource[key] ?? 0) + 1;
    }
    console.log(`  ${result.positions.length} positions — ${Object.entries(bySource).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
  }

  console.log("\nAggregate:");
  console.log(`  deployed: ${result.totals.deployed_count}/${result.positions.length}, blocked: ${result.totals.blocked_count}`);
  console.log(`  win rate (of deployed): ${(result.totals.win_rate * 100).toFixed(0)}%`);
  console.log(`  avg pnl_pct (of deployed): ${fmt(result.totals.avg_pnl_pct, 2)}%`);
  console.log(`  total_pnl_sol: ${fmt(result.totals.total_pnl_sol)} SOL`);
  console.log(`  total_pnl_usd: $${fmt(result.totals.total_pnl_usd, 2)}`);

  console.log("\nCompared to actual real-world history:");
  console.log(`  actual_total_pnl_sol: ${fmt(result.comparisonToActual.actual_total_pnl_sol)} SOL`);
  console.log(`  actual_total_pnl_usd: $${fmt(result.comparisonToActual.actual_total_pnl_usd, 2)}`);
  console.log(`  delta_pnl_sol: ${fmt(result.comparisonToActual.delta_pnl_sol)} SOL`);
  console.log(`  delta_pnl_usd: $${fmt(result.comparisonToActual.delta_pnl_usd, 2)}`);
}

if (compareHeadroom) {
  const noHeadroom = evaluateConfig(cfg, positions, poolMemory, { applyHeadroom: false });
  const withHeadroom = evaluateConfig(cfg, positions, poolMemory, { applyHeadroom: true });

  const byPosNo = new Map(noHeadroom.positions.map((r) => [r.pool_name + "|" + r.tag, r]));
  let rule3Changed = 0, pnlChanged = 0;
  for (const r of withHeadroom.positions) {
    const before = byPosNo.get(r.pool_name + "|" + r.tag);
    if (!before) continue;
    if (before.rule !== r.rule && (before.rule === 3 || r.rule === 3)) rule3Changed++;
    if (Math.abs((before.pnl_pct ?? 0) - (r.pnl_pct ?? 0)) > 1e-9) pnlChanged++;
  }

  printReport(noHeadroom, "no headroom");
  console.log("\n" + "=".repeat(70) + "\n");
  printReport(withHeadroom, "WITH 10% headroom");
  console.log("\n" + "=".repeat(70));
  console.log("\nHeadroom cross-check:");
  console.log(`  positions whose exit outcome changed at all: ${pnlChanged}`);
  console.log(`  positions where rule 3 (pumped-above) started/stopped firing: ${rule3Changed}`);
  console.log(`  total_pnl_usd: no-headroom $${fmt(noHeadroom.totals.total_pnl_usd, 2)} -> with-headroom $${fmt(withHeadroom.totals.total_pnl_usd, 2)} (delta ${fmt(withHeadroom.totals.total_pnl_usd - noHeadroom.totals.total_pnl_usd, 2)})`);
  console.log(`  total_pnl_sol: no-headroom ${fmt(noHeadroom.totals.total_pnl_sol)} -> with-headroom ${fmt(withHeadroom.totals.total_pnl_sol)} (delta ${fmt(withHeadroom.totals.total_pnl_sol - noHeadroom.totals.total_pnl_sol)})`);
} else {
  const result = evaluateConfig(cfg, positions, poolMemory, { applyHeadroom });
  printReport(result, applyHeadroom ? "10% top headroom applied" : null);
}
