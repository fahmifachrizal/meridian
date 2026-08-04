/**
 * Fetches real 1-minute OHLCV for every unique pool this agent has ever
 * deployed into (pool-memory.json), covering each pool's first WINDOW_DAYS
 * of life (pool_created_at -> +WINDOW_DAYS, or "now" if the pool is younger
 * than that). Sourced from GeckoTerminal's public API (same one used by
 * scripts/fetch-benchmark-ohlcv.js) and Meteora's pool-discovery API for
 * pool_created_at (same one used by scripts/fetch-benchmark-pool-metadata.js).
 *
 * Output is a durable, git-trackable data file (not a scratch/.cache dir) —
 * this *is* the deliverable dataset, alongside its CSV export from
 * scripts/export-pool-ohlcv-csv.js.
 *
 * Resumable: writes progress to OUT_PATH after every pool, so re-running
 * the script picks up where it left off (skips pools already cached,
 * including ones that failed and were cached with an `error` field so we
 * don't hammer a dead/delisted pool's endpoint every re-run). Changing
 * WINDOW_DAYS invalidates the whole cache (the window end shifts), so bump
 * OUT_PATH's filename alongside it rather than silently mixing windows.
 *
 * Run: node scripts/fetch-pool-first-days-ohlcv.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";

const POOL_MEMORY_PATH = repoPath("pool-memory.json");
const LESSONS_PATH = repoPath("lessons.json");
const WINDOW_DAYS = 3;
const OUT_PATH = repoPath(`scripts/data/pool-first-${WINDOW_DAYS}days-ohlcv.json`);

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const META_DELAY_MS = 800;
const OHLCV_DELAY_MS = 11000;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;
const MAX_CANDLES_PER_CALL = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPoolCreatedAt(poolAddress) {
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=5m`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const pool = data?.data?.[0];
  if (!pool) throw new Error("pool not found in discovery API");
  return pool.pool_created_at ?? pool.token_x?.created_at ?? null;
}

// Paginates backwards from windowEndMs until candles reach windowStartMs or
// the API stops returning older data (pool younger than requested window).
async function fetchMinuteOhlcvRange(poolAddress, windowStartMs, windowEndMs) {
  const all = [];
  let cursorMs = windowEndMs;
  let guard = 0;
  while (cursorMs > windowStartMs && guard < 8) {
    guard++;
    const beforeTimestampSec = Math.floor(cursorMs / 1000);
    const url = `${GECKO_BASE}/networks/solana/pools/${poolAddress}/ohlcv/minute?limit=${MAX_CANDLES_PER_CALL}&currency=usd&before_timestamp=${beforeTimestampSec}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.errors) throw new Error(data.errors.map((e) => e.title).join("; "));
    const raw = data?.data?.attributes?.ohlcv_list ?? [];
    if (raw.length === 0) break;
    const candles = raw.map(([ts, open, high, low, close, volume]) => ({ ts: ts * 1000, open, high, low, close, volume }));
    all.push(...candles);
    const oldestMs = Math.min(...candles.map((c) => c.ts));
    if (oldestMs >= cursorMs) break; // no progress, avoid infinite loop
    cursorMs = oldestMs;
    if (raw.length < MAX_CANDLES_PER_CALL) break; // API ran out of history
    await sleep(OHLCV_DELAY_MS);
  }
  const seen = new Set();
  return all
    .filter((c) => c.ts >= windowStartMs && c.ts <= windowEndMs)
    .filter((c) => (seen.has(c.ts) ? false : (seen.add(c.ts), true)))
    .sort((a, b) => a.ts - b.ts);
}

function loadCache() {
  if (!fs.existsSync(OUT_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.mkdirSync(repoPath("scripts/data"), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(cache, null, 2));
}

function buildTargets() {
  const poolMemory = JSON.parse(fs.readFileSync(POOL_MEMORY_PATH, "utf8"));
  const lessons = JSON.parse(fs.readFileSync(LESSONS_PATH, "utf8"));
  const perf = lessons.performance || [];
  const firstPerfByPool = {};
  for (const p of perf) {
    if (!firstPerfByPool[p.pool]) firstPerfByPool[p.pool] = p;
  }

  return Object.entries(poolMemory).map(([poolAddress, mem]) => {
    const perfRow = firstPerfByPool[poolAddress];
    const firstDeploy = mem.deploys?.[0];
    return {
      pool: poolAddress,
      pool_name: mem.name ?? perfRow?.pool_name ?? poolAddress.slice(0, 8),
      base_mint: mem.base_mint ?? perfRow?.base_mint ?? null,
      metadata: {
        entry_mcap: perfRow?.entry_mcap ?? firstDeploy?.entry_mcap ?? null,
        entry_tvl: perfRow?.entry_tvl ?? firstDeploy?.entry_tvl ?? null,
        entry_volume: perfRow?.entry_volume ?? firstDeploy?.entry_volume ?? null,
        fee_tvl_ratio: perfRow?.fee_tvl_ratio ?? null,
        organic_score: perfRow?.organic_score ?? null,
        volatility: perfRow?.volatility ?? firstDeploy?.volatility_at_deploy ?? null,
        avg_pnl_pct: mem.avg_pnl_pct ?? null,
        win_rate: mem.win_rate ?? null,
        total_deploys: mem.total_deploys ?? null,
      },
    };
  });
}

async function main() {
  const targets = buildTargets();
  const cache = loadCache();
  console.log(`${targets.length} unique pools total, ${Object.keys(cache).length} already cached`);

  let processed = 0;
  for (const t of targets) {
    if (cache[t.pool] && !cache[t.pool].error) continue;
    processed++;
    console.log(`[${processed}] ${t.pool_name} (${t.pool})`);
    try {
      const createdAt = await fetchPoolCreatedAt(t.pool);
      await sleep(META_DELAY_MS);
      if (!createdAt) throw new Error("no pool_created_at from discovery API");

      const windowStartMs = createdAt;
      const windowEndMs = Math.min(createdAt + WINDOW_MS, Date.now());
      const candles = await fetchMinuteOhlcvRange(t.pool, windowStartMs, windowEndMs);

      cache[t.pool] = {
        pool_name: t.pool_name,
        base_mint: t.base_mint,
        metadata: t.metadata,
        pool_created_at: createdAt,
        window_end_ms: windowEndMs,
        candle_count: candles.length,
        candles: candles.map((c) => ({ ts: c.ts, close: c.close, volume: c.volume })),
      };
      console.log(`  ok: ${candles.length} candles, created ${new Date(createdAt).toISOString()}`);
    } catch (error) {
      cache[t.pool] = { pool_name: t.pool_name, base_mint: t.base_mint, metadata: t.metadata, error: error.message };
      console.warn(`  FAILED: ${error.message}`);
    }
    saveCache(cache);
    await sleep(OHLCV_DELAY_MS);
  }

  console.log(`\nDone. ${Object.keys(cache).length}/${targets.length} pools cached at ${OUT_PATH}`);
}

main();
