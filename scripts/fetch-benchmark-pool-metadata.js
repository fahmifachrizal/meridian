/**
 * Enriches test/fixtures/benchmark-positions.json with the two pieces of
 * metadata guard #1 (repeat-deploy cooldown) and guard #6 (token-age
 * window) actually key off of, so test/test-benchmark.js can replay both
 * guards against real historical deploys offline:
 *
 *  - pool_created_at: the DLMM pool's own creation timestamp (not the
 *    token's mint date — see guard #6's fix earlier this session), fetched
 *    live from Meteora's pool-discovery API since it's not recorded
 *    anywhere in this repo's own JSON stores.
 *  - deploy_sequence: this position's 1-based index among all deploys ever
 *    recorded into that pool in pool-memory.json's `deploys` array (deploys
 *    are appended in chronological order) — computed locally, no network.
 *
 * Run: node scripts/fetch-benchmark-pool-metadata.js
 * (run after build-benchmark-dataset.js; safe to run before or after
 * fetch-benchmark-ohlcv.js)
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";

const FIXTURE_PATH = repoPath("test/fixtures/benchmark-positions.json");
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const REQUEST_DELAY_MS = 1000;

// WORM-SOL's pool has since dropped out of the pool-discovery API's index
// entirely (confirmed: every filter/timeframe variant returns zero results,
// not a rate-limit or transient error — likely delisted after the crash,
// probably zero remaining liquidity). Its pool_created_at was captured from
// a live API call earlier in the same session that built this dataset
// (2026-07-27), before the pool dropped out of the index.
const KNOWN_POOL_CREATED_AT_FALLBACK = {
  "Dtiuey8YKBMduGbtNgNs1gNruJxuHmCh6nCtpDiYL9jF": 1784975899000, // WORM-SOL
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPoolCreatedAt(poolAddress) {
  if (KNOWN_POOL_CREATED_AT_FALLBACK[poolAddress] != null) {
    return KNOWN_POOL_CREATED_AT_FALLBACK[poolAddress];
  }
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=5m`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const pool = data?.data?.[0];
  if (!pool) throw new Error("pool not found in discovery API");
  return pool.pool_created_at ?? pool.token_x?.created_at ?? null;
}

function computeDeploySequence(poolMemory, poolAddress, positionAddress, closedAtIso) {
  const entry = poolMemory[poolAddress];
  if (!entry?.deploys) return null;
  // deploys[] doesn't carry a position address (see CLAUDE.md — deployed_at
  // is never populated either), so match by closed_at timestamp instead,
  // which recordPoolDeploy always sets from the real close event.
  const idx = entry.deploys.findIndex((d) => d.closed_at === closedAtIso);
  return idx === -1 ? null : idx + 1; // 1-based
}

async function main() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  const poolMemory = JSON.parse(fs.readFileSync(repoPath("pool-memory.json"), "utf8"));

  for (const pos of fixture.positions) {
    if (pos.error) continue;

    pos.deploy_sequence = computeDeploySequence(poolMemory, pos.pool, pos.position, pos.outcome.recorded_at);

    if (pos.pool_created_at) {
      console.log(`Skipping ${pos.pool_name} — pool_created_at already fetched`);
      continue;
    }
    console.log(`Fetching pool metadata for ${pos.pool_name}...`);
    try {
      pos.pool_created_at = await fetchPoolCreatedAt(pos.pool);
      const deployedAt = new Date(pos.outcome.recorded_at).getTime() - pos.outcome.minutes_held * 60_000;
      pos.pool_age_hours_at_deploy = pos.pool_created_at ? (deployedAt - pos.pool_created_at) / 3_600_000 : null;
      console.log(`  pool_created_at=${new Date(pos.pool_created_at).toISOString()}, age at this deploy=${pos.pool_age_hours_at_deploy?.toFixed(2)}h, deploy_sequence=${pos.deploy_sequence}`);
    } catch (error) {
      console.warn(`  FAILED: ${error.message}`);
      pos.pool_created_at = null;
      pos.pool_age_hours_at_deploy = null;
    }
    await sleep(REQUEST_DELAY_MS);
  }

  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2));
  console.log(`\nWrote enriched dataset to ${FIXTURE_PATH}`);
}

main();
