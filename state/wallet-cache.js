/**
 * Shared "last known" wallet balance snapshot — in-memory only, not
 * persisted to disk (same category as state/signal-tracker.js: cheap to
 * lose on restart, a fresh fetch just repopulates it).
 *
 * WHY THIS EXISTS
 * ---------------
 * tools/wallet.js's getWalletBalances() is a real Helius Wallet API call,
 * billed at a flat 100 credits/call (https://www.helius.dev/docs/billing/credits).
 * Before this file existed, every caller — deploy-time safety checks,
 * close-time swap sizing, AND purely informational reads like Telegram
 * /status — hit that endpoint independently. The opportunity poller alone
 * calling it unconditionally every ~45s was a large chunk of a Helius "max
 * usage reached" incident (see CHANGELOG's 2026-08 entries).
 *
 * The fix is a hard split by call intent:
 *   - Balance-CRITICAL call sites (about to deploy, about to close/withdraw,
 *     insurance-pool cap checks) call refreshWalletBalanceCache() — a real,
 *     live Helius fetch, exactly as before, just also updating the shared
 *     snapshot as a side effect. Never served stale.
 *   - Informational call sites (Telegram /status, /wallet, the REPL's
 *     /status) call getCachedWalletBalance() — reads the shared snapshot,
 *     ZERO Helius calls. Can be up to an hour stale in the worst case
 *     (nothing deployed/closed and no one asked in that window) — the
 *     hourly floor below exists specifically to bound that.
 *
 * The hourly refresh (wired in index.js's launchCron) is a floor, not the
 * primary freshness mechanism — in an active trading period, deploy/close
 * events refresh this snapshot far more often than hourly on their own.
 */

import { getWalletBalances } from "../tools/wallet.js";

let _cached = null; // last known getWalletBalances() result (only successful, non-error reads)
let _cachedAt = 0;

/**
 * Live fetch — use at genuinely balance-critical call sites (deploy-time
 * verification, close-time updates, the hourly floor). Same return shape
 * as getWalletBalances() itself; a failed fetch is NOT cached (so a
 * transient Helius error can't pin a bad/empty snapshot for informational
 * readers), and this function never throws — matches getWalletBalances()'s
 * own fail-open contract.
 */
export async function refreshWalletBalanceCache() {
  const balance = await getWalletBalances();
  if (balance && !balance.error) {
    _cached = balance;
    _cachedAt = Date.now();
  }
  return balance;
}

/**
 * Informational read — never triggers a Helius call. Returns the last
 * successfully cached snapshot plus `cached_at` (ISO string) so a caller
 * can show staleness if it wants to. Before anything has ever been
 * cached (e.g. right at boot, before the first deploy/close/hourly tick),
 * falls back to a zeroed shape matching getWalletBalances()'s own error
 * shape — never returns undefined/null.
 */
export function getCachedWalletBalance() {
  if (_cached) return { ..._cached, cached_at: new Date(_cachedAt).toISOString() };
  return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, cached_at: null, error: "not yet cached" };
}

/**
 * Human-readable staleness for a getCachedWalletBalance() result's
 * `cached_at`, e.g. "3m ago", "2h ago", "just now". Returns null for
 * `cached_at: null` (nothing cached yet) — callers should handle that
 * case with their own "not yet available" wording rather than a bogus age.
 */
export function formatWalletCacheAge(cachedAtIso) {
  if (!cachedAtIso) return null;
  const ageMs = Date.now() - new Date(cachedAtIso).getTime();
  if (ageMs < 30_000) return "just now";
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m ago` : `${hours}h ago`;
}
