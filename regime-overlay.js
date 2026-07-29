/**
 * Bounded, in-memory regime overlay.
 *
 * WHY THIS EXISTS
 * ---------------
 * The first version of the regime system handed a profile's absolute `changes`
 * map straight to applyConfigChanges(), which (a) persisted to user-config.json
 * and pushed to Supabase, and (b) could set any CONFIG_MAP key to any value.
 * That let an automated market read permanently overwrite the operator's own
 * risk settings — and in the "hot" profile it sized UP and widened the stop-loss
 * in exactly the volatile conditions that produced the worst historical loss.
 *
 * This module replaces that with an overlay that is:
 *   - DERIVED  — always computed from the operator's baseline, never absolute.
 *   - BOUNDED  — every key has hard clamps; no overshoot in either direction.
 *   - RATCHETED — risk keys may only ever move toward LESS exposure than
 *     baseline. The agent can protect capital; it can never bet more than the
 *     operator authorized.
 *   - EPHEMERAL — applied to the live in-memory config only. Never written to
 *     user-config.json, never pushed to Supabase. Supabase is the operator's
 *     source of truth and is pull-only for the agent.
 *
 * Direction of travel (the "first principle" encoded):
 *   hot / volatile → TIGHTEN screening (plenty of choice, be picky),
 *                    SIZE DOWN (volatility is where positions go out of range
 *                    and losses compound).
 *   slow           → LOOSEN screening (scarce choice, accept thinner pools),
 *                    size slightly down and take profit earlier (low fee yield
 *                    means there is less to wait for).
 *   normal         → exact baseline, no overlay at all.
 */

import fs from "fs";

const MULT = "mult";
const DELTA = "delta";

/**
 * The complete set of keys a regime is allowed to touch. Anything not listed
 * here is beyond the agent's reach and stays exactly as the operator set it —
 * notably maxPositions and maxDeployAmount, the two portfolio-level ceilings.
 *
 * `hot`/`slow` are the factor (MULT) or offset (DELTA) applied to baseline.
 * `floorPct`/`ceilPct` clamp relative to baseline; `min`/`max` clamp absolutely.
 */
export const REGIME_TUNABLE = {
  // ── screening bars: may move BOTH ways, inside relative clamps ──
  minTvl:               { kind: "screening", mode: MULT,  hot: 1.5, slow: 0.7,  floorPct: 0.5, ceilPct: 3.0 },
  minVolume:            { kind: "screening", mode: MULT,  hot: 1.5, slow: 0.6,  floorPct: 0.4, ceilPct: 3.0 },
  minFeeActiveTvlRatio: { kind: "screening", mode: MULT,  hot: 1.6, slow: 0.6,  floorPct: 0.4, ceilPct: 3.0 },
  minOrganic:           { kind: "screening", mode: DELTA, hot: 6,   slow: -6,   min: 40,       max: 95 },

  // ── risk: RATCHETED — never more exposure than baseline ──
  deployAmountSol:      { kind: "risk", mode: MULT, hot: 0.6,  slow: 0.85, min: 0.05, max: 50, ratchet: "down" },
  positionSizePct:      { kind: "risk", mode: MULT, hot: 0.6,  slow: 0.85, min: 0.05, max: 0.9, ratchet: "down" },
  // stopLossPct is negative: shrinking magnitude = tighter = safer.
  stopLossPct:          { kind: "risk", mode: MULT, hot: 0.8,  slow: 0.7,  min: -60, max: -1,  ratchet: "up" },
  // takeProfitPct does not create loss exposure, so it is unratcheted:
  // let winners run when the market is actually moving, bank earlier when not.
  takeProfitPct:        { kind: "risk", mode: MULT, hot: 1.4,  slow: 0.8,  min: 1,   max: 50 },
};

export const RISK_KEYS = Object.keys(REGIME_TUNABLE).filter((k) => REGIME_TUNABLE[k].kind === "risk");
export const SCREENING_KEYS = Object.keys(REGIME_TUNABLE).filter((k) => REGIME_TUNABLE[k].kind === "screening");

const KNOWN_REGIMES = new Set(["slow", "normal", "hot"]);

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Compute the config overlay for a regime, derived from `baseline`.
 *
 * Pure: reads `baseline`, mutates nothing, touches no files. Returns a flat
 * map of CONFIG_MAP keys → values. "normal", an unknown id, or a null id all
 * return {} (fail safe — no overlay means the operator's baseline stands).
 */
export function computeRegimeOverlay(regimeId, baseline) {
  if (!regimeId || regimeId === "normal" || !KNOWN_REGIMES.has(regimeId)) return {};
  if (!baseline || typeof baseline !== "object") return {};

  const overlay = {};
  for (const [key, rule] of Object.entries(REGIME_TUNABLE)) {
    const base = Number(baseline[key]);
    if (!Number.isFinite(base)) continue; // key absent from baseline — skip it

    const factor = rule[regimeId];
    if (factor === undefined) continue;

    let value = rule.mode === DELTA ? base + factor : base * factor;

    // Relative clamps (screening bars) — never drift more than Nx from baseline.
    if (rule.floorPct != null && rule.ceilPct != null) {
      const lo = Math.min(base * rule.floorPct, base * rule.ceilPct);
      const hi = Math.max(base * rule.floorPct, base * rule.ceilPct);
      value = clamp(value, lo, hi);
    }
    // Absolute clamps — hard sanity rails regardless of baseline.
    if (rule.min != null && rule.max != null) value = clamp(value, rule.min, rule.max);

    // THE RATCHET, applied last so it always wins: a regime may only ever
    // reduce exposure. "down" = never numerically above baseline (size);
    // "up" = never numerically below baseline (stop-loss, which is negative).
    if (rule.ratchet === "down") value = Math.min(value, base);
    if (rule.ratchet === "up") value = Math.max(value, base);

    if (!Number.isFinite(value)) continue;
    // Round to a sane precision so logs/telegram stay readable.
    overlay[key] = Math.abs(value) >= 100 ? Math.round(value) : Number(value.toFixed(4));
  }
  return overlay;
}

/**
 * Human-readable one-liner describing an overlay, for logs and Telegram.
 */
export function describeOverlay(overlay, baseline) {
  const parts = Object.entries(overlay).map(([k, v]) => `${k} ${baseline?.[k] ?? "?"}→${v}`);
  return parts.length > 0 ? parts.join(", ") : "no changes";
}

/**
 * Read the operator's baseline — the on-disk user-config.json, which is what
 * Supabase pulls into. This is the authoritative "ideal" the agent references
 * but never writes. Falls back to the live config's current values per key so
 * a key absent from user-config.json still has a sane baseline.
 */
export function readBaseline(userConfigPath, liveConfig, configMap) {
  let onDisk = {};
  try {
    if (fs.existsSync(userConfigPath)) onDisk = JSON.parse(fs.readFileSync(userConfigPath, "utf8"));
  } catch { /* fall through to live config */ }

  const baseline = {};
  for (const key of Object.keys(REGIME_TUNABLE)) {
    if (Number.isFinite(Number(onDisk[key]))) {
      baseline[key] = Number(onDisk[key]);
      continue;
    }
    const path = configMap?.[key];
    if (Array.isArray(path) && liveConfig?.[path[0]]?.[path[1]] !== undefined) {
      baseline[key] = Number(liveConfig[path[0]][path[1]]);
    }
  }
  return baseline;
}

/**
 * Apply an overlay to the LIVE IN-MEMORY config only.
 *
 * Deliberately does not persist: no user-config.json write, no Supabase push.
 * A restart, or a Supabase pull, returns the agent to the operator's baseline.
 * Returns the list of {key, from, to} actually changed, for logging/notify.
 */
export function applyOverlayToLiveConfig(overlay, liveConfig, configMap) {
  const changed = [];
  for (const [key, value] of Object.entries(overlay)) {
    const path = configMap?.[key];
    if (!Array.isArray(path)) continue;
    const [section, field] = path;
    if (!liveConfig?.[section]) continue;
    const from = liveConfig[section][field];
    if (from === value) continue;
    liveConfig[section][field] = value;
    changed.push({ key, from, to: value });
  }
  return changed;
}
