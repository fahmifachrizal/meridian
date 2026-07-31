import { getRecentRejectionCount, recordRejection } from "../pool-memory.js";
import { log } from "../logger.js";

/**
 * Guard #3 — rejection hysteresis.
 *
 * Fires 3rd in the deploy pipeline, inside index.js's runScreeningCycle
 * post-recon hard-filter loop (after guards #1/#2 have already run in
 * tools/screening.js).
 *
 * A pool rejected ≥N times recently for bot-holders%/top10% gets a
 * tightened (harder) cutoff so it can't slip through the instant a metric
 * dips just under the raw cutoff. Checks bot-holders% first, then top10%;
 * returns on the first that trips (matching the original inline order).
 */
export function checkRejectionHysteresis(pool, ti, screeningConfig) {
  const botPct = ti?.audit?.bot_holders_pct;
  const top10Pct = ti?.audit?.top_holders_pct;
  const maxBotHoldersPct = screeningConfig.maxBotHoldersPct;
  const maxTop10Pct = screeningConfig.maxTop10Pct;
  const hysteresisCount = screeningConfig.hysteresisRejectionCount ?? 2;
  const hysteresisWindow = screeningConfig.hysteresisWindowHours ?? 24;
  const hysteresisMargin = screeningConfig.hysteresisMarginPct ?? 5;

  if (botPct != null && maxBotHoldersPct != null) {
    const priorRejections = getRecentRejectionCount(pool.pool, "bot_holders_pct", hysteresisWindow);
    const effectiveCap = priorRejections >= hysteresisCount ? maxBotHoldersPct - hysteresisMargin : maxBotHoldersPct;
    if (botPct > effectiveCap) {
      const marginNote = priorRejections >= hysteresisCount ? ` (hysteresis: ${priorRejections} recent rejections, cap tightened by ${hysteresisMargin}%)` : "";
      log("screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${effectiveCap}%${marginNote}`);
      recordRejection(pool.pool, "bot_holders_pct", botPct);
      return { blocked: true, reason: `bot holders ${botPct}% > ${effectiveCap}%${marginNote}` };
    }
  }
  if (top10Pct != null && maxTop10Pct != null) {
    const priorRejections = getRecentRejectionCount(pool.pool, "top10pct", hysteresisWindow);
    const effectiveCap = priorRejections >= hysteresisCount ? maxTop10Pct - hysteresisMargin : maxTop10Pct;
    if (top10Pct > effectiveCap) {
      const marginNote = priorRejections >= hysteresisCount ? ` (hysteresis: ${priorRejections} recent rejections, cap tightened by ${hysteresisMargin}%)` : "";
      log("screening", `Top10 filter: dropped ${pool.name} — top10 ${top10Pct}% > ${effectiveCap}%${marginNote}`);
      recordRejection(pool.pool, "top10pct", top10Pct);
      return { blocked: true, reason: `top10 concentration ${top10Pct}% > ${effectiveCap}%${marginNote}` };
    }
  }
  return { blocked: false, reason: null };
}
