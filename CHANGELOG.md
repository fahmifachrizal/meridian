# Changelog

All notable changes to Meridian, from the original fork onward. Entries are
grouped by era and dated by when the work landed; within an era, related
commits are summarized together rather than listed one-by-one. No formal
version tags exist in this repo's history, so dates are the anchor.

---

## 2026-08-18 — Real-price backtest of the 10% upside headroom; reverted

Built out `test/lib/benchmark-eval.js`'s config backtester to actually
replay the OOR rules (3 and 5) against real minute-level price data,
instead of falling back to each position's historical outcome whenever
its recorded `timeline` didn't happen to trip a rule:

- **Tier 1** — `deriveBinTimeline()` reconstructs a per-minute `active_bin`
  series from the curated 8-position fixture's real `price_ohlcv_1m`,
  anchored on `bin_range.max` == the active bin at deploy (true
  historically: every deploy had `bins_above: 0`). `pnl_pct` at each
  derived tick is interpolated from the sparse recorded `timeline`, not
  recomputed from bin composition — good enough to answer "would this
  rule have fired sooner," not to independently verify a pnl curve. On
  this fixture, isolated to the one usable pumped-above case
  (brain-SOL), the 10% headroom looked like a clean improvement
  (+1.27% -> +1.45% at exit) — but the fixture's other 7 positions are
  mostly blocked at the deploy gate by other guards, so the aggregate
  couldn't show the effect at all.
- **Fetched real per-pool OHLCV to fix the sample-size gap** —
  `scripts/fetch-pool-first-days-ohlcv.js` (already existed, first-3-days
  cache) went from 187/316 pools cached to 305/316 (11 permanently
  outside GeckoTerminal's public-API 180-day historical window, now
  cached with a `permanent` flag so future runs stop retrying them
  instead of treating it as transient).
- **Tier 2** — `attachPriceOhlcv()` merges that cache onto the
  316-position `market-benchmark-positions.json` fixture at runtime
  (verified: every position with a usable `bin_step` also has
  `pool_age_hours_at_deploy <= 72`, so the cached first-3-days window
  always covers its deploy). `scripts/evaluate-config.js --fixture=market
  --compare-headroom` runs both variants and diffs them.

**Result: the larger sample reversed the Tier 1 read.** Under the live
config (current `stopLossPct: -15%`), the headroom is net **negative**:
-$26.69 across 184 deployed positions, 33 of them changed exit. Diagnosed
(not assumed): the live stop-loss fires very aggressively when replayed
against these positions' real interim-drawdown timelines — many swing to
-15/-17% mid-flight before recovering to a real historical win, a
pre-existing confound of backtesting today's config against old data. It
dominates the headroom signal. Isolating just the OOR mechanics
(stop-loss/take-profit disabled) confirms the mechanism itself works —
net **+$239.73**, win rate 80% -> 87% — but under the *actual* running
config, delaying a pumped-above exit often rides the position into a
worse stop-loss instead of capturing the extra upside, and that effect
wins out in aggregate.

**Reverted the 10% upside headroom** (`tools/dlmm.js`, `index.js`'s
SCREENER prompt) back to `bins_above = 0` for single-sided SOL deploys —
the backtest that motivated adding it didn't have the sample size to
catch this interaction; the backtest that does says it costs money under
current settings. The 10% *downside* padding from the same session is
unaffected (it isn't part of this rule's replay) and stays as-is.

## 2026-08-17 — OOR pattern analysis + range/timer re-strategizing

Data-driven analysis of the full closed-position history (726 positions
with range data): 51% of all positions go out-of-range at some point, and
55.8% of all closes are OOR-triggered — but that split into three very
different failure modes once broken down by close reason:

- `pumped_above` (price shot past the range) — **41% of ALL closes**,
  averaging +0.48% held only ~21 min. Root cause: every deploy used
  `bins_above = 0` (hardcoded, single-sided SOL), so *any* upward move
  exited the position immediately, capping every winner at a small,
  early gain regardless of how strong the move was.
- `oor_wait_timer` (drifted, sat OOR the full 30-minute wait) — 14.2% of
  closes, averaging **-1.33%** having spent two-thirds of their held time
  already out of range before the timer finally fired. This is genuinely
  wasted capital, not a directional bet.
- Volatility-scaled range sizing was checked and is *not* the problem —
  range efficiency is actually slightly better at higher volatility
  (69.6% at volat 0-3 vs 79.3% at volat 10-20), so that formula is doing
  its job; the two failure modes above are structural, not a sizing bug.

Three changes shipped from this:

- **`outOfRangeWaitMinutes`: 30 -> 20.** The OOR-wait rule was already
  duration-only (no PnL gate), so tightening this single threshold
  directly targets the costly `oor_wait_timer` bucket — no strategy-risk
  tradeoff, positions just get freed up sooner instead of drifting dead
  for the full 30 minutes.
- **Deterministic 10% downside padding** (`tools/dlmm.js`) — `bins_below`
  is now widened by 10% after all existing clamping, applied in code
  rather than left to the LLM's own formula, so it can't be skipped or
  miscalculated.
- **Deterministic 10% upside headroom for single-sided SOL deploys** —
  previously hard-blocked by two redundant safety throws forcing
  `bins_above = 0`. Verified against `@meteora-ag/dlmm`'s own
  `toAmountAskSide` source before touching this (not guessed): with
  `amount_x` staying 0, a range extending above the active bin produces
  zero-amount entries for every upper bin — no error, no real token-price
  exposure added, it only widens the tracked range so a pump doesn't
  immediately trip `pumped_above` while the position is still gaining.
  `bins_above`/`upside_pct` requests from the LLM are still rejected (the
  10% figure is fixed, not LLM-chosen); a wider total range does mean
  volatile-token deploys will hit the >69-bin wide-range multi-tx path
  somewhat more often than before, which that path already exists to
  handle safely.

## 2026-08-17 — Weekend fresh-token repeat guard (guard #8)

Data-driven safety guard, built from a pattern-analysis session across the
full closed-position history (734 positions). Findings that motivated it:

- Losses during Sat 18:00 → Mon 04:00 WIB aren't more *frequent* than the
  rest of the week (~33% either way), but they're **~4-5x more severe on
  average** (−4.84% vs. −1.14%), and this ~12%-of-the-week window accounts
  for a third of all-time big losses (≥15%).
- Every major weekend blowup checked (WORM-SOL −44.21%, SalaryCat-SOL
  −35.96%, Apu-SOL −20.71%, CALICO-SOL −10.05%, Frock-SOL −9.79%) followed
  the same shape: one or two small wins on a pool that was **under 6 hours
  old** at deploy, then a repeat deploy into the same `base_mint` that gave
  everything back and then some.
- `smart_wallets_present` was checked as a candidate signal and **retired
  immediately** — 0 of 742 positions in history ever had it `true`, so it's
  a base-rate artifact of memecoin screening, not a discriminating signal.
- Simulated against history: capping a `base_mint` to one deploy per
  weekend session, but only counting it as "capped" when that token's
  *first* deploy the session started under a 6h freshness cutoff (not
  re-checked on the repeat — SalaryCat's fatal leg was 7.84h old by the
  time it fired, well past 6h, but the session-opening deploy was 4.37h),
  turned the weekend-night dataset from a **$35.79 net loss into a $5.14
  net gain** — better than either a blanket "one deploy per token, any
  age" rule (+$36.67) or a naive per-leg freshness recheck (+$25.86, which
  misses SalaryCat's case specifically).

**Guard #8** (`guards/08-weekend-fresh-repeat.js`) implements exactly that:
pure `getWeekendSessionBoundsWIB()`/`isWeekendNightWIB()` for the WIB
window math, `getWeekendFreshRepeatRejectReason()` for the decision. Wired
into `tools/executor.js`'s `runSafetyChecks()` for `deploy_position`,
reusing `pool_age_hours`/`base_mint` that `validateDeployPoolThresholds()`
already fetches fresh before every deploy (zero extra network calls) and
`state/state.js`'s `getTrackedPositions(false)` for same-session history.
Two new fields on `state.json` position records make the "was it fresh at
session-open" check possible going forward: `base_mint` (wasn't stored at
all before this) and `pool_age_hours_at_deploy`. Five new config keys under
`management.weekendGuard*`, defaulting to enabled with the exact validated
window (Sat 18:00 → Mon 04:00 WIB, 6h freshness cutoff).

## 2026-08-11-17 — Telegram redesign: deterministic deploy/close cards

The LLM-authored "🚀 DEPLOYED" report — hand-formatted numbers, prone to
the same drift/hallucination class of bug PR #8 already fixed once — is
replaced with `deployedReport()` (`integrations/telegram-format.js`): a
deterministic card built entirely from `deploy_position`'s own tool result
and the winning candidate's recon data, following the same pattern
`noDeployReport()` already established. Adds a conviction badge line
(derived from `organic_score`: 🟢 HIGH ≥85, 🟡 MODERATE ≥70, 🟠 LOW below)
and an aligned `<pre>` metrics block, which Telegram renders with its
native copy affordance. The SCREENER prompt is simplified accordingly —
the LLM now supplies only a one-line "why" instead of hand-formatting an
entire report. The "LLM chose no deploy" case is also routed through
`noDeployReport()` for the same visual consistency the hallucination-
override case already had. `notifyClose()` gets a matching 🟢 WIN / 🔴 LOSS
badge line, and a failed insurance withdrawal now renders distinctly
("⚠️ withdrawal FAILED") instead of looking identical to "nothing needed
withdrawing" — a real accuracy gap, since every withdrawal had in fact
been failing silently on the VPS until the unit-bug fixes below.

Also this window: `close_position`'s `reason` argument is now sanitized
(`sanitizeCloseReason()`, `tools/executor.js`) — an LLM that formatted its
close reason as a JSON object instead of a short phrase (schema-valid,
since it's still technically a string) was flowing straight through into
pool-memory notes and the Telegram message verbatim; fixed after the
operator reported receiving raw JSON as a "close reason" in production.

## 2026-08-11/12 — Self-funded pooled insurance backstop

New opt-in feature: a small % of every deploy is skimmed to a separate
token and held aside in the same wallet as a shared loss backstop, sized
from real win/loss occurrence data (47.3 wins per big loss, historically)
rather than a per-position self-insurance guess.

- **Pooled, not per-position** — `management.insurancePct` (default 1%) is
  skimmed at deploy time before the LP deposit; a severe loss draws on the
  *aggregate* wallet balance, capped at whatever's accumulated, since one
  position's own skim (~$0.17 typical) can't meaningfully offset a real
  ~$7–20 loss on its own.
- **5-tier withdrawal rules** (`computeInsuranceWithdraw()`, reworked from
  an initial single-severe-loss-only version): profit ≥1% keeps everything;
  0–1% profit tops up the shortfall vs. this position's own contribution;
  a mild loss (worse than 0, better than `stopLossPct × triggerFraction`)
  withdraws the position's own contribution in full; a severe loss covers
  the loss capped at the pool; an empty pool never withdraws.
- **Deploy-time pool cap** (`insuranceMaxPoolPct`, default 30%) — stops
  growing the pool once it already holds that share of the estimated total
  portfolio (wallet SOL + all open positions' value), so a backstop can't
  itself become an unbounded slice of holdings.
- **Token switched twice**: USDC → CASH (Bridge's USD stablecoin, verified
  via Jupiter's asset API before wiring in) → JitoSOL (an explicit
  operator tradeoff: the pool now tracks SOL price and earns staking
  yield instead of holding USD value through a SOL crash).
- **Two real unit bugs found and fixed after pulling live VPS data**,
  verified against actual on-chain transactions via Solana RPC:
  1. `swapToken()` returned Jupiter Swap V2's raw atomic units without
     converting to decimal token amounts — a swap that delivered
     `0.752897` CASH was recorded as `752897`.
  2. The real cause of every "Insufficient funds" withdrawal failure in
     production: a dollar-denominated withdrawal amount was passed
     directly as `swapToken()`'s `amount`, which means *native token
     units*, not USD — a ~$15 withdrawal was read as "sell 15 JitoSOL"
     (~$1500) against a wallet holding ~$15 of it. Every withdrawal on the
     VPS had been failing silently until this fix; the Telegram close
     message was also fixed to say "withdrawal FAILED" instead of
     rendering a failed swap identically to "nothing needed withdrawing".
- Telegram notifications extended to show the insured amount at deploy
  time and the full contribute/withdraw/pool-remaining flow at close.

## 2026-08-10 — Deploy-amount rounding fix, hallucinated reports, briefing HTML escaping

Root-caused why the VPS had stopped deploying and why a morning briefing
(and manual `/briefing`) went silently unanswered — two unrelated bugs
found via live VPS log analysis:

- **Deploy-amount rounding rejection loop**: `computeDeployAmount()`'s
  `.toFixed(2)` could round a regime-adjusted amount down (e.g.
  `0.7 × 0.85` → `"0.59"`) while the safety check compared it against the
  raw unrounded config floor (`≈0.59499999999999997`), rejecting every
  deploy by less than half a cent. Fixed with a shared `round2()` helper
  applied to both sides of every SOL-amount floor/ceiling comparison. This
  also explained an OpenRouter usage spike the same day — the SCREENER
  kept re-evaluating the same 2–3 candidates that repeatedly failed the
  mismatched check.
- **Hallucinated deploy reports**: the SCREENER LLM could write "🚀
  DEPLOYED" text even when `deploy_position` had actually failed, and the
  Telegram report forwarded it verbatim. Now overridden with a
  deterministic failure report whenever `deploySucceeded` is false,
  regardless of what the LLM's own text claimed.
- **Briefing HTML escaping**: a lesson's `rule` text containing raw `<=`
  broke Telegram's HTML parser, silently dropping the entire briefing
  message — both the scheduled 1am briefing and on-demand `/briefing`
  share this code path, explaining both symptoms at once. Fixed by
  escaping lesson text before interpolation.
- Added a deterministic, non-LLM `reason` field to close notifications,
  sourced from `result.close_reason`.

## 2026-07-31 — Guard extraction + folder reorganization

Major refactor, no behavior change — reorganizes code, doesn't change what
the agent does.

- **Rule 1–6 reorder** (`getDeterministicCloseRule`) — Rule 6 (fast-exit) fired
  4th positionally, sandwiched between Rule 3 and Rule 4. Renumbered 1→6 to
  match actual execution/precedence order.
- **7 deploy/close safety guards extracted into `guards/`**, one file per
  guard, renumbered by *execution order* instead of the order they were
  historically added:
  `01-token-age-window` → `02-repeat-deploy-cooldown` →
  `03-rejection-hysteresis` → `04-tvl-decline` → `05-repeat-deploy-taper` →
  `06-fast-exit` → `07-avoid-pin`. Each guard file owns the decision (pure
  predicate); `pool-memory.js`/`lessons.js` keep owning persistence.
- **25 root-level modules reorganized** into `core/`, `state/`, `regime/`,
  `integrations/`, `util/` by concern. `index.js`/`cli.js`/`setup.js`
  (entry points) and `logger.js`/`repo-root.js` (near-universal, and the
  latter anchors JSON-file resolution) deliberately stay at repo root. JSON
  state/config files never moved.
- Verified end-to-end: full `npm test` (168 checks) green after every
  commit, `node cli.js` smoke-tested, git history preserved through every
  rename (`git mv` + `--follow`), and a live Supabase pull/push re-verified
  functional through the new `integrations/supabase-config.js` path.

## 2026-07-30 — Bounded regime overlay, Supabase pull-only, Telegram HTML revamp

The market-regime auto-switcher (added 2026-07-27, below) could previously
write **absolute** config values straight to `user-config.json` and push
them to Supabase — an automated market read could permanently overwrite the
operator's own risk settings, and its `hot` profile actually sized *up* and
widened the stop-loss in the most volatile conditions, the exact shape of
the original SalaryCat-SOL loss. Replaced with a bounded system:

- **Bounded, ratcheted, in-memory-only overlay** (`regime-overlay.js`) —
  regime effects are now derived from the operator's own baseline, not
  absolute. Screening bars (`minTvl`, `minVolume`, `minFeeActiveTvlRatio`,
  `minOrganic`) may move both ways inside relative clamps; risk keys
  (`deployAmountSol`, `positionSizePct`, `stopLossPct`) are **ratcheted** — a
  regime can only ever reduce exposure below baseline, never increase it.
  Applied to live config only; never written to `user-config.json`, never
  pushed to Supabase. A restart or a Supabase pull always restores the
  operator's baseline.
- **Relax + loopback suppression** — after `regimeRelaxAfterFails` (default
  3) consecutive no-deploy screening cycles, the active regime force-relaxes
  back to `normal` regardless of whether the classifier can see enough
  candidates to detect it. Without a follow-up fix this alone would
  oscillate (relax → re-detect the same regime → tighten → starve → relax
  → repeat); the regime just relaxed out of is now suppressed for
  `regimeSuppressMinutes` (default 120) before it can be re-entered — other
  regimes stay reachable, so adaptation isn't frozen.
- **Supabase is now pull-only for the agent** — `update_config` no longer
  pushes. Supabase is the operator's source of truth; publishing a new
  baseline is an explicit operator action via `node scripts/push-config.js
  --yes`.
- **Telegram HTML revamp** — deploy/close/swap/config-change/OOR
  notifications and the Screening Cycle live message now render as aligned
  `<pre>` tables via a shared `htmlTable()` helper, plus a dedicated regime
  transition notice that states the change is in-memory-only.
- Fixed a real bug in the previous regime switcher: it read `.active` off a
  regime profile object that only exposes `.id`, so the "has the regime
  changed" check was permanently comparing against `"normal"`.
- Added `scripts/pull-vps-state.sh` + `scripts/reconcile-user-config.js` —
  operator-only, pull-only sync of live JSON state from a VPS.
  `user-config.json` is reconciled (Supabase > local > VPS) rather than
  overwritten.

## 2026-07-27/28 — Risk guard hardening (SalaryCat-SOL loss post-mortem)

Root-caused a real trading loss (SalaryCat-SOL, three same-day deploys, third
one lost -35.96% / -$16.23) and added seven config-driven safety guards,
each verified against the real historical data for this and two other past
≥20% losses (WORM-SOL, Agamemnon-SOL):

- **Repeat-deploy cooldown tightened** — `repeatDeployCooldownTriggerCount`
  3 → 2, blocks a 3rd same-day deploy into one pool before it can lose money.
- **Rejection hysteresis** — a pool rejected ≥2 times for bot-holders%/top10%
  concentration gets a tightened cap so it can't slip through the instant a
  metric dips just under the raw cutoff.
- **Pre-deploy TVL/mcap decline check** — rejects a deploy if the pool's TVL
  has dropped >20% since the last observed screening pass, even if it still
  clears the static minimum.
- **Token-age deploy window** — allows deploys in a pool's first 6h (early
  momentum), blocks hours 6–30 (highest-risk dump window), reopens after —
  using the DLMM pool's own creation time, not the token's original mint
  date.
- **Repeat-deploy size taper + tighter stop-loss** — a 2nd+ deploy into a
  pool still within its early window gets a smaller position size (60%/40%
  tiers) and a tightened, position-specific stop-loss.
- **Fast OOR + negative-PnL exit** — closes a position immediately once it's
  out-of-range (either direction) and already past half its effective
  stop-loss, instead of waiting the full OOR timer or full stop-loss
  threshold.
- **AVOID-tagged pinned lessons** — a pool with a proven bad track record
  (≥2 deploys, avg PnL ≤ -10%) gets a pinned lesson that bypasses the normal
  recency cap in future SCREENER prompts.
- **Market-regime-aware screening** — classifies Slow/Normal/Hot from
  aggregate `degenScore` across each cycle's candidates and auto-forks
  strategy, screening thresholds, exit rules, and sizing (later bounded, see
  2026-07-30 above).
- **Supabase integration added** — `supabase-config.js` syncs
  `user-config.json` to/from a Supabase key-value table, and
  `position-log.js` mirrors every deploy/close into
  `deploy_position`/`closed_position` tables for external reporting.
- **QA/benchmark harness** — `test/lib/test-kit.js` (shared suite/snapshot-
  restore helpers), `test/test-invariants.js` (config bound + `CONFIG_MAP`
  consistency + rule-precedence contract tests), and a benchmark harness
  replaying 8 real historical positions (3 known losses + 5 wins) against
  the current guards via `test/lib/benchmark-eval.js`, a TDD-built config
  backtester reporting pnl_sol/pnl_usd vs. real history.
- **Telegram redesign** — Management Cycle report rewritten as HTML
  `<b>`/`<pre>` tables (fixes `**bold**` markdown never actually rendering,
  since `sendMessage`/`editMessage` never set `parse_mode` before this).

All 15 new config keys are settable via `update_config`/Telegram, default
on, and backtested to have prevented all three known historical ≥20% losses.

## 2026-07-14 — Telegram group-topic messaging

- Telegram messages now route correctly into group topics/threads, with
  improved message handling for group chats and fuller error logging on
  unclassified LLM provider errors.

## 2026-06-25 — PnL exit unfreeze + Degen Score recalibration

- **`fix(pnl)`**: unfroze exits that could get stuck, added 2-tick
  confirmation before acting on a PnL signal, made the management cycle more
  deterministic, and introduced an opportunity poller for faster reaction
  between full cycles.
- **`fix(degen)`**: Degen Score's window-dependent inputs (volume/fee/LP) are
  now normalized to a fixed 30-minute reference window so targets stay valid
  regardless of the configured screening timeframe; recalibrated targets to
  match.

## 2026-06-07 → 2026-06-12 — RPC-derived PnL, GMGN fees, entry/exit learning

- **`feat`**: entry/exit learning, HiveMind market-data push, OKX removal
  (screening no longer depends on OKX's rugpull/wash-trade flags), and a
  setup wizard overhaul.
- **`feat`**: RPC-derived PnL poller (positions priced directly from
  on-chain state rather than solely through third-party PnL APIs) + GMGN as
  an alternative fee-data source (merged via PR #87 from `yunus-0x`).
- **`fix(pnl)`**: `pnl_pct_suspicious` is now based on genuine input
  validity, not a stale percentage-diff heuristic (PR #89); `rules` in
  `getDeterministicCloseRule` now honor that flag so a suspect tick can't
  trigger stop-loss/take-profit on bad data.
- Dropped 15-minute screening timeframe — not supported by the pool
  discovery API.

## 2026-05-04 → 2026-05-26 — Screening hardening, PM2, Discord signals

- **DLMM deploy guard**: range and volatility validated before every deploy;
  fixed Meteora discovery screening source and switched to 30-minute (later
  screening-timeframe-matched) volatility windows.
- **PM2 hardening**: fixed restart handling, graceful shutdown under PM2,
  and entrypoint-path recognition so the daemon behaves correctly whether
  started via `npm start` or PM2.
- Enriched Discord-sourced signal launchpads before filtering; moved relay
  position enrichment into the main bot process.
- Fixed false `volume=0` screening rejections; exported tracked positions
  and a Telegram edit helper so PnL/Darwin snapshots stay consistent.
- Handled DeepSeek's "thinking mode" rejecting `tool_choice`, and added
  automatic Telegram bot-command registration on startup.

## 2026-04-17 → 2026-04-29 — Experimental runtime merge, relay hardening

- Wired the experimental agent runtime (developed in parallel) into `main`.
- Routed OKX enrichment through Agent Meridian instead of calling OKX
  directly; retried open-position relay checks on failure.
- Added a Telegram settings menu (inline-keyboard config editing).
- Added the repeat-deploy cost guard (later superseded/expanded by the
  2026-07-27 guard hardening pass).
- Hardened relay signing and environment loading; removed a fragile
  zap-out quote preflight from the relay path.
- Enforced screening thresholds again immediately before deploy, closing a
  gap where a stale screening pass could slip through.

## 2026-04-02 → 2026-04-06 — OKX integration, live Telegram progress, close hardening

- **`feat: wire experimental additions to main`** — ported management and
  screening upgrades built in an experimental branch; fixed a double-deploy
  race (more than one deploy could fire in a single screening cycle) and a
  double-screening race (two cycles overlapping).
- Surfaced OKX rugpull/wash-trade flags to the screener, then later
  hard-filtered on Jupiter bot-holder data instead of OKX bundle data;
  authenticated OKX requests added and risk-flag preservation hardened when
  OKX's auth endpoints failed (this whole OKX path was removed in June —
  see 2026-06-07 above).
- **Close-position hardening**: force-closes empty positions, verifies a
  close actually happened before recording PnL, separates claim/close tx
  reporting, detects DLMM position liquidity correctly, and keeps lesson
  PnL accounting in USD throughout.
- **`feat: stream live telegram progress`** — the live-editing Telegram
  message pattern (`createLiveMessage`) used throughout the agent today
  originates here; also fixed typing-indicator continuing after a skipped
  cycle and cleared the screening-busy flag correctly on skipped pre-checks.
- Enforced real tool calls in Telegram chat (rejects no-tool hallucinated
  responses), fixed top-LPer request routing, and switched open-position
  accounting to the PnL API.

## 2026-03-23 → 2026-03-26 — CLI, Claude Code integration, setup wizard

- **`feat: meridian CLI`** — the agent-native command-line interface
  (`cli.js`, every tool exposed as a subcommand) that `.claude/commands/*`
  still shells out to today.
- **`feat: Claude Code integration`** — `.claude/agents/`, `.claude/commands/`
  slash commands, and a Discord listener, merged via PR #3 from `fciaf420`.
- Added and then removed "flip bid-ask" and tokenX-only deploy modes within
  the same few days — shipped, found too fragile (bin-recalculation edge
  cases, incomplete execution after `remove_liquidity`), and reverted in
  favor of the simpler, still-current bid_ask/spot strategy model.
  (`refactor: remove flip bid-ask, tokenX-only deploy; add CLAUDE.md` —
  this commit is also the origin of this repo's `CLAUDE.md` engineering
  manual.)
- Setup wizard: masks API keys instead of printing them to the terminal
  during interactive setup.
- Strategy-aware position management landed here (the LP-strategy library
  concept still in `state/strategy-library.js` today).

## 2026-03-21 → 2026-03-22 — HiveMind, LM Studio support

- **Add Hive Mind** — opt-in collective intelligence for Meridian agents
  (share/pull lessons and presets across agents), merged via PR #1 from
  `fciaf420`. Registration required a token distributed in a private
  Telegram at the time; that gate has since been superseded by the built-in
  public HiveMind key.
- **LM Studio support** — any OpenAI-compatible local endpoint can now serve
  as the LLM backend, not just OpenRouter.
- Management-triggered screening (a management cycle under `maxPositions`
  can immediately trigger a screening cycle rather than waiting for its own
  cron tick) — the `_screeningLastTriggered`/`screeningCooldownMs` pattern
  still in `index.js` today traces to here.
- Volatility-based `bins_below` scaling (35–69 bins, linear in volatility)
  replaced an earlier fixed-tier approach, after first getting the
  direction of the mapping backwards and fixing it same-day.

## 2026-03-18 → 2026-03-20 — Config-driven close rules, pool memory, performance

- Every management close rule (stop-loss, take-profit, OOR, low-yield) made
  configurable via `user-config.json` instead of hardcoded, and given
  explicit precedence (position instruction > hard config rules > LLM
  judgment) — the deterministic-rules-first design that
  `getDeterministicCloseRule` still embodies today.
- Added pool memory (deploy history per pool), token blacklist, closed-
  position performance history, and a briefing watchdog (catches up a
  missed daily briefing on next boot).
- Added token narrative checks (`get_token_narrative`) and defined
  good-vs-bad narrative criteria before a deploy.
- Strategy library added — store, switch between, and apply named LP
  strategies per screening cycle.
- Compounding-aware deploy sizing and a hard `global_fees_sol` gate (skip
  candidates with under 30 SOL in trader fees).
- Major LLM-cost/latency pass: pre-load all cycle data before invoking the
  LLM (cut typical steps from 8–12 down to 2–3), raise output-token limits
  where they were clipping reports, and filter the tool list by agent role
  to shrink the prompt.

## 2026-03-16 → 2026-03-18 — Token analysis, smart wallets, DLMM SDK patches

- Added `get_token_info`/`get_token_holders` via Jupiter datapi, then
  bundler/bot-holder detection on top of it, then corrected the holder-
  percentage math to compute from total supply rather than trusting an API
  field directly.
- Added the smart-wallet tracker (`check_smart_wallets_on_pool`) — cross-
  referencing known KOL/alpha wallets' positions and PnL as a pre-deploy
  confidence signal; later split into separate `lp`/`holder` wallet types.
- Added `search_pools` (query by symbol/ticker/contract address) and
  `self_update` (git pull + auto-restart via Telegram).
- A run of DLMM SDK Anchor-import patches (`patch-anchor.js`): the
  `postinstall` step that rewrites `@meteora-ag/dlmm`'s `BN` import to avoid
  a CJS/ESM naming collision was hardened across several commits this week
  (orphaned commas, aliased imports, quote-style-agnostic dedup) — this is
  the same lazy-load/patch mechanism documented in `CLAUDE.md`'s "Known
  issues" section today.
- Decoupled the management and screening cron busy-flags so one cycle
  running long can't block the other.

## 2026-03-15 → 2026-03-16 — Initial release

- **Initial release — Meridian DLMM LP Agent** (`0eb79f7`, authored by
  `yunus-0x`): autonomous Meteora DLMM liquidity management agent powered by
  LLMs. Core feature set from day one: pool screening, position management,
  fee claiming, Telegram notifications, and adaptive learning from closed
  positions.
- Fixed an early NaN-fees bug (`unclaimedFeeTokenX/Y` are objects, not
  numbers), removed then re-added an SDK fee fallback in favor of the DLMM
  PnL API, and added retry-on-transient-error handling for LLM calls plus a
  fallback model for when the primary provider is down.
- Added `get_wallet_positions` and `get_top_lpers` for on-demand queries,
  and full agent screening reports sent to Telegram.

---

## Fork lineage

This repo began as a fork of `yunus-0x`'s original Meridian DLMM LP Agent
(initial commit `0eb79f7`, 2026-03-15). Notable external contributions
merged along the way:

- **`fciaf420`** — Hive Mind (PR #1) and Claude Code integration (PR #3).
- **`yunus-0x`** — RPC-derived PnL poller + GMGN fee source (PR #87), PnL
  suspicious-tick validity fix (PR #89).

Everything from 2026-07-27 onward (Supabase integration, the SalaryCat-SOL
risk-guard hardening, market-regime-aware screening, the bounded regime
overlay, and the guard-extraction/folder-reorg refactor) was built in this
fork by `fahmifachrizal`, largely in pair-programming sessions with Claude
Code.
