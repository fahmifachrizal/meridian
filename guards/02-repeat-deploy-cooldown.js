import { isPoolOnCooldown, isBaseMintOnCooldown } from "../pool-memory.js";

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
    return { blocked: true, reason: "pool cooldown active" };
  }
  if (isBaseMintOnCooldown(baseMint)) {
    return { blocked: true, reason: "token cooldown active" };
  }
  return { blocked: false, reason: null };
}
