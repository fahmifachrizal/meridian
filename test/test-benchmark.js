/**
 * Benchmark test — replays test/fixtures/benchmark-positions.json (8 real
 * historical closed positions) against the CURRENT guards and
 * getDeterministicCloseRule, and asserts the system that exists today would
 * have caught (or at least mitigated) all 3 known big losses.
 *
 * Offline: reads only the static, pre-enriched fixture (pool_created_at,
 * deploy_sequence, and price_ohlcv_1m were fetched once by the scripts/
 * fetch-benchmark-*.js scripts and committed into the JSON) — no network
 * calls happen here.
 *
 * Known coverage gaps, by design (see test/fixtures/README.md):
 *  - `timeline` snapshots don't include active_bin/upper_bin or
 *    fee_per_tvl_24h, so rules 3 (pumped-above-range), 5 (OOR-wait), and 6
 *    (low-yield) can never fire in this replay — only rules 1 (stop-loss),
 *    2 (take-profit), and 4 (fast-exit) are replayable from recorded data.
 *    This is reported explicitly per-position, not hidden.
 *  - Guards #1 and #2 each have exactly one known false positive in this
 *    8-position sample: guard #1 (token-age window) would have blocked
 *    brain-SOL's 2nd deploy (a real win, inside the 6-30h cooldown zone);
 *    guard #2 (repeat-deploy cooldown) would have blocked Waddles-SOL's 3rd
 *    deploy (also a real win). Both are accepted trade-offs — cut the big
 *    losses, occasionally skip a legitimate repeat win — asserted as
 *    *expected* per-pool outcomes so they don't spuriously fail the gate,
 *    while any NEW unseen false positive still would.
 *
 * Run: node test/test-benchmark.js
 */

import { repoPath } from "../repo-root.js";
import { createSuite } from "./lib/test-kit.js";
import { config } from "../core/config.js";
import { getTokenAgeWindowRejectReason } from "../guards/01-token-age-window.js";
import { getDeterministicCloseRule } from "../index.js";
import fs from "fs";

const fixture = JSON.parse(fs.readFileSync(repoPath("test/fixtures/benchmark-positions.json"), "utf8"));
const suite = createSuite("Benchmark replay — real historical positions vs. current guards");
const { section, check } = suite;

// Mirrors pool-memory.js's isFeeGeneratingDeploy — reimplemented inline so
// this benchmark stays decoupled from that module's internals.
function isFeeGenerating(deploy, minFeeEarnedPct) {
  const feesUsd = Number(deploy.fees_earned_usd ?? 0);
  const feesSol = Number(deploy.fees_earned_sol ?? 0);
  const hasFees = feesUsd > 0 || feesSol > 0;
  if (!hasFees) return false;
  return Number(deploy.fee_earned_pct ?? 0) >= minFeeEarnedPct;
}

function wouldGuard1Block(pos) {
  if (pos.pool_age_hours_at_deploy == null) return null;
  const reason = getTokenAgeWindowRejectReason(
    Date.now() - pos.pool_age_hours_at_deploy * 3_600_000,
    config.screening,
  );
  return reason !== null;
}

function wouldGuard2Block(pos, poolMemory) {
  const triggerCount = config.management.repeatDeployCooldownTriggerCount;
  if (!config.management.repeatDeployCooldownEnabled) return false;
  if (pos.deploy_sequence == null || pos.deploy_sequence <= triggerCount) return false;
  const entry = poolMemory[pos.pool];
  if (!entry?.deploys) return null; // can't determine — insufficient data
  const priorDeploys = entry.deploys.slice(pos.deploy_sequence - 1 - triggerCount, pos.deploy_sequence - 1);
  if (priorDeploys.length < triggerCount) return null;
  const minFeeEarnedPct = config.management.repeatDeployCooldownMinFeeEarnedPct ?? 0;
  return priorDeploys.every((d) => isFeeGenerating(d, minFeeEarnedPct));
}

// Replays the recorded per-tick timeline through today's getDeterministicCloseRule.
// Only rules 1/2/4 can ever fire here — see file header for why.
function replayTimeline(pos) {
  const mgmt = config.management;
  for (const tick of pos.timeline ?? []) {
    const fakePosition = {
      pnl_pct: tick.pnl_pct,
      in_range: tick.in_range,
      minutes_out_of_range: tick.minutes_out_of_range,
      active_bin: null,
      upper_bin: null,
      fee_per_tvl_24h: null,
      stop_loss_pct_override: null,
    };
    const result = getDeterministicCloseRule(fakePosition, mgmt);
    if (result) return { ...result, tick };
  }
  return null;
}

const poolMemory = JSON.parse(fs.readFileSync(repoPath("pool-memory.json"), "utf8"));

for (const pos of fixture.positions) {
  if (pos.error) continue;
  section(`${pos.pool_name} (${pos.tag}) — actual: ${pos.outcome.close_reason} @ ${pos.outcome.pnl_pct}%`);

  const g1 = wouldGuard1Block(pos);
  const g2 = wouldGuard2Block(pos, poolMemory);
  const replay = replayTimeline(pos);

  console.log(`  guard #1 (token-age window, pool age ${pos.pool_age_hours_at_deploy?.toFixed(2)}h): ${g1 === null ? "insufficient data" : g1 ? "WOULD BLOCK" : "allows"}`);
  console.log(`  guard #2 (repeat-deploy cooldown, seq=${pos.deploy_sequence}): ${g2 === null ? "insufficient data" : g2 ? "WOULD BLOCK" : "allows"}`);
  console.log(`  timeline replay (rules 1/2/4 only): ${replay ? `rule ${replay.rule} "${replay.reason}" at age ${replay.tick.age_minutes}m` : "no rule fires (needs rule 3/5/6 data not captured historically)"}`);

  if (pos.tag === "big_loss") {
    const caught = g1 === true || g2 === true || replay !== null;
    check(`current system catches or mitigates this loss (guard1=${g1}, guard2=${g2}, replay=${!!replay})`, caught);
  }

  if (pos.tag.startsWith("win_")) {
    // Both guards have exactly one known, accepted false positive in this
    // 8-position sample (guard #1: brain-SOL, a legitimate early-repeat win
    // inside the age-cooldown zone; guard #2: Waddles-SOL, a 3rd-deploy
    // repeat that happened to still work out). Asserting the *expected*
    // per-pool outcome — not a blanket "never blocks a win" — means a NEW,
    // previously-unseen false positive still fails loudly, while these two
    // documented trade-offs don't spuriously break the gate.
    const expectedG1Block = pos.pool_name === "brain-SOL";
    const expectedG2Block = pos.pool_name === "Waddles-SOL";
    check(
      `guard #1 result matches expectation (${expectedG1Block ? "known accepted false positive" : "should not block"})`,
      g1 === expectedG1Block,
    );
    check(
      `guard #2 result matches expectation (${expectedG2Block ? "known accepted false positive" : "should not block"})`,
      g2 === expectedG2Block,
    );
  }
}

process.exit(suite.finish());
