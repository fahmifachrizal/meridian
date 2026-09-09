import {
  isPoolOnCooldown,
  isBaseMintOnCooldown,
  getPoolCooldownRemainingMs,
  getBaseMintCooldownRemainingMs,
} from "../state/pool-memory.js";

/**
 * Formats a remaining-cooldown duration as a negative, human-readable
 * suffix: " (-Xhr)" for >=1 hour, " (-Xmn)" for <1 hour. Rounds up
 * (Math.ceil) so "1 minute left" never displays as "-0mn".
 */
function formatRemaining(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const totalMinutes = Math.ceil(ms / 60_000);
  return totalMinutes < 60 ? ` (-${totalMinutes}mn)` : ` (-${Math.ceil(totalMinutes / 60)}hr)`;
}

/**
 * Guard #2 — repeat-deploy cooldown.
 *
 * Fires 2nd in the deploy pipeline, inside tools/screening.js's
 * getTopCandidates() eligible-filter, after discoverPools() (guard #1).
 *
 * Blocks further deploys into a pool/token after N consecutive
 * fee-generating deploys, for a cooldown window — see
 * pool-memory.js#recordPoolDeploy for where the cooldown gets SET (at
 * position close); this is the read-side check consumed at screening time.
 */
export function checkRepeatDeployCooldown(poolAddress, baseMint) {
  if (isPoolOnCooldown(poolAddress)) {
    const remaining = formatRemaining(getPoolCooldownRemainingMs(poolAddress));
    return { blocked: true, type: "pool", reason: `pool cooldown active${remaining}` };
  }
  if (isBaseMintOnCooldown(baseMint)) {
    const remaining = formatRemaining(getBaseMintCooldownRemainingMs(baseMint));
    return { blocked: true, type: "token", reason: `token cooldown active${remaining}` };
  }
  return { blocked: false, type: null, reason: null };
}
