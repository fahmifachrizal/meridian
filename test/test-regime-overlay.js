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
} from "../regime/regime-overlay.js";

const suite = createSuite("QA protocol — bounded regime overlay");
const { section, check } = suite;

// A representative baseline — stands in for the user's Supabase ideal.
// Includes a couple of non-tunable keys (minFeeActiveTvlRatio,
// positionSizePct, stopLossPct, takeProfitPct) deliberately, so the tests
// below can assert the overlay never touches them, not just that it CAN'T
// (they're not even in REGIME_TUNABLE) but that a baseline containing them
// doesn't accidentally leak them into an overlay some other way.
const BASELINE = {
  minTvl: 10000,
  minVolume: 1000,
  minOrganic: 60,
  deployAmountSol: 0.6,
  // Present in baseline, but intentionally NOT regime-tunable:
  minFeeActiveTvlRatio: 0.05,
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
  check(
    "minFeeActiveTvlRatio is NOT tunable (operator-owned, unconditionally)",
    !tunableKeys.includes("minFeeActiveTvlRatio"),
  );
  check(
    "positionSizePct is NOT tunable (deploy sizing beyond deployAmountSol stays operator-owned)",
    !tunableKeys.includes("positionSizePct"),
  );
  check(
    "stopLossPct is NOT tunable (exit rules stay operator-owned)",
    !tunableKeys.includes("stopLossPct"),
  );
  check(
    "takeProfitPct is NOT tunable (exit rules stay operator-owned)",
    !tunableKeys.includes("takeProfitPct"),
  );
  check(
    "deployAmountSol is the ONLY tunable risk key",
    RISK_KEYS.length === 1 && RISK_KEYS[0] === "deployAmountSol",
  );
}

// ─── 2. normal == baseline, exactly — EXCEPT keys that opt in ────
section("normal regime is a no-op for every key except explicit opt-ins");
{
  const overlay = computeRegimeOverlay("normal", BASELINE);
  const nonOptIns = Object.keys(overlay).filter((k) => k !== "deployAmountSol");
  check("normal produces no overlay for keys without an explicit normal: factor", nonOptIns.length === 0);
  check("deployAmountSol DOES opt in to a normal-regime factor", overlay.deployAmountSol !== undefined);
}

// ─── 2b. deployAmountSol's explicit 3-way regime sizing ──────────
// Operator policy: full size in hot, 85% in normal, 70% in slow/cool —
// deliberately inverted from the old "size down when volatile" default,
// see REGIME_TUNABLE's comment on this key for why.
section("deployAmountSol — explicit hot/normal/slow sizing factors");
{
  const hot = computeRegimeOverlay("hot", BASELINE);
  const normal = computeRegimeOverlay("normal", BASELINE);
  const slow = computeRegimeOverlay("slow", BASELINE);

  check("hot = 100% of baseline", hot.deployAmountSol === BASELINE.deployAmountSol);
  check("normal = 85% of baseline", Math.abs(normal.deployAmountSol - BASELINE.deployAmountSol * 0.85) < 1e-9);
  check("slow = 70% of baseline", Math.abs(slow.deployAmountSol - BASELINE.deployAmountSol * 0.70) < 1e-9);
  check("hot > normal > slow (monotonic across regimes)", hot.deployAmountSol > normal.deployAmountSol && normal.deployAmountSol > slow.deployAmountSol);
}

// ─── 3. THE RISK RATCHET ─────────────────────────────────────────
// The single most important invariant: no regime, ever, may increase
// risk exposure above the user's baseline.
section("Risk ratchet — no regime may ever increase exposure");
for (const regime of ["slow", "normal", "hot"]) {
  const o = computeRegimeOverlay(regime, BASELINE);

  check(
    `${regime}: deployAmountSol never exceeds baseline`,
    (o.deployAmountSol ?? BASELINE.deployAmountSol) <= BASELINE.deployAmountSol,
  );
  check(
    `${regime}: deployAmountSol stays positive`,
    (o.deployAmountSol ?? BASELINE.deployAmountSol) > 0,
  );
  // Regression guard for the scoped-down whitelist: none of these four keys
  // should EVER appear in an overlay, in any regime, even though the
  // baseline object above carries values for them.
  check(
    `${regime}: minFeeActiveTvlRatio never appears in the overlay`,
    o.minFeeActiveTvlRatio === undefined,
  );
  check(
    `${regime}: positionSizePct never appears in the overlay`,
    o.positionSizePct === undefined,
  );
  check(
    `${regime}: stopLossPct never appears in the overlay`,
    o.stopLossPct === undefined,
  );
  check(
    `${regime}: takeProfitPct never appears in the overlay`,
    o.takeProfitPct === undefined,
  );
}

// ─── 4. Directional semantics ────────────────────────────────────
// "tighten when volatile, loosen when slow" — on SCREENING bars.
section("Directional semantics — hot tightens, slow loosens (screening)");
{
  const hot = computeRegimeOverlay("hot", BASELINE);
  const slow = computeRegimeOverlay("slow", BASELINE);

  check("hot raises minTvl (demand deeper liquidity)", hot.minTvl > BASELINE.minTvl);
  check("hot raises minOrganic (demand cleaner holders)", hot.minOrganic > BASELINE.minOrganic);

  check("slow lowers minTvl (accept thinner pools)", slow.minTvl < BASELINE.minTvl);
  check("slow lowers minOrganic", slow.minOrganic < BASELINE.minOrganic);

  // deployAmountSol's own policy (not "size down when volatile" — see section 2b):
  check("hot sizes deployAmountSol UP vs slow (full size in hot, per operator policy)", hot.deployAmountSol > slow.deployAmountSol);
}

// ─── 5. Clamps — no overshoot in either direction ────────────────
section("Clamps hold against absurd baselines");
{
  const tiny = { ...BASELINE, minTvl: 1, minVolume: 1, minOrganic: 1, deployAmountSol: 0.01 };
  const huge = { ...BASELINE, minTvl: 10_000_000, minVolume: 10_000_000, minOrganic: 99, deployAmountSol: 40 };

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
        (o.deployAmountSol ?? base.deployAmountSol) <= base.deployAmountSol,
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
