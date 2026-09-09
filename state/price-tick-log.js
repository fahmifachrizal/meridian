/**
 * Per-position price/PnL history — opt-in
 * (config.management.priceTickLogEnabled), zero extra network calls: this
 * only persists data the 3s PnL poller (index.js) already fetches every
 * tick to drive the exit-rule checks.
 *
 * Three stores, three very different retention policies:
 *
 * - position-price-history.json — the OPEN position's FULL history, deploy
 *   to now. Uncapped while open (every tick since deploy is kept, so the
 *   record always spans the position's whole lifetime so far) — not a
 *   short rolling window. Shape: { [position]: { pool, pair, ticks: [...] } }.
 *
 * - recent-deploy-price-history.json — once a position CLOSES, its full
 *   deploy-to-close tick history moves here and is removed from the open
 *   store. This is a FIFO capped at
 *   config.management.priceTickHistoryDeployCount (default 10) *deploys*,
 *   not ticks — the oldest closed deploy's full record is evicted once the
 *   count is exceeded, not individual ticks trimmed off any one record.
 *   Shape: { deploys: [{ position, pool, pair, closed_at, ticks: [...] }, ...] },
 *   newest last.
 *
 * - severe-drawdowns/<position>.json — PERMANENT, one file per flagged
 *   position (a deliberate exception to this repo's usual "one shared file
 *   keyed by ID" convention — pool-memory.json/state.json — per explicit
 *   operator choice: these are meant to read as standalone incident
 *   records, not entries buried in a shared file, and not subject to the
 *   10-deploy FIFO above). Created the first time a position's pnl_pct
 *   crosses `effectiveStopLossPct * fastExitStopLossFraction` — the EXACT
 *   same threshold guard #8 (guards/08-fast-exit.js) already uses for a
 *   fast exit; no new threshold is introduced here. Once created, every
 *   subsequent tick for that position is appended to it (uncapped) through
 *   to close, so the file shows the whole crash-to-close path. Never
 *   pruned or evicted, regardless of how many deploys happen afterward.
 */

import fs from "fs";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";
import { loadCached, saveJson } from "./json-store.js";

const OPEN_FILE = repoPath("position-price-history.json");
const RECENT_DEPLOYS_FILE = repoPath("recent-deploy-price-history.json");
const SEVERE_DIR = repoPath("severe-drawdowns");

function loadOpen() {
  return loadCached(OPEN_FILE, () => ({}), "price_tick_log");
}

function saveOpen(db) {
  saveJson(OPEN_FILE, db, "price_tick_log");
}

function loadRecentDeploys() {
  return loadCached(RECENT_DEPLOYS_FILE, () => ({ deploys: [] }), "recent_deploy_price_history");
}

function saveRecentDeploys(db) {
  saveJson(RECENT_DEPLOYS_FILE, db, "recent_deploy_price_history");
}

function severeFilePath(position) {
  return repoPath("severe-drawdowns", `${position}.json`);
}

function loadSevere(position) {
  return loadCached(severeFilePath(position), () => null, "severe_drawdown");
}

function saveSevere(position, record) {
  fs.mkdirSync(SEVERE_DIR, { recursive: true });
  saveJson(severeFilePath(position), record, "severe_drawdown");
}

/**
 * Record one poller tick for an open position. No-op if
 * priceTickLogEnabled is false. `tick` fields mirror what the poller
 * already has on hand (tools/pnl.js's buildPosition() output) — nothing
 * extra is computed or fetched. Ticks accumulate without limit while the
 * position stays open — the cap in this file applies to how many CLOSED
 * deploys are retained, not how many ticks one open position can log.
 */
export function recordPriceTick(position, { pool, pair, pnl_pct, pnl_usd, active_bin, in_range, age_minutes }, config) {
  if (!config.management.priceTickLogEnabled) return;

  const tickRecord = { ts: new Date().toISOString(), pnl_pct, pnl_usd, active_bin, in_range, age_minutes };

  const db = loadOpen();
  const entry = db[position] ?? { pool, pair, ticks: [] };
  entry.pool = pool;
  entry.pair = pair;
  entry.ticks.push(tickRecord);
  db[position] = entry;
  saveOpen(db);

  // Severe-drawdown snapshot — same formula as guards/08-fast-exit.js.
  // Independent of the open/closed-deploy stores above: permanent,
  // never evicted, regardless of the FIFO cap on recent deploys.
  const stopLossPct = config.management.stopLossPct;
  const fastExitStopLossFraction = config.management.fastExitStopLossFraction ?? 0.5;
  const severeThreshold = stopLossPct * fastExitStopLossFraction;

  const existingSevere = loadSevere(position);
  const crossedThreshold = pnl_pct != null && pnl_pct <= severeThreshold;
  if (existingSevere || crossedThreshold) {
    const record = existingSevere ?? {
      position,
      pool,
      pair,
      stop_loss_pct: stopLossPct,
      fast_exit_stop_loss_fraction: fastExitStopLossFraction,
      severe_threshold_pct: severeThreshold,
      triggered_at: tickRecord.ts,
      ticks: [],
    };
    record.ticks.push(tickRecord);
    saveSevere(position, record);
    if (!existingSevere) {
      log("state", `Severe drawdown: ${pair || position} crossed ${severeThreshold.toFixed(2)}% (pnl_pct=${pnl_pct}) — permanent snapshot started at state/severe-drawdowns/${position}.json`);
    }
  }
}

/**
 * Called on close: moves the position's full deploy-to-close tick history
 * from the OPEN store into the recent-deploys FIFO (capped at
 * config.management.priceTickHistoryDeployCount, default 10 — oldest
 * closed deploy evicted first), then removes it from the open store.
 * No-op if the position was never tracked (priceTickLogEnabled was off,
 * or no ticks were ever recorded for it). Never touches the severe file,
 * if one exists — that record is permanent by design, independent of
 * this FIFO.
 */
export function archiveClosedPosition(position, config) {
  const openDb = loadOpen();
  const entry = openDb[position];
  if (!entry) return;

  delete openDb[position];
  saveOpen(openDb);

  const maxDeploys = Math.max(1, Number(config.management.priceTickHistoryDeployCount ?? 10));
  const recentDb = loadRecentDeploys();
  recentDb.deploys.push({ position, pool: entry.pool, pair: entry.pair, closed_at: new Date().toISOString(), ticks: entry.ticks });
  if (recentDb.deploys.length > maxDeploys) {
    recentDb.deploys = recentDb.deploys.slice(-maxDeploys);
  }
  saveRecentDeploys(recentDb);
}
