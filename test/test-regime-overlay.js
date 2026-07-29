/**
 * QA protocol — bounded regime overlay contract tests.
 *
 * The regime system's safety contract, in one place. The overlay is the ONLY
 * way the agent is allowed to alter live config, and these tests lock in the
 * two properties that keep it from losing money:
 *
 *   1. RISK RATCHET — a regime may only ever reduce risk exposure relative to
 *      the user's baseline (Supabase/user-config.json). It can never deploy
 *      more SOL, size up, or widen a stop-loss beyond what the user set.
 *   2. BOUNDED SCREENING — a regime may loosen or tighten screening bars, but
 *      always inside hard clamps derived from baseline, so it can never
 *      overshoot into "accept anything" (loss) or "accept nothing" (stall).
 *
 * Offline, no network, no wallet, no file writes.
 * Run: node test/test-regime-overlay.js
 */

import { createSuite } from "./lib/test-kit.js";
import { CONFIG_MAP } from "../tools/executor.js";
import {
  REGIME_TUNABLE,
  RISK_KEYS,
  SCREENING_KEYS,
  computeRegimeOverlay,
} from "../regime-overlay.js";

const suite = createSuite("QA protocol — bounded regime overlay");
const { section, check } = suite;

// A representative baseline — stands in for the user's Supabase ideal.
const BASELINE = {
  minTvl: 10000,
  minVolume: 1000,
  minFeeActiveTvlRatio: 0.05,
  minOrganic: 60,
  deployAmountSol: 0.6,
  positionSizePct: 0.35,
  stopLossPct: -15,
  takeProfitPct: 5,
};

// ─── 1. Whitelist integrity ──────────────────────────────────────
section("Tunable whitelist integrity");
{
  const tunableKeys = Object.keys(REGIME_TUNABLE);
  check("whitelist is non-empty", tunableKeys.length > 0);
  check(
    "every tunable key is a real CONFIG_MAP key (no silent no-op)",
    tunableKeys.every((k) => Boolean(CONFIG_MAP[k])),
  );
  check(
    "RISK_KEYS and SCREENING_KEYS partition the whitelist exactly",
    [...RISK_KEYS, ...SCREENING_KEYS].sort().join(",") === tunableKeys.sort().join(",") &&
      RISK_KEYS.every((k) => !SCREENING_KEYS.includes(k)),
  );
  check(
    "maxPositions is NOT tunable (portfolio-level cap stays user-owned)",
    !tunableKeys.includes("maxPositions"),
  );
  check(
    "maxDeployAmount is NOT tunable (hard ceiling stays user-owned)",
    !tunableKeys.includes("maxDeployAmount"),
  );
}

// ─── 2. normal == baseline, exactly ──────────────────────────────
section("normal regime is a true no-op");
{
  const overlay = computeRegimeOverlay("normal", BASELINE);
  check("normal produces an empty overlay", Object.keys(overlay).length === 0);
}

// ─── 3. THE RISK RATCHET ─────────────────────────────────────────
// The single most important invariant: no regime, ever, may increase
// risk exposure above the user's baseline.
section("Risk ratchet — no regime may ever increase exposure");
for (const regime of ["slow", "hot"]) {
  const o = computeRegimeOverlay(regime, BASELINE);

  check(
    `${regime}: deployAmountSol never exceeds baseline`,
    (o.deployAmountSol ?? BASELINE.deployAmountSol) <= BASELINE.deployAmountSol,
  );
  check(
    `${regime}: positionSizePct never exceeds baseline`,
    (o.positionSizePct ?? BASELINE.positionSizePct) <= BASELINE.positionSizePct,
  );
  // stopLossPct is negative; "looser" means MORE negative. Never allowed.
  check(
    `${regime}: stopLossPct never looser (more negative) than baseline`,
    (o.stopLossPct ?? BASELINE.stopLossPct) >= BASELINE.stopLossPct,
  );
  check(
    `${regime}: deployAmountSol stays positive`,
    (o.deployAmountSol ?? BASELINE.deployAmountSol) > 0,
  );
  check(
    `${regime}: positionSizePct stays positive`,
    (o.positionSizePct ?? BASELINE.positionSizePct) > 0,
  );
}

// ─── 4. Directional semantics ────────────────────────────────────
// "tighten when volatile, loosen when slow" — on SCREENING bars.
section("Directional semantics — hot tightens, slow loosens (screening)");
{
  const hot = computeRegimeOverlay("hot", BASELINE);
  const slow = computeRegimeOverlay("slow", BASELINE);

  check("hot raises minTvl (demand deeper liquidity)", hot.minTvl > BASELINE.minTvl);
  check("hot raises minFeeActiveTvlRatio (demand real fee yield)", hot.minFeeActiveTvlRatio > BASELINE.minFeeActiveTvlRatio);
  check("hot raises minOrganic (demand cleaner holders)", hot.minOrganic > BASELINE.minOrganic);

  check("slow lowers minTvl (accept thinner pools)", slow.minTvl < BASELINE.minTvl);
  check("slow lowers minFeeActiveTvlRatio", slow.minFeeActiveTvlRatio < BASELINE.minFeeActiveTvlRatio);
  check("slow lowers minOrganic", slow.minOrganic < BASELINE.minOrganic);

  // The volatile market is where the SalaryCat-style loss happened: size down.
  check("hot sizes DOWN vs slow (volatility = smaller bets)", hot.positionSizePct < slow.positionSizePct);
}

// ─── 5. Clamps — no overshoot in either direction ────────────────
section("Clamps hold against absurd baselines");
{
  const tiny = { ...BASELINE, minTvl: 1, minVolume: 1, minOrganic: 1, positionSizePct: 0.01, deployAmountSol: 0.01 };
  const huge = { ...BASELINE, minTvl: 10_000_000, minVolume: 10_000_000, minOrganic: 99, positionSizePct: 0.99, deployAmountSol: 40 };

  for (const [label, base] of [["tiny", tiny], ["huge", huge]]) {
    for (const regime of ["slow", "hot"]) {
      const o = computeRegimeOverlay(regime, base);
      const allFinite = Object.values(o).every((v) => Number.isFinite(v));
      check(`${label}/${regime}: every overlay value is finite`, allFinite);
      check(
        `${label}/${regime}: organic stays in a sane [40,95] band`,
        o.minOrganic === undefined || (o.minOrganic >= 40 && o.minOrganic <= 95),
      );
      check(
        `${label}/${regime}: risk ratchet still holds`,
        (o.deployAmountSol ?? base.deployAmountSol) <= base.deployAmountSol &&
          (o.positionSizePct ?? base.positionSizePct) <= base.positionSizePct,
      );
    }
  }
}

// ─── 6. Purity — overlay computes, never persists ────────────────
section("Overlay is pure");
{
  const before = JSON.stringify(BASELINE);
  computeRegimeOverlay("hot", BASELINE);
  computeRegimeOverlay("slow", BASELINE);
  check("computeRegimeOverlay does not mutate the baseline it is given", JSON.stringify(BASELINE) === before);

  const unknown = computeRegimeOverlay("nonsense-regime", BASELINE);
  check("unknown regime id yields an empty overlay (fails safe)", Object.keys(unknown).length === 0);
  const nullish = computeRegimeOverlay(null, BASELINE);
  check("null regime yields an empty overlay (fails safe)", Object.keys(nullish).length === 0);
}

process.exit(suite.finish());
