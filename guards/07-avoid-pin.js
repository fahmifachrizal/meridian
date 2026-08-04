/**
 * Guard #7 — AVOID-tagged pinned lessons.
 *
 * Fires last in the position lifecycle, inside lessons.js's
 * recordPerformance() at close time — advisory, not a hard filter. Pins a
 * lesson that survives the LLM prompt's normal lesson-recency cap so a pool
 * with a proven bad track record stays flagged on future SCREENER cycles
 * regardless of how much time has passed.
 *
 * @returns {{avoidThreshold: number, minDeploys: number} | null} non-null
 *   means "pin an AVOID lesson for this pool"; the caller (lessons.js) owns
 *   actually writing/updating the lessons.json entry.
 */
export function shouldPinAvoid(poolMemory, managementConfig) {
  const avoidThreshold = managementConfig.avoidPinThresholdPct ?? -10;
  const minDeploys = managementConfig.avoidPinMinDeploys ?? 2;
  if (!(poolMemory?.known && poolMemory.total_deploys >= minDeploys && poolMemory.avg_pnl_pct <= avoidThreshold)) {
    return null;
  }
  return { avoidThreshold, minDeploys };
}
