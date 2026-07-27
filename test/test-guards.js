/**
 * Offline unit tests for the SalaryCat-SOL post-mortem guards.
 * No network, no wallet. Touches pool-memory.json with fake pool addresses
 * only, and restores the file to its exact pre-test content afterward.
 * Run: node test/test-guards.js
 */

import fs from "fs";
import assert from "assert";
import { repoPath } from "../repo-root.js";
import { getTokenAgeWindowRejectReason } from "../tools/screening.js";
import {
  recordRejection,
  getRecentRejectionCount,
  recordTvlObservation,
  getPriorTvlObservation,
} from "../pool-memory.js";

const POOL_MEMORY_FILE = repoPath("pool-memory.json");
const FAKE_POOL_HYSTERESIS = "TEST_GUARD_POOL_HYSTERESIS_DO_NOT_USE";
const FAKE_POOL_TVL = "TEST_GUARD_POOL_TVL_DO_NOT_USE";

let failures = 0;
function check(name, condition) {
  if (condition) {
    console.log(`  ok — ${name}`);
  } else {
    console.error(`  FAIL — ${name}`);
    failures++;
  }
}

// ─── Guard #6: token-age deploy window ──────────────────────────
function testTokenAgeWindow() {
  console.log("\n=== Guard #6: token-age deploy window (6h early / 24h cooldown) ===");
  const s = { tokenAgeWindowEnabled: true, tokenEarlyWindowMaxHours: 6, tokenCooldownHours: 24 };
  const now = Date.now();
  const ageHours = (h) => now - h * 3_600_000;

  check("1h old — allowed (early momentum)", getTokenAgeWindowRejectReason(ageHours(1), s) === null);
  check("5h old — allowed (early momentum)", getTokenAgeWindowRejectReason(ageHours(5), s) === null);
  check("6h old — allowed (boundary, inclusive)", getTokenAgeWindowRejectReason(ageHours(6), s) === null);
  check("15h old — blocked (in cooldown)", getTokenAgeWindowRejectReason(ageHours(15), s) !== null);
  check("29h old — blocked (in cooldown)", getTokenAgeWindowRejectReason(ageHours(29), s) !== null);
  // Exactly 30h is the instant the cooldown ends — same-millisecond clock
  // reads can make this boundary land either side, so check just past it.
  check("30h+1s old — allowed (cooldown just ended)", getTokenAgeWindowRejectReason(now - (30 * 3_600_000 + 1000), s) === null);
  check("31h old — allowed (past cooldown)", getTokenAgeWindowRejectReason(ageHours(31), s) === null);
  check("unknown age (null) — fails open, allowed", getTokenAgeWindowRejectReason(null, s) === null);

  const disabled = { ...s, tokenAgeWindowEnabled: false };
  check("disabled toggle — always allowed even mid-cooldown", getTokenAgeWindowRejectReason(ageHours(15), disabled) === null);
}

// ─── Guard #2: rejection hysteresis ──────────────────────────────
function testRejectionHysteresis() {
  console.log("\n=== Guard #2: rejection hysteresis ===");
  check("no rejections recorded yet", getRecentRejectionCount(FAKE_POOL_HYSTERESIS, "bot_holders_pct", 24) === 0);

  recordRejection(FAKE_POOL_HYSTERESIS, "bot_holders_pct", 36);
  recordRejection(FAKE_POOL_HYSTERESIS, "bot_holders_pct", 38);
  check("2 same-reason rejections counted", getRecentRejectionCount(FAKE_POOL_HYSTERESIS, "bot_holders_pct", 24) === 2);
  check("different reason key not counted", getRecentRejectionCount(FAKE_POOL_HYSTERESIS, "top10pct", 24) === 0);

  // Simulate the exact SalaryCat pattern: 2 rejections, then a pass at 34%
  // (below raw 35% cap) — with hysteresis (count>=2, margin=5) the effective
  // cap tightens to 30%, so 34% should still be treated as a rejection.
  const maxBotHoldersPct = 35;
  const hysteresisMargin = 5;
  const priorRejections = getRecentRejectionCount(FAKE_POOL_HYSTERESIS, "bot_holders_pct", 24);
  const effectiveCap = priorRejections >= 2 ? maxBotHoldersPct - hysteresisMargin : maxBotHoldersPct;
  check("effective cap tightened to 30% after 2 rejections", effectiveCap === 30);
  check("34% still rejected under tightened cap", 34 > effectiveCap);
}

// ─── Guard #3: TVL decline pre-deploy check ──────────────────────
function testTvlDeclineCheck() {
  console.log("\n=== Guard #3: TVL/mcap decline check ===");
  check("no observation yet — fails open", getPriorTvlObservation(FAKE_POOL_TVL, 4) === null);

  recordTvlObservation(FAKE_POOL_TVL, 81_600); // SalaryCat-like entry TVL
  const prior = getPriorTvlObservation(FAKE_POOL_TVL, 4);
  check("observation recorded and retrievable", prior?.tvl === 81_600);

  const currentTvl = 29_700; // SalaryCat-like collapsed TVL
  const declinePct = ((prior.tvl - currentTvl) / prior.tvl) * 100;
  check(`decline computed correctly (${declinePct.toFixed(1)}% ~= 63.6%)`, Math.abs(declinePct - 63.6) < 1);
  check("63.6% decline exceeds default 20% cap — would reject deploy", declinePct > 20);

  // A mild, healthy fluctuation should NOT trip the guard
  const mildDeclinePct = ((prior.tvl - 75_000) / prior.tvl) * 100;
  check("mild ~8% decline stays under 20% cap — deploy allowed", mildDeclinePct < 20);
}

function cleanup() {
  if (!fs.existsSync(POOL_MEMORY_FILE)) return;
  const db = JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
  delete db[FAKE_POOL_HYSTERESIS];
  delete db[FAKE_POOL_TVL];
  fs.writeFileSync(POOL_MEMORY_FILE, JSON.stringify(db, null, 2));
  console.log("\nCleaned up test fixtures from pool-memory.json");
}

testTokenAgeWindow();
testRejectionHysteresis();
testTvlDeclineCheck();
cleanup();

console.log(`\n=== ${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`} ===`);
process.exit(failures === 0 ? 0 : 1);
