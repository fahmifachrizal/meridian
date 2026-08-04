# Benchmark positions

`benchmark-positions.json` — 8 real historical closed positions from this
repo's own recorded data, curated as a benchmark for testing new guards,
screening logic, or exit rules against known-real outcomes rather than
synthetic fixtures.

Regenerate with:
```bash
node scripts/build-benchmark-dataset.js       # base records — local only, no network
node scripts/fetch-benchmark-ohlcv.js         # + real minute-level price OHLCV (network, ~8s/pool)
node scripts/fetch-benchmark-pool-metadata.js # + pool_created_at / deploy_sequence (network, ~1s/pool)
```

Then `node test/test-benchmark.js` (or `npm run test:benchmark`, part of the
default `npm test` gate) replays every position against the *current*
guards — offline, reads only the static fixture, no network at test time.

## What's in it

| tag | pool | pnl | why it's here |
|---|---|---|---|
| `big_loss` | SalaryCat-SOL | -35.96% | 3rd same-day deploy, stop-loss — the loss that started the guard work this session |
| `big_loss` | WORM-SOL | -44.21% | 3rd same-day deploy, OOR crash |
| `big_loss` | Agamemnon-SOL | -27.37% | 2nd deploy, pool already past its early-momentum window |
| `win_pumped_above_range` | brain-SOL | +4.36% | clean win, price ran away from range |
| `win_take_profit` | RAKO-SOL | +5.94% | clean take-profit exit |
| `win_trailing_tp` | Waddles-SOL | +1.33% | trailing take-profit on a high-volatility pool |
| `small_loss_low_yield` | HermesWorld-SOL | -1.94% | long hold, fee/TVL never cleared the floor |
| `small_loss_agent_decision` | OGDOGE-SOL | -0.26% | closed by LLM judgment, not a deterministic rule |

Each record has: pool/strategy/bin_range metadata, entry/exit market metrics
(mcap, tvl, volume, holders, volatility), the outcome (pnl, fees, close
reason, minutes held), a **`price_ohlcv_1m` array of real minute-level
price/volume candles spanning the position's exact deploy-to-close window**
(+30min before / +10min after), a `timeline` array, `pool_created_at` /
`pool_age_hours_at_deploy` / `deploy_sequence` (the pool's own creation time,
this deploy's age relative to it, and its 1-based index among all deploys
into that pool — what guards #6 and #1 respectively key off of), and
matching `decisions` from `decision-log.json` where still retained (that log
is a rolling 100-entry window, so older positions may show `decisions: []`).

## Where the price data comes from

`price_ohlcv_1m` is sourced from **GeckoTerminal's public API**
(`api.geckoterminal.com/api/v2/networks/solana/pools/{pool}/ohlcv/minute`),
fetched by `scripts/fetch-benchmark-ohlcv.js`. Meteora's own pool OHLCV API
(`dlmm.datapi.meteora.ag/pools/{pool}/ohlcv`) was tried first and can't do
this — it only serves the *current* ~10 most-recent candles regardless of
`timeframe`/`start_time`/`end_time`, returning `data: []` for any real
historical window on an already-closed pool. GeckoTerminal's `before_timestamp`
param genuinely pages backward into history (verified against every pool in
this dataset, including two from 40+ days back) — free tier covers the last
180 days, no API key required, but is rate-limited (the fetch script sleeps
~8s between pools).

**`timeline` is a useful complement, not a fallback**: it's the actual
`pnl_pct` / `in_range` / `unclaimed_fees_usd` / `minutes_out_of_range` /
`age_minutes` snapshots this repo recorded live during each position's life
(`pool-memory.json`'s per-pool `snapshots`, ~10min cadence) — already in the
exact shape the deterministic close rules (`getDeterministicCloseRule` in
`index.js`) consume, so it's closer to a direct regression fixture than
price alone.

## Using it

```js
const { positions } = JSON.parse(fs.readFileSync("test/fixtures/benchmark-positions.json", "utf8"));
const bigLosses = positions.filter(p => p.tag === "big_loss");
```

Good uses: sanity-checking a new guard's would-it-have-fired logic against
a known-real loss (the pattern used to backtest the 7 post-mortem guards
this session), spot-checking that a threshold change doesn't flip a
historical win into a loss or vice versa, or seeding realistic `pool`
objects for a new screening filter's edge-case tests.

## Known accepted false positives

`test/test-benchmark.js` replays guards #1 and #6 against all 8 positions
and found one false positive each in this small sample — both documented
and asserted as *expected*, not silently passing:

- **Guard #1** (repeat-deploy cooldown) would have blocked **Waddles-SOL**'s
  3rd deploy — a real win, but its 2 prior deploys were both fee-generating,
  exactly the pattern the guard targets.
- **Guard #6** (token-age window) would have blocked **brain-SOL**'s 2nd
  deploy — a real win, but the pool was 7.53h old, inside the 6-30h
  cooldown zone.

Both are accepted trade-offs (cut the 3 known big losses, occasionally skip
a legitimate repeat/early win) — not bugs. If a future change introduces a
*new* false positive beyond these two, `test-benchmark.js` will fail.

## Config backtester (`test/lib/benchmark-eval.js`)

Answers "how would this config change have performed against these 8 real
positions, in SOL/USD?" — not just "would it have fired," but the actual
simulated `pnl_sol`/`pnl_usd` per position and in aggregate, compared to
what really happened. Built test-first (TDD): `test/test-benchmark-eval.js`
was written with hand-computed expected numbers before the implementation
existed, confirmed to fail (module not found), then `benchmark-eval.js` was
written to make every one of those pre-computed numbers pass.

```bash
npm run evaluate-config                              # evaluate the live config
node scripts/evaluate-config.js path/to/candidate.json  # evaluate a { screening: {...}, management: {...} } override
```

Under the live config today, this dataset shows:

```
total_pnl_usd:        +$1.26   (vs actual real-world: -$41.65)
total_pnl_sol:        +0.017 SOL (vs actual: -0.557 SOL)
delta:                +$42.91 / +0.574 SOL saved
```

— i.e. the 3 known big losses being blocked/mitigated more than offsets the
2 known false positives being blocked too. Same replay scope as
`test-benchmark.js` (guards #1/#2/#5 for the deploy gate, rules 1/2/4 for
the exit) — see `test/test-benchmark-eval.js`'s file header for the full
scope statement.
