/**
 * QA protocol — pooled insurance withdrawal (tools/executor.js's
 * computeInsuranceWithdraw()).
 *
 * At the sized-down 1% skim (see the plan that introduced this — 47.3
 * wins per big loss historically, six sizing methods landing 0.25%-0.6%),
 * a single position's own contribution (~$0.17 on a typical deploy) can't
 * meaningfully offset a real loss. The mechanism only works pooled: most
 * closes draw nothing, letting the shared wallet USDC balance accumulate,
 * and only a severe loss (pnl_pct <= stopLossPct * triggerFraction) draws
 * on that aggregate — capped at whatever's actually there, since early on
 * (before ~47 wins have accrued) the pool may only partially cover it.
 *
 * Pure function, no I/O, no wallet/network — safe to run offline.
 * Run: node test/test-insurance.js
 */

import { createSuite } from "./lib/test-kit.js";
import { computeInsuranceWithdraw } from "../tools/executor.js";

const suite = createSuite("QA protocol — pooled insurance withdrawal");
const { section, check } = suite;

const BASE = { stopLossPct: -15, triggerFraction: 0.5 }; // trigger = -7.5%

section("Zero-pool guard — nothing accumulated yet");
{
  check("null pool -> 0", computeInsuranceWithdraw({ ...BASE, poolUsd: null, pnlUsd: -10, pnlPct: -20 }) === 0);
  check("zero pool -> 0", computeInsuranceWithdraw({ ...BASE, poolUsd: 0, pnlUsd: -10, pnlPct: -20 }) === 0);
  check("negative pool (shouldn't happen, but fail safe) -> 0", computeInsuranceWithdraw({ ...BASE, poolUsd: -5, pnlUsd: -10, pnlPct: -20 }) === 0);
}

section("Missing PnL data — can't evaluate, fail safe to 0");
{
  check("pnlUsd null -> 0", computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: null, pnlPct: -20 }) === 0);
  check("pnlPct null -> 0", computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: -10, pnlPct: null }) === 0);
}

section("Non-severe outcomes — no draw, pool keeps accumulating");
{
  check("a win draws 0", computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: 0.18, pnlPct: 0.53 }) === 0);
  check("a mild loss, better than the -7.5% trigger, draws 0", computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: -0.19, pnlPct: -3 }) === 0);
  check("exactly at the trigger boundary minus a hair (not yet severe) draws 0", computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: -0.5, pnlPct: -7.49 }) === 0);
}

section("Severe loss, well-funded pool — full breakeven draw");
{
  // Pool at $8 (~47 skims of the ~$0.17 typical contribution), hit by the
  // historical mean severe loss (-$7.51 at -19.4% avg pnl_pct).
  const w = computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: -7.51, pnlPct: -19.4 });
  check("draws exactly the loss amount ($7.51)", Math.abs(w - 7.51) < 1e-9);

  const w2 = computeInsuranceWithdraw({ ...BASE, poolUsd: 100, pnlUsd: -6.315, pnlPct: -16.8 });
  check("draws exactly the median severe loss ($6.315), pool has plenty left", Math.abs(w2 - 6.315) < 1e-9);

  check("exactly AT the trigger boundary counts as severe", computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: -0.5, pnlPct: -7.5 }) === 0.5);
}

section("Severe loss, thin pool (cold-start) — capped partial draw");
{
  // Right after enabling the feature, before ~47 wins have accumulated.
  const w = computeInsuranceWithdraw({ ...BASE, poolUsd: 2, pnlUsd: -7.51, pnlPct: -19.4 });
  check("caps at the pool balance, not the full loss", w === 2);

  const w2 = computeInsuranceWithdraw({ ...BASE, poolUsd: 0.17, pnlUsd: -19.6, pnlPct: -44.21 });
  check("even the worst historical loss only draws what the thin pool has", w2 === 0.17);
}

section("Trigger scales with stopLossPct / triggerFraction");
{
  // A tighter stop-loss (-10%) with the same 0.5 fraction -> trigger -5%.
  const tighter = { stopLossPct: -10, triggerFraction: 0.5 };
  check("a -6% loss is severe under a -5% trigger", computeInsuranceWithdraw({ ...tighter, poolUsd: 8, pnlUsd: -0.6, pnlPct: -6 }) === 0.6);
  check("the same -6% loss is NOT severe under the default -7.5% trigger", computeInsuranceWithdraw({ ...BASE, poolUsd: 8, pnlUsd: -0.6, pnlPct: -6 }) === 0);

  // A different fraction changes the trigger independent of stopLossPct.
  const looser = { stopLossPct: -15, triggerFraction: 0.8 }; // trigger -12%
  check("a -10% loss is not severe under a stricter 0.8 fraction (-12% trigger)", computeInsuranceWithdraw({ ...looser, poolUsd: 8, pnlUsd: -1, pnlPct: -10 }) === 0);
  check("a -13% loss IS severe under that same 0.8 fraction", computeInsuranceWithdraw({ ...looser, poolUsd: 8, pnlUsd: -1.3, pnlPct: -13 }) === 1.3);
}

process.exit(suite.finish());
