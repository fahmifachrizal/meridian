/**
 * Tiny in-process TTL cache for idempotent GET responses.
 *
 * WHY THIS EXISTS
 * ---------------
 * One discovery pass issues up to 51 requests (1 pool page + one detail
 * fetch per pool, because applyVolatilityTimeframe's early-return never
 * fires while the screening timeframe is below the 30m volatility floor).
 * The opportunity poller then runs getTopCandidates and immediately triggers
 * runScreeningCycle, which runs the whole pipeline again seconds later with
 * no reuse. The same Jupiter assets/search URL is also fetched twice per
 * candidate — once during PVP/launchpad enrichment, once in the recon loop.
 *
 * The direct latency saving is modest, but every removed request is one less
 * chance of a 429 — and 429-driven retries are what stack into the multi-
 * minute screening tails this change set is targeting.
 *
 * Deliberately in-process, not Redis: this caches small JSON bodies for
 * seconds, the agent is a single process, and a network round-trip plus a
 * JSON.parse of the returned string would cost more than it saves. See the
 * measurements in state/json-store.js's header for the same conclusion.
 */

import crypto from "crypto";
import { fetchWithTimeout } from "./fetch-timeout.js";

const DEFAULT_TTL_MS = 45_000;
const MAX_ENTRIES = 500;

// key -> { body, expiresAt }
const _cache = new Map();
// key -> Promise, so N concurrent callers for the same URL make ONE request.
const _inflight = new Map();

function keyFor(url) {
  return crypto.createHash("sha1").update(String(url)).digest("hex");
}

function prune() {
  const now = Date.now();
  for (const [k, v] of _cache) {
    if (v.expiresAt <= now) _cache.delete(k);
  }
  // Still oversized after dropping expired entries: evict oldest-inserted
  // (Map preserves insertion order) until back under the cap.
  while (_cache.size > MAX_ENTRIES) {
    const oldest = _cache.keys().next().value;
    if (oldest === undefined) break;
    _cache.delete(oldest);
  }
}

/**
 * GET `url` and parse JSON, reusing a recent response when one is cached.
 *
 * A cache miss, an expired entry, or ANY error falls through to a real
 * fetch — the cache can never starve a screening cycle of candidates.
 * Non-OK responses are not cached, so a transient 429/500 doesn't get
 * pinned for the TTL.
 *
 * @param {string} url
 * @param {{ttlMs?: number, timeoutMs?: number, headers?: object}} [opts]
 */
export async function cachedJson(url, { ttlMs = DEFAULT_TTL_MS, timeoutMs, headers } = {}) {
  const key = keyFor(url);
  const now = Date.now();

  const hit = _cache.get(key);
  if (hit && hit.expiresAt > now) return hit.body;

  const pending = _inflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const res = await fetchWithTimeout(url, headers ? { headers } : {}, timeoutMs);
    if (!res.ok) {
      const err = new Error(`${url} -> ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    if (ttlMs > 0) {
      _cache.set(key, { body, expiresAt: Date.now() + ttlMs });
      prune();
    }
    return body;
  })();

  _inflight.set(key, task);
  try {
    return await task;
  } finally {
    _inflight.delete(key);
  }
}

/** Drop cached entries. Tests and long-running processes use this. */
export function clearHttpCache() {
  _cache.clear();
  _inflight.clear();
}

/** Introspection for tests/diagnostics. */
export function httpCacheStats() {
  const now = Date.now();
  let live = 0;
  for (const v of _cache.values()) if (v.expiresAt > now) live++;
  return { entries: _cache.size, live, inflight: _inflight.size };
}
