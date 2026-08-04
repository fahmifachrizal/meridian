import { getPoolMemory } from "../state/pool-memory.js";
import { log } from "../logger.js";

/**
 * Guard #5 — repeat-deploy size taper + tightened stop-loss.
 *
 * Fires 5th in the deploy pipeline (last deploy-gate stage), inside
 * tools/executor.js's runSafetyChecks, deploy_position case tail.
 *
 * On a 2nd+ deploy into a pool still inside its early-momentum window (the
 * exact scenario guards #2/#6/#7-old can't help with yet — no repeat-deploy
 * history, no prior close, still within the allowed age window), tapers
 * position size (60%/40% tiers by default) and sets a tighter,
 * position-specific stop-loss override. The override is stored directly on
 * the position record at deploy time and read again during every later
 * management cycle by guards/06-fast-exit.js and getDeterministicCloseRule
 * (via `position.stop_loss_pct_override`) — there is no separate lookup.
 *
 * @returns {{ tapered: boolean, amountY: number, taperSizeCap: number|null, stopLossOverride: number|null }}
 */
export function computeDeployTaper(poolAddress, requestedAmountY, rawPoolAgeHours, config) {
  const notTapered = { tapered: false, amountY: requestedAmountY, taperSizeCap: null, stopLossOverride: null };
  if (!config.management.repeatDeploySizeTaperEnabled) return notTapered;

  const poolAgeHoursNum = Number(rawPoolAgeHours);
  const poolAgeHours = Number.isFinite(poolAgeHoursNum) ? poolAgeHoursNum : null;
  const earlyWindowHoursNum = Number(config.screening.tokenEarlyWindowMaxHours);
  const earlyWindowHours = Number.isFinite(earlyWindowHoursNum) ? earlyWindowHoursNum : 6;
  const priorDeploys = getPoolMemory({ pool_address: poolAddress })?.total_deploys ?? 0;

  if (!(priorDeploys >= 1 && poolAgeHours != null && poolAgeHours <= earlyWindowHours)) {
    return notTapered;
  }

  const taperPct = config.management.repeatDeploySizeTaperPct ?? [0.6, 0.4];
  const taperIndex = Math.min(priorDeploys - 1, taperPct.length - 1);
  const taperMultiplier = Number(taperPct[taperIndex] ?? taperPct[taperPct.length - 1]);
  const taperSizeCap = Math.max(0.1, config.management.deployAmountSol * taperMultiplier);

  let amountY = requestedAmountY;
  if (amountY > taperSizeCap) {
    log("screening", `Guard #5: repeat deploy #${priorDeploys + 1} into ${poolAddress.slice(0, 8)} (pool age ${poolAgeHours.toFixed(1)}h) — tapering size from ${amountY} to ${taperSizeCap} SOL`);
    amountY = taperSizeCap;
  }

  const stopLossOverride = config.management.stopLossPct * (config.management.repeatDeployStopLossFraction ?? 0.5);
  log("screening", `Guard #5: repeat deploy #${priorDeploys + 1} into ${poolAddress.slice(0, 8)} — tightened stop-loss to ${stopLossOverride.toFixed(2)}%`);

  return { tapered: true, amountY, taperSizeCap, stopLossOverride };
}
