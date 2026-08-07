#!/usr/bin/env node
/**
 * Reconstruct the VPS agent's TRUE live/effective config — locally, from
 * files pull-vps-state.sh already pulled. Operator-only, read-only, no SSH.
 *
 * WHY THIS IS EXACT, NOT AN APPROXIMATION
 * ----------------------------------------
 * user-config.json alone shows the operator's baseline, not what the
 * running process is actually using — regime/regime-overlay.js mutates
 * config in-memory only, keyed off the active regime in
 * market-regime-profiles.json (see applyOverlayToLiveConfig, called from
 * index.js's applyRegimeOverlay). That function is the ONLY code path in
 * this codebase that changes live config without also persisting to
 * user-config.json in the same call — applyConfigChanges() (the function
 * behind both the agent's update_config tool and the /setcfg command)
 * writes disk and live config synchronously in one call
 * (tools/executor.js's applyConfigChanges). So:
 *
 *   baseline (user-config.json) + active regime id + computeRegimeOverlay()
 *
 * fully reconstructs the true live config, using the exact same pure
 * function the live process itself calls — not a model of it.
 *
 * Run: node scripts/show-effective-config.js
 * (after `npm run pull:vps`, which pulls user-config.json,
 * market-regime-profiles.json, decision-log.json, and logs/vps-snapshot/.)
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { flattenConfig } from "../core/config-groups.js";
import { REGIME_TUNABLE, computeRegimeOverlay } from "../regime/regime-overlay.js";

function readJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// ─── 1. Baseline — flatten the grouped local user-config.json ────
// readBaseline() in regime-overlay.js expects a FLAT on-disk file (a legacy
// shape) and falls back to a live config object otherwise; since this
// machine has no live config object (no running agent locally) and
// user-config.json is grouped-by-section on disk, that fallback branch would
// never fire here anyway. Flattening directly is the correct, simpler path.
const userConfigPath = repoPath("user-config.json");
const flatConfig = flattenConfig(readJson(userConfigPath, {}));

const baseline = {};
for (const key of Object.keys(REGIME_TUNABLE)) {
  const v = Number(flatConfig[key]);
  if (Number.isFinite(v)) baseline[key] = v;
}

// ─── 2. Active regime ──────────────────────────────────────────
const regimeStore = readJson(repoPath("market-regime-profiles.json"), { active: null, regimes: {} });
const activeRegimeId = regimeStore.active || "normal";

// ─── 3. Recompute the effective config ────────────────────────
const overlay = computeRegimeOverlay(activeRegimeId, baseline);

console.log(`\n=== Effective runtime config (reconstructed, not measured) ===`);
console.log(`Active regime: ${activeRegimeId}\n`);

const rows = Object.keys(REGIME_TUNABLE).map((key) => {
  const base = baseline[key];
  const effective = overlay[key] !== undefined ? overlay[key] : base;
  const source = overlay[key] !== undefined ? `regime:${activeRegimeId}` : "= baseline";
  return { key, base, effective, source };
});

const w1 = Math.max(...rows.map((r) => r.key.length), "key".length);
const w2 = Math.max(...rows.map((r) => String(r.base).length), "baseline".length);
const w3 = Math.max(...rows.map((r) => String(r.effective).length), "effective".length);
console.log(`${"key".padEnd(w1)}  ${"baseline".padEnd(w2)}  ${"effective".padEnd(w3)}  source`);
for (const r of rows) {
  console.log(`${r.key.padEnd(w1)}  ${String(r.base ?? "?").padEnd(w2)}  ${String(r.effective ?? "?").padEnd(w3)}  ${r.source}`);
}

// ─── 4. Cross-check against the pulled PM2 log ────────────────
// Costs zero extra SSH calls — logs/vps-snapshot/pm2-out.log was already
// pulled by pull-vps-state.sh's log-tail step.
const pm2LogPath = repoPath("logs", "vps-snapshot", "pm2-out.log");
if (fs.existsSync(pm2LogPath)) {
  const lines = fs.readFileSync(pm2LogPath, "utf8").split("\n");
  const match = [...lines].reverse().find((l) => l.includes("Computed deploy amount"));
  if (match) {
    const m = match.match(/Computed deploy amount:\s*([\d.]+)\s*SOL/);
    const observed = m ? Number(m[1]) : null;
    const expected = overlay.deployAmountSol ?? baseline.deployAmountSol;
    console.log(`\nCross-check (last observed cycle):`);
    console.log(`  ${match.trim()}`);
    if (observed != null && expected != null) {
      // computeDeployAmount() = clamp((wallet - gasReserve) * positionSizePct,
      // [deployAmountSol, maxDeployAmount]) — deployAmountSol is the LOWER
      // bound of that clamp. The observed figure legitimately EXCEEDS the
      // recomputed floor whenever wallet balance is large enough (the normal
      // case — confirmed live: wallet 1.77 SOL -> raw 0.57 SOL > floor 0.51
      // SOL, no clamping needed). The actual bug signature is the opposite:
      // observed falling BELOW the floor would mean the clamp isn't being
      // enforced.
      if (observed < expected - 0.0001) {
        console.log(`  ⚠️  observed ${observed} SOL is BELOW the recomputed floor ${expected} SOL — the deploy-amount floor may not be enforced, investigate`);
      } else {
        console.log(`  ok — observed ${observed} SOL is at or above the recomputed floor ${expected} SOL, as expected`);
      }
    }
  } else {
    console.log(`\nCross-check: no "Computed deploy amount" line found in the pulled PM2 log.`);
  }
} else {
  console.log(`\nCross-check skipped: logs/vps-snapshot/pm2-out.log not present (VPS_CONTAINER unset, or not yet pulled).`);
}

// ─── 5. Staleness check ────────────────────────────────────────
const decisionLog = readJson(repoPath("decision-log.json"), { decisions: [] });
const newestDecision = decisionLog.decisions?.[0]?.ts ? Date.parse(decisionLog.decisions[0].ts) : null;
const screeningIntervalMin = Number(flatConfig.screeningIntervalMin) || 30;
const staleThresholdMs = 2 * screeningIntervalMin * 60_000;

console.log(`\n=== Staleness check ===`);
if (newestDecision) {
  const ageMs = Date.now() - newestDecision;
  const ageMin = Math.round(ageMs / 60_000);
  if (ageMs > staleThresholdMs) {
    console.log(`⚠️  Last decision-log entry is ${ageMin}m old (threshold: ${Math.round(staleThresholdMs / 60_000)}m = 2x screeningIntervalMin).`);
    console.log(`    The VPS agent may be stuck, crashed, or unreachable — check logs/vps-snapshot/pm2-status.json and pm2-out.log.`);
  } else {
    console.log(`ok — last decision-log entry is ${ageMin}m old (threshold ${Math.round(staleThresholdMs / 60_000)}m).`);
  }
} else {
  console.log(`No decisions found in decision-log.json — nothing to check (or file not yet pulled).`);
}
console.log("");
