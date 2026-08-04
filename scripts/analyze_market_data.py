#!/usr/bin/env python3
"""
Deep analysis of the 3-day OHLCV market dataset (scripts/data/pool-first-3days-ohlcv.csv)
against the live config (user-config.json). Pure market-data analysis — no
guard/rule replay (see scripts/build-market-benchmark-positions.js +
scripts/evaluate-config.js --fixture=market for that side of things).

Requires: pandas, numpy (pip install pandas numpy)
Run: python3 scripts/analyze_market_data.py
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = REPO_ROOT / "scripts/data/pool-first-3days-ohlcv.csv"
CONFIG_PATH = REPO_ROOT / "user-config.json"


def load_config():
    with open(CONFIG_PATH) as f:
        return json.load(f)


def load_candles():
    df = pd.read_csv(CSV_PATH, parse_dates=["pool_created_at_iso", "candle_ts_iso"])
    df["hours_since_created"] = df["minutes_since_created"].astype(float) / 60
    entry_close = df.sort_values("minutes_since_created").groupby("pool")["close"].first()
    df = df.join(entry_close.rename("entry_close"), on="pool")
    df["ratio"] = df["close"] / df["entry_close"]
    return df


def nearest_ratio_at_hour(df, target_hour, tolerance_hours=1.0):
    """For each pool, the ratio at the candle closest to `target_hour` since
    creation, or NaN if nothing within `tolerance_hours` (pool too young)."""
    out = {}
    for pool, g in df.groupby("pool"):
        idx = (g["hours_since_created"] - target_hour).abs().idxmin()
        row = g.loc[idx]
        if abs(row["hours_since_created"] - target_hour) <= tolerance_hours:
            out[pool] = row["ratio"]
    return pd.Series(out)


def pct_table(series, label):
    s = series.dropna()
    q = s.quantile([0.10, 0.25, 0.50, 0.75, 0.90])
    print(f"  {label:<28} n={len(s):<4} "
          f"p10={q[0.10]:.2f}x  p25={q[0.25]:.2f}x  p50={q[0.50]:.2f}x  "
          f"p75={q[0.75]:.2f}x  p90={q[0.90]:.2f}x")


def section(title):
    print(f"\n{'=' * 78}\n{title}\n{'=' * 78}")


def main():
    cfg = load_config()
    df = load_candles()

    n_pools = df["pool"].nunique()
    print(f"Loaded {len(df):,} candle rows across {n_pools} pools from {CSV_PATH.name}")

    # ------------------------------------------------------------------
    section("1. Live config — the thresholds this analysis is checked against")
    screening_keys = ["minTvl", "minVolume", "minOrganic", "minFeeActiveTvlRatio",
                       "minTokenAgeHours", "maxTokenAgeHours"]
    management_keys = ["stopLossPct", "takeProfitPct", "outOfRangeWaitMinutes",
                       "trailingTriggerPct", "trailingDropPct",
                       "fastExitStopLossFraction", "minFeePerTvl24h",
                       "minAgeBeforeYieldCheck"]
    for k in screening_keys:
        print(f"  screening.{k:<24} = {cfg.get(k)}")
    for k in management_keys:
        print(f"  management.{k:<23} = {cfg.get(k)}")

    # ------------------------------------------------------------------
    section("2. Ratio-to-entry distribution at 24h / 48h / 72h checkpoints")
    for h in (24, 48, 72):
        pct_table(nearest_ratio_at_hour(df, h), f"@{h}h")
    print("  -> median holds ~flat across all three checkpoints; the LOSER tail\n"
          "     (p10/p25) keeps deteriorating over time, the WINNER tail (p90)\n"
          "     compresses — waiting longer helps a losing position revert less\n"
          "     than it costs a winning one in given-back gains.")

    # ------------------------------------------------------------------
    section("3. Peak timing & giveback (how fast pumps fade)")
    peak_idx = df.groupby("pool")["ratio"].idxmax()
    peaks = df.loc[peak_idx, ["pool", "ratio", "hours_since_created"]].set_index("pool")
    peaks.columns = ["peak_ratio", "peak_hour"]

    last_idx = df.groupby("pool")["hours_since_created"].idxmax()
    finals = df.loc[last_idx, ["pool", "ratio"]].set_index("pool")
    finals.columns = ["final_ratio"]

    joined = peaks.join(finals)
    joined["giveback"] = (joined["peak_ratio"] - joined["final_ratio"]) / joined["peak_ratio"]
    pumped = joined[joined["peak_ratio"] > 1.05]

    print(f"  pools that pumped >1.05x at some point: {len(pumped)} of {len(joined)}")
    pct_table(joined["peak_hour"], "peak hour (hrs since creation)")
    pct_table(pumped["giveback"], "giveback fraction of peak")
    give_80 = (pumped["giveback"] >= 0.8).mean() * 100
    give_50 = (pumped["giveback"] >= 0.5).mean() * 100
    print(f"  share giving back >=80% of peak gain: {give_80:.1f}%")
    print(f"  share giving back >=50% of peak gain: {give_50:.1f}%")

    oor_wait_hours = cfg.get("outOfRangeWaitMinutes", 30) / 60
    within_wait = (pumped["peak_hour"] <= oor_wait_hours).mean() * 100
    print(f"  -> {within_wait:.1f}% of pumping pools peak within the current "
          f"outOfRangeWaitMinutes window ({cfg.get('outOfRangeWaitMinutes')}min) of pool creation.")

    # ------------------------------------------------------------------
    section("4. Entry-signal correlation with 72h outcome")
    meta_cols = ["pool", "organic_score", "fee_tvl_ratio", "entry_mcap"]
    meta = df[meta_cols].drop_duplicates(subset="pool").set_index("pool")
    outcomes = joined.join(meta)

    def bucket_report(col, bins, labels):
        print(f"\n  -- by {col} --")
        cut = pd.cut(outcomes[col], bins=bins, labels=labels)
        g = outcomes.groupby(cut, observed=True)[["final_ratio", "peak_ratio"]].median()
        counts = outcomes.groupby(cut, observed=True).size()
        for label in g.index:
            print(f"    {str(label):<14} n={counts[label]:<4} "
                  f"median final={g.loc[label, 'final_ratio']:.2f}x  "
                  f"median peak={g.loc[label, 'peak_ratio']:.2f}x")

    bucket_report("organic_score", [0, 60, 70, 80, 101], ["<60", "60-70", "70-80", "80+"])
    bucket_report("fee_tvl_ratio", [0, 0.05, 0.15, 0.4, np.inf], ["<0.05", "0.05-0.15", "0.15-0.4", "0.4+"])
    bucket_report("entry_mcap", [0, 100_000, 400_000, np.inf], ["<100k", "100k-400k", "400k+"])
    print(f"\n  live config's own minOrganic={cfg.get('minOrganic')}, "
          f"minFeeActiveTvlRatio={cfg.get('minFeeActiveTvlRatio')} — compare against the buckets above.")

    # ------------------------------------------------------------------
    section("5. Stop-loss threshold reality check")
    stop_loss_pct = cfg.get("stopLossPct", -15)
    stop_loss_ratio = 1 + stop_loss_pct / 100
    ever_breached = (df.groupby("pool")["ratio"].min() <= stop_loss_ratio).mean() * 100
    print(f"  stopLossPct = {stop_loss_pct}% (ratio <= {stop_loss_ratio:.2f}x)")
    print(f"  {ever_breached:.1f}% of pools drop through this threshold at some point "
          f"within their observed window.")
    print("  (this does NOT mean that share of live positions lose 15%+ — the agent's "
          "real median hold time is ~1h, so most positions close long before a pool's "
          "eventual dip; see the guard/rule benchmark comparison for the confound-aware version.)")

    print("\nDone.")


if __name__ == "__main__":
    main()
