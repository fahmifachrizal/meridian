#!/usr/bin/env node
/**
 * Cross-check the VPS agent's actual runtime behavior against the local
 * user-config.json baseline — locally, from files pull-vps-state.sh already
 * pulled. Operator-only, read-only, no SSH.
 *
 * user-config.json IS the live config here — nothing in this codebase
 * mutates config in-memory without also persisting it (applyConfigChanges(),
 * behind both the agent's update_config tool and the /setcfg command, writes
 * disk and live config synchronously in one call — see
 * tools/executor.js's applyConfigChanges). So there is no reconstruction
 * step needed; this script's job is just cross-checking the pulled evidence
 * (PM2 log, decision-log) against that baseline.
 *
 * Run: node scripts/show-effective-config.js
 * (after `npm run pull:vps`, which pulls user-config.json, decision-log.json,
 * and logs/vps-snapshot/.)
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { flattenConfig } from "../core/config-groups.js";

function readJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

const userConfigPath = repoPath("user-config.json");
const flatConfig = flattenConfig(readJson(userConfigPath, {}));

// ─── Cross-check against the pulled PM2 log ────────────────────
// Costs zero extra SSH calls — logs/vps-snapshot/pm2-out.log was already
// pulled by pull-vps-state.sh's log-tail step.
const pm2LogPath = repoPath("logs", "vps-snapshot", "pm2-out.log");
if (fs.existsSync(pm2LogPath)) {
  const lines = fs.readFileSync(pm2LogPath, "utf8").split("\n");
  const match = [...lines].reverse().find((l) => l.includes("Computed deploy amount"));
  if (match) {
    const m = match.match(/Computed deploy amount:\s*([\d.]+)\s*SOL/);
    const observed = m ? Number(m[1]) : null;
    const expected = Number(flatConfig.deployAmountSol);
    console.log(`=== Deploy-amount cross-check (last observed cycle) ===`);
    console.log(`  ${match.trim()}`);
    if (observed != null && Number.isFinite(expected)) {
      // computeDeployAmount() = clamp((wallet - gasReserve) * positionSizePct,
      // [deployAmountSol, maxDeployAmount]) — deployAmountSol is the LOWER
      // bound of that clamp. The observed figure legitimately EXCEEDS the
      // floor whenever wallet balance is large enough (the normal case). The
      // bug signature to watch for is observed falling BELOW the floor,
      // which would mean the clamp isn't being enforced.
      if (observed < expected - 0.0001) {
        console.log(`  ⚠️  observed ${observed} SOL is BELOW the configured floor ${expected} SOL — the deploy-amount floor may not be enforced, investigate`);
      } else {
        console.log(`  ok — observed ${observed} SOL is at or above the configured floor ${expected} SOL, as expected`);
      }
    }
  } else {
    console.log(`Cross-check: no "Computed deploy amount" line found in the pulled PM2 log.`);
  }
} else {
  console.log(`Cross-check skipped: logs/vps-snapshot/pm2-out.log not present (VPS_CONTAINER unset, or not yet pulled).`);
}

// ─── Staleness check ────────────────────────────────────────────
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
