/**
 * Offline unit tests for state/price-tick-log.js — full deploy-to-close
 * price/PnL history per position, a 10-recent-deploys FIFO archive on
 * close, and permanent severe-drawdown snapshots.
 * No network, no wallet. Touches position-price-history.json,
 * recent-deploy-price-history.json, and a TEST_..._DO_NOT_USE
 * severe-drawdown file, restoring all three afterward.
 * Run: node test/test-price-tick-log.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { createSuite, withRestoredFile } from "./lib/test-kit.js";
import { recordPriceTick, archiveClosedPosition } from "../state/price-tick-log.js";

const OPEN_FILE = repoPath("position-price-history.json");
const RECENT_DEPLOYS_FILE = repoPath("recent-deploy-price-history.json");
const TEST_POSITION = "TEST_PRICE_TICK_LOG_DO_NOT_USE";
const SEVERE_FILE = repoPath("severe-drawdowns", `${TEST_POSITION}.json`);

const suite = createSuite("Price tick log (full history + recent-deploys FIFO + severe-drawdown snapshots)");
const { section, check } = suite;

function cfg(overrides = {}) {
  return {
    management: {
      priceTickLogEnabled: true,
      priceTickHistoryDeployCount: 10,
      stopLossPct: -15,
      fastExitStopLossFraction: 0.5, // severe threshold = -7.5%
      ...overrides,
    },
  };
}

function tick(pnl_pct) {
  return { pool: "TEST_POOL", pair: "TEST-SOL", pnl_pct, pnl_usd: pnl_pct / 10, active_bin: 0, in_range: true, age_minutes: 1 };
}

function readJsonSafe(path) {
  if (!fs.existsSync(path)) return null;
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

section("disabled — no-op, no file created");
withRestoredFile(OPEN_FILE, () => {
  recordPriceTick(TEST_POSITION, tick(1), cfg({ priceTickLogEnabled: false }));
  const db = readJsonSafe(OPEN_FILE);
  check("open file untouched when disabled", db == null || !(TEST_POSITION in db));
});

section("open position — full history, uncapped while open");
withRestoredFile(OPEN_FILE, () => {
  for (let i = 1; i <= 15; i++) {
    recordPriceTick(TEST_POSITION, tick(i * 0.1), cfg());
  }
  const db = readJsonSafe(OPEN_FILE);
  const ticks = db[TEST_POSITION].ticks;
  check("all 15 ticks kept — no truncation while open", ticks.length === 15);
  check("first tick is #1, not dropped", Math.abs(ticks[0].pnl_pct - 0.1) < 1e-9);
  check("last tick is #15", Math.abs(ticks[14].pnl_pct - 1.5) < 1e-9);
  check("pool/pair recorded", db[TEST_POSITION].pool === "TEST_POOL" && db[TEST_POSITION].pair === "TEST-SOL");
});

section("archiveClosedPosition — moves full history into the recent-deploys FIFO, removes from open");
withRestoredFile(OPEN_FILE, () => {
  withRestoredFile(RECENT_DEPLOYS_FILE, () => {
    recordPriceTick(TEST_POSITION, tick(1), cfg());
    recordPriceTick(TEST_POSITION, tick(2), cfg());
    archiveClosedPosition(TEST_POSITION, cfg());

    const openDb = readJsonSafe(OPEN_FILE);
    check("removed from the open store after archiving", openDb == null || !(TEST_POSITION in openDb));

    const recentDb = readJsonSafe(RECENT_DEPLOYS_FILE);
    check("recent-deploys file has exactly 1 archived deploy", recentDb.deploys.length === 1);
    check("archived deploy carries the full 2-tick history", recentDb.deploys[0].ticks.length === 2);
    check("archived deploy records position/pool/pair", recentDb.deploys[0].position === TEST_POSITION && recentDb.deploys[0].pool === "TEST_POOL");
    check("archived deploy has a closed_at timestamp", typeof recentDb.deploys[0].closed_at === "string");
  });
});

section("archiveClosedPosition — FIFO caps at priceTickHistoryDeployCount, oldest deploy evicted first");
withRestoredFile(OPEN_FILE, () => {
  withRestoredFile(RECENT_DEPLOYS_FILE, () => {
    for (let d = 1; d <= 12; d++) {
      const pos = `${TEST_POSITION}_${d}`;
      recordPriceTick(pos, tick(d), cfg());
      archiveClosedPosition(pos, cfg({ priceTickHistoryDeployCount: 10 }));
    }
    const recentDb = readJsonSafe(RECENT_DEPLOYS_FILE);
    check("capped at exactly 10 archived deploys", recentDb.deploys.length === 10);
    check("oldest 2 deploys (1,2) evicted — first remaining is deploy #3", recentDb.deploys[0].position === `${TEST_POSITION}_3`);
    check("most recent archived deploy is #12", recentDb.deploys[9].position === `${TEST_POSITION}_12`);
  });
});

section("archiveClosedPosition — no-op for a position with no open entry");
withRestoredFile(OPEN_FILE, () => {
  withRestoredFile(RECENT_DEPLOYS_FILE, () => {
    archiveClosedPosition("TEST_NEVER_TRACKED_DO_NOT_USE", cfg()); // should not throw
    const recentDb = readJsonSafe(RECENT_DEPLOYS_FILE);
    check("nothing archived for an untracked position", recentDb == null || recentDb.deploys.length === 0);
  });
});

section("severe-drawdown threshold — matches guard #8's exact formula (stopLossPct * fastExitStopLossFraction)");
withRestoredFile(OPEN_FILE, () => {
  withRestoredFile(SEVERE_FILE, () => {
    // threshold = -15 * 0.5 = -7.5%
    recordPriceTick(TEST_POSITION, tick(-5), cfg()); // above threshold, not yet severe
    let severe = readJsonSafe(SEVERE_FILE);
    check("no severe file before crossing -7.5%", severe == null);

    recordPriceTick(TEST_POSITION, tick(-8), cfg()); // crosses -7.5%
    severe = readJsonSafe(SEVERE_FILE);
    check("severe file created exactly at the crossing tick", severe != null);
    check("severe file records the crossing threshold", severe.severe_threshold_pct === -7.5);
    check("severe file has exactly 1 tick so far", severe.ticks.length === 1);
    check("severe file's tick is the -8% one, not the -5% one", severe.ticks[0].pnl_pct === -8);

    // Subsequent ticks keep accumulating, even after a partial recovery
    // above the threshold (the crash-to-close path stays complete).
    recordPriceTick(TEST_POSITION, tick(-6), cfg());
    recordPriceTick(TEST_POSITION, tick(-20), cfg());
    severe = readJsonSafe(SEVERE_FILE);
    check("severe file keeps accumulating after the initial trigger, uncapped", severe.ticks.length === 3);
  });
});

section("severe-drawdown file survives archiveClosedPosition (permanent, independent of the FIFO)");
withRestoredFile(OPEN_FILE, () => {
  withRestoredFile(RECENT_DEPLOYS_FILE, () => {
    withRestoredFile(SEVERE_FILE, () => {
      recordPriceTick(TEST_POSITION, tick(-8), cfg()); // both open history + severe now exist
      archiveClosedPosition(TEST_POSITION, cfg());

      const severe = readJsonSafe(SEVERE_FILE);
      check("severe file untouched by archiveClosedPosition", severe != null && severe.ticks.length === 1);
    });
  });
});

process.exit(suite.finish());
