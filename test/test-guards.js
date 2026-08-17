/**
 * Offline unit tests for the SalaryCat-SOL post-mortem guards.
 * No network, no wallet. Touches pool-memory.json with fake pool addresses
 * only, and restores the file to its exact pre-test content afterward.
 * Run: node test/test-guards.js
 */

import { repoPath } from "../repo-root.js";
import { createSuite, withRestoredFile } from "./lib/test-kit.js";
import { getTokenAgeWindowRejectReason } from "../guards/01-token-age-window.js";
import { checkRejectionHysteresis } from "../guards/03-rejection-hysteresis.js";
import { getWeekendSessionBoundsWIB, isWeekendNightWIB, getWeekendFreshRepeatRejectReason } from "../guards/08-weekend-fresh-repeat.js";
import {
  recordRejection,
  getRecentRejectionCount,
  recordTvlObservation,
  getPriorTvlObservation,
} from "../state/pool-memory.js";

const POOL_MEMORY_FILE = repoPath("pool-memory.json");
const FAKE_POOL_HYSTERESIS = "TEST_GUARD_POOL_HYSTERESIS_DO_NOT_USE";
const FAKE_POOL_TVL = "TEST_GUARD_POOL_TVL_DO_NOT_USE";

const suite = createSuite("Post-mortem guards (SalaryCat-SOL)");
const { section, check } = suite;

// ─── Guard #1: token-age deploy window ──────────────────────────
section("Guard #1: token-age deploy window (6h early / 24h cooldown)");
{
  const s = { tokenAgeWindowEnabled: true, tokenEarlyWindowMaxHours: 6, tokenCooldownHours: 24 };
  const now = Date.now();
  const ageHours = (h) => now - h * 3_600_000;

  check("1h old — allowed (early momentum)", getTokenAgeWindowRejectReason(ageHours(1), s) === null);
  check("5h old — allowed (early momentum)", getTokenAgeWindowRejectReason(ageHours(5), s) === null);
  // Exactly 6h is the instant the early window closes — same-millisecond
  // clock reads can make this boundary land either side (Date.now() only
  // moves forward between snapshot and check), so test just under it.
  check("6h-1s old — allowed (still in early window)", getTokenAgeWindowRejectReason(now - (6 * 3_600_000 - 1000), s) === null);
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

// ─── Guard #3: rejection hysteresis + Guard #4: TVL decline ──────
// Both touch pool-memory.json with fake pool addresses — one snapshot/
// restore wraps both so a failure partway through still cleans up.
withRestoredFile(POOL_MEMORY_FILE, () => {
  section("Guard #3: rejection hysteresis");
  check("no rejections recorded yet", getRecentRejectionCount(FAKE_POOL_HYSTERESIS, "bot_holders_pct", 24) === 0);

  recordRejection(FAKE_POOL_HYSTERESIS, "bot_holders_pct", 36);
  recordRejection(FAKE_POOL_HYSTERESIS, "bot_holders_pct", 38);
  check("2 same-reason rejections counted", getRecentRejectionCount(FAKE_POOL_HYSTERESIS, "bot_holders_pct", 24) === 2);
  check("different reason key not counted", getRecentRejectionCount(FAKE_POOL_HYSTERESIS, "top10pct", 24) === 0);

  // The SalaryCat-era pattern (2 rejections tightening a 35% cap to 30%,
  // catching a 34% pass) now applies to top10pct ONLY — bot-holders%
  // deliberately never gets this tightening (operator decision), see below.
  // getRecentRejectionCount/recordRejection stay generic, reason-agnostic
  // storage primitives (used here to confirm they still work for any
  // reasonKey); the behavior difference lives entirely in the guard itself.
  const screeningConfig = { maxBotHoldersPct: 35, maxTop10Pct: 35, hysteresisRejectionCount: 2, hysteresisWindowHours: 24, hysteresisMarginPct: 5 };
  const fakePool = { pool: FAKE_POOL_HYSTERESIS, name: "TEST_POOL" };

  // Bot-holders: 2 prior rejections already recorded above, but the raw cap
  // must still apply, un-tightened — 34% is BELOW the raw 35% cap, so it
  // should pass clean, not get caught by a phantom tightened cap.
  const botResult = checkRejectionHysteresis(fakePool, { audit: { bot_holders_pct: 34 } }, screeningConfig);
  check("bot-holders 34% passes at the raw (untightened) 35% cap despite 2 prior rejections", botResult.blocked === false);
  const botResultOverRaw = checkRejectionHysteresis(fakePool, { audit: { bot_holders_pct: 36 } }, screeningConfig);
  check("bot-holders 36% still blocked by the raw 35% cap itself (not hysteresis)", botResultOverRaw.blocked === true && !botResultOverRaw.reason.includes("hysteresis"));

  // top10pct: hysteresis is still live — 2 prior rejections tighten 35%→30%,
  // so a 34% pass (under the raw cap) should still be caught.
  recordRejection(FAKE_POOL_HYSTERESIS, "top10pct", 36);
  recordRejection(FAKE_POOL_HYSTERESIS, "top10pct", 38);
  const top10Result = checkRejectionHysteresis(fakePool, { audit: { top_holders_pct: 34 } }, screeningConfig);
  check("top10pct 34% still caught by the tightened 30% cap after 2 prior rejections", top10Result.blocked === true && top10Result.reason.includes("hysteresis"));

  section("Guard #4: TVL/mcap decline check");
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
});
console.log("  (restored pool-memory.json to pre-test content)");

// ─── Guard #8: weekend fresh-token repeat block ─────────────────
section("Guard #8: weekend fresh-token repeat block (Sat 18:00 -> Mon 04:00 WIB)");
{
  const s = { weekendGuardEnabled: true, weekendGuardMaxFreshAgeHours: 6, weekendGuardStartDow: 6, weekendGuardStartHour: 18, weekendGuardEndDow: 1, weekendGuardEndHour: 4 };
  // Build a Date whose WIB (UTC+7) wall-clock reads y-m-d h:mi.
  const wib = (y, m, d, h, mi = 0) => new Date(Date.UTC(y, m - 1, d, h, mi) - 7 * 3_600_000);

  section("getWeekendSessionBoundsWIB / isWeekendNightWIB");
  {
    const satNight = wib(2026, 8, 15, 20, 0); // Sat 20:00 WIB
    const { start, end } = getWeekendSessionBoundsWIB(satNight, s);
    check("session starts Sat 18:00 WIB", start.getTime() === wib(2026, 8, 15, 18, 0).getTime());
    check("session ends Mon 04:00 WIB", end.getTime() === wib(2026, 8, 17, 4, 0).getTime());

    check("Sat 20:00 WIB is in the window", isWeekendNightWIB(satNight, s));
    check("Sun 03:00 WIB (early hours) is in the window", isWeekendNightWIB(wib(2026, 8, 16, 3, 0), s));
    check("Mon 03:00 WIB (still before 04:00 cutoff) is in the window", isWeekendNightWIB(wib(2026, 8, 17, 3, 0), s));
    check("Mon 05:00 WIB (past the cutoff) is NOT in the window", !isWeekendNightWIB(wib(2026, 8, 17, 5, 0), s));
    check("Wed 12:00 WIB (midweek) is NOT in the window", !isWeekendNightWIB(wib(2026, 8, 19, 12, 0), s));
    check("Fri 23:00 WIB (before the Sat 18:00 open) is NOT in the window", !isWeekendNightWIB(wib(2026, 8, 14, 23, 0), s));
  }

  section("getWeekendFreshRepeatRejectReason");
  {
    const now = wib(2026, 8, 15, 20, 24); // matches WORM-SOL's real 3rd-leg time
    const baseMint = "TEST_GUARD_MINT_DO_NOT_USE";

    check("disabled -> always allowed", getWeekendFreshRepeatRejectReason({ now, baseMint, priorDeploysThisSession: [{ pool_age_hours_at_deploy: 1 }], s: { ...s, weekendGuardEnabled: false } }) === null);
    check("no base_mint -> allowed (fails open)", getWeekendFreshRepeatRejectReason({ now, baseMint: null, priorDeploysThisSession: [{ pool_age_hours_at_deploy: 1 }], s }) === null);

    const midweekNow = wib(2026, 8, 19, 12, 0);
    check("outside the weekend window -> allowed regardless of history", getWeekendFreshRepeatRejectReason({ now: midweekNow, baseMint, priorDeploysThisSession: [{ pool_age_hours_at_deploy: 0.5 }], s }) === null);

    check("first deploy this session (no prior history) -> allowed", getWeekendFreshRepeatRejectReason({ now, baseMint, priorDeploysThisSession: [], s }) === null);

    const priorNotFresh = [{ pool_age_hours_at_deploy: 8.2, deployed_at: "2026-08-15T18:30:00Z" }];
    check("prior deploy existed but started >6h old -> allowed (that token was never 'fresh' this session)", getWeekendFreshRepeatRejectReason({ now, baseMint, priorDeploysThisSession: priorNotFresh, s }) === null);

    // WORM-SOL's actual shape: 2 prior legs, the first (0.77h old) was fresh.
    const wormPriors = [
      { pool_age_hours_at_deploy: 0.77, deployed_at: "2026-08-15T18:28:00Z" },
      { pool_age_hours_at_deploy: 0.99, deployed_at: "2026-08-15T19:04:00Z" },
    ];
    const wormReason = getWeekendFreshRepeatRejectReason({ now, baseMint, priorDeploysThisSession: wormPriors, s });
    check("a prior fresh-session-open deploy blocks the repeat", wormReason !== null);
    check("reject reason names the trigger", wormReason.includes("weekend fresh-repeat guard"));

    // SalaryCat-SOL's actual shape: repeat itself is 7.84h old (past the 6h
    // cutoff), but the session-opening deploy was 4.37h old — must still block.
    const salaryCatPriors = [
      { pool_age_hours_at_deploy: 4.37, deployed_at: "2026-07-27T00:02:00Z" },
      { pool_age_hours_at_deploy: 5.85, deployed_at: "2026-07-27T02:14:00Z" },
    ];
    const salaryCatReason = getWeekendFreshRepeatRejectReason({ now: wib(2026, 7, 27, 3, 19), baseMint, priorDeploysThisSession: salaryCatPriors, s });
    check("locked-in freshness still blocks even once the repeat itself has aged past 6h", salaryCatReason !== null);
  }
}

process.exit(suite.finish());
