/**
 * Enriches test/fixtures/benchmark-positions.json with real minute-level
 * price OHLCV for each position's exact deploy-to-close window, sourced
 * from GeckoTerminal's public API (which — unlike Meteora's own pool OHLCV
 * endpoint — actually supports paging into real history via
 * `before_timestamp`, verified against known-real historical windows for
 * every pool in this dataset).
 *
 * Free-tier GeckoTerminal API: 180-day retention, no API key required, rate
 * limited — this script sleeps between requests to stay well under that.
 *
 * Run: node scripts/fetch-benchmark-ohlcv.js
 * (run scripts/build-benchmark-dataset.js first if benchmark-positions.json
 * doesn't exist yet or you want to regenerate the base records)
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";

const FIXTURE_PATH = repoPath("test/fixtures/benchmark-positions.json");
const REQUEST_DELAY_MS = 8000;
const BUFFER_BEFORE_MIN = 30;
const BUFFER_AFTER_MIN = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchMinuteOhlcv(poolAddress, beforeTimestampSec, limit) {
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/minute?limit=${limit}&currency=usd&before_timestamp=${beforeTimestampSec}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.errors) throw new Error(data.errors.map((e) => e.title).join("; "));
  return data?.data?.attributes?.ohlcv_list ?? [];
}

async function main() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

  for (const pos of fixture.positions) {
    if (pos.error) {
      console.log(`Skipping ${pos.tag} (${pos.position}) — no base record`);
      continue;
    }
    if (Array.isArray(pos.price_ohlcv_1m) && pos.price_ohlcv_1m.length > 0) {
      console.log(`Skipping ${pos.pool_name} (${pos.tag}) — already fetched (${pos.price_ohlcv_1m.length} candles)`);
      continue;
    }
    const closedAt = new Date(pos.outcome.recorded_at);
    const minutesHeld = pos.outcome.minutes_held ?? 60;
    const deployedAt = new Date(closedAt.getTime() - minutesHeld * 60_000);

    const windowStartMs = deployedAt.getTime() - BUFFER_BEFORE_MIN * 60_000;
    const windowEndMs = closedAt.getTime() + BUFFER_AFTER_MIN * 60_000;
    const beforeTimestampSec = Math.floor(windowEndMs / 1000);
    const limit = Math.min(1000, Math.ceil((windowEndMs - windowStartMs) / 60_000) + 5);

    console.log(`Fetching ${pos.pool_name} (${pos.tag})... deploy=${deployedAt.toISOString()} close=${closedAt.toISOString()} limit=${limit}`);
    try {
      const raw = await fetchMinuteOhlcv(pos.pool, beforeTimestampSec, limit);
      const candles = raw
        .map(([ts, open, high, low, close, volume]) => ({ ts: ts * 1000, open, high, low, close, volume }))
        .filter((c) => c.ts >= windowStartMs && c.ts <= windowEndMs)
        .sort((a, b) => a.ts - b.ts)
        .map((c) => ({ ...c, iso: new Date(c.ts).toISOString() }));

      pos.price_ohlcv_1m = candles;
      pos.price_ohlcv_source = "geckoterminal (usd, 1-minute candles)";
      console.log(`  got ${candles.length} candles (${deployedAt.toISOString()} .. ${closedAt.toISOString()})`);
    } catch (error) {
      console.warn(`  FAILED: ${error.message}`);
      pos.price_ohlcv_1m = null;
      pos.price_ohlcv_error = error.message;
    }

    await sleep(REQUEST_DELAY_MS);
  }

  fixture.price_ohlcv_note = "price_ohlcv_1m is real minute-level OHLCV from GeckoTerminal's public API (networks/solana/pools/{pool}/ohlcv/minute), fetched for each position's exact deploy-to-close window (+30min before / +10min after buffer). Source: scripts/fetch-benchmark-ohlcv.js.";
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2));
  console.log(`\nWrote enriched dataset to ${FIXTURE_PATH}`);
}

main();
