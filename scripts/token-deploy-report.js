#!/usr/bin/env node
/**
 * Read-only report over token-deploy-count.json (see
 * state/token-deploy-count.js for what the file is and how it's kept
 * live). Two sections:
 *
 *   1. Top tokens by total historical deploy count.
 *   2. Repeat-deploy-cooldown taper projection — how many tokens would
 *      currently fall into each effective cooldown-hours bucket, using
 *      the taper formula in state/pool-memory.js against the LIVE config
 *      (config.management.repeatDeployCooldown*). Shown regardless of
 *      whether repeatDeployCooldownTaperEnabled is currently true or
 *      false — this is a projection of what the taper WOULD do, not a
 *      readout of live behavior.
 *
 * Never writes anything. Run: node scripts/token-deploy-report.js
 * [--top=N]
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { config } from "../core/config.js";

const topN = Number((process.argv.find((a) => a.startsWith("--top=")) || "--top=10").split("=")[1]) || 10;

const filePath = repoPath("token-deploy-count.json");
if (!fs.existsSync(filePath)) {
  console.error(`${filePath} not found. Run: node scripts/backfill-token-deploy-counts.js`);
  process.exit(1);
}

const db = JSON.parse(fs.readFileSync(filePath, "utf8"));
const entries = Object.entries(db);

const totalTokens = entries.length;
const totalDeploys = entries.reduce((s, [, e]) => s + Number(e.total_deploys ?? 0), 0);

console.log(`token-deploy-count.json: ${totalTokens} distinct tokens, ${totalDeploys} total historical deploys.\n`);

console.log(`Top ${topN} tokens by deploy count:`);
const top = [...entries].sort((a, b) => b[1].total_deploys - a[1].total_deploys).slice(0, topN);
for (const [mint, e] of top) {
  console.log(`  ${mint.slice(0, 8)}...  ${e.total_deploys} deploys  (last: ${e.last_updated})`);
}

// Same taper formula as state/pool-memory.js's recordPoolDeploy() —
// kept in sync manually since it's simple/pure; if that formula ever
// changes, update this copy too.
const cooldownHours = Number(config.management.repeatDeployCooldownHours ?? 12);
const decrementHours = Number(config.management.repeatDeployCooldownTaperDecrementHours ?? 4);
const everyNDeploys = Math.max(1, Number(config.management.repeatDeployCooldownTaperEveryNDeploys ?? 4));
const minHours = Number(config.management.repeatDeployCooldownTaperMinHours ?? 0);

const buckets = new Map();
for (const [, e] of entries) {
  const total = Number(e.total_deploys ?? 0);
  const decrementSteps = Math.floor(Math.max(0, total - 1) / everyNDeploys);
  const effectiveHours = Math.max(minHours, cooldownHours - decrementSteps * decrementHours);
  buckets.set(effectiveHours, (buckets.get(effectiveHours) ?? 0) + 1);
}

console.log(
  `\nRepeat-deploy cooldown taper projection (base ${cooldownHours}h, -${decrementHours}h every ${everyNDeploys} deploys, floor ${minHours}h)` +
    ` — taperEnabled is currently ${config.management.repeatDeployCooldownTaperEnabled}:`
);
for (const hours of [...buckets.keys()].sort((a, b) => b - a)) {
  console.log(`  ${hours}h cooldown: ${buckets.get(hours)} tokens`);
}
