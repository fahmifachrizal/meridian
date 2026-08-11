/**
 * QA protocol — pooled insurance withdrawal (tools/executor.js's
 * computeInsuranceWithdraw()).
 *
 * Five rules, driven by this position's own pnl_pct/pnl_usd and its own
 * insured contribution (contributedUsd = tracked.insurance_usdc_amount),
 * but the actual draw always comes from the aggregate pool (poolUsd),
 * capped at whatever's there:
 *   1. profit >= 1%              -> 0 (keep everything, pool grows)
 *   2. 0% <= profit < 1%          -> top up the shortfall vs this
 *      position's own contribution: max(0, contributedUsd - pnlUsd)
 *   3. mild loss (trigger < p < 0%) -> withdraw the position's own
 *      contribution in full, not netted against the loss size
 *   4. severe loss (p <= stopLossPct * triggerFraction) -> cover the
 *      loss, capped at pool
 *   5. pool is empty (or negative) -> 0, always, checked first
 *
 * Pure function, no I/O, no wallet/network — safe to run offline.
 * Run: node test/test-insurance.js
 */

import { createSuite } from "./lib/test-kit.js";
import { computeInsuranceWithdraw } from "../tools/executor.js";

const suite = createSuite("QA protocol — pooled insurance withdrawal");
const { section, check } = suite;

const BASE = { stopLossPct: -15, triggerFraction: 0.5 }; // trigger = -7.5%

section("Zero-pool guard — nothing accumulated yet (rule 5)");
{
  check("null pool -> 0", computeInsuranceWithdraw({ ...BASE, poolUsd: null, pnlUsd: -10, pnlPct: -20, contributedUsd: 0.35 }) === 0);
  check("zero pool -> 0", computeInsuranceWithdraw({ ...BASE, poolUsd: 0, pnlUsd: -10, pnlPct: -20, contributedUsd: 0.35 }) === 0);
  check("negative pool (shouldn't happen, but fail safe) -> 0", computeInsuranceWithdraw({ ...BASE, poolUsd: -5, pnlUsd: -10, pnlPct: -20, contributedUsd: 0.35 }) === 0);
}

section("Missing PnL data — can't evaluate, fail safe to 0");
{
  check("pnlUsd null -> 0", computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: null, pnlPct: -20, contributedUsd: 0.35 }) === 0);
  check("pnlPct null -> 0", computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: -10, pnlPct: null, contributedUsd: 0.35 }) === 0);
}

section("Rule 1 — profit >= 1%, no withdraw");
{
  check("clear win draws 0", computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: 5, pnlPct: 5, contributedUsd: 0.35 }) === 0);
  check("exactly at the 1% boundary draws 0", computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: 0.35, pnlPct: 1, contributedUsd: 0.35 }) === 0);
}

section("Rule 2 — 0% <= profit < 1%, top up shortfall vs own contribution");
{
  check("small win under 1% tops up the shortfall", Math.abs(computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: 0.18, pnlPct: 0.53, contributedUsd: 0.35 }) - 0.17) < 1e-9);
  check("breakeven (p=0) withdraws the full contribution", computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: 0, pnlPct: 0, contributedUsd: 0.35 }) === 0.35);
  check("profit already exceeds the contribution -> no top-up needed", computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: 0.5, pnlPct: 0.8, contributedUsd: 0.35 }) === 0);
  check("top-up capped at a thin pool", computeInsuranceWithdraw({ ...BASE, poolUsd: 0.1, pnlUsd: 0, pnlPct: 0, contributedUsd: 0.35 }) === 0.1);
}

section("Rule 3 — mild loss (trigger < p < 0%), withdraw own contribution in full");
{
  check("mild loss withdraws the full contribution regardless of loss size", computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: -0.19, pnlPct: -3, contributedUsd: 0.35 }) === 0.35);
  check("just inside the trigger (-7.49%, still mild) withdraws the contribution", computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: -0.5, pnlPct: -7.49, contributedUsd: 0.35 }) === 0.35);
  check("mild loss capped at a thin pool", computeInsuranceWithdraw({ ...BASE, poolUsd: 0.1, pnlUsd: -0.19, pnlPct: -3, contributedUsd: 0.35 }) === 0.1);
  check("zero contribution (pre-insurance position) mild loss withdraws 0", computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: -0.19, pnlPct: -3, contributedUsd: 0 }) === 0);
}

section("Rule 4 — severe loss (p <= trigger), cover the loss capped at pool");
{
  const w = computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: -7.51, pnlPct: -19.4, contributedUsd: 0.35 });
  check("draws exactly the loss amount ($7.51)", Math.abs(w - 7.51) < 1e-9);

  const w2 = computeInsuranceWithdraw({ ...BASE, poolUsd: 100, pnlUsd: -6.315, pnlPct: -16.8, contributedUsd: 0.35 });
  check("draws exactly the median severe loss ($6.315), pool has plenty left", Math.abs(w2 - 6.315) < 1e-9);

  check("exactly AT the trigger boundary counts as severe", computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: -0.5, pnlPct: -7.5, contributedUsd: 0.35 }) === 0.5);
  check("severe-loss draw is independent of this position's own contribution", computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: -0.5, pnlPct: -7.5, contributedUsd: 0 }) === 0.5);
}

section("Rule 4 — severe loss, thin pool (cold-start) — capped partial draw");
{
  const w = computeInsuranceWithdraw({ ...BASE, poolUsd: 2, pnlUsd: -7.51, pnlPct: -19.4, contributedUsd: 0.35 });
  check("caps at the pool balance, not the full loss", w === 2);

  const w2 = computeInsuranceWithdraw({ ...BASE, poolUsd: 0.17, pnlUsd: -19.6, pnlPct: -44.21, contributedUsd: 0.35 });
  check("even the worst historical loss only draws what the thin pool has", w2 === 0.17);
}

section("Trigger scales with stopLossPct / triggerFraction (rules 3 vs 4 boundary)");
{
  // A tighter stop-loss (-10%) with the same 0.5 fraction -> trigger -5%.
  const tighter = { stopLossPct: -10, triggerFraction: 0.5 };
  check("a -6% loss is severe under a -5% trigger", computeInsuranceWithdraw({ ...tighter, poolUsd: 8, pnlUsd: -0.6, pnlPct: -6, contributedUsd: 0.35 }) === 0.6);
  check("the same -6% loss is mild (not severe) under the default -7.5% trigger", computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: -0.6, pnlPct: -6, contributedUsd: 0.35 }) === 0.35);

  // A different fraction changes the trigger independent of stopLossPct.
  const looser = { stopLossPct: -15, triggerFraction: 0.8 }; // trigger -12%
  check("a -10% loss is mild under a stricter 0.8 fraction (-12% trigger)", computeInsuranceWithdraw({ ...looser, poolUsd: 8, pnlUsd: -1, pnlPct: -10, contributedUsd: 0.35 }) === 0.35);
  check("a -13% loss IS severe under that same 0.8 fraction", computeInsuranceWithdraw({ ...looser, poolUsd: 8, pnlUsd: -1.3, pnlPct: -13, contributedUsd: 0.35 }) === 1.3);
}

process.exit(suite.finish());
