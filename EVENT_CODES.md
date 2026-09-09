# Event codes reference

The event/error taxonomy in [`util/event-codes.js`](util/event-codes.js) maps a raw log line (`tag` + `message`) to a short, stable code — so recurring incidents (Helius rate limits, deploy simulation failures, a hallucinated deploy report, ...) can be counted and reported on consistently instead of re-diagnosed from scratch every time.

Built from a full sweep of every `logs/agent-*.log` file on disk (2026-07-13 through 2026-09-07, ~200k lines) — every rule below matched at least one real historical occurrence; nothing here is speculative. `scripts/classify-log-events.js` is what generated the frequency counts this taxonomy is based on, and can be re-run any time to check current log volume against it.

## The contract

- **`classifyEvent(tag, message)`** — never throws, never returns `null`. Returns `{ code, category, label }`. An unmatched `(tag, message)` pair falls through to `GENERAL_ERROR` — a first-class bucket for new or not-yet-identified events, not a silent gap. `GENERAL_ERROR` occurrences are meant to be reviewed periodically; if a pattern repeats, promote it into its own rule.
- **`describeEvent(tag, message)`** — the one function any human-facing surface (Telegram, a chat reply, a status report) should call. Returns **only** the `label` — never the internal `code`. `code` is an implementation detail (for counting, grepping, deduping, and the pinned tests in `test/test-event-codes.js`); it must never be shown to a person as-is.
- Rule order matters where one message could match more than one pattern (see `util/event-codes.js`'s `RULES` array) — first match wins, checked top to bottom.

## Where this is actually used

- `scripts/classify-log-events.js` — offline CLI that batch-scans `logs/agent-*.log` for a frequency report.
- `integrations/telegram-format.js`'s `describeErrorForTelegram()` / `formatErrorForTelegram()` — routes Telegram command-handler errors through this taxonomy instead of showing the raw exception string. An unrecognized (`GENERAL_ERROR`) message always keeps its full original text; nothing is ever hidden or paraphrased away.
- `test/test-event-codes.js` — the pinned test suite (robustness, known real-message patterns, rule precedence, the `describeEvent()` human-facing contract).

## The full list (45 codes, 12 categories)

### Helius / RPC provider

| Code | Meaning |
|---|---|
| `HELIUS_MAX_USAGE` | Helius monthly credit cap reached (persistent, not a burst limit) |
| `HELIUS_RATE_LIMIT` | Helius rate limit (429 Too Many Requests) |
| `HELIUS_BAD_GATEWAY` | Helius 502 Bad Gateway |
| `HELIUS_UNAUTHORIZED` | 401 Unauthorized — likely missing/invalid RPC auth |
| `HELIUS_RPC_OVERLOADED` | RPC account-index service overloaded |
| `HELIUS_RPC_UNAVAILABLE` | RPC 503 / internal error |
| `HELIUS_FETCH_FAILED` | Network-level fetch failure to Helius |
| `HELIUS_HTTP_ERROR` | Helius API error, uncategorized HTTP status |

### PnL pricing

| Code | Meaning |
|---|---|
| `PNL_PRICE_MISSING` | PnL tick: price feed data missing for this position |
| `PNL_DEPOSITS_MISSING` | PnL tick: on-chain deposit data missing for this position (usually RPC-side) |
| `PNL_TICK_UNRELIABLE` | PnL tick flagged suspicious for another reason — rule skipped rather than acted on |

### Deploy (on-chain)

| Code | Meaning |
|---|---|
| `DEPLOY_SIMULATION_FAILED` | Deploy tx simulation failed — never broadcast, no gas spent |
| `DEPLOY_TX_EXPIRED` | Deploy tx expired before confirmation — may have cost gas; can leave an orphaned empty position on the wide-range multi-tx path |
| `DEPLOY_TX_ERROR` | Deploy tx resulted in an on-chain error |

### Close (on-chain)

| Code | Meaning |
|---|---|
| `CLOSE_BLOCKHASH_UNAVAILABLE` | Couldn't obtain a fresh blockhash in time (RPC latency) |
| `CLOSE_ONCHAIN_ERROR` | Close tx resulted in an on-chain program error |
| `CLOSE_SETTLEMENT_DELAY` | Close: position still settling on-chain (retried) |
| `CLOSE_NOTHING_TO_CLAIM` | Close: no fee to claim — not an error |
| `CLOSE_SIMULATION_FAILED` | Close: claim/close tx simulation failed |
| `CLOSE_TX_EXPIRED` | Close tx expired before confirmation |
| `CLOSE_STILL_OPEN` | Close: position still appears open after close txs |

### Safety-block (pre-flight rejections — not on-chain failures)

| Code | Meaning |
|---|---|
| `BLOCK_FEE_TVL_LOW` | Blocked: fee/active-TVL below threshold |
| `BLOCK_TVL_DECLINING` | Blocked: pool TVL declining (guard #4) |
| `BLOCK_MIN_AMOUNT` | Blocked: deploy amount invalid or below minimum |
| `BLOCK_POOL_NOT_FOUND` | Blocked: pool not found on the fresh pre-deploy lookup |
| `BLOCK_QUOTE_NOT_SOL` | Blocked: pool's quote token isn't SOL |

### Swap (Jupiter)

| Code | Meaning |
|---|---|
| `SWAP_INSUFFICIENT_FUNDS` | Swap failed: insufficient funds |
| `SWAP_ONCHAIN_FAILED` | Swap failed on-chain |
| `SWAP_NOT_FULLY_SIGNED` | Swap tx not fully signed |
| `SWAP_NO_QUOTE` | Swap: failed to get a quote |

### LLM provider / agent reasoning

| Code | Meaning |
|---|---|
| `LLM_NO_ENDPOINTS` | LLM provider: no endpoints match guardrail/data policy |
| `LLM_PROVIDER_ERROR` | LLM provider returned a generic error |
| `LLM_BAD_RESPONSE` | LLM returned an invalid/unparseable response |
| `LLM_HALLUCINATED_DEPLOY` | LLM claimed a deploy succeeded when it didn't — caught and overridden |

### Telegram

| Code | Meaning |
|---|---|
| `TELEGRAM_MESSAGE_UNCHANGED` | Telegram: edit rejected, content unchanged — benign |
| `TELEGRAM_TRANSIENT_FAILURE` | Telegram: transient send/poll fetch failure |
| `TELEGRAM_PARSE_ERROR` | Telegram: message failed to parse (bad HTML entities) |
| `TELEGRAM_THREAD_NOT_FOUND` | Telegram: target message thread not found (group-topic config) |

### HiveMind

| Code | Meaning |
|---|---|
| `HIVEMIND_AUTH_FAILED` | HiveMind: invalid API key |
| `HIVEMIND_UNAVAILABLE` | HiveMind: request failed or unreachable |

### Agent framework

| Code | Meaning |
|---|---|
| `AGENT_ARGS_REPAIRED` | Agent: malformed tool-call JSON args auto-repaired — not an error |
| `AGENT_DUPLICATE_BLOCKED` | Agent: duplicate protected tool call blocked (once-per-session lock) |

### State / storage

| Code | Meaning |
|---|---|
| `JSON_STORE_CORRUPT` | A JSON state file failed to parse |

### Test harness noise

| Code | Meaning |
|---|---|
| `TEST_ARTIFACT` | Synthetic event from this repo's own test suite, not production |

### Fallback

| Code | Meaning |
|---|---|
| `GENERAL_ERROR` | Unclassified event — new or not-yet-identified pattern |

## Adding a new code

1. Confirm the pattern actually occurred — grep `logs/agent-*.log` (or run `scripts/classify-log-events.js` and look at its `GENERAL_ERROR` sample output) rather than guessing at a message shape.
2. Add an entry to `EVENT_CODES` in `util/event-codes.js` with a `category` and a plain-English `label` (a sentence, not `SCREAMING_SNAKE_CASE`).
3. Add a matching rule to the `RULES` array — place it carefully relative to existing rules if your new pattern could also match an existing, more/less specific one (first match wins).
4. Add a pinned test in `test/test-event-codes.js` using the real message text that prompted the addition.
5. Update this file.
