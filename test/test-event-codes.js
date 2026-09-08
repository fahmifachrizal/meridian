/**
 * util/event-codes.js — the log-event classification taxonomy.
 *
 * Every "known pattern" check here is a real message pulled verbatim (or
 * near-verbatim) from logs/agent-*.log — this taxonomy was built by
 * scanning the full production history (2026-07-13 through 2026-09-07,
 * ~225k lines), not written speculatively. See
 * scripts/classify-log-events.js for the scanner that generated the
 * frequency counts these rules are based on.
 *
 * Offline, no network. Run: node test/test-event-codes.js
 */

import { createSuite } from "./lib/test-kit.js";
import { classifyEvent, describeEvent, EVENT_CODES } from "../util/event-codes.js";

const suite = createSuite("Event/error taxonomy (util/event-codes.js)");
const { section, check } = suite;

// ─── Every code referenced by a rule must exist in EVENT_CODES ───
section("taxonomy self-consistency");
{
  // Reach into the module's own rule set indirectly: classify a message for
  // each known code's own label keyword isn't reliable, so instead assert
  // the two structural invariants that matter — every code classifyEvent
  // can return has a category+label, and GENERAL_ERROR itself is one of them.
  check("GENERAL_ERROR is a defined code with category+label", EVENT_CODES.GENERAL_ERROR?.category != null && EVENT_CODES.GENERAL_ERROR?.label != null);
  check("every EVENT_CODES entry has both category and label", Object.values(EVENT_CODES).every((e) => typeof e.category === "string" && typeof e.label === "string"));
}

// ─── classifyEvent never throws, never returns null/undefined ────
section("classifyEvent — robustness contract");
{
  const garbageInputs = [null, undefined, "", 123, {}, [], NaN, Symbol("x")];
  let allSafe = true;
  for (const bad of garbageInputs) {
    try {
      const result = classifyEvent(bad, bad);
      if (!result || !result.code) allSafe = false;
    } catch {
      allSafe = false;
    }
  }
  check("classifyEvent never throws and always returns a code, even for garbage input", allSafe);

  const unknown = classifyEvent("SOME_NEW_TAG", "a completely novel error message never seen before, xyz123");
  check("an unrecognized tag/message falls into GENERAL_ERROR, not silently dropped", unknown.code === "GENERAL_ERROR");
  check("GENERAL_ERROR result still carries category+label", unknown.category === "general" && typeof unknown.label === "string");
}

// ─── Known real-world patterns classify correctly ─────────────────
// Each case below is a real message shape confirmed present in production
// logs (see the file header) — pinned so a future rule reorder or typo is
// caught immediately.
section("known patterns — real production message shapes");
{
  const cases = [
    ["WALLET_ERROR", "Helius API error: 429 Too Many Requests", "HELIUS_RATE_LIMIT"],
    ["CRON", "Screening skipped — insufficient SOL (0.000 < 0.745 needed for deploy + gas)", "GENERAL_ERROR"], // CRON isn't an anomaly tag scope, but classifyEvent itself doesn't gate on tag scope — confirms it still falls through cleanly
    ["WALLET_ERROR", "429 Too Many Requests: max usage reached", "HELIUS_MAX_USAGE"],
    ["WALLET_ERROR", "Helius API error: 502 Bad Gateway", "HELIUS_BAD_GATEWAY"],
    ["POSITIONS_WARN", "RPC PnL path failed; falling back to Meteora portfolio API: 503 Service Unavailable: {...}", "HELIUS_RPC_UNAVAILABLE"],
    ["POSITIONS_WARN", "RPC PnL path failed; falling back to Meteora portfolio API: failed to get accounts owned by program ...: account index service overloaded, please try again.", "HELIUS_RPC_OVERLOADED"],
    ["CRON_WARN", "SCREENER reported a deploy but deploy_position did not succeed (401 Unauthorized: Unauthorized) — overriding hallucinated report", "LLM_HALLUCINATED_DEPLOY"],
    ["DEPLOY_ERROR", "Signature 3UipdDvG... has expired: block height exceeded.", "DEPLOY_TX_EXPIRED"],
    ["DEPLOY_ERROR", "Simulation failed. Message: Transaction simulation failed: Error processing Instruction 4: custom program error: 0x1.", "DEPLOY_SIMULATION_FAILED"],
    ["SAFETY_BLOCK", "deploy_position blocked: Pool fee/active-TVL 0.05% is below configured minFeeActiveTvlRatio 0.5%.", "BLOCK_FEE_TVL_LOW"],
    ["SAFETY_BLOCK", "deploy_position blocked: Pool TVL declining 25% since 2026-08-01T00:00:00Z ($10000 → $7500) — exceeds maxTvlDeclinePctForDeploy 20%.", "BLOCK_TVL_DECLINING"],
    ["SAFETY_BLOCK", "deploy_position blocked: Pool quote token is not SOL (EPjFWdd5...) — single-sided SOL deploys require a SOL-quoted pool.", "BLOCK_QUOTE_NOT_SOL"],
    ["PNL_WARN", "6uniXNRK suspicious tick — priceMissing=false depositsMissing=true (solUsd=94.9, priceX=0.001)", "PNL_DEPOSITS_MISSING"],
    ["PNL_WARN", "abc123 suspicious tick — priceMissing=true depositsMissing=false (solUsd=null, priceX=0)", "PNL_PRICE_MISSING"],
    ["CLOSE_WARN", "Position not found in status=closed response (attempt 1/6) — may still be settling", "CLOSE_SETTLEMENT_DELAY"],
    ["CLOSE_ERROR", "500 : error code: 6001", "CLOSE_ONCHAIN_ERROR"],
    ["CLOSE_WARN", "Step 1 (Claim) failed or nothing to claim: No fee to claim", "CLOSE_NOTHING_TO_CLAIM"],
    ["SWAP_ERROR", "Swap V2 order error: Insufficient funds", "SWAP_INSUFFICIENT_FUNDS"],
    ["HIVEMIND_WARN", "Preset pull failed: Invalid HiveMind API key", "HIVEMIND_AUTH_FAILED"],
    ["CRON_ERROR", "Screening cycle failed: 403 No endpoints available matching your guardrail restrictions and data policy.", "LLM_NO_ENDPOINTS"],
    ["WARN", "Repaired malformed JSON args for deploy_position", "AGENT_ARGS_REPAIRED"],
    ["AGENT", "Blocked duplicate deploy_position call — already executed this session", "AGENT_DUPLICATE_BLOCKED"],
    ["TELEGRAM_ERROR", "editMessageText 400: {\"ok\":false,...,\"description\":\"Bad Request: message is not modified...\"}", "TELEGRAM_MESSAGE_UNCHANGED"],
    ["TELEGRAM_ERROR", "sendMessage 400: {\"ok\":false,...,\"description\":\"Bad Request: message thread not found\"}", "TELEGRAM_THREAD_NOT_FOUND"],
    ["CRON_WARN", "Suspect PnL for TEST-SOL: -95% but position still has value — skipping PnL rules", "TEST_ARTIFACT"],
    ["JSON_STORE_WARN", "Invalid JSON in /tmp/meridian-json-store-test-1.json: Expected property name or '}' in JSON at position 2", "JSON_STORE_CORRUPT"],
  ];

  for (const [tag, message, expectedCode] of cases) {
    const result = classifyEvent(tag, message);
    check(`[${tag}] "${message.slice(0, 50)}..." -> ${expectedCode}`, result.code === expectedCode);
  }
}

// ─── Rule precedence — more specific patterns must win ────────────
section("rule precedence — specific patterns checked before general ones");
{
  check(
    "a 'max usage reached' 429 gets HELIUS_MAX_USAGE, not the more generic HELIUS_RATE_LIMIT",
    classifyEvent("WALLET_ERROR", "429 Too Many Requests: max usage reached").code === "HELIUS_MAX_USAGE",
  );
  check(
    "a TEST-SOL fixture never gets misclassified as a real PnL/Helius event",
    classifyEvent("CRON_WARN", "Suspect PnL for TEST-SOL: -95% but position still has value").code === "TEST_ARTIFACT",
  );
}

// ─── describeEvent() — the human-facing contract ──────────────────
// Locks in that any future Telegram/chat/report integration has a safe,
// obvious function to reach for that can only ever return prose, never
// the internal code string.
section("describeEvent() — human-facing output never leaks the internal code");
{
  const label = describeEvent("WALLET_ERROR", "Helius API error: 429 Too Many Requests");
  check("describeEvent returns a string", typeof label === "string");
  check("describeEvent's output does not contain the raw code", !label.includes("HELIUS_RATE_LIMIT"));
  check("describeEvent's output matches classifyEvent's own label", label === classifyEvent("WALLET_ERROR", "Helius API error: 429 Too Many Requests").label);

  // Every defined label, across the whole taxonomy, must read as prose —
  // not double as an identifier a careless caller could mistake for safe
  // to render as-is. Codes are SCREAMING_SNAKE_CASE; labels are not.
  const allLabelsAreProse = Object.values(EVENT_CODES).every((e) => !/^[A-Z0-9_]+$/.test(e.label));
  check("no EVENT_CODES label is itself a bare SCREAMING_SNAKE_CASE code", allLabelsAreProse);
}

process.exit(suite.finish());
