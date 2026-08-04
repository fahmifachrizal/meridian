/**
 * Market regime decision tree — classifies live pool candidates into
 * Slow / Normal / Hot based on aggregate liquidity/activity across the set.
 *
 * Pure, side-effect-free (no I/O, no config import) so it stays trivially
 * unit-testable — deliberately kept separate from tools/screening.js, which
 * carries import-time side effects (dev-blocklist, pool-memory).
 */

import { degenScore } from "../tools/screening.js";

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Classify the current market regime from a set of screened candidates.
 *
 * @param {Array} candidates - candidates from getTopCandidates() (same pool
 *   shape already passed to degenScore() elsewhere, e.g. the opportunity poller)
 * @param {Object} opts
 * @param {Object} [opts.targets] - degenScore() target calibration, defaults
 *   to config.opportunity's targets when omitted by the caller
 * @param {Object} [opts.cutoffs] - { slowCutoff, hotCutoff }
 * @returns {{ regime: "slow"|"normal"|"hot"|null, aggregateScore: number|null, sampleSize: number }}
 */
export function classifyRegime(candidates, { targets = {}, cutoffs = {} } = {}) {
  const pool = Array.isArray(candidates) ? candidates : [];
  if (pool.length === 0) {
    return { regime: null, aggregateScore: null, sampleSize: 0 };
  }

  const scores = pool.map((p) => degenScore(p, targets));
  const aggregateScore = median(scores);

  const slowCutoff = Number(cutoffs.slowCutoff ?? 15);
  const hotCutoff = Number(cutoffs.hotCutoff ?? 45);

  let regime;
  if (aggregateScore < slowCutoff) regime = "slow";
  else if (aggregateScore < hotCutoff) regime = "normal";
  else regime = "hot";

  return { regime, aggregateScore, sampleSize: pool.length };
}
