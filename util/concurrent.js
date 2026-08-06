/**
 * Bounded-concurrency map with a hard deadline.
 *
 * WHY THIS EXISTS
 * ---------------
 * The screening cycle's per-candidate recon loop was a plain sequential
 * `for...of` with a 150ms sleep between iterations. Each iteration can burn
 * the full fetch timeout, so the worst case was
 * `candidates × (timeout + 150ms)` — with 10 candidates and a 15s timeout
 * that is ~151s, and two live cycles were observed taking 102s and 251s
 * between "Computed deploy amount" and the first LLM step.
 *
 * Running them with bounded concurrency AND an overall deadline caps that:
 * whatever has not finished by the deadline is abandoned and reported as
 * `timedOut`, so a stalled third-party API degrades one candidate's
 * enrichment instead of stalling the whole cycle.
 *
 * The concurrency limit (rather than a full Promise.all) preserves the
 * 429-avoidance intent of the original sleep without its dead time.
 */

/**
 * Map `items` through async `fn` with at most `limit` in flight, giving up on
 * anything still running at `deadlineMs`.
 *
 * Never rejects: a thrown `fn` yields `{ status: "rejected", reason }`, and an
 * abandoned item yields `{ status: "timedout", value: undefined }`. Results
 * are returned in INPUT ORDER, not completion order, so callers can zip them
 * against the original array.
 *
 * @param {Array} items
 * @param {(item: any, index: number) => Promise<any>} fn
 * @param {{limit?: number, deadlineMs?: number}} [opts]
 * @returns {Promise<Array<{status: "fulfilled"|"rejected"|"timedout", value?: any, reason?: any}>>}
 */
export async function mapWithConcurrency(items, fn, { limit = 4, deadlineMs = 0 } = {}) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length).fill(null);
  if (list.length === 0) return results;

  const width = Math.max(1, Math.min(limit || 1, list.length));

  let expired = false;
  let timer = null;
  // A single deadline promise shared by every worker. Racing against one
  // shared timer (rather than one per item) keeps this to a single pending
  // timeout no matter how many candidates there are.
  const deadline = deadlineMs > 0
    ? new Promise((resolve) => {
        timer = setTimeout(() => { expired = true; resolve("__DEADLINE__"); }, deadlineMs);
        // Do not hold the event loop open just for the deadline.
        if (typeof timer.unref === "function") timer.unref();
      })
    : null;

  let cursor = 0;
  async function worker() {
    for (;;) {
      if (expired) return;
      const index = cursor++;
      if (index >= list.length) return;

      try {
        const task = Promise.resolve(fn(list[index], index));
        const outcome = deadline ? await Promise.race([task, deadline]) : await task;
        if (outcome === "__DEADLINE__") {
          results[index] = { status: "timedout" };
          return; // deadline hit — stop pulling new work
        }
        results[index] = { status: "fulfilled", value: outcome };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: width }, worker));
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Anything never started (or abandoned mid-flight) reports as timed out.
  for (let i = 0; i < results.length; i++) {
    if (results[i] === null) results[i] = { status: "timedout" };
  }
  return results;
}

/** Convenience: the fulfilled value, or `fallback` for rejected/timed-out. */
export function valueOr(result, fallback = null) {
  return result && result.status === "fulfilled" ? result.value : fallback;
}
