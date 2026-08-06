# Meridian — CLAUDE.md

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

> **Audience**: future agents/sessions that need to make non-trivial changes
> (add a tool, change a safety rule, fix a cron race, extend a state file)
> without re-reading the whole repo. The README stays user-facing; this
> file is the engineering manual.

---

## TL;DR (read this first)

- **What it is**: Node 22+ ESM service that runs an LLM-driven loop
  (OpenAI-compatible) to screen Meteora DLMM pools, deploy SOL into
  long/short positions, monitor them, and close them — all without a human
  in the loop. Telegram + Discord provide ops surface; HiveMind provides
  shared learning.
- **Entry points**: `node index.js` (full daemon — REPL + cron + Telegram),
  `node cli.js <cmd>` (one-shot CLI), `node setup.js` (first-run wizard).
- **Two agent roles run automatically**:
  - `SCREENER` — every `screeningIntervalMin` minutes, picks a pool,
    calls `deploy_position`.
  - `MANAGER` — every `managementIntervalMin` minutes, evaluates open
    positions, claims/closes them.
- **`GENERAL`** role handles ad-hoc chat (REPL, Telegram, Claude Code
  slash commands) and dispatches to a role-filtered tool subset based on
  intent-pattern matching of the user's goal.
- **All state lives in JSON files at the repo root** — see
  [§ Persistent files](#persistent-files) below. There is no DB.
- **"Always first read the rest of this file"** — there are real
  cross-cutting invariants (lazy SDK load, ONCE_PER_SESSION tool locks,
  position-cache TTL, trailing-TP 15s recheck) that are easy to break.

---

## Architecture

```
                ┌──────────────────────────────────────────────┐
                │              index.js  (daemon)              │
                │  REPL + cron + Telegram bot + PnL poller    │
                │  Health check + briefing + HiveMind HB      │
                └────────────┬─────────────────────────────────┘
                             │
            ┌────────────────┼────────────────────┐
            ▼                ▼                    ▼
       runScreeningCycle  runManagementCycle  cron (every N min)
            │                │                    │
            └────────┬───────┘                    │
                     ▼                            │
                 agentLoop() ◀────────────────────┘
                  (ReAct)               (telegram / REPL messages)
                     │
                     ▼
              buildSystemPrompt(role, …)  →  LLM  →  tool calls
                                                       │
                                                       ▼
                                                executeTool(name, args)
                                                       │
                                                       ▼
                                              PROTECTED_TOOLS →
                                              runSafetyChecks()
                                                       │
                                                       ▼
                                                toolMap[name](args)
                                                       │
                                  ┌────────────────────┴──────────┐
                                  ▼                                ▼
                       tools/dlmm.js (SDK)               tools/wallet.js (Jupiter)
                       tools/screening.js                tools/token.js (Jupiter)
                       tools/study.js (LPAgent)         tools/agent-meridian.js
                                                      tools/chart-indicators.js
                                  │                                │
                                  └──────── on-chain + 3rd-party APIs ─┘
```

### Module responsibilities (read me before editing)

| File | Lines | Purpose |
|---|---:|---|
| **Entry / orchestration** | | |
| `index.js` | ~2016 | Daemon. Cron, REPL, Telegram bot, briefing, HiveMind bootstrap, PnL poller, deterministic close rules, single-candidate skip rule, settings menu. **All** automatic cycles start here. |
| `core/agent.js` | 416 | `agentLoop(goal, maxSteps, history, agentType, model, maxOut, opts)`. The ReAct loop. Provider fallback, JSON repair, once-per-session tool locks, no-tool retries, `onToolStart`/`onToolFinish` callbacks for live Telegram messages. |
| `cli.js` | 676 | One-shot CLI; every tool exposed as a subcommand. Also writes a `~/.meridian/SKILL.md` at startup for agent discovery. Loads `.env`/`user-config.json` from `~/.meridian/` if present, else from cwd. |
| `setup.js` | ~750 | Interactive first-run wizard. Three presets (degen/moderate/safe) + custom. Covers strategy, screening filters, position sizing, trailing TP, per-role models. |
| **Config & state** (`core/`, `regime/`) | | |
| `core/config.js` | 278 | Loads `user-config.json` → live `config` object. Sections: `risk`, `screening`, `management`, `strategy`, `schedule`, `llm`, `darwin`, `tokens`, `hiveMind`, `api`, `jupiter`, `indicators`, `regime`. Exposes `computeDeployAmount(walletSol)`, `reloadScreeningThresholds()`. `MIN_SAFE_BINS_BELOW = 35` (exported). |
| `core/prompt.js` | 176 | `buildSystemPrompt(agentType, …)`. Three role-specific prompts. MANAGER is intentionally lean (positions pre-loaded into goal). SCREENER gets bins_below formula. |
| `regime/market-regime.js` | 48 | `classifyRegime(candidates, {targets, cutoffs})` — pure, side-effect-free (no I/O). Median `degenScore()` across a cycle's candidates vs `slowCutoff`/`hotCutoff` → `"slow"`/`"normal"`/`"hot"`/`null` (empty sample fails open to `null`, meaning "no re-evaluation possible this cycle"). |
| `regime/market-regime-library.js` | ~190 | Persists `market-regime-profiles.json`: `active` regime pointer, `consecutiveFails` counter, `suppressedRegime`/`suppressedUntil` window. The `changes` maps under each regime id are **legacy documentation only** — no longer applied to config (see `regime-overlay.js`). `recordScreeningOutcome({deployed})`, `noteRegimeRelax(fromRegime, suppressMs)`, `isRegimeSuppressed(id)`, `clearRegimeSuppression()`. |
| `regime/regime-overlay.js` | ~140 | **The only code path that actually changes config for a regime.** `computeRegimeOverlay(regimeId, baseline)` — bounded + ratcheted, pure function. `REGIME_TUNABLE` is the exhaustive whitelist of 8 keys a regime may touch (4 screening, 4 risk). Risk keys (`deployAmountSol`, `positionSizePct`, `stopLossPct`) are ratcheted: a regime can only ever move them toward LESS exposure than `baseline`, never more — this is what stops a "hot" (volatile) regime from sizing up into the exact conditions that produced the original SalaryCat-SOL loss. `applyOverlayToLiveConfig()` mutates the in-memory `config` object ONLY — never writes `user-config.json`, never pushes Supabase. `readBaseline()` reads the operator's own `user-config.json` (falling back to live config per key) as the reference the overlay is derived FROM. See README's "Market regime state machine" diagram for the full picture. |
| **Tools layer** | | |
| `tools/definitions.js` | 1124 | OpenAI-format tool schemas. **Source of truth for what the LLM sees.** All 40+ tool names listed. |
| `tools/executor.js` | ~1100 | `executeTool(name, args)`. Pre-flight safety checks for `PROTECTED_TOOLS = {deploy, claim, close, swap, self_update}`. Validates pool thresholds via fresh pool discovery call before deploy. Post-tool side-effects: telegram notifications, pool-memory auto-annotation on `low yield` close, auto-swap base→SOL on close. `CONFIG_MAP` is exported (used by `test-invariants.js`, `regime-overlay.js`'s whitelist check, `market-regime-invariants.js`). `applyConfigChanges()` (the shared apply+persist logic behind `update_config`) writes `user-config.json` locally but **does not** push to Supabase anymore — see `supabase-config.js` below. |
| `integrations/supabase-config.js` | ~130 | `pullSupabaseConfig()` — the agent's ONLY sanctioned Supabase interaction, called on startup + every 15 min (`startSupabaseConfigBackgroundSync`). Remote wins on any key it has, merges into `user-config.json`, reloads live config. `pushSupabaseConfig()` still exists (used only by `scripts/push-config.js`, an operator-run CLI) but is **never called from anywhere in the running agent** — Supabase is the operator's source of truth and is pull-only for the agent by design. |
| `tools/dlmm.js` | huge | Meteora DLMM SDK wrapper. **Lazy-loads** `@meteora-ag/dlmm` to avoid CJS-import-time crash in DRY_RUN/test. Pool cache (5 min), metadata cache (15 min), positions cache (5 min TTL + inflight dedup). `deployPosition`, `getMyPositions`, `getPositionPnl`, `getActiveBin`, `closePosition`, `claimFees`, `searchPools`, `getWalletPositions`, `addLiquidity`, `withdrawLiquidity`. Also has relay-mode (zap-in via LPAgent) and wide-range path (multi-tx `createExtendedEmptyPosition` + `addLiquidityByStrategyChunkable` for >69 bin ranges). Asserts Meteora bin-array initialization rent never charged. |
| `tools/screening.js` | 862 | `discoverPools`, `getTopCandidates` (hard filter + enrich + score), `getPoolDetail`. Scoring = `fee_tvl*1000 + organic*10 + vol/100 + holders/100`. Has Discord signal merge/only modes, PVP-rival detection. |
| `tools/wallet.js` | 251 | `getWalletBalances` (Helius), `swapToken` (Jupiter Swap V2). `normalizeMint` collapses "SOL"/"native"/any So1-prefixed token to wrapped-SOL. Built-in referral: 50 bps to a fixed address (configurable). |
| `tools/token.js` | 209 | `getTokenInfo` (Jupiter datapi), `getTokenHolders` (top 100 + filter pool-tagged), `getTokenNarrative` (Jupiter ChainInsight). Cross-references smart wallets from `smart-wallets.json`. |
| `tools/study.js` | 152 | `studyTopLPers` → Agent Meridian `/top-lp` + `/study-top-lp`. Returns ranked LPer patterns (avg hold, win rate, preferred strategy). |
| `tools/agent-meridian.js` | 110 | `agentMeridianJson(path, opts)` with retry/backoff. Default base = `https://api.agentmeridian.xyz/api`. |
| `tools/chart-indicators.js` | 299 | `confirmIndicatorPreset({mint, side})`. Eight presets: `supertrend_break`, `rsi_reversal`, `bollinger_reversion`, `rsi_plus_supertrend`, `supertrend_or_rsi`, `bb_plus_rsi`, `fibo_reclaim`, `fibo_reject`. Fetches from Agent Meridian `/chart-indicators/{mint}`. |
| **Guards** (`guards/`) — see "Market regime overlay" below for a similarly-shaped system on the config side | | |
| `guards/01-token-age-window.js` through `guards/07-avoid-pin.js` | | The 7 post-mortem safety guards, one file per guard, numbered by **execution order** (not by when each was historically added — see the "Known issues" entry on this). Each file owns the DECISION (a pure predicate given state + config); `state/pool-memory.js`/`state/lessons.js` keep owning persistence, guards import their read accessors. Two guards (#4 TVL-decline, #5 repeat-deploy-taper) fire at two pipeline stages each and export two functions rather than being split across files. Call sites: `tools/screening.js` (guards #1–#3), `tools/executor.js` (guards #4–#5), `index.js`'s `getDeterministicCloseRule` (guard #6), `state/lessons.js`'s `recordPerformance` (guard #7). |
| **Persistence** (`state/` — JSON stores still live at repo root, unmoved) | | |
| `state/state.js` | 513 | `trackPosition`, `markOutOfRange/InRange`, `recordClaim`, `recordClose`, `setPositionInstruction`, `updatePnlAndCheckExits` (the deterministic rules: STOP_LOSS, TRAILING_TP, OUT_OF_RANGE, LOW_YIELD), `getStateSummary`. `syncOpenPositions` reconciles local state with on-chain after 5 min grace. |
| `state/pool-memory.js` | 405 | Per-pool deploy history + rolling 48-snapshot trend (5min × 4h). Computes `avg_pnl_pct`, `win_rate`, `adjusted_win_rate` (excludes OOR pumps). Cooldown logic: low yield → 4h pool cooldown, 3× OOR closes → 12h pool+token cooldown, optional repeat-deploy cooldown (configurable trigger count/hours/min fee yield/scope). `recordPositionSnapshot`, `recallForPool` for prompt injection. |
| `state/lessons.js` | 765 | `recordPerformance(perf)` called by executor after `close_position`. Builds lesson string (PREFER/AVOID/WORKED/FAILED). Pinned + role-tagged lesson injection (3-tier cap: PINNED, ROLE, RECENT) with `ROLE_TAGS` map. `evolveThresholds` adjusts `minOrganic` (auto), and writes `[AUTO-EVOLVED @ N]` lesson + applies to live `config`. **Known bug: also references `maxVolatility` and `minFeeTvlRatio` which don't exist in config — no-op for those keys.** `pushHiveLesson`/`pushHivePerformanceEvent` are fire-and-forget. |
| `state/decision-log.js` | 68 | Rolling 100-entry log. Types: `deploy` / `close` / `skip` / `no_deploy`. Each entry: actor, pool, summary, reason, risks[], metrics{}, rejected[]. Surfaced via `get_recent_decisions` tool and `getDecisionSummary()` in the prompt. The 100-cap is *runtime* behavior only — full history goes to the `decisions` archive stream, because real volume is ~100/day and the cap was destroying about a day of history daily. |
| `state/json-store.js` | ~105 | `loadCached(path, makeEmpty, label)` / `saveJson` / `invalidateCache`. Caches the parsed object, re-parsing only when mtime **or size** changes. Every state store reads through it. **Returns a SHARED mutable reference** — mutate only if you then save; never mutate-and-abandon or the mutation is served to the next reader as if persisted. Defensive copying was measured and rejected (`structuredClone` of pool-memory.json costs 2.26ms vs a 1.86ms parse). Measured win: 400 pool-memory reads went 744ms → 8.7ms. |
| `state/archive.js` | ~140 | Dated append-only JSONL at `logs/archive/<stream>-YYYYMMDD.jsonl`, four streams (`decisions`, `performance`, `lessons`, `positions`) hooked at their existing single write points. JSONL because appending is a pure `appendFileSync`. Date computed **per write** (UTC, copying `logger.js`) so a long-lived process rolls over at midnight. `archiveAppend` never throws into its caller — an archive must never break a deploy. **Suppressed when `NODE_ENV=test`**. ~98 KB/day / ~35 MB/year measured across all four streams. |
| `state/signal-tracker.js` | 87 | In-memory 10-min staging for screening-time signals (`organic_score`, `fee_tvl_ratio`, …). Cleared on deploy or TTL. **Not persisted** — fine because the staged snapshot is also written to `state.json` via `trackPosition({ signal_snapshot })`. |
| `state/signal-weights.js` | 330 | Darwinian signal weighting. Recalculates every 5 closes (or 10-sample min). Splits signals into quartiles; top → `weight*1.05`, bottom → `weight*0.95`. Persists `signal-weights.json`. `getWeightsSummary()` injected into SCREENER prompt. |
| `state/strategy-library.js` | 227 | Saved LP strategies. Five defaults preloaded: `custom_ratio_spot`, `single_sided_reseed`, `fee_compounding`, `multi_layer`, `partial_harvest`. `getActiveStrategy()` → used in SCREENER prompt. |
| `state/smart-wallets.js` | 103 | Tracked KOL/alpha wallets. `type: "lp"` (default) checks positions; `type: "holder"` only checks token holdings. 5-min position cache. `check_smart_wallets_on_pool` is the deployment confidence signal. |
| `state/token-blacklist.js` | 103 | Mint → reason. Hard-filtered before LLM in `getTopCandidates`. |
| `state/dev-blocklist.js` | 66 | Deployer wallet → reason. Hard-filtered before LLM, fetched from Jupiter dev field. |
| `state/position-log.js` | | Records deploy/close events to Supabase (a separate, simpler channel than `supabase-config.js`'s config sync). |
| **Integrations** (`integrations/`) | | |
| `integrations/hivemind.js` | 346 | Agent Meridian shared learning. `bootstrapHiveMind` on startup, `startHiveMindBackgroundSync` every 15 min. Pushes lessons + performance events; pulls shared lessons + presets. `getSharedLessonsForPrompt` → injected under `── HIVEMIND ──` in prompt. Failures are non-blocking. |
| `integrations/telegram.js` | ~590 | `startPolling(onMessage)`, `stopPolling()`. Long-poll with 35s abort. `createLiveMessage` returns a handle with `toolStart/toolFinish/note/finalize/fail` for live progress; supports `{parseMode: "HTML"}`. `htmlTable(rows, {labelWidth})` is the shared house style — aligned `<pre>` label/value blocks, both sides escaped via `escapeHtml()`. Sends deploy/close/swap/OOR/**regime-change** notifications, all HTML, all escaped. `notifyRegimeChange({from, to, reason, changes})` explicitly states the change is in-memory-only so it's never mistaken for a saved-baseline edit. Auth: `isAuthorizedIncomingMessage` (chatId match + group→allowed user IDs). Registers `/help` `/status` `/positions` `/close` `/closeall` `/set` `/settings` `/setcfg` `/screen` `/candidates` `/deploy` `/briefing` `/hive` `/pause` `/resume` `/stop` via `setMyCommands`. |
| `integrations/briefing.js` | 71 | HTML daily report. 24h activity, performance, lessons, current portfolio. Sent at 1:00 UTC. |
| `discord-listener/index.js` | 152 | Selfbot (uses `discord.js-selfbot-v13`). Listens to `DISCORD_CHANNEL_IDS` for `Metlex Pool Bot`, extracts Solana addresses, runs pre-check pipeline, appends to `discord-signals.json`. Independent of this folder reorg — computes its own repo-root path, imports none of the moved files. |
| `discord-listener/pre-checks.js` | 205 | Pipeline: dedup (10min) → blacklist → pool resolution (Meteora direct → DexScreener) → rugcheck.xyz (score>50000 OR top10>60% reject) → deployer blacklist → Jupiter global fees check (`minTokenFeesSol`). |
| **Infra** (stays at repo root — see reasoning in each row) | | |
| `util/envcrypt.js` | 121 | XOR-cipher with a key from `.envrypt`/`ENVRYPT_KEY`. Encrypts anything matching `*_KEY`, `*SECRET*`, `*TOKEN*`, `*MNEMONIC*`, etc. The `# encrypted` marker in `.env` precedes encrypted lines. |
| `util/fetch-timeout.js` | 25 | `fetchWithTimeout(url, options, timeoutMs)`, 15s default via `AbortController`. Native `fetch` has **no** default timeout — an accepted-but-silent connection hangs the await forever, which is what wedged `_screeningBusy` for 13h in production. |
| `util/concurrent.js` | ~95 | `mapWithConcurrency(items, fn, {limit, deadlineMs})` — bounded parallelism with a hard deadline, results in input order, never rejects. Unfinished items return `{status:"timedout"}`. Used by the screening recon phase; `valueOr(result, fallback)` is the companion accessor. |
| `util/http-cache.js` | ~110 | `cachedJson(url, {ttlMs, timeoutMs})` — in-process TTL cache + inflight dedup for idempotent discovery GETs. Non-OK responses are never cached, and any error falls through to a real fetch, so it can't starve a cycle. Deliberately not Redis (single process, small bodies; a hop + re-parse would cost more than it saves). |
| `integrations/telegram-format.js` | ~160 | The house style: `card`, `compactLine`, `positionBlock` (4 dense lines, replaces the 7-row table), `noDeployReport` (`html:true` for direct sends, `html:false` for `runScreeningCycle`, which escapes `screenReport` wholesale at finalize), plus `fmt*` helpers that render null/"" as `?` rather than a misleading `0`. |
| `logger.js` | 75 | Daily-rotating `logs/agent-YYYY-MM-DD.log`. `logAction({tool, args, result, duration_ms, success})` writes JSONL `actions-YYYY-MM-DD.jsonl` audit trail. Level via `LOG_LEVEL` env. **Deliberately stays at repo root** — imported by 18-19 of the 25 files under `core/`/`state/`/`regime/`/`integrations/`, a near-universal dependency rather than a concern bucket. |
| `repo-root.js` | 11 | `REPO_ROOT`/`repoPath()` — anchors JSON state-file resolution to wherever this file itself lives. **Deliberately stays at repo root**, same reasoning as `logger.js`, plus: JSON files never moved in the 2026-07 folder reorg, so the anchor can't move without every `repoPath("x.json")` call resolving one level off. |
| **Other** | | |
| `discord-listener/`, `test/`, `utils/` | | Discord listener (above), syntax-checked tests, `safeNumber`. |
| `scripts/push-config.js` | ~50 | **Operator-only**, never called by the agent. Publishes local `user-config.json` to Supabase. Dry-run by default (lists keys + flags secret-looking values); `--yes` actually pushes. |
| `scripts/pull-vps-state.sh` + `scripts/reconcile-user-config.js` | | **Operator-only**, pull-only in both directions (VPS and Supabase). Pulls the VPS's live JSON state files verbatim (they're ground truth for a running agent); `user-config.json` is reconciled instead of overwritten, priority Supabase > local > VPS (VPS only fills gaps, never overrides). Config via `scripts/.env.vps` (gitignored, template at `scripts/.env.vps.example`). Run via `npm run pull:vps`. **Gotcha already fixed once**: `scp` uses `-P` (capital) for port, `ssh` uses `-p` — do not share one options array between them, or every `scp` silently fails (misparses the port as a source path). |
| `.claude/agents/{screener,manager}.md` | | Claude Code sub-agent configs — used when you run `claude` inside the repo. |
| `.claude/commands/*.md` | | Slash commands (`/screen`, `/manage`, `/balance`, `/candidates`, `/pool-ohlcv`, etc.) that wrap `cli.js`. |
| `.claude/settings.json` | | Denies `rm -rf`, `wget`, `Read(./.env*)`. **Forbids `run_in_background: true` via a PreToolUse hook.** |

---

## Agent roles & tool access

Three roles (`core/agent.js:7-8`):

| Role | Tool set (filter on `MANAGER_TOOLS` / `SCREENER_TOOLS` / `INTENT_TOOLS`) | Prompt source |
|---|---|---|
| `SCREENER` | `deploy_position, get_active_bin, get_top_candidates, check_smart_wallets_on_pool, get_token_holders, get_token_narrative, get_token_info, search_pools, get_pool_memory, get_wallet_balance, get_my_positions` | `prompt.js:104` — strict regime, "no hallucination" hard rule, must call `deploy_position` to claim success. |
| `MANAGER` | `close_position, claim_fees, swap_token, get_position_pnl, get_my_positions, get_wallet_balance` | `prompt.js:18` — *mechanical rule-application*; positions + management config pre-loaded in goal. |
| `GENERAL` | Intent-pattern matched (see `INTENT_PATTERNS` in `core/agent.js:51`). 17 intents: decisions, deploy, close, claim, swap, selfupdate, blocklist, config, balance, positions, strategy, screen, memory, smartwallet, study, performance, lessons. | `prompt.js:156` — full instruction-following. |

Some tools are explicitly **never** sent to GENERAL unless the goal matches an intent: `self_update`, `update_config`, all `add/remove_*` and `pin_/unpin_` tools, `clear_lessons`, `set_active_strategy` (see `GENERAL_INTENT_ONLY_TOOLS`).

### Adding a new tool

1. **`tools/definitions.js`** — add the OpenAI-format schema to the `tools` array.
2. **`tools/executor.js`** — add `tool_name: functionImpl` to the `toolMap`. If it modifies on-chain state, also add it to `WRITE_TOOLS` + `PROTECTED_TOOLS` and add a `case` in `runSafetyChecks()`.
3. **`core/agent.js`** — add the tool name to `MANAGER_TOOLS` / `SCREENER_TOOLS` and/or to the relevant `INTENT_TOOLS[intent]` set.
4. If you want it in the Telegram `/settings` button menu, add it to `settingValue()` in `index.js` + the relevant `renderSettingsMenu` page.

---

## The ReAct loop (`core/agent.js:157`)

- **System prompt is built at the start of every cycle** with: portfolio, positions, state summary, lessons (3-tier cap — pinned / role / recent), performance summary, decision summary, optional signal weights summary (SCREENER only), `lessons_for_prompt`.
- **Messages get pushed in OpenAI format** unless the provider rejects the `system` role — then we switch to `providerMode = "user_embedded"` and embed the system prompt inside a user message.
- **Per-step retry**: 3 attempts on transient errors. If the response is 502/503/529 the second attempt swaps to fallback model `stepfun/step-3.5-flash:free`. If `tool_choice=required` is rejected or the provider is in thinking mode, retry with `tool_choice=auto` / omitted.
- **Tool args are JSON-validated** and run through `jsonrepair` if malformed; unrepairable args result in `blocked: true` returned to the LLM.
- **No-tool-loop guard**: if `mustUseRealTool` is true (action intents, `MUTATING_TOOL_INTENTS` regex) and the LLM responds with text only, we inject a reminder; second failure returns an error message.
- **Once-per-session tool locks**:
  - `ONCE_PER_SESSION = { deploy_position, swap_token, close_position }` — blocked on second call regardless of success.
  - `NO_RETRY_TOOLS = { deploy_position }` — locks on first attempt even if it failed.
  - For `swap_token` / `close_position`, locks only on `result.success === true` so a genuine failure can be retried.
- **On every tool call**: `logAction({tool, args, result, duration_ms, success})` writes the audit JSONL.

---

## Cron & cycle architecture (`index.js`)

Cron tasks created by `startCronJobs()`:

| Task | Cadence | Job |
|---|---|---|
| Management | `*/managementIntervalMin * * * *` | `runManagementCycle()` |
| Screening | `*/screeningIntervalMin * * * *` | `runScreeningCycle()` |
| Health check | `0 * * * *` | One-shot `agentLoop` as MANAGER with health summary goal |
| Briefing | `0 1 * * *` (UTC) | `runBriefing()` — 8 AM Jakarta |
| Briefing watchdog | `0 */6 * * *` (UTC) | `maybeRunMissedBriefing()` — fires on startup if missed |
| **PnL poller** | every 30s (`setInterval`) | Trailing-TP detection between management cycles (below) |

**Race condition guards** (all in `index.js`):
- `_managementBusy` / `_screeningBusy` flags prevent overlap.
- `_screeningLastTriggered` (epoch ms) prevents management from spamming screening.
- `_pollTriggeredAt` cooldown equal to `managementIntervalMin` to avoid PnL-poller double-triggering.
- `deploy_position` safety check uses `force: true` on `getMyPositions()` for a fresh position count.

### The hybrid management cycle (deterministic + LLM)

The management cycle is **mostly deterministic in JS, LLM only for the hard cases**:

1. `getMyPositions({ force: true })` → snapshot.
2. `recordPositionSnapshot` per pool.
3. JS `updatePnlAndCheckExits(position, …)` for each:
   - `STOP_LOSS` if `pnl_pct <= stopLossPct`
   - `TRAILING_TP` if `trailing_active && (peak - current) >= trailingDropPct` (queued for 15s recheck)
   - `OUT_OF_RANGE` if `minutes_out_of_range >= outOfRangeWaitMinutes`
   - `LOW_YIELD` if `fee_per_tvl_24h < minFeePerTvl24h && age >= minAgeBeforeYieldCheck`
4. For positions with no exit alert: `getDeterministicCloseRule(p, mgmtConfig)` applies the **5 hard rules** (`index.js:895`):
   - Rule 1: stop loss, Rule 2: take profit, Rule 3: pumped far above range, Rule 4: OOR wait, Rule 5: low yield.
5. Positions needing `CLAIM` if `unclaimed_fees_usd >= minClaimAmount`.
6. Positions with `instruction` set are marked `INSTRUCTION` and deferred to the LLM.
7. **LLM is invoked only if any actionMap value is not `STAY`**, with a hard-coded goal that already lists positions + their assigned action. The LLM just executes (no re-evaluation). This saves tokens and prevents hallucinated rules.

**Trailing TP two-phase confirmation** (15s recheck):
- First poll: candidate drop queued in state.
- 15s later: re-fetch positions, `resolvePendingTrailingDrop` — if the drop still holds (within 1% tolerance), fire `confirmed_trailing_exit` and trigger management cycle.
- Mirror pattern for peak confirmation (`queuePeakConfirmation` / `resolvePendingPeak`).

### The screening cycle (multi-stage pipeline)

1. **Pre-checks**: `getMyPositions` + `getWalletBalances` in parallel. Skip if at `maxPositions` or `balance.sol < deployAmountSol + gasReserve`. Each skip writes a `decision-log` entry.
2. **Top candidates**: `getTopCandidates({limit: 10})` — applies ALL hard filters (TVL, fee/TVL, volatility, organic, holders, mcap, bin step, launchpad allow/block, token age, cooldowns, base mints already in use, dev blocklist), optional indicator confirmation, **and** PVP-rival detection (default: warn; `blockPvpSymbols: true` → hard filter).
3. **Sequential recon** with 150ms throttle (avoid 429s): `getActiveBin`, `checkSmartWalletsOnPool`, `getTokenNarrative`, `getTokenInfo` per candidate.
4. **Hard filters after recon**: launchpad allow/block, `bot_holders_pct > maxBotHoldersPct`.
5. **If 0 pass**: write `no_deploy` decision with `rejected[]` and return `⛔ NO DEPLOY` report.
6. **If 1 pass**: `getLoneCandidateSkipReason()` (smart-wallet absence, no narrative, PVP conflict, etc.) — if skipped, write `no_deploy` decision.
7. **Stage signals** for Darwinian attribution.
8. **Compact candidate blocks** built in `index.js:543`.
9. **LLM** gets the blocks + active strategy + balance + computed deploy amount + bins_below formula. The LLM is *forced* via `tool_choice: "required"` on step 0.
10. **Post-deploy**: `appendDecision` with full context. Darwinian signals (if enabled) get consumed via `getAndClearStagedSignals`.

Regime detection/overlay (below) runs between steps 2 and the rest — right after `getTopCandidates()` returns this cycle's candidate set, before `deployAmount`/`strategyBlock` are computed, so a same-cycle regime switch is reflected in this cycle's sizing and prompt.

---

## Market regime overlay

Detects Slow/Normal/Hot from the current screening cycle's candidates and adjusts config accordingly — but through a **bounded, ratcheted, in-memory-only** channel, not the absolute apply-and-persist path an earlier version of this feature used. See README's "Market regime state machine" and "Regime change ↔ open positions" diagrams for the full picture; this section is the engineering summary.

**Why bounded/ratcheted at all**: the original design handed a profile's *absolute* `changes` map straight to `applyConfigChanges()`, which persisted to `user-config.json` and pushed to Supabase — an automated market read could permanently overwrite the operator's own risk settings. Worse, its `hot` profile sized **up** (`deployAmountSol`, `positionSizePct`) and widened the stop-loss in the most volatile conditions — the exact shape of the SalaryCat-SOL loss this repo was built to prevent. `regime-overlay.js` replaces that.

**The flow, once per screening cycle** (`index.js`'s `runScreeningCycle`):
1. `classifyRegime(candidates, {targets, cutoffs})` → `"slow"`/`"normal"`/`"hot"`/`null`.
2. `prevRegime = getActiveRegime()?.id ?? "normal"` — **read `.id`, not `.active`**. A profile object exposes `id`; only the top-level store object has `.active`. This was a real bug (fixed): reading `.active` off the profile made `prevRegime` permanently `"normal"`, so every non-normal detection re-applied config every single cycle. If you ever see repeated identical `[SELF-TUNED]` lessons piling up, check this first.
3. If `regime !== prevRegime` and `!isRegimeSuppressed(regime)`: `applyRegimeOverlay(regime, reason, prevRegime)` (in `index.js`) — calls `readBaseline()` + `computeRegimeOverlay()` + `applyOverlayToLiveConfig()`, then `setActiveRegime()`, then logs a `regime_change` decision + sends `notifyRegimeChange()`.
4. If `regime !== prevRegime` but suppressed: no-op, just logs why.

**The relax/loopback-suppression fallback** — a *separate* mechanism, needed because #3 alone can starve itself: a tightened regime lowers the discovery filters `classifyRegime` samples from next cycle, so once candidates hit zero, the classifier gets an empty sample and fails open (`null` = no re-evaluation), and the regime can get stuck tight even after conditions recover.
- `noteScreeningResult(deployed)` runs after **every** screening outcome (all 4 no-deploy exit points + the success path). `recordScreeningOutcome({deployed})` increments/resets a persisted fail counter.
- After `config.regime.relaxAfterFails` (default 3) consecutive no-deploy cycles with `activeId !== "normal"`: force-relax to `normal` via the same `applyRegimeOverlay()` path, then `noteRegimeRelax(activeId, suppressMinutes * 60_000)` — zeroes the counter AND suppresses re-entry into `activeId` for `config.regime.suppressMinutes` (default 120min). Other regimes stay reachable; only the one just left is blocked, so this can't freeze adaptation, only break the specific tighten→starve→relax→re-tighten loop.

**`regime-overlay.js`'s `REGIME_TUNABLE`** is the exhaustive whitelist — nothing outside these 4 keys is regime-tunable. `maxPositions`/`maxDeployAmount` are deliberately absent (portfolio ceilings stay 100% operator-owned), and — by explicit operator decision — so are `minFeeActiveTvlRatio`, `positionSizePct`, `stopLossPct`, and `takeProfitPct`. Regime affects screening bars only (`minTvl`, `minVolume`, `minOrganic`) plus exactly one risk key (`deployAmountSol`); nothing about position sizing beyond `deployAmountSol` or exit rules is ever touched by regime:

| Key | Kind | Mode | slow factor | normal factor | hot factor | Bound |
|---|---|---|---|---|---|---|
| `minTvl` | screening | mult | 0.7 | — (no-op) | 1.5 | relative 0.5–3.0× baseline |
| `minVolume` | screening | mult | 0.6 | — (no-op) | 1.5 | relative 0.4–3.0× baseline |
| `minOrganic` | screening | delta | −6 | — (no-op) | +6 | absolute 40–95 |
| `deployAmountSol` | risk, **ratchet: down** | mult | 0.70 | **0.85** | 1.00 | absolute 0.05–50, never > baseline |

The ratchet is applied **last**, after every other clamp, so it always wins — even a pathological baseline can't produce an overlay that authorizes more risk than the operator set. `normal` returns `{}` for any key with no explicit `normal:` factor (exact no-op; baseline stands) — of the 4 keys above, only `deployAmountSol` opts in to its own three-way sizing policy (full size in hot, 85% in normal, 70% in slow/cool — a deliberate operator choice, not the "size down when volatile" pattern a risk key would default to). This also closes a real gap the old blanket-normal-is-always-{} rule had: since `computeRegimeOverlay` is called on every regime *transition* (including transitions *into* normal), a key with no `normal:` factor simply keeps whatever a prior hot/slow overlay last set it to — there is no periodic correction back to baseline for such a key short of a Supabase pull (screening keys only, via `reloadScreeningThresholds()`) or a full process restart. `deployAmountSol` doesn't have this gap because every transition, including into normal, now computes it fresh from baseline. Unknown/null regime id still returns `{}` (fails safe) for every key.

`minFeeActiveTvlRatio`, `positionSizePct`, `stopLossPct`, and `takeProfitPct` were regime-tunable in an earlier version of this system (with slow/hot factors and, for the risk keys, a ratchet) — removed by explicit operator decision so regime can never touch deploy sizing beyond `deployAmountSol` or any exit rule. If you're tempted to re-add one of them: don't, unless the operator asks — this was a deliberate scope narrowing, not an oversight.

**Adding a new regime-tunable key**: add it to `REGIME_TUNABLE` with a real `CONFIG_MAP` entry (checked by `test:regime-overlay`'s whitelist-integrity test), decide `mode` (`mult` for proportional, `delta` for additive), pick `slow`/`hot` factors, and — critically — decide whether it needs `ratchet: "down"`/`"up"` (anything that changes loss exposure should be ratcheted; anything that doesn't, like `takeProfitPct`, doesn't need to be).

---

## Position lifecycle

```
deployPosition()                   tools/dlmm.js
   ├─ safety: pool_detail fresh fetch, TVL, fee/TVL, volatility, bin_step
   ├─ safety: bin-array init rent check (refuses pools that need initialization)
   ├─ strategy: spot | curve | bid_ask (config.strategy.strategy)
   ├─ range: bins_below linear in volatility, totalBins >= 35 (MIN_SAFE_BINS_BELOW)
   ├─ wide path: totalBins > 69 → createExtendedEmptyPosition + addLiquidityByStrategyChunkable
   ├─ standard path: initializePositionAndAddLiquidityByStrategy
   └─ post: trackPosition({ signal_snapshot: getAndClearStagedSignals })
        appendDecision({ type: "deploy", actor: "SCREENER", metrics, risks, rejected })
        notifyDeploy (Telegram)   ── skip if live message active

manage cycle (every N min)
   ├─ recordPositionSnapshot per pool
   ├─ updatePnlAndCheckExits → STOP_LOSS / TRAILING_TP / OOR / LOW_YIELD
   ├─ getDeterministicCloseRule → 5 hard rules
   ├─ LLM invoked only for non-STAY actions (or INSTRUCTION)
   └─ on close: recordClose() → recordPerformance() in lessons.js
                 ├─ recordPoolDeploy (pool-memory.json)
                 ├─ derive lesson (PREFER/AVOID/WORKED/FAILED)
                 ├─ if performance.length % 5 == 0 → evolveThresholds + recalculateWeights
                 └─ push HiveMind event (fire-and-forget)

auto-swap on close (executor.js:610)
   ├─ only if !skip_swap && result.base_mint
   ├─ get wallet balance, find base token
   ├─ if usd >= 0.10 → swapToken back to SOL
   └─ result.auto_swapped = true + auto_swap_note (so LLM doesn't double-swap)
```

**OOR detection**: `getMyPositions` calls `markOutOfRange` / `markInRange` for every position every cycle. The first time we see OOR, `out_of_range_since` is set; `minutesOutOfRange` is the diff.

**Position instruction** (`set_position_note`): `instruction` is sanitized (no newlines, max 280 chars, no `<>`) and shown in the system prompt + injected verbatim. The LLM must check `get_position_pnl` against the condition and execute immediately if met. The MANAGER prompt (line 144) says: "BIAS TO HOLD does NOT apply when an instruction condition is met."

**Cooldown logic** (`state/pool-memory.js`):
- Single `low yield` close → 4h pool cooldown.
- `oorCooldownTriggerCount` (default 3) consecutive OOR closes → `oorCooldownHours` (default 12h) cooldown on **both pool and base mint**.
- Optional repeat-deploy cooldown: `repeatDeployCooldownTriggerCount` (default 3) fee-generating deploys in a row → pool+token cooldown (configurable scope).
- All checked by `isPoolOnCooldown` / `isBaseMintOnCooldown` in `getTopCandidates` and `deployPosition`.

---

## Persistent files (all JSON at repo root)

| File | Shape | Mutated by |
|---|---|---|
| `user-config.json` | **Grouped by section** (`screening`/`management`/`strategy`/`schedule`/`llm`/`darwin`/`hiveMind`/`api`/`pnl`/`opportunity`/`regime`/`gmgn`/`risk`/`connection`), mirroring `core/config.js`'s own section names 1:1 — see `core/config-groups.js`'s `KEY_GROUPS` for the exhaustive key→group map. Plus a few top-level ungrouped keys: `chartIndicators` (its own nested object, always was), `preset`, `_lastAgentTune`. Field *names* are unchanged from the pre-grouping flat file — grouping only changed *where* each key lives, never what it's called, so `core/config.js`'s ~150 `u.someKey` reads didn't need touching; `flattenConfig()`/`groupConfig()` (both idempotent) are the load/save adapter every writer uses. **Supabase's own schema stays flat by design** — the local-file boundary is the only place grouping happens; `integrations/supabase-config.js`, `scripts/push-config.js`, and `scripts/reconcile-user-config.js` all flatten before touching Supabase/VPS data and group before writing the local file. | `config.js` (load, flattened), `update_config` tool, `evolveThresholds`, setup wizard, Telegram chatId persistence, HiveMind `ensureAgentId` — all via `core/config-groups.js`. **NEVER gitignored but you must `.gitignore` it locally** — README says so. |
| `state.json` | `{ positions: { [address]: {position, pool, pool_name, strategy, bin_range, amount_sol, active_bin_at_deploy, deployed_at, out_of_range_since, last_claim_at, total_fees_claimed_usd, rebalance_count, closed, closed_at, notes, peak_pnl_pct, pending_*, trailing_active, instruction, _lastBriefingDate, recentEvents[]} }` | `state.js` |
| `lessons.json` | `{ lessons: [{id, rule, tags, outcome, sourceType, confidence, role, pinned, context, ...}], performance: [{position, pool, pnl_pct, pnl_usd, fees_earned_usd, range_efficiency, minutes_held, close_reason, signal_snapshot, ...}] }` | `lessons.js` |
| `pool-memory.json` | `{ [poolAddress]: { name, base_mint, deploys[], total_deploys, avg_pnl_pct, win_rate, adjusted_win_rate, cooldown_until, base_mint_cooldown_until, notes[], snapshots[] } }` | `pool-memory.js` |
| `decision-log.json` | `{ decisions: [{id, ts, type, actor, pool, summary, reason, risks[], metrics{}, rejected[]}] }` max 100 | `decision-log.js` (called from deploy/close/skip in `tools/dlmm.js`, `index.js`) |
| `signal-weights.json` | `{ weights: {signal: 0.3-2.5}, last_recalc, recalc_count, history[] }` | `signal-weights.js` |
| `strategy-library.json` | `{ active: <id>, strategies: { [id]: {id, name, author, lp_strategy, token_criteria, entry, range, exit, best_for, raw} } }` | `strategy-library.js` |
| `market-regime-profiles.json` | `{ active: "slow"\|"normal"\|"hot", consecutiveFails, suppressedRegime, suppressedUntil, regimes: { [id]: {id, label, description, changes} } }` — `changes` is **legacy documentation only**, no longer applied (see `regime-overlay.js`) | `market-regime-library.js` |
| `smart-wallets.json` | `{ wallets: [{name, address, category, type, addedAt}] }` | `smart-wallets.js` |
| `token-blacklist.json` | `{ [mint]: {symbol, reason, added_at, added_by} }` | `token-blacklist.js` |
| `dev-blocklist.json` | `{ [wallet]: {label, reason, added_at} }` | `dev-blocklist.js` |
| `deployer-blacklist.json` | `{ _note, addresses: [wallet, …] }` (legacy) | `discord-listener/pre-checks.js` |
| `discord-signals.json` | Array of signals with status pending/processed | `discord-listener` |
| `hivemind-cache.json` | `{ sharedLessons: [], presets: [], pulledAt }` | `hivemind.js` |
| `logs/agent-YYYY-MM-DD.log` | Plain text | `logger.js` |
| `logs/actions-YYYY-MM-DD.jsonl` | Audit JSONL | `logger.js logAction` |
| `logs/archive/<stream>-YYYYMMDD.jsonl` | One JSON record per line. Streams: `decisions`, `performance`, `lessons`, `positions`. Append-only, never read by the running agent — `readArchive()` is for analysis/backtest scripts. ~98 KB/day total. | `state/archive.js` |

**Active file vs archive.** Each store keeps ONE complete active file (so
`repoPath()`, `pull-vps-state.sh`'s `VERBATIM_FILES`, and every consumer keep
working unchanged) and *additionally* appends to a dated archive. Sharding
the active stores by date was considered and rejected: `pool-memory.js` does
cross-key `Object.values(db)` scans for base-mint cooldowns (:74, :347) and
`state.js` looks positions up by address in 12 places, so a position opened
Monday and closed Wednesday would land in the wrong shard.

`scripts/migrate-archive.js` (operator-only, dry-run by default, `--yes` to
write) backfills pre-existing history — bucketing each record by *its own*
timestamp — then prunes the active files. Measured on real data:
`state.json` 1045KB → 126KB, `pool-memory.json` 1395KB → 1044KB.
**`lessons.json` is deliberately not shrunk**: `signal-weights.js:101,118-121`
filters `performance[]` by `darwinWindowDays` (60), so that window is a hard
retention floor — pruning below it silently degrades Darwin signal weighting.

All persistent files are loaded/saved on each call — no in-memory caching layer. Keep writes small and on the path of one position close, never inside a hot loop.

---

## Config system

`core/config.js` exports a single `config` object built once at module load, then mutated by `update_config` tool and `reloadScreeningThresholds()`. **Top-level keys** (all flat unless noted):

| Section | Keys | Default |
|---|---|---|
| `risk` | `maxPositions`, `maxDeployAmount` | 3, 50 |
| `screening` | `excludeHighSupplyConcentration`, `minFeeActiveTvlRatio`, `minTvl`, `maxTvl`, `minVolume`, `minOrganic`, `minQuoteOrganic`, `minHolders`, `minMcap`, `maxMcap`, `minBinStep`, `maxBinStep`, `timeframe`, `category`, `minTokenFeesSol`, `useDiscordSignals`, `discordSignalMode`, `avoidPvpSymbols`, `blockPvpSymbols`, `maxBotHoldersPct`, `maxTop10Pct`, `allowedLaunchpads`, `blockedLaunchpads`, `minTokenAgeHours`, `maxTokenAgeHours`, `reconConcurrency`, `reconDeadlineSec`, `enrichTimeoutMs` | see `user-config.example.json`; recon defaults 4 / 60s / 8000ms |
| `management` | `minClaimAmount`, `autoSwapAfterClaim`, `outOfRangeBinsToClose`, `outOfRangeWaitMinutes`, `oorCooldownTriggerCount`, `oorCooldownHours`, `repeatDeployCooldownEnabled`, `repeatDeployCooldownTriggerCount`, `repeatDeployCooldownHours`, `repeatDeployCooldownScope`, `repeatDeployCooldownMinFeeEarnedPct`, `minVolumeToRebalance`, `stopLossPct`, `takeProfitPct`, `minFeePerTvl24h`, `minAgeBeforeYieldCheck`, `minSolToOpen`, `deployAmountSol`, `gasReserve`, `positionSizePct`, `trailingTakeProfit`, `trailingTriggerPct`, `trailingDropPct`, `pnlSanityMaxDiffPct`, `solMode` | 5, false, 10, 30, 3, 12, true, 3, 12, "token", 0, 1000, -50, 5, 7, 60, 0.55, 0.5, 0.2, 0.35, true, 3, 1.5, 5, false |
| `strategy` | `strategy`, `minBinsBelow`, `maxBinsBelow`, `defaultBinsBelow` | bid_ask, 35, 69, 69 |
| `schedule` | `managementIntervalMin`, `screeningIntervalMin`, `healthCheckIntervalMin` | 10, 30, 60 |
| `llm` | `temperature`, `maxTokens`, `maxSteps`, `managementModel`, `screeningModel`, `generalModel` | 0.373, 4096, 20, healer-alpha, hunter-alpha, healer-alpha |
| `darwin` | `enabled`, `windowDays`, `recalcEvery`, `boostFactor`, `decayFactor`, `weightFloor`, `weightCeiling`, `minSamples` | true, 60, 5, 1.05, 0.95, 0.3, 2.5, 10 |
| `tokens` | `SOL`, `USDC`, `USDT` (mint addresses) | canonical |
| `hiveMind` | `url`, `apiKey`, `agentId`, `pullMode` | `https://api.agentmeridian.xyz`, built-in key, auto-generated, "auto" |
| `api` | `url`, `publicApiKey`, `lpAgentRelayEnabled` | `https://api.agentmeridian.xyz/api`, built-in key, false |
| `jupiter` | `apiKey`, `referralAccount`, `referralFeeBps` | env override, fixed referral, 50 bps |
| `indicators` | `enabled`, `entryPreset`, `exitPreset`, `rsiLength`, `intervals`, `candles`, `rsiOversold`, `rsiOverbought`, `requireAllIntervals` | false, supertrend_break, supertrend_break, 2, ["5_MINUTE"], 298, 30, 80, false |
| `regime` | `enabled`, `slowCutoff`, `hotCutoff`, `relaxAfterFails`, `suppressMinutes` | true, 15, 45, 3, 120 |

`update_config` (executor.js:333) uses a flat-key `CONFIG_MAP` (50+ entries) that knows how to (a) coerce booleans/arrays/strings/numbers, (b) clamp `binsBelow*` to `MIN_SAFE_BINS_BELOW=35`, (c) restart cron if `managementIntervalMin` / `screeningIntervalMin` changed, (d) write a `[SELF-TUNED]` lesson.

`computeDeployAmount(walletSol) = clamp((walletSol - gasReserve) × positionSizePct, [deployAmountSol, maxDeployAmount])` → 2-decimal SOL.

`reloadScreeningThresholds()` (config.js:236) is called by `evolveThresholds` to re-apply changes to the in-memory `config` without process restart.

---

## Environment variables (`.env`)

| Var | Required | Purpose |
|---|---|---|
| `WALLET_PRIVATE_KEY` | yes | Base58 (or JSON array) |
| `RPC_URL` | yes | Solana RPC. Helius recommended. |
| `OPENROUTER_API_KEY` (or `LLM_API_KEY`) | yes | LLM provider key. |
| `LLM_BASE_URL` | no | Override for any OpenAI-compatible endpoint (LM Studio: `http://localhost:1234/v1`). |
| `LLM_MODEL` | no | Default model. Per-role models in `user-config.json` override. |
| `HELIUS_API_KEY` | recommended | Wallet balance lookups via Helius. |
| `LPAGENT_API_KEY` | optional | Direct LPAgent positions fetch fallback. |
| `JUPITER_API_KEY` | optional | Better rate limit on Jupiter Swap. Default key baked in. |
| `TELEGRAM_BOT_TOKEN` | no | Notifications + REPL. |
| `TELEGRAM_CHAT_ID` | no | Default chat (also persisted to `user-config.telegramChatId`). |
| `TELEGRAM_ALLOWED_USER_IDS` | no | Comma-separated Telegram user IDs allowed to control. Required if chat is a group. |
| `ALLOW_SELF_UPDATE` | no | Set `true` to allow the `self_update` tool (default false). |
| `DRY_RUN` | no | Skip all on-chain txs. `npm run dev` sets it. |
| `LOG_LEVEL` | no | `debug` / `info` / `warn` / `error`. |
| `DISCORD_USER_TOKEN` | no | Selfbot for `discord-listener/`. |
| `DISCORD_GUILD_ID` / `DISCORD_CHANNEL_IDS` | no | Discord listener config. |
| `DISCORD_MIN_FEES_SOL` | no | Default 5. |
| `ENVRYPT_KEY` / `ENVCRYPT_KEY` | no | Key for `.env` XOR encryption (line-by-line marked with `# encrypted`). |
| `HIVE_MIND_URL` / `HIVE_MIND_API_KEY` | no | Override defaults. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_DB_SCHEMA` / `SUPABASE_DB_TABLENAME` | no | Enables `supabase-config.js`. See "Supabase & VPS sync" below. |

Encrypted env flow (optional, see `scripts/envrypt.js`):
1. Save plain values to `.env.raw`.
2. `printf "long-local-key\n" > .envrypt`.
3. `npm run env:encrypt` reads `.env.raw`, encrypts anything matching `*_KEY`/`*SECRET*`/`*TOKEN*`/`*MNEMONIC*`/etc., writes `.env`. Originals are XOR'd with a positional repeating key — **not** cryptographically secure, but obscures values in plaintext grep.

---

## Supabase & VPS sync

**Supabase is pull-only for the running agent, by design.** `pullSupabaseConfig()` (`supabase-config.js`) is the only Supabase call anywhere in the live agent path — startup + every 15 min, remote-wins merge into `user-config.json`. Nothing in `tools/executor.js`'s `applyConfigChanges()` (the shared logic behind `update_config` and, indirectly, the old regime path) pushes to Supabase anymore. If you're tempted to add a push call from agent code: don't — that was the exact bug this session fixed (an automated decision could permanently overwrite the operator's baseline).

**Publishing a new baseline is an explicit human action**: `node scripts/push-config.js --yes` (dry-run without `--yes` — lists keys, flags anything secret-looking via a `/apikey|secret|mnemonic|...long-string/` heuristic).

**Pulling a dev/audit copy of the live VPS state** is a separate, also-operator-only, also-pull-only script: `npm run pull:vps` (`scripts/pull-vps-state.sh` + `scripts/reconcile-user-config.js`). Config in `scripts/.env.vps` (gitignored, template in `scripts/.env.vps.example`).
- Most JSON files are pulled **verbatim** — the VPS's live running agent is ground truth for `state.json`, `pool-memory.json`, `decision-log.json`, `lessons.json`, `hivemind-cache.json`, `signal-weights.json`, `strategy-library.json`, `market-regime-profiles.json` (plus `smart-wallets.json`/`token-blacklist.json`/`dev-blocklist.json`/`discord-signals.json` if present — skipped silently if not, matching their existing fail-open design).
- `user-config.json` is **reconciled, never overwritten wholesale** — priority Supabase (calls `pullSupabaseConfig()`, the same path the agent uses) > local machine's current file > VPS copy (lowest priority, gap-fill only — a key both local and VPS have is never taken from VPS).
- **Known gotcha, already hit once**: `ssh` uses `-p` for port, `scp` uses `-P` (capital) — sharing one options array between them makes every `scp` call silently fail (it treats the port number as a source-file argument and the copy just does nothing, no error surfaced unless you drop the `>/dev/null 2>&1` redirect). The script uses separate `SSH_OPTS`/`SCP_OPTS` arrays now; don't merge them back.
- **Known gotcha, operationally important**: because `lessons.json` is pulled verbatim from a VPS that's *independently generating lessons in real time*, a local cleanup of `lessons.json` (e.g. stripping stale `[SELF-TUNED]` regime-hysteresis spam — see "Known issues" below) does **not** touch the VPS's own copy. The next `pull:vps` run will reintroduce whatever noise the VPS accumulated in between. If you clean local lesson history, the durable fix has to happen upstream (fix the bug producing the noise) — a local-only cleanup is cosmetic and temporary until the next pull.

---

## Telegram ops surface

| Surface | Where handled | Notes |
|---|---|---|
| `/help` / `/status` / `/wallet` / `/config` | `index.js#telegramHandler` | Read-only. |
| `/positions` / `/pool <n>` / `/close <n>` / `/set <n> <note>` | `index.js#telegramHandler` | Bypass LLM — direct state mutation. `/close <n>` calls `closePosition` directly. |
| `/closeall` | index.js | Closes all open positions in sequence. |
| `/screen` / `/candidates` / `/deploy <n>` | `runDeterministicScreen` + `deployLatestCandidate` | Deterministic — no LLM. The single-candidate skip rule applies. |
| `/briefing` | `generateBriefing` | On-demand daily report. |
| `/settings` / `/menu` / `/configmenu` | `renderSettingsMenu` + `applySettingsMenuCallback` | Inline-keyboard menu with toggle/step buttons. Updates flow through `update_config` tool. |
| `/hive pull` | `pullHiveMindLessons` + `pullHiveMindPresets` | Manual HiveMind fetch. |
| `/pause` / `/resume` / `/stop` | index.js | Toggle cron jobs / graceful shutdown. |
| Free-form chat | `agentLoop` with `agentType=GENERAL` | Intent-matched tool subset. |
| `cfg:*` callback queries | `applySettingsMenuCallback` | Settings menu button presses. |

**Auth** (`integrations/telegram.js#isAuthorizedIncomingMessage`):
- `chatId` must match incoming message's chat (env or persisted `user-config.telegramChatId`).
- If chat is a group/supergroup, `TELEGRAM_ALLOWED_USER_IDS` must be non-empty.
- Otherwise, all messages from the matching chat are accepted.
- Warns-once on missing config, then silently ignores inbound.

**Queueing**: while a management/screening cycle or free-form agentLoop is busy, inbound messages are queued (`_telegramQueue`, max 5). Overflow sends "Queue is full".

**Live messages**: `createLiveMessage` returns a handle. `toolStart`/`toolFinish` push per-tool lines (with `ℹ️`/`✅`/`❌` icons) into a single Telegram message that gets edited in place. While a live message is active, standalone notifications (`notifyDeploy`/`notifyClose`/`notifySwap`/`notifyOutOfRange`) are suppressed to avoid spam.

---

## Discord listener

Standalone process — `cd discord-listener && npm install && npm start`. Shares `../.env` for env vars.

- Uses `discord.js-selfbot-v13` (personal account, not bot). **Selfbot — use responsibly; against Discord TOS.**
- Filters: only `Metlex Pool Bot` author, only configured channels.
- Extracts Solana addresses (base58, 32-44 chars, must contain digit, not in `FALSE_POSITIVE_SKIP` set).
- For each address: runs `runPreChecks` (dedup → blacklist → pool resolve → rug → deployer → fees) and appends to `discord-signals.json` with `status: "pending"`.
- Screener picks up pending signals first (or only, if `discordSignalMode: "only"`).
- `DISCORD_MIN_FEES_SOL` defaults to 5; the screener's hard floor is `minTokenFeesSol` (default 30) — both apply.

---

## Strategy library (default strategies)

| id | name | lp_strategy | idea |
|---|---|---|---|
| `custom_ratio_spot` | Custom Ratio Spot | spot | Express directional bias via token:SOL ratio. |
| `single_sided_reseed` | Single-Sided Bid-Ask + Re-seed | bid_ask | Token-only redeploys on OOR downside. |
| `fee_compounding` | Fee Compounding | any | Claim + add back to same position. |
| `multi_layer` | Multi-Layer | mixed | One position, multiple add-liquidity layers with different shapes. |
| `partial_harvest` | Partial Harvest | any | Withdraw 50% at 10% return; rest keeps running. |

`set_active_strategy` swaps the active one. The screener prompt mentions the active strategy in the `ACTIVE STRATEGY` block.

---

## Testing / QA protocol

`npm test` is the gate — it must stay green through any change to `core/config.js`,
`tools/executor.js`'s `CONFIG_MAP`, `getDeterministicCloseRule` (index.js),
`regime-overlay.js`'s `REGIME_TUNABLE`, or any of the 7 post-mortem guards.
It runs, in order: `test:syntax`, `test:json-store`, `test:telegram-format`,
`test:concurrent`, `test:archive`, `test:guards`, `test:invariants`,
`test:regime`, `test:regime-invariants`, `test:regime-overlay`,
`test:regime-state`, `test:benchmark`, `test:benchmark-eval` — all offline,
no network, no wallet, no live agent. 307 checks total as of this writing.

**Every test script sets `NODE_ENV=test`**, and that is load-bearing, not
cosmetic: it suppresses `state/archive.js` writes. Without it,
`test-regime.js` → `applyConfigChanges` → `addLesson` would append a
synthetic lesson to a real archive shard on every run, and
`withRestoredFile` cannot undo it (it snapshots one path; appends land in
`logs/archive/`). If you add a test script, set `NODE_ENV=test` on it.

| Script | Covers |
|---|---|
| `test:syntax` | Every file in the repo parses. |
| `test:json-store` | The mtime+size cache behind every JSON store — cache hits, and (the ones that matter) invalidation on external writes including a same-size rewrite, plus fail-open on missing/corrupt files. |
| `test:telegram-format` | `safeTruncate` against six adversarial inputs (never over 4096 *including* the closing tags it appends, never an unbalanced tag, never half an entity), the compact formatters, and `noDeployReport`'s HTML/plain duality. |
| `test:concurrent` | `mapWithConcurrency`'s deadline — a task sleeping 5000ms must return within a 150ms budget — plus concurrency ceiling, input-order results, and that it never rejects. |
| `test:archive` | Suppression under test (see the `NODE_ENV` note above), UTC date bucketing across a midnight boundary, shard merge/range filtering, and graceful handling of malformed lines. |
| `test:guards` | The 7 SalaryCat-SOL post-mortem guards (token-age window, rejection hysteresis, TVL decline check). |
| `test:invariants` | **"Absolute state" contract tests** — see below. This is the one future changes are most likely to break, and the one that matters most. |
| `test:regime` | `classifyRegime()`'s decision tree + `market-regime-library.js`'s profile store, active-pointer persistence, `applyConfigChanges` round-trip. |
| `test:regime-invariants` | Regime-profile structural completeness + `classifyRegime()`'s return-domain contract. Checks the now-legacy `changes` maps for internal consistency (still useful as documentation, just not applied). |
| `test:regime-overlay` | **The safety-critical suite for the overlay** — 38 checks: whitelist integrity (only 8 keys tunable, `maxPositions`/`maxDeployAmount` NOT tunable), `normal` is an exact no-op, the risk ratchet (no regime may ever increase `deployAmountSol`/`positionSizePct` or loosen `stopLossPct` beyond baseline), directional semantics (hot tightens screening + sizes down, slow loosens screening), clamps hold against absurd baselines, purity (no mutation, fails safe on unknown/null regime). |
| `test:regime-state` | The relax + loopback-suppression state machine: fail counter increment/reset, suppression window set/expire/clear, relax zeroing the counter so it can't immediately re-fire. |

`test/test-invariants.js` is the executable version of README.md's
"Position lifecycle" diagram. It locks in:
- Config sign/bound invariants (`stopLossPct < 0`, `takeProfitPct > 0`,
  `minBinsBelow >= MIN_SAFE_BINS_BELOW`, …).
- **`CONFIG_MAP` <-> `core/config.js` bidirectional consistency** — every
  `CONFIG_MAP` entry must resolve to a real `config[section][field]` path.
  A typo'd or renamed config field fails this immediately instead of silently
  no-op'ing the next time an agent calls `update_config`.
- `degenScore()`/`classifyRegime()` bounds — fuzzed edge-case pools always
  score a finite `[0,100]`; `classifyRegime()` always returns one of
  `null`/`"slow"`/`"normal"`/`"hot"`.
- **`getDeterministicCloseRule()` rule precedence** — one isolated test per
  close reason (stop loss, take profit, pumped-above-range, fast-exit,
  OOR-wait, low-yield), plus a precedence test that locks in which rule wins
  when a fabricated position matches more than one condition at once. If you
  reorder the rules in `index.js`, this test tells you immediately whether
  the new order is intentional or a regression.

**Conventions for new tests** (see `test/lib/test-kit.js`):
- `createSuite(title)` → `{ section, check, finish }`. Call `finish()` last
  and `process.exit()` its return value.
- Anything that touches a real `*.json` store (`pool-memory.json`,
  `market-regime-profiles.json`, `user-config.json`, `state.json`, …) MUST
  wrap the touching code in `withRestoredFile(path, fn)` — snapshots the
  file, runs `fn`, restores exact pre-test content even if `fn` throws. Use
  fake IDs prefixed `TEST_..._DO_NOT_USE` so a forgotten restore is obvious
  and grep-able, never real pool/position addresses.
- `getDeterministicCloseRule` and `CONFIG_MAP` are exported from
  `index.js`/`tools/executor.js` specifically so they're directly
  unit-testable — importing `index.js` for tests is safe because every
  side effect (cron, Telegram polling, HiveMind/Supabase bootstrap) is
  gated behind the `isMain` check, which is false when the module isn't
  run as the actual entrypoint.

**When adding a new config key or guard**: add it to `test:invariants` — at
minimum a sign/bound check if it's a threshold, and if it's part of a
regime profile, the completeness test already checks it automatically as
long as all 3 profiles define it.

**`test/fixtures/benchmark-positions.json`** — 8 real historical closed
positions (3 known big losses + 5 diverse wins/small-losses), each with
entry/exit market metrics, a real minute-level `price_ohlcv_1m` price/volume
series spanning the exact deploy-to-close window (sourced from
GeckoTerminal's public API — Meteora's own pool OHLCV endpoint only serves
the current ~10 recent candles and can't reconstruct history), and the
actual per-tick `pnl_pct`/`in_range` `timeline` this repo recorded live.
Regenerate with `node scripts/build-benchmark-dataset.js` then
`node scripts/fetch-benchmark-ohlcv.js` and
`node scripts/fetch-benchmark-pool-metadata.js` (the last adds
`pool_created_at`/`pool_age_hours_at_deploy`/`deploy_sequence`, needed by
guards #1 and #2's replay). See `test/fixtures/README.md` for full details.

**`test/test-benchmark.js`** (part of `npm test`) replays all 8 positions
against the *current* guards and `getDeterministicCloseRule` — offline,
reads only the static fixture. Asserts every `big_loss` position is caught
or mitigated by at least one of {guard #1, guard #2, a rule-1/2/4 replay of
its recorded `timeline`}, and that guards #1/#2 only ever block the two
already-known, accepted false positives in this sample (brain-SOL for
guard #1, Waddles-SOL for guard #2 — both real wins that a token-age/
repeat-deploy guard would still have flagged; a NEW unseen false positive
still fails the gate). This is how a future guard/threshold change gets
checked against real outcomes instead of just synthetic fixtures.

**`test/lib/benchmark-eval.js`** (built TDD — spec in
`test/test-benchmark-eval.js` was written first with hand-computed expected
numbers, confirmed to fail before the module existed) is a config
backtester: `evaluateConfig(cfg, positions, poolMemory)` replays guards
#1/#2/#5 for the deploy gate and rules 1/2/4 for the exit, then converts the
result into `pnl_sol`/`pnl_usd` per position and in aggregate, compared
against what actually happened historically. Run
`npm run evaluate-config` (live config) or
`node scripts/evaluate-config.js path/to/candidate.json` (a
`{screening:{...}, management:{...}}` partial override merged onto the live
config) for a report. Same scope ceiling as `test-benchmark.js` — guards
#3/#4/#7 aren't replayed, rules 3/5/6 aren't replayable from `timeline`, and
a candidate config change is scored only against the same 8 fixture
positions, not live re-screening.

---

## Known issues / tech debt (verified by reading the code)

- **`lessons.js evolveThresholds()`** evolves `minOrganic` and `minFeeActiveTvlRatio` only.
- **A key with no `normal:` factor never self-corrects back to baseline on its own** — `applyRegimeOverlay()` only runs on a regime *transition* (`index.js`, `regime !== prevRegime`), and a key with no explicit `normal:` factor produces no overlay entry when transitioning into normal (see `regime-overlay.js`'s `REGIME_TUNABLE` table), so it silently keeps whatever value a *prior* hot/slow overlay last set until a Supabase pull (screening keys, via `reloadScreeningThresholds()`, ~every 15min) or a full process restart. This used to also bite `positionSizePct`, `stopLossPct`, and `takeProfitPct` — they were removed from `REGIME_TUNABLE` entirely (operator decision: regime should never touch deploy sizing beyond `deployAmountSol` or any exit rule), so the gap can't manifest for them anymore since regime never sets them in the first place. `deployAmountSol` (the one risk key still tunable) was fixed the other way — it defines an explicit `normal:` factor, so every transition, including into normal, recomputes it fresh from baseline. If you ever add a new regime-tunable risk key, give it either an explicit `normal:` factor or accept it inherits this same staleness risk.
- **`get_wallet_positions` tool** is in `definitions.js` and wired in `executor.js`, but not in `MANAGER_TOOLS`/`SCREENER_TOOLS`. Only `INTENT_TOOLS.balance` / `INTENT_TOOLS.positions` expose it to GENERAL.
- **Lazy SDK load** (`tools/dlmm.js:33`) — `@meteora-ag/dlmm` is dynamic-imported on first on-chain call to avoid CJS-import crash on Node 24 (the `postinstall` `patch-anchor.js` handles another piece of this). Don't `import` it eagerly at top of file.
- **Position cache** (`_positionsCache` 5min TTL) — in single-process mode it's a perf win, but the cache is invalidated by `_positionsCacheAt = 0` after every deploy/close, and the executor's `deploy_position` safety check uses `force: true` for a fresh count.
- **PnL sanity check** (`pnlSanityMaxDiffPct`, default 5%) — if reported vs derived pnl_pct differ by more than this, the LLM is told not to trust that tick. Implemented in `dlmm.js` getMyPositions and `state.js` updatePnlAndCheckExits.
- **DRY_RUN auto-skip SOL balance check** — `runSafetyChecks` for `deploy_position` only checks `balance.sol < amountY + gasReserve` if `DRY_RUN !== "true"`.
- **HiveMind disable path is murky** — README says "there is currently no empty-string disable path" for HiveMind. `config.hiveMind.url/apiKey` fall back to defaults if blank. Set `pullMode: "manual"` to suppress auto-pull.
- **Selfbot in `discord-listener/`** is a ToS gray area. Make sure operators know.
- **`.claude/settings.json`** denies `rm -rf`, `wget`, and **reads of `.env*`**. It also blocks `run_in_background: true` via a PreToolUse hook. So in this repo, Claude Code can't background long-running commands — serial execution only.
- **Drift risk** — `user-config.json` keys must match the **flat** `update_config` CONFIG_MAP in executor.js. New keys: add to both, otherwise `update_config` returns `unknown: [...]` and skips the apply.
- **The Discord `useDiscordSignals` flag** lives in `screening`, not `discord`. Screener checks `config.screening.useDiscordSignals`, and `discordSignalMode: "merge" | "only"`.
- **Fixed this session, worth remembering the shape of**: the regime switcher's `prevRegime = getActiveRegime()?.active` bug (should be `.id`) meant the "has the regime changed" check permanently compared against `"normal"`, so every non-normal detection re-applied config every cycle. Its symptom was dozens of near-identical `[SELF-TUNED] Changed strategy=...` lessons piling up with timestamps minutes apart — if you see that pattern again, check every place a regime/profile object's identity is read, not just this one call site.
- **Fixed this session**: `test/test-regime.js`'s `applyConfigChanges` test called the real function, which writes a lesson as an intrinsic side effect — the test only snapshotted/restored `user-config.json` and `market-regime-profiles.json`, not `lessons.json`, so every test run leaked a synthetic `"test: regime apply"` lesson into the real lesson history. Fixed by wrapping that test block in `withRestoredFile(LESSONS_FILE, ...)` too. **General lesson**: when writing a test around any function, grep its body for every file it writes, not just the ones the test is nominally about — a persistence side effect one function call deep is easy to miss.
- **`lessons.json` can drift between this machine and the VPS** — see "Supabase & VPS sync" above. A local cleanup doesn't reach the VPS's own copy; `pull:vps` will reintroduce whatever's accumulated there.

---

## Patterns to copy

When adding a new tool that reads on-chain data, copy the **cache + inflight dedup + `force` flag** pattern from `getMyPositions` (`tools/dlmm.js:1154`). The `force: true` is what the deploy safety check relies on.

When adding a new persistent JSON store, copy the load/save pattern from `state.js` or `pool-memory.js` — which now means `loadCached`/`saveJson` from `state/json-store.js`, never a raw `readFileSync`+`JSON.parse`. Respect its shared-reference contract: load → mutate → save, with no early return in between. **Always** run text through `sanitizeStoredText` (or write a domain-specific sanitizer that strips `<>` and newlines) before persisting — those values get echoed into the LLM prompt later. If the store accumulates history rather than current state, add an `archiveAppend()` at its write point instead of letting the file grow forever.

When adding anything that fans out over N items with network calls, use `mapWithConcurrency` from `util/concurrent.js` rather than a sequential `for...await` loop. A sequential loop makes worst-case latency `N × timeout`; that is exactly how a screening cycle reached 251s. Always pass a `deadlineMs`.

When adding a user-visible Telegram message, build it with `integrations/telegram-format.js` — never hand-assemble HTML and never `.slice()` to the 4096 limit yourself (`safeTruncate` exists because a cut inside a tag makes Telegram drop the entire message silently). If the LLM authors the text, give its prompt an explicit output contract; the `GENERAL` role's missing one is why markdown tables reached production.

When adding a new pre-LLM enrichment, follow the **3-strikes (Discord pre-checks)** model: cheap checks first (in-memory dedup, file lookup), then network (pool resolution, rugcheck), then more network (deployer, global fees). Log each pass/reject with the stage name.

When scheduling work, follow the **`_busy` flag + cooldown** pattern. `_managementBusy`, `_screeningBusy`, `_pnlPollBusy`, `_pollTriggeredAt`, `_screeningLastTriggered` are the canonical examples.

---

## What to read next

- Adding a new tool → `tools/definitions.js` + `tools/executor.js` + `core/agent.js` (see "Adding a new tool" above).
- Changing safety rules → `tools/executor.js#runSafetyChecks` and `index.js#getDeterministicCloseRule`.
- Adding a new persistent state file → copy `state.js` or `pool-memory.js`. Add a getter to `index.js` system-prompt section if the LLM needs to see it.
- Changing the LLM contract → `core/prompt.js` (buildSystemPrompt) and `core/agent.js` (INTENT_TOOLS + role sets + safety guards).
- Changing deploy/close behavior → `tools/dlmm.js` (the SDK wrapper) and `tools/executor.js` (the post-tool side effects + Telegram notify + auto-swap).
- Discord listener issues → `discord-listener/pre-checks.js`.
- HiveMind protocol issues → `integrations/hivemind.js` (push side) and `state/lessons.js#getLessonsForPrompt` (pull side injection).
- Changing what a regime can do to config → `regime-overlay.js`'s `REGIME_TUNABLE` (add the key + `test:regime-overlay`'s whitelist check will catch a missing `CONFIG_MAP` entry).
- Changing the relax/loopback behavior → `market-regime-library.js` (`noteRegimeRelax`/`isRegimeSuppressed`) and `index.js`'s `noteScreeningResult`.
- Supabase/VPS sync issues → `integrations/supabase-config.js`, `scripts/push-config.js`, `scripts/pull-vps-state.sh` + `scripts/reconcile-user-config.js`.
