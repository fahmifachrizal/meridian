/**
 * QA protocol — sanitizeCloseReason() (tools/executor.js).
 *
 * close_position's `reason` argument is free text the LLM authors. It was
 * never sanitized — an LLM that formatted its reason as a JSON object
 * instead of a short phrase flowed straight through into pool-memory
 * notes and the Telegram close message verbatim (a real bug: operator
 * reported receiving raw JSON as a "close reason" in Telegram).
 *
 * Pure function, no I/O, no wallet/network — safe to run offline.
 * Run: node test/test-sanitize-close-reason.js
 */

import { createSuite } from "./lib/test-kit.js";
import { sanitizeCloseReason } from "../tools/executor.js";

const suite = createSuite("QA protocol — sanitizeCloseReason");
const { section, check } = suite;

section("Null/empty input");
{
  check("null -> null", sanitizeCloseReason(null) === null);
  check("undefined -> null", sanitizeCloseReason(undefined) === null);
  check("empty string -> null", sanitizeCloseReason("") === null);
}

section("Plain text passes through unchanged");
{
  check("simple reason kept as-is", sanitizeCloseReason("stop loss") === "stop loss");
  check("reason with the codebase's own arrow char kept as-is", sanitizeCloseReason("Trailing TP: peak 3.19% → current 1.24%") === "Trailing TP: peak 3.19% → current 1.24%");
  check("literal '>' stripped like sanitizeStoredText already does for '<>'", sanitizeCloseReason("peak 3% -> current 1%") === "peak 3% - current 1%");
}

section("JSON-object reason — pulls a human string out instead of dumping raw JSON");
{
  check("extracts .reason field", sanitizeCloseReason('{"reason":"stop loss","pnl":-16.2}') === "stop loss");
  check("extracts .rule field when no .reason", sanitizeCloseReason('{"rule":"take profit"}') === "take profit");
  check("extracts .summary field when no .reason/.rule", sanitizeCloseReason('{"summary":"pumped far above range"}') === "pumped far above range");
  check("falls back to stringifying the object when no known field matches", sanitizeCloseReason('{"foo":"bar"}') === '{"foo":"bar"}');
}

section("JSON-array reason");
{
  const result = sanitizeCloseReason('["stop loss","OOR"]');
  check("array with no reason/rule/summary field stringifies the array", result === '["stop loss","OOR"]');
}

section("Malformed JSON-looking text — not valid JSON, cleaned as plain text");
{
  check("unparseable but brace-prefixed text survives as cleaned text", sanitizeCloseReason("{not valid json") === "{not valid json");
}

section("Cleanup — control chars, angle brackets, length cap");
{
  check("newlines/tabs collapsed to single spaces", sanitizeCloseReason("stop\nloss\ttriggered") === "stop loss triggered");
  check("angle brackets and backticks stripped", sanitizeCloseReason("<script>alert(1)</script> `rm -rf`") === "scriptalert(1)/script rm -rf");
  check("capped at 200 chars", sanitizeCloseReason("x".repeat(500)).length === 200);
}

process.exit(suite.finish());
