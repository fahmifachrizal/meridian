import { round2 } from "../core/config.js";

/**
 * Guard #7 — token-name pattern size penalty.
 *
 * Opt-in, data-driven from a pool_name/PnL correlation review (no reliable
 * predictive signal was found in general — see CHANGELOG — but the operator
 * chose to size down a specific naming pattern anyway as a standing risk
 * preference, not because the pattern itself predicts loss).
 *
 * `config.management.tokenNamePenalties` is a list of
 * `{ pattern, penaltyPct }` — `pattern` is matched as a case-insensitive
 * substring against the pool/token name, `penaltyPct` (0-100) is how much
 * to cut the requested deploy size by (50 = half size). Only the FIRST
 * matching rule applies — rules are not combined/stacked.
 *
 * Fires in tools/executor.js's runSafetyChecks, deploy_position case tail,
 * chained after guard #6's repeat-deploy taper — so it discounts whatever
 * amount guard #6 already produced, not the original requested amount.
 *
 * @returns {{ penalized: boolean, amountY: number, matchedPattern: string|null, penaltyPct: number|null }}
 */
export function computeTokenNamePenalty(tokenName, requestedAmountY, config) {
  const notPenalized = { penalized: false, amountY: requestedAmountY, matchedPattern: null, penaltyPct: null };
  if (!config.management.tokenNamePenaltiesEnabled) return notPenalized;
  if (!tokenName) return notPenalized;

  const rules = Array.isArray(config.management.tokenNamePenalties) ? config.management.tokenNamePenalties : [];
  const nameLower = tokenName.toLowerCase();
  const rule = rules.find((r) => r?.pattern && nameLower.includes(String(r.pattern).toLowerCase()));
  if (!rule) return notPenalized;

  const penaltyPct = Number(rule.penaltyPct);
  if (!Number.isFinite(penaltyPct) || penaltyPct <= 0) return notPenalized;

  const multiplier = Math.max(0, 1 - penaltyPct / 100);
  const amountY = Math.max(0.1, round2(requestedAmountY * multiplier));
  return { penalized: true, amountY, matchedPattern: rule.pattern, penaltyPct };
}
