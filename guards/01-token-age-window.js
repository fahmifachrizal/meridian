/**
 * Guard #1 — token-age deploy window.
 *
 * Fires first in the deploy pipeline, inside tools/screening.js's
 * discoverPools() (via getRawPoolScreeningRejectReason).
 *
 * Allow deploys in the token's first `tokenEarlyWindowMaxHours` (genuine
 * early-momentum plays), then hard-block for the following
 * `tokenCooldownHours` (the highest-risk pump/dump distribution window),
 * then allow again indefinitely past that point. Fails open if the token's
 * creation time is unknown.
 *
 * NOTE: the caller passes the DLMM *pool's* creation time, not the token's
 * original mint date — for a pump.fun graduation, the token can be weeks
 * older than the pool Meridian is actually pricing risk on.
 */
export function getTokenAgeWindowRejectReason(createdAt, s) {
  if (!s.tokenAgeWindowEnabled) return null;
  if (createdAt == null) return null;

  const earlyWindowMs = (s.tokenEarlyWindowMaxHours ?? 6) * 3_600_000;
  const cooldownMs = (s.tokenCooldownHours ?? 24) * 3_600_000;
  const ageMs = Date.now() - createdAt;
  if (ageMs <= earlyWindowMs) return null; // within early-momentum window
  if (ageMs > earlyWindowMs + cooldownMs) return null; // past cooldown, reopened

  const ageHours = (ageMs / 3_600_000).toFixed(1);
  const earlyHours = s.tokenEarlyWindowMaxHours ?? 6;
  const reopenHours = earlyHours + (s.tokenCooldownHours ?? 24);
  return `token age ${ageHours}h in cooldown window (${earlyHours}h–${reopenHours}h)`;
}
