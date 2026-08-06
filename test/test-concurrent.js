/**
 * Offline unit tests for util/concurrent.js and util/http-cache.js — the two
 * pieces that bound screening-cycle latency.
 *
 * The property that matters is the DEADLINE: the screening recon loop used to
 * be sequential, so one stalled third-party API could cost
 * candidates x fetch-timeout (two live cycles were observed at 102s and 251s).
 * mapWithConcurrency must return by its deadline regardless of how badly a
 * task misbehaves, and must never reject — a screening cycle that throws here
 * deploys nothing.
 *
 * Run: NODE_ENV=test node test/test-concurrent.js
 */

import { createSuite } from "./lib/test-kit.js";
import { mapWithConcurrency, valueOr } from "../util/concurrent.js";
import { clearHttpCache, httpCacheStats } from "../util/http-cache.js";

const suite = createSuite("concurrent + http-cache — latency bounds");
const { section, check, finish } = suite;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

section("Basic mapping");
{
  const out = await mapWithConcurrency([1, 2, 3], async (n) => n * 2, { limit: 2 });
  check("all items processed", out.length === 3);
  check("results are in INPUT order, not completion order", out.map((r) => r.value).join(",") === "2,4,6");
  check("every entry is fulfilled", out.every((r) => r.status === "fulfilled"));
  check("empty input returns empty", (await mapWithConcurrency([], async () => 1)).length === 0);
}

section("Concurrency limit is respected");
{
  let inFlight = 0;
  let peak = 0;
  await mapWithConcurrency(
    Array.from({ length: 12 }, (_, i) => i),
    async () => { inFlight++; peak = Math.max(peak, inFlight); await sleep(10); inFlight--; },
    { limit: 3 },
  );
  check(`never exceeds the limit (peak was ${peak})`, peak <= 3);
  check("actually ran in parallel (peak > 1)", peak > 1);
}

section("Failures are isolated, never thrown");
{
  const out = await mapWithConcurrency([1, 2, 3], async (n) => {
    if (n === 2) throw new Error("boom");
    return n;
  }, { limit: 3 });
  check("does not reject the whole batch", Array.isArray(out));
  check("failing item is marked rejected", out[1].status === "rejected");
  check("its reason is preserved", out[1].reason?.message === "boom");
  check("siblings still succeed", out[0].value === 1 && out[2].value === 3);
  check("valueOr falls back for a rejection", valueOr(out[1], "FALLBACK") === "FALLBACK");
}

section("THE DEADLINE — a stalled task cannot stall the cycle");
{
  // One task hangs far longer than the deadline. Before this change that
  // would have blocked the whole screening cycle.
  const started = Date.now();
  const out = await mapWithConcurrency(
    [1, 2, 3, 4],
    async (n) => { await sleep(n === 1 ? 5000 : 5); return n; },
    { limit: 1, deadlineMs: 150 },
  );
  const elapsed = Date.now() - started;

  check(`returns by the deadline (took ${elapsed}ms, budget 150ms)`, elapsed < 1000);
  check("result array still matches input length", out.length === 4);
  check("the stalled item is marked timedout", out[0].status === "timedout");
  check("timed-out entries degrade via valueOr", valueOr(out[0]) === null);
  check("never throws", out.every((r) => r && typeof r.status === "string"));
}

section("Deadline does not fire when work finishes in time");
{
  const out = await mapWithConcurrency([1, 2, 3], async (n) => { await sleep(5); return n; }, { limit: 3, deadlineMs: 5000 });
  check("all complete normally", out.every((r) => r.status === "fulfilled"));
  check("values intact", out.map((r) => r.value).join(",") === "1,2,3");
}

section("http-cache");
{
  clearHttpCache();
  const empty = httpCacheStats();
  check("starts empty after clear", empty.entries === 0 && empty.inflight === 0);
  // The network paths are exercised live, not here — this suite is offline.
  // What matters structurally is that clearing is total, so a stale entry can
  // never survive into a later cycle or another test.
  check("stats shape is reported", typeof empty.live === "number");
}

process.exit(finish());
