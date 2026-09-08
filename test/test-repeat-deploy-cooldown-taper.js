/**
 * Repeat-deploy cooldown taper (opt-in) — state/pool-memory.js +
 * state/token-deploy-count.js.
 *
 * Not to be confused with guard #5's repeatDeploySizeTaperPct (tapers
 * DEPLOY SIZE for repeat deploys within the token-age early window). This
 * is a different mechanism: repeatDeployCooldownHours is the fixed
 * duration applied once a pool/token proves `repeatDeployCooldownTriggerCount`
 * consecutive fee-generating deploys in a row. The taper here shrinks that
 * DURATION as the TOKEN (base_mint, across every pool it's ever traded in)
 * accumulates more total deploys — every `taperEveryNDeploys` deploys, the
 * cooldown drops by `taperDecrementHours`, floored at `taperMinHours`.
 *
 * Offline. Wraps every pool-memory.json / token-deploy-count.json touch in
 * withRestoredFile(); uses TEST_..._DO_NOT_USE fake addresses so a
 * forgotten restore is grep-able. Run: node test/test-repeat-deploy-cooldown-taper.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { createSuite, withRestoredFile } from "./lib/test-kit.js";
import { config } from "../core/config.js";
import { recordPoolDeploy, getPoolMemory } from "../state/pool-memory.js";
import { getTokenDeployCount } from "../state/token-deploy-count.js";

const POOL_MEMORY_FILE = repoPath("pool-memory.json");
const TOKEN_DEPLOY_COUNT_FILE = repoPath("token-deploy-count.json");
const TEST_POOL = "TEST_REPEAT_COOLDOWN_TAPER_DO_NOT_USE";
const TEST_MINT = "TEST_REPEAT_COOLDOWN_TAPER_MINT_DO_NOT_USE";

const suite = createSuite("Repeat-deploy cooldown taper (state/pool-memory.js + state/token-deploy-count.js)");
const { section, check } = suite;

function feeGeneratingDeploy(overrides = {}) {
  return {
    pool_name: "TEST-SOL",
    base_mint: TEST_MINT,
    pnl_pct: 2,
    fees_earned_usd: 1,
    fee_earned_pct: 5,
    close_reason: "take profit",
    ...overrides,
  };
}

function hoursUntil(isoString) {
  return (new Date(isoString).getTime() - Date.now()) / 3_600_000;
}

function clearTestFixtures() {
  const pm = fs.existsSync(POOL_MEMORY_FILE) ? JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8")) : {};
  delete pm[TEST_POOL];
  fs.writeFileSync(POOL_MEMORY_FILE, JSON.stringify(pm, null, 2));

  const td = fs.existsSync(TOKEN_DEPLOY_COUNT_FILE) ? JSON.parse(fs.readFileSync(TOKEN_DEPLOY_COUNT_FILE, "utf8")) : {};
  delete td[TEST_MINT];
  fs.writeFileSync(TOKEN_DEPLOY_COUNT_FILE, JSON.stringify(td, null, 2));
}

withRestoredFile(POOL_MEMORY_FILE, () => {
  withRestoredFile(TOKEN_DEPLOY_COUNT_FILE, () => {
    clearTestFixtures();

    const savedMgmt = { ...config.management };
    Object.assign(config.management, {
      repeatDeployCooldownEnabled: true,
      repeatDeployCooldownTriggerCount: 2,
      repeatDeployCooldownHours: 12,
      repeatDeployCooldownScope: "pool",
      repeatDeployCooldownMinFeeEarnedPct: 0,
      repeatDeployCooldownTaperEnabled: false,
      repeatDeployCooldownTaperDecrementHours: 4,
      repeatDeployCooldownTaperEveryNDeploys: 4,
      repeatDeployCooldownTaperMinHours: 0,
    });

    try {
      section("token-deploy-count.js — increments once per closed deploy, independent of the cooldown trigger");
      {
        recordPoolDeploy(TEST_POOL, feeGeneratingDeploy());
        check("count is 1 after the 1st deploy (below triggerCount, no cooldown fires)", getTokenDeployCount(TEST_MINT) === 1);
        recordPoolDeploy(TEST_POOL, feeGeneratingDeploy());
        check("count is 2 after the 2nd deploy", getTokenDeployCount(TEST_MINT) === 2);
        recordPoolDeploy(TEST_POOL, feeGeneratingDeploy());
        recordPoolDeploy(TEST_POOL, feeGeneratingDeploy());
        check("count keeps incrementing regardless of cooldown state", getTokenDeployCount(TEST_MINT) === 4);
      }

      section("taper disabled (default) — cooldown stays at the full 12h regardless of deploy count");
      {
        let mem = getPoolMemory({ pool_address: TEST_POOL });
        check("cooldown fired by deploy 2 (2 consecutive fee-generating deploys)", mem.cooldown_until != null);
        check("cooldown is the full 12h with taper off", Math.abs(hoursUntil(mem.cooldown_until) - 12) < 0.05);

        recordPoolDeploy(TEST_POOL, feeGeneratingDeploy());
        recordPoolDeploy(TEST_POOL, feeGeneratingDeploy()); // deploys 5,6 — still no taper
        mem = getPoolMemory({ pool_address: TEST_POOL });
        check("still the full 12h at deploy 6 with taper off", Math.abs(hoursUntil(mem.cooldown_until) - 12) < 0.05);
      }

      // Fresh fixtures for the taper-enabled section, so the deploy count starts at 0.
      clearTestFixtures();

      section("taper enabled — matches the operator's exact worked example (12h, 12h, 8h, 8h, 4h, 4h, 0h, 0h)");
      {
        config.management.repeatDeployCooldownTaperEnabled = true;
        const expected = [
          [1, null],  // deploy 1 — below triggerCount, no cooldown set yet
          [2, 12],
          [3, null],  // not asserted — see the note below on odd-numbered deploys
          [4, 12],
          [5, null],
          [6, 8],
          [7, null],
          [8, 8],
          [9, null],
          [10, 4],
          [11, null],
          [12, 4],
          [13, null],
          [14, 0],
          [15, null],
          [16, 0],
        ];
        // The sliding-window trigger fires on EVERY deploy once past
        // triggerCount (a pre-existing, unchanged behavior — see the file
        // header), not just even-numbered ones. So odd-numbered deploys
        // also re-fire the cooldown; this table only asserts the values at
        // the specific deploy counts the operator's example named (2, 4,
        // 6, 8, ...), skipping the odd ones rather than asserting a
        // stronger claim than what was actually specified.
        for (const [n, expectedHours] of expected) {
          recordPoolDeploy(TEST_POOL, feeGeneratingDeploy());
          if (expectedHours == null) continue;
          const mem = getPoolMemory({ pool_address: TEST_POOL });
          check(`deploy #${n}: cooldown is ${expectedHours}h`, Math.abs(hoursUntil(mem.cooldown_until) - expectedHours) < 0.05);
        }
      }
    } finally {
      Object.assign(config.management, savedMgmt);
    }
  });
});

process.exit(suite.finish());
