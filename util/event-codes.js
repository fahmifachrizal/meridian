/**
 * Event/error taxonomy — maps a raw log line (tag + message) to a short,
 * stable code, so recurring incidents (Helius rate limits, deploy
 * simulation failures, hallucinated deploy reports, ...) can be counted
 * and reported on consistently instead of re-diagnosed from scratch every
 * time someone asks "why did X happen" in Telegram.
 *
 * Built from a full sweep of every logs/agent-*.log file on disk
 * (2026-07-13 through 2026-09-07, ~200k lines) — every pattern below
 * matched at least one real historical occurrence; nothing here is
 * speculative. See scripts/classify-log-events.js, which is what
 * generated the frequency counts this taxonomy is based on.
 *
 * classifyEvent() never throws and never returns null. An unmatched
 * tag/message pair falls through to GENERAL_ERROR — a first-class bucket
 * for new or not-yet-identified events, not a silent gap. The intent is
 * that GENERAL_ERROR occurrences get reviewed periodically and, if a
 * pattern repeats, promoted into its own rule here.
 */

export const EVENT_CODES = {
  // ── Helius / RPC provider ──────────────────────────────────────
  HELIUS_MAX_USAGE:        { category: "helius", label: "Helius monthly credit cap reached (persistent, not a burst limit)" },
  HELIUS_RATE_LIMIT:       { category: "helius", label: "Helius rate limit (429 Too Many Requests)" },
  HELIUS_BAD_GATEWAY:      { category: "helius", label: "Helius 502 Bad Gateway" },
  HELIUS_UNAUTHORIZED:     { category: "helius", label: "401 Unauthorized — likely missing/invalid RPC auth" },
  HELIUS_RPC_OVERLOADED:   { category: "helius", label: "RPC account-index service overloaded" },
  HELIUS_RPC_UNAVAILABLE:  { category: "helius", label: "RPC 503 / internal error" },
  HELIUS_FETCH_FAILED:     { category: "helius", label: "Network-level fetch failure to Helius" },
  HELIUS_HTTP_ERROR:       { category: "helius", label: "Helius API error, uncategorized HTTP status" },

  // ── PnL pricing ─────────────────────────────────────────────────
  PNL_PRICE_MISSING:    { category: "pnl", label: "PnL tick: price feed data missing for this position" },
  PNL_DEPOSITS_MISSING: { category: "pnl", label: "PnL tick: on-chain deposit data missing for this position (usually RPC-side)" },
  PNL_TICK_UNRELIABLE:  { category: "pnl", label: "PnL tick flagged suspicious for another reason — rule skipped rather than acted on" },

  // ── Deploy (on-chain) ───────────────────────────────────────────
  DEPLOY_SIMULATION_FAILED: { category: "deploy", label: "Deploy tx simulation failed — never broadcast, no gas spent" },
  DEPLOY_TX_EXPIRED:        { category: "deploy", label: "Deploy tx expired before confirmation — may have cost gas; can leave an orphaned empty position on the wide-range multi-tx path" },
  DEPLOY_TX_ERROR:          { category: "deploy", label: "Deploy tx resulted in an on-chain error" },
  CLOSE_BLOCKHASH_UNAVAILABLE: { category: "close", label: "Couldn't obtain a fresh blockhash in time (RPC latency)" },
  CLOSE_ONCHAIN_ERROR:         { category: "close", label: "Close tx resulted in an on-chain program error" },

  // ── Safety-block (pre-flight rejections — not on-chain failures) ─
  BLOCK_FEE_TVL_LOW:    { category: "safety_block", label: "Blocked: fee/active-TVL below threshold" },
  BLOCK_TVL_DECLINING:  { category: "safety_block", label: "Blocked: pool TVL declining (guard #4)" },
  BLOCK_MIN_AMOUNT:     { category: "safety_block", label: "Blocked: deploy amount invalid or below minimum" },
  BLOCK_POOL_NOT_FOUND: { category: "safety_block", label: "Blocked: pool not found on the fresh pre-deploy lookup" },
  BLOCK_QUOTE_NOT_SOL:  { category: "safety_block", label: "Blocked: pool's quote token isn't SOL" },

  // ── Close (on-chain) ────────────────────────────────────────────
  CLOSE_SETTLEMENT_DELAY:  { category: "close", label: "Close: position still settling on-chain (retried)" },
  CLOSE_NOTHING_TO_CLAIM:  { category: "close", label: "Close: no fee to claim — not an error" },
  CLOSE_SIMULATION_FAILED: { category: "close", label: "Close: claim/close tx simulation failed" },
  CLOSE_TX_EXPIRED:        { category: "close", label: "Close tx expired before confirmation" },
  CLOSE_STILL_OPEN:        { category: "close", label: "Close: position still appears open after close txs" },

  // ── Swap (Jupiter) ──────────────────────────────────────────────
  SWAP_INSUFFICIENT_FUNDS: { category: "swap", label: "Swap failed: insufficient funds" },
  SWAP_ONCHAIN_FAILED:     { category: "swap", label: "Swap failed on-chain" },
  SWAP_NOT_FULLY_SIGNED:   { category: "swap", label: "Swap tx not fully signed" },
  SWAP_NO_QUOTE:           { category: "swap", label: "Swap: failed to get a quote" },

  // ── LLM provider / agent reasoning ──────────────────────────────
  LLM_NO_ENDPOINTS:        { category: "llm", label: "LLM provider: no endpoints match guardrail/data policy" },
  LLM_PROVIDER_ERROR:      { category: "llm", label: "LLM provider returned a generic error" },
  LLM_BAD_RESPONSE:        { category: "llm", label: "LLM returned an invalid/unparseable response" },
  LLM_HALLUCINATED_DEPLOY: { category: "llm", label: "LLM claimed a deploy succeeded when it didn't — caught and overridden" },

  // ── Telegram ────────────────────────────────────────────────────
  TELEGRAM_MESSAGE_UNCHANGED: { category: "telegram", label: "Telegram: edit rejected, content unchanged — benign" },
  TELEGRAM_TRANSIENT_FAILURE: { category: "telegram", label: "Telegram: transient send/poll fetch failure" },
  TELEGRAM_PARSE_ERROR:       { category: "telegram", label: "Telegram: message failed to parse (bad HTML entities)" },
  TELEGRAM_THREAD_NOT_FOUND:  { category: "telegram", label: "Telegram: target message thread not found (group-topic config)" },

  // ── HiveMind ────────────────────────────────────────────────────
  HIVEMIND_AUTH_FAILED: { category: "hivemind", label: "HiveMind: invalid API key" },
  HIVEMIND_UNAVAILABLE: { category: "hivemind", label: "HiveMind: request failed or unreachable" },

  // ── Agent framework ─────────────────────────────────────────────
  AGENT_ARGS_REPAIRED:     { category: "agent", label: "Agent: malformed tool-call JSON args auto-repaired — not an error" },
  AGENT_DUPLICATE_BLOCKED: { category: "agent", label: "Agent: duplicate protected tool call blocked (once-per-session lock)" },

  // ── State / storage ─────────────────────────────────────────────
  JSON_STORE_CORRUPT: { category: "state", label: "A JSON state file failed to parse" },

  // ── Test harness noise ──────────────────────────────────────────
  // This repo's own test convention (see CLAUDE.md) uses fake IDs prefixed
  // TEST_..._DO_NOT_USE / a "TEST-SOL" pair-name for synthetic fixtures —
  // recognizable and worth separating from real production events rather
  // than either miscategorizing them or letting them dilute GENERAL_ERROR.
  TEST_ARTIFACT: { category: "test", label: "Synthetic event from this repo's own test suite, not production" },

  // ── Fallback ────────────────────────────────────────────────────
  GENERAL_ERROR: { category: "general", label: "Unclassified event — new or not-yet-identified pattern" },
};

// Ordered — first match wins. Order matters where one message could match
// more than one rule: e.g. a "max usage reached" response is still
// nominally a 429, so the more specific HELIUS_MAX_USAGE rule must be
// checked before the general HELIUS_RATE_LIMIT one, or every occurrence
// would get the less useful, less actionable generic code.
const RULES = [
  // Test-harness fixtures — checked first so a synthetic event never gets
  // mistaken for a real Helius/PnL/deploy incident.
  { code: "TEST_ARTIFACT", test: (t, m) => /TEST[-_](SOL|FAKE)|DO_NOT_USE/i.test(m) },

  // Also checked early, before any inner-error pattern: this message wraps
  // whatever error blocked/failed the deploy in parentheses (e.g. "...did
  // not succeed (401 Unauthorized: Unauthorized) — overriding..."), so a
  // more specific rule further down (HELIUS_UNAUTHORIZED, BLOCK_*, ...)
  // would otherwise steal the classification from the more important,
  // more actionable outer signal: the LLM hallucinated a success report.
  { code: "LLM_HALLUCINATED_DEPLOY", test: (t, m) => /reported a deploy but deploy_position did not succeed|hallucinated report/i.test(m) },

  { code: "HELIUS_MAX_USAGE", test: (t, m) => /max usage reached/i.test(m) },
  { code: "HELIUS_RATE_LIMIT", test: (t, m) => /429|too many requests/i.test(m) },
  { code: "HELIUS_BAD_GATEWAY", test: (t, m) => /502|bad gateway/i.test(m) },
  { code: "HELIUS_UNAUTHORIZED", test: (t, m) => /\b401\b|unauthorized/i.test(m) },
  { code: "HELIUS_RPC_OVERLOADED", test: (t, m) => /overloaded/i.test(m) },
  { code: "HELIUS_RPC_UNAVAILABLE", test: (t, m) => /503|service unavailable|internal error/i.test(m) },
  { code: "HELIUS_FETCH_FAILED", test: (t, m) => /helius|rpc/i.test(t + m) && /fetch failed/i.test(m) },
  // Catch-all for any other "Helius API error: <status>" shape (e.g. a
  // response with no status text at all) — still Helius-specific, still
  // worth its own bucket rather than falling through to GENERAL_ERROR.
  { code: "HELIUS_HTTP_ERROR", test: (t, m) => /helius api error/i.test(m) },

  // PnL pricing — by far the highest-volume anomaly tag in production
  // (11k+ occurrences across the full history). priceMissing and
  // depositsMissing are reported independently on the same tick and have
  // different likely root causes (price-feed vs RPC deposit-fetch), so
  // they get distinct codes; check price first since a tick can have both
  // set and the price-feed side is the more actionable one to know about.
  { code: "PNL_PRICE_MISSING", test: (t, m) => t === "PNL_WARN" && /suspicious tick/i.test(m) && /priceMissing=true/i.test(m) },
  { code: "PNL_DEPOSITS_MISSING", test: (t, m) => t === "PNL_WARN" && /suspicious tick/i.test(m) && /depositsMissing=true/i.test(m) },
  { code: "PNL_TICK_UNRELIABLE", test: (t, m) => t === "PNL_WARN" && /suspicious tick/i.test(m) },

  { code: "DEPLOY_TX_EXPIRED", test: (t, m) => t === "DEPLOY_ERROR" && /block height exceeded/i.test(m) },
  { code: "DEPLOY_SIMULATION_FAILED", test: (t, m) => t === "DEPLOY_ERROR" && /simulation failed/i.test(m) },
  { code: "DEPLOY_TX_ERROR", test: (t, m) => t === "DEPLOY_ERROR" && /resulted in an error/i.test(m) },
  { code: "CLOSE_BLOCKHASH_UNAVAILABLE", test: (t, m) => /unable to obtain a new blockhash/i.test(m) },
  { code: "CLOSE_ONCHAIN_ERROR", test: (t, m) => t === "CLOSE_ERROR" && /error code:/i.test(m) },

  { code: "BLOCK_QUOTE_NOT_SOL", test: (t, m) => t === "SAFETY_BLOCK" && /quote token/i.test(m) && /not sol/i.test(m) },
  { code: "BLOCK_FEE_TVL_LOW", test: (t, m) => t === "SAFETY_BLOCK" && /fee\/active-tvl/i.test(m) },
  { code: "BLOCK_TVL_DECLINING", test: (t, m) => t === "SAFETY_BLOCK" && /tvl declining/i.test(m) },
  { code: "BLOCK_MIN_AMOUNT", test: (t, m) => t === "SAFETY_BLOCK" && /(positive sol amount|minimum deploy amount)/i.test(m) },
  { code: "BLOCK_POOL_NOT_FOUND", test: (t, m) => t === "SAFETY_BLOCK" && /not found/i.test(m) },

  { code: "CLOSE_TX_EXPIRED", test: (t, m) => /^close/i.test(t) && /block height exceeded/i.test(m) },
  { code: "CLOSE_SETTLEMENT_DELAY", test: (t, m) => /(may still be settling|rejected unsettled closed pnl)/i.test(m) },
  { code: "CLOSE_STILL_OPEN", test: (t, m) => /still appears open/i.test(m) },
  { code: "CLOSE_NOTHING_TO_CLAIM", test: (t, m) => /no fee to claim/i.test(m) },
  { code: "CLOSE_SIMULATION_FAILED", test: (t, m) => /^close/i.test(t) && /simulation failed/i.test(m) },

  { code: "SWAP_NOT_FULLY_SIGNED", test: (t, m) => /not fully signed/i.test(m) },
  { code: "SWAP_NO_QUOTE", test: (t, m) => /failed to get quotes/i.test(m) },
  { code: "SWAP_INSUFFICIENT_FUNDS", test: (t, m) => /insufficient funds/i.test(m) },
  { code: "SWAP_ONCHAIN_FAILED", test: (t, m) => /swap failed on-chain/i.test(m) },

  { code: "LLM_NO_ENDPOINTS", test: (t, m) => /no endpoints available/i.test(m) },
  { code: "LLM_BAD_RESPONSE", test: (t, m) => /invalid json response body/i.test(m) },
  { code: "LLM_PROVIDER_ERROR", test: (t, m) => /provider returned error/i.test(m) },

  { code: "TELEGRAM_MESSAGE_UNCHANGED", test: (t, m) => /message is not modified/i.test(m) },
  { code: "TELEGRAM_PARSE_ERROR", test: (t, m) => /can.t parse entities/i.test(m) },
  { code: "TELEGRAM_THREAD_NOT_FOUND", test: (t, m) => /message thread not found/i.test(m) },
  { code: "TELEGRAM_TRANSIENT_FAILURE", test: (t, m) => t.startsWith("TELEGRAM") && /fetch failed/i.test(m) },

  { code: "HIVEMIND_AUTH_FAILED", test: (t, m) => /invalid hivemind api key/i.test(m) },
  { code: "HIVEMIND_UNAVAILABLE", test: (t) => t.startsWith("HIVEMIND") },

  { code: "AGENT_ARGS_REPAIRED", test: (t, m) => /repaired malformed json args/i.test(m) },
  { code: "AGENT_DUPLICATE_BLOCKED", test: (t, m) => /blocked duplicate/i.test(m) },

  { code: "JSON_STORE_CORRUPT", test: (t, m) => /invalid json in/i.test(m) },
];

/**
 * Classify one (tag, message) pair — e.g. from a parsed log line like
 * `[WALLET_ERROR] Helius API error: 429 Too Many Requests`, tag is
 * "WALLET_ERROR" and message is the rest. Always returns a full entry
 * ({ code, category, label }); never throws, never returns null/undefined.
 *
 * `code` (e.g. "HELIUS_RATE_LIMIT") is an internal identifier — for
 * counting, grepping, deduping, and the pinned tests in
 * test/test-event-codes.js. It is NOT written in prose and must never be
 * shown to a human as-is. `label` is the human-facing sentence. Any
 * surface a person reads — Telegram, a REPL reply, a report — must use
 * `label` (or describeEvent() below), never `code`.
 */
export function classifyEvent(tag, message) {
  const t = String(tag || "").toUpperCase();
  const m = String(message || "");
  for (const rule of RULES) {
    let matched = false;
    try {
      matched = rule.test(t, m);
    } catch {
      matched = false; // a malformed rule must never crash classification
    }
    if (matched) return { code: rule.code, ...EVENT_CODES[rule.code] };
  }
  return { code: "GENERAL_ERROR", ...EVENT_CODES.GENERAL_ERROR };
}

/**
 * The one function any human-facing surface (Telegram, a chat reply, a
 * status report) should call — returns ONLY the readable label, never the
 * internal code, so a future integration can't accidentally send someone
 * a bare "HELIUS_RATE_LIMIT" instead of a sentence. Nothing in this
 * codebase currently calls this from a live notification path (checked
 * 2026-09-07 — classifyEvent/EVENT_CODES are only used by this file, the
 * offline scanner in scripts/classify-log-events.js, and its tests); this
 * exists so that the moment one does, the safe default is already here
 * rather than someone reaching for `.code` under time pressure.
 */
export function describeEvent(tag, message) {
  return classifyEvent(tag, message).label;
}
