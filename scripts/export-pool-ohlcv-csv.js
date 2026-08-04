/**
 * Flattens scripts/data/pool-first-{N}days-ohlcv.json (one JSON object keyed
 * by pool address, each with a nested candles[] array) into a single CSV —
 * one row per pool per 1-minute candle, with that pool's static metadata
 * repeated on every row so the file is self-contained for spreadsheet/pandas
 * use without needing to join back against pool-memory.json or lessons.json.
 *
 * Run: node scripts/export-pool-ohlcv-csv.js [windowDays]
 * (windowDays defaults to 3, matching fetch-pool-first-days-ohlcv.js)
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";

const WINDOW_DAYS = Number(process.argv[2]) || 3;
const IN_PATH = repoPath(`scripts/data/pool-first-${WINDOW_DAYS}days-ohlcv.json`);
const OUT_PATH = repoPath(`scripts/data/pool-first-${WINDOW_DAYS}days-ohlcv.csv`);

const COLUMNS = [
  "pool",
  "pool_name",
  "base_mint",
  "pool_created_at_iso",
  "candle_ts_iso",
  "minutes_since_created",
  "close",
  "volume",
  "entry_mcap",
  "entry_tvl",
  "entry_volume",
  "fee_tvl_ratio",
  "organic_score",
  "volatility",
  "avg_pnl_pct",
  "win_rate",
  "total_deploys",
];

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function main() {
  if (!fs.existsSync(IN_PATH)) {
    console.error(`Not found: ${IN_PATH} — run scripts/fetch-pool-first-days-ohlcv.js first.`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(IN_PATH, "utf8"));

  const rows = [COLUMNS.join(",")];
  let poolCount = 0, candleCount = 0, skippedPools = 0;

  for (const [poolAddress, entry] of Object.entries(data)) {
    if (entry.error || !Array.isArray(entry.candles) || entry.candles.length === 0) {
      skippedPools++;
      continue;
    }
    poolCount++;
    const m = entry.metadata || {};
    const createdIso = entry.pool_created_at ? new Date(entry.pool_created_at).toISOString() : "";
    for (const c of entry.candles) {
      candleCount++;
      const minutesSinceCreated = entry.pool_created_at ? Math.round((c.ts - entry.pool_created_at) / 60000) : "";
      rows.push([
        poolAddress,
        entry.pool_name,
        entry.base_mint,
        createdIso,
        new Date(c.ts).toISOString(),
        minutesSinceCreated,
        c.close,
        c.volume,
        m.entry_mcap,
        m.entry_tvl,
        m.entry_volume,
        m.fee_tvl_ratio,
        m.organic_score,
        m.volatility,
        m.avg_pnl_pct,
        m.win_rate,
        m.total_deploys,
      ].map(csvEscape).join(","));
    }
  }

  fs.writeFileSync(OUT_PATH, rows.join("\n") + "\n");
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`${poolCount} pools with data, ${candleCount} candle rows, ${skippedPools} pools skipped (error or empty)`);
}

main();
