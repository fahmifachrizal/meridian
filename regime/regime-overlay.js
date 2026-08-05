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
 *   hot / volatile → TIGHTEN screening (plenty of choice, be picky).
 *   slow           → LOOSEN screening (scarce choice, accept thinner pools).
 *   normal         → exact baseline for every key EXCEPT ones that opt in to
 *                    their own explicit `normal:` factor (currently just
 *                    deployAmountSol — see REGIME_TUNABLE below). A key with
 *                    no `normal:` factor is untouched when regime is normal,
 *                    same as before.
 *
 * Scope, by deliberate operator choice: regime changes affect SCREENING bars
 * only (minTvl, minVolume, minOrganic — NOT minFeeActiveTvlRatio, which stays
 * fully operator-owned) plus exactly one risk key, deployAmountSol, which has
 * its own explicit hot/normal/slow sizing policy. Nothing else about how a
 * position is deployed or managed (positionSizePct, stopLossPct,
 * takeProfitPct) is regime-tunable — those stay 100% at whatever the
 * operator set in user-config.json, unconditionally.
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
  // minFeeActiveTvlRatio is deliberately NOT here — operator-owned,
  // unconditionally, regardless of regime.
  minTvl:               { kind: "screening", mode: MULT,  hot: 1.5, slow: 0.7,  floorPct: 0.5, ceilPct: 3.0 },
  minVolume:            { kind: "screening", mode: MULT,  hot: 1.5, slow: 0.6,  floorPct: 0.4, ceilPct: 3.0 },
  minOrganic:           { kind: "screening", mode: DELTA, hot: 6,   slow: -6,   min: 40,       max: 95 },

  // ── risk: RATCHETED — never more exposure than baseline ──
  // deployAmountSol is the ONLY deploy/management key regime is allowed to
  // touch. It explicitly defines all three regime factors (including
  // `normal:`) rather than relying on the "normal = untouched" default —
  // see computeRegimeOverlay: a key with no `normal:` factor stays a no-op
  // in the normal regime. This one opts out of that default deliberately,
  // per the operator's own sizing policy: full size in hot, 85% in normal,
  // 70% in slow/cool.
  //
  // positionSizePct, stopLossPct, and takeProfitPct are deliberately NOT
  // here (removed by operator choice) — regime never touches how a position
  // is sized (beyond deployAmountSol) or exited. They stay exactly what the
  // operator set, unconditionally, in every regime.
  deployAmountSol:      { kind: "risk", mode: MULT, hot: 1.0, normal: 0.85, slow: 0.70, min: 0.05, max: 50, ratchet: "down" },
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
 * map of CONFIG_MAP keys → values. An unknown id or a null id return {}
 * (fail safe — no overlay means the operator's baseline stands). "normal"
 * is NOT special-cased here — it goes through the same per-key loop as
 * hot/slow. Each rule in REGIME_TUNABLE only fires for "normal" if it
 * explicitly defines a `normal:` factor (checked below); every existing key
 * except deployAmountSol has no such factor, so `factor === undefined` skips
 * them exactly as the old blanket "normal → {}" shortcut did. This is what
 * lets deployAmountSol opt in to an explicit normal-regime value instead of
 * silently inheriting whatever a PRIOR hot/slow overlay last left it at.
 */
export function computeRegimeOverlay(regimeId, baseline) {
  if (!regimeId || !KNOWN_REGIMES.has(regimeId)) return {};
  if (!baseline || typeof baseline !== "object") return {};

  const overlay = {};
  for (const [key, rule] of Object.entries(REGIME_TUNABLE)) {
    const base = Number(baseline[key]);
    if (!Number.isFinite(base)) continue; // key absent from baseline — skip it

    const factor = rule[regimeId];
    if (factor === undefined) continue; // this rule has no factor for this regime — untouched (the "normal is a no-op" default, for keys that don't opt out of it)

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
