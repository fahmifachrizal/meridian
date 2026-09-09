/**
 * Cooldown remaining-duration display — guards/02-repeat-deploy-cooldown.js
 * + state/pool-memory.js's getPoolCooldownRemainingMs/getBaseMintCooldownRemainingMs.
 *
 * Pins the "-[xx]hr" / "-[xx]mn" suffix format shown in the collapsed
 * screening-cycle Telegram message (index.js's no-candidates branch), and
 * the `type: "pool"|"token"` field tools/screening.js branches on instead
 * of matching the reason string exactly.
 *
 * Offline. Wraps every pool-memory.json touch in withRestoredFile(); uses
 * TEST_..._DO_NOT_USE fake addresses so a forgotten restore is grep-able.
 * Run: node test/test-cooldown-remaining.js
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { createSuite, withRestoredFile } from "./lib/test-kit.js";
import {
  getPoolCooldownRemainingMs,
  getBaseMintCooldownRemainingMs,
} from "../state/pool-memory.js";
import { checkRepeatDeployCooldown } from "../guards/02-repeat-deploy-cooldown.js";

const POOL_MEMORY_FILE = repoPath("pool-memory.json");
const TEST_POOL = "TEST_COOLDOWN_REMAINING_POOL_DO_NOT_USE";
const TEST_POOL_2 = "TEST_COOLDOWN_REMAINING_POOL2_DO_NOT_USE";
const TEST_MINT = "TEST_COOLDOWN_REMAINING_MINT_DO_NOT_USE";

const suite = createSuite("Cooldown remaining-duration display (pool-memory.js + guards/02-repeat-deploy-cooldown.js)");
const { section, check } = suite;

function isoIn(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function writeDb(entries) {
  fs.writeFileSync(POOL_MEMORY_FILE, JSON.stringify(entries, null, 2));
}

withRestoredFile(POOL_MEMORY_FILE, () => {
  section("getPoolCooldownRemainingMs / getBaseMintCooldownRemainingMs");
  {
    writeDb({});
    check("no entry — pool remaining is 0", getPoolCooldownRemainingMs(TEST_POOL) === 0);
    check("no entry — base mint remaining is 0", getBaseMintCooldownRemainingMs(TEST_MINT) === 0);

    writeDb({
      [TEST_POOL]: { cooldown_until: isoIn(2 * 3_600_000), base_mint: TEST_MINT, base_mint_cooldown_until: isoIn(30 * 60_000) },
    });
    const poolRemaining = getPoolCooldownRemainingMs(TEST_POOL);
    check("pool cooldown remaining is ~2h", Math.abs(poolRemaining - 2 * 3_600_000) < 5000);
    const mintRemaining = getBaseMintCooldownRemainingMs(TEST_MINT);
    check("base mint cooldown remaining is ~30m", Math.abs(mintRemaining - 30 * 60_000) < 5000);

    // Expired cooldown — remaining is <= 0 (not used directly; guards only
    // call this accessor after isPoolOnCooldown/isBaseMintOnCooldown has
    // already confirmed the cooldown is still active).
    writeDb({ [TEST_POOL]: { cooldown_until: isoIn(-1000) } });
    check("expired pool cooldown reports <= 0 remaining", getPoolCooldownRemainingMs(TEST_POOL) <= 0);

    // Base-mint scan takes the MAX remaining across every matching entry.
    writeDb({
      [TEST_POOL]: { base_mint: TEST_MINT, base_mint_cooldown_until: isoIn(10 * 60_000) },
      [TEST_POOL_2]: { base_mint: TEST_MINT, base_mint_cooldown_until: isoIn(3 * 3_600_000) },
    });
    check("base mint remaining takes the MAX across matching pool entries", Math.abs(getBaseMintCooldownRemainingMs(TEST_MINT) - 3 * 3_600_000) < 5000);
  }

  section("checkRepeatDeployCooldown — formatted suffix + type field");
  {
    writeDb({ [TEST_POOL]: { cooldown_until: isoIn(2 * 3_600_000) } });
    let result = checkRepeatDeployCooldown(TEST_POOL, TEST_MINT);
    check("pool cooldown — blocked", result.blocked === true);
    check("pool cooldown — type is 'pool'", result.type === "pool");
    check("pool cooldown — reason includes hour suffix with negative sign", result.reason === "pool cooldown active (-2hr)");

    writeDb({ [TEST_POOL]: { base_mint: TEST_MINT, base_mint_cooldown_until: isoIn(45 * 60_000) } });
    result = checkRepeatDeployCooldown(TEST_POOL, TEST_MINT);
    check("token cooldown — blocked", result.blocked === true);
    check("token cooldown — type is 'token'", result.type === "token");
    check("token cooldown — reason includes minute suffix with negative sign", result.reason === "token cooldown active (-45mn)");

    writeDb({});
    result = checkRepeatDeployCooldown(TEST_POOL, TEST_MINT);
    check("no cooldown — not blocked, type null, reason null", result.blocked === false && result.type === null && result.reason === null);
  }

  section("suffix rounding — Math.ceil, minute/hour boundary at 60");
  {
    writeDb({ [TEST_POOL]: { cooldown_until: isoIn(59 * 60_000 + 30_000) } }); // 59m30s -> ceils to 60m -> displayed as hours
    let result = checkRepeatDeployCooldown(TEST_POOL, null);
    check("59m30s rounds up across the hour boundary to -1hr", result.reason === "pool cooldown active (-1hr)");

    writeDb({ [TEST_POOL]: { cooldown_until: isoIn(30_000) } }); // 30s -> ceils to 1m
    result = checkRepeatDeployCooldown(TEST_POOL, null);
    check("30s rounds up to -1mn (never -0mn)", result.reason === "pool cooldown active (-1mn)");
  }
});

process.exit(suite.finish());
