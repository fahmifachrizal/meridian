#!/usr/bin/env node
/**
 * CLI report: evaluates a config against test/fixtures/benchmark-positions.json
 * and prints pnl_sol/pnl_usd metrics per position + aggregate, compared to
 * what actually happened historically.
 *
 * Usage:
 *   node scripts/evaluate-config.js                 # evaluates the live config (user-config.json + defaults)
 *   node scripts/evaluate-config.js path/to/cfg.json # evaluates a candidate config — merges onto the live
 *                                                     # config's screening/management sections (partial override)
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { config as liveConfig } from "../config.js";
import { evaluateConfig } from "../test/lib/benchmark-eval.js";

const candidatePath = process.argv[2];
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

const fixture = JSON.parse(fs.readFileSync(repoPath("test/fixtures/benchmark-positions.json"), "utf8"));
const poolMemory = JSON.parse(fs.readFileSync(repoPath("pool-memory.json"), "utf8"));

const result = evaluateConfig(cfg, fixture.positions, poolMemory);

const fmt = (n, decimals = 4) => (n >= 0 ? "+" : "") + n.toFixed(decimals);

console.log("Per-position:");
for (const r of result.positions) {
  const status = r.deployed
    ? `deployed @ ${r.sizeSol.toFixed(2)} SOL, pnl ${fmt(r.pnl_pct, 2)}% (${r.source}${r.rule ? ` rule ${r.rule}` : ""})`
    : `BLOCKED (${r.blockedBy.join(", ")})`;
  console.log(`  ${r.tag.padEnd(28)} ${r.pool_name.padEnd(18)} ${status.padEnd(55)} pnl_sol=${fmt(r.pnl_sol)} pnl_usd=$${fmt(r.pnl_usd, 2)}`);
}

console.log("\nAggregate (this config):");
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
