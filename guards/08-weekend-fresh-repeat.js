/**
 * Guard #8 — weekend fresh-token repeat block.
 *
 * Data-driven finding (see the pattern-analysis session that produced this):
 * losses during the Sat 18:00 -> Mon 04:00 WIB window aren't more frequent
 * than the rest of the week, but they're ~4-5x more severe on average, and
 * every major weekend blowup checked (WORM-SOL -44.21%, SalaryCat-SOL
 * -35.96%, Apu-SOL -20.71%, CALICO-SOL -10.05%) followed the same shape:
 * one or two small wins on a freshly-created pool, then a repeat deploy
 * into the SAME base_mint that gave everything back and then some.
 *
 * Simulated against the full history: capping a base_mint to one deploy
 * per weekend session, but ONLY when that base_mint's first deploy that
 * session was itself into a pool under `weekendGuardMaxFreshAgeHours` old
 * (not re-checking freshness on the repeat — SalaryCat's disaster leg was
 * 7.84h old by the time it fired, well past a 6h "fresh" cutoff, but its
 * session-opening deploy was 4.37h old) — turned the weekend-night dataset
 * from a $35.79 net loss into a $5.14 net gain. Re-checking freshness on
 * every leg (rather than locking it in at session-open) only recovered
 * $25.86 of that, because it doesn't catch SalaryCat's case.
 *
 * Deliberately does NOT touch weekday deploys, and does NOT touch a
 * weekend deploy into an already-mature pool — only "started fresh this
 * weekend session" gets capped to one shot.
 */

const WIB_OFFSET_MS = 7 * 3_600_000;

/**
 * The [start, end) UTC bounds of the weekend session containing `now`,
 * even if `now` itself falls outside any session (bounds are always the
 * most recent session at or before `now`) — callers should check
 * isWeekendNightWIB() first if they only want a real "we're in it" answer.
 */
export function getWeekendSessionBoundsWIB(now, s) {
  const startDow = s.weekendGuardStartDow ?? 6; // Saturday
  const startHour = s.weekendGuardStartHour ?? 18;
  const endDow = s.weekendGuardEndDow ?? 1; // Monday
  const endHour = s.weekendGuardEndHour ?? 4;

  const wibNow = new Date(now.getTime() + WIB_OFFSET_MS);
  const wibMidnightToday = new Date(Date.UTC(wibNow.getUTCFullYear(), wibNow.getUTCMonth(), wibNow.getUTCDate()));

  const daysBack = (wibNow.getUTCDay() - startDow + 7) % 7;
  let sessionStartWib = new Date(wibMidnightToday.getTime() - daysBack * 86_400_000 + startHour * 3_600_000);
  if (sessionStartWib > wibNow) sessionStartWib = new Date(sessionStartWib.getTime() - 7 * 86_400_000);

  let dowDiff = (endDow - startDow + 7) % 7;
  if (dowDiff === 0) dowDiff = 7; // a same-day window still needs to span forward, not collapse to zero
  const sessionEndWib = new Date(sessionStartWib.getTime() - startHour * 3_600_000 + dowDiff * 86_400_000 + endHour * 3_600_000);

  return {
    start: new Date(sessionStartWib.getTime() - WIB_OFFSET_MS),
    end: new Date(sessionEndWib.getTime() - WIB_OFFSET_MS),
  };
}

export function isWeekendNightWIB(now, s) {
  const { start, end } = getWeekendSessionBoundsWIB(now, s);
  return now >= start && now < end;
}

/**
 * `priorDeploysThisSession` — the same base_mint's other tracked positions
 * (open or closed) with deployed_at inside the current session's bounds,
 * excluding this attempt. Each needs a `pool_age_hours_at_deploy` field
 * (see state.js's trackPosition()) to know whether IT started fresh.
 *
 * Returns a reject reason string, or null to allow the deploy.
 */
export function getWeekendFreshRepeatRejectReason({ now, baseMint, priorDeploysThisSession, s }) {
  if (!s.weekendGuardEnabled) return null;
  if (!baseMint) return null;
  if (!isWeekendNightWIB(now, s)) return null;

  const maxFreshHours = s.weekendGuardMaxFreshAgeHours ?? 6;
  const priorFreshDeploy = (priorDeploysThisSession || []).find(
    (p) => p.pool_age_hours_at_deploy != null && p.pool_age_hours_at_deploy <= maxFreshHours
  );
  if (!priorFreshDeploy) return null;

  return `weekend fresh-repeat guard: this base_mint already deployed into a fresh pool (${priorFreshDeploy.pool_age_hours_at_deploy.toFixed(1)}h old) earlier this weekend session (${priorFreshDeploy.deployed_at}) — one shot per token on weekend nights`;
}
