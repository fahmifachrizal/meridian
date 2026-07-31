import { recordTvlObservation, getPriorTvlObservation } from "../pool-memory.js";

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Guard #4 — pre-deploy TVL/mcap decline check.
 *
 * Two touchpoints: `recordTvlSnapshot` runs during tools/screening.js's
 * getTopCandidates() (recording, right after guards #1/#2), `checkTvlDecline`
 * is ENFORCED in tools/executor.js's runSafetyChecks →
 * validateDeployPoolThresholds — the last gate before deploy_position
 * executes.
 *
 * Rejects a pool whose TVL is actively collapsing right now, even if the
 * absolute value still clears the static minTvl. Fails open if there's no
 * recent-enough observation to compare against.
 */
export function recordTvlSnapshot(poolAddress, tvl) {
  recordTvlObservation(poolAddress, tvl);
}

export function checkTvlDecline(poolAddress, currentTvl, managementConfig) {
  const maxSnapshotAgeHours = numberOrNull(managementConfig.maxTvlSnapshotAgeHours);
  const maxTvlDeclinePct = numberOrNull(managementConfig.maxTvlDeclinePctForDeploy);
  if (maxSnapshotAgeHours == null || maxTvlDeclinePct == null) {
    return { blocked: false, reason: null };
  }

  const priorObservation = getPriorTvlObservation(poolAddress, maxSnapshotAgeHours);
  if (!priorObservation || priorObservation.tvl <= 0) {
    return { blocked: false, reason: null };
  }

  const declinePct = ((priorObservation.tvl - currentTvl) / priorObservation.tvl) * 100;
  if (declinePct <= maxTvlDeclinePct) {
    return { blocked: false, reason: null };
  }

  return {
    blocked: true,
    reason: `Pool TVL declining ${declinePct.toFixed(1)}% since ${priorObservation.ts} ($${priorObservation.tvl} → $${currentTvl}) — exceeds maxTvlDeclinePctForDeploy ${maxTvlDeclinePct}%.`,
  };
}
