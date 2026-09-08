#!/usr/bin/env node
/**
 * One-time seed for token-deploy-count.json (see state/token-deploy-count.js
 * for why this file exists). Sums `deploys.length` across every
 * pool-memory.json entry that shares a base_mint — a token traded across
 * multiple pools (a relaunch, a pump.fun graduation into a new pool, ...)
 * gets its TRUE historical total, not just one pool's count.
 *
 * Safe to re-run: always recomputes from the full pool-memory.json history
 * and overwrites token-deploy-count.json entirely (see
 * seedTokenDeployCounts()'s own doc for why a partial merge would be wrong
 * here). After this runs once, state/pool-memory.js's recordPoolDeploy()
 * keeps the file accurate live — this script never needs to run again
 * under normal operation; it's here for the initial seed and as a repair
 * tool if the file is ever lost or suspected stale.
 *
 * Run: node scripts/backfill-token-deploy-counts.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { seedTokenDeployCounts } from "../state/token-deploy-count.js";

const poolMemoryPath = repoPath("pool-memory.json");
if (!fs.existsSync(poolMemoryPath)) {
  console.error(`${poolMemoryPath} not found — nothing to backfill from.`);
  process.exit(1);
}

const poolMemory = JSON.parse(fs.readFileSync(poolMemoryPath, "utf8"));

const counts = {};
let poolsWithoutBaseMint = 0;
for (const entry of Object.values(poolMemory)) {
  const baseMint = entry?.base_mint;
  const deployCount = Array.isArray(entry?.deploys) ? entry.deploys.length : Number(entry?.total_deploys ?? 0);
  if (!baseMint) {
    poolsWithoutBaseMint++;
    continue;
  }
  counts[baseMint] = (counts[baseMint] ?? 0) + deployCount;
}

const result = seedTokenDeployCounts(counts);

const tokenCount = Object.keys(result).length;
const totalDeploys = Object.values(result).reduce((s, e) => s + e.total_deploys, 0);
console.log(`Seeded token-deploy-count.json: ${tokenCount} distinct tokens, ${totalDeploys} total historical deploys.`);
if (poolsWithoutBaseMint > 0) {
  console.log(`(${poolsWithoutBaseMint} pool-memory.json entries had no base_mint and were skipped — those pools' deploys aren't attributable to any token.)`);
}

const top5 = Object.entries(result).sort((a, b) => b[1].total_deploys - a[1].total_deploys).slice(0, 5);
if (top5.length > 0) {
  console.log("\nMost-deployed tokens:");
  for (const [mint, e] of top5) console.log(`  ${mint.slice(0, 8)}...  ${e.total_deploys} deploys`);
}
