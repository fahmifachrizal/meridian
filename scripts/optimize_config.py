#!/usr/bin/env python3
"""
Grid-search over entry-gate config parameters — token-age window ("new
token"), repeat-deploy cooldown ("past cooldown"), and core screening
thresholds — using REAL historical outcomes (test/fixtures/market-benchmark-
positions.json's 316 real deploys), not a simulated exit.

Why entry-gate only, not exit rules (stop-loss/take-profit/OOR-wait): those
were already grid-searched via scripts/evaluate-config.js --fixture=market
and found to be confounded by a time-horizon mismatch (see that analysis).
Entry-gate parameters don't have that problem — for each real historical
deploy we already know its REAL recorded pnl_usd; the only question a
candidate config changes is whether that deploy would have been ALLOWED at
all. Summing real pnl_usd over "would have been allowed" positions is a
clean historical replay, no simulation involved.

Note: the adaptive market-regime overlay that used to modulate these same
screening thresholds (minOrganic, minFeeActiveTvlRatio, minTvl, minVolume)
at runtime has been removed — the sweep below is now the whole picture,
not a range regime would additionally push thresholds into.

Requires: pandas, numpy
Run: python3 scripts/optimize_config.py
"""

import itertools
import json
from pathlib import Path

import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURE_PATH = REPO_ROOT / "test/fixtures/market-benchmark-positions.json"
POOL_MEMORY_PATH = REPO_ROOT / "pool-memory.json"
CONFIG_PATH = REPO_ROOT / "user-config.json"


def load_positions():
    with open(FIXTURE_PATH) as f:
        data = json.load(f)
    with open(POOL_MEMORY_PATH) as f:
        pool_memory = json.load(f)

    rows = []
    for p in data["positions"]:
        pool_entry = pool_memory.get(p["pool"], {})
        deploys = pool_entry.get("deploys", [])
        rows.append({
            "tag": p["tag"],
            "pool": p["pool"],
            "pool_name": p["pool_name"],
            "amount_sol": p["amount_sol"],
            "organic_score": p["entry"]["organic_score"],
            "fee_tvl_ratio": p["entry"]["fee_tvl_ratio"],
            "entry_mcap": p["entry"]["mcap"],
            "entry_tvl": p["entry"]["tvl"],
            "pool_age_hours_at_deploy": p["pool_age_hours_at_deploy"],
            "deploy_sequence": p["deploy_sequence"],
            "pnl_usd": p["outcome"]["pnl_usd"],
            "pnl_pct": p["outcome"]["pnl_pct"],
            "recorded_at": p["outcome"]["recorded_at"],
            # prior deploys into this same pool, for cooldown replay
            "_prior_deploys": deploys,
        })
    df = pd.DataFrame(rows).sort_values("recorded_at").reset_index(drop=True)
    return df


def is_fee_generating(deploy, min_fee_earned_pct):
    fees_usd = deploy.get("fees_earned_usd") or 0
    fees_sol = deploy.get("fees_earned_sol") or 0
    if fees_usd <= 0 and fees_sol <= 0:
        return False
    return (deploy.get("fee_earned_pct") or 0) >= min_fee_earned_pct


def token_age_blocked(age_hours, early_window_hours, cooldown_hours):
    """Replicates guards/01-token-age-window.js exactly (age-at-evaluation-
    time version — here age_hours is fixed at the historical deploy point,
    which is the correct static replay of what the guard saw then)."""
    if age_hours is None or (isinstance(age_hours, float) and np.isnan(age_hours)):
        return False
    if age_hours <= early_window_hours:
        return False  # early-momentum window: allowed
    if age_hours > early_window_hours + cooldown_hours:
        return False  # past cooldown: reopened
    return True  # inside the cooldown window: blocked


def cooldown_blocked(deploy_sequence, prior_deploys, trigger_count, min_fee_earned_pct):
    """Replicates guard #2 (repeat-deploy cooldown) — blocks if this
    deploy's `trigger_count` immediately-prior deploys into the same pool
    were ALL fee-generating."""
    if deploy_sequence is None or (isinstance(deploy_sequence, float) and np.isnan(deploy_sequence)):
        return False
    deploy_sequence = int(deploy_sequence)
    trigger_count = int(trigger_count)
    if deploy_sequence <= trigger_count:
        return False
    window = prior_deploys[deploy_sequence - 1 - trigger_count: deploy_sequence - 1]
    if len(window) < trigger_count:
        return False
    return all(is_fee_generating(d, min_fee_earned_pct) for d in window)


def evaluate(df, params):
    mask = pd.Series(True, index=df.index)

    mask &= df["organic_score"].fillna(-1) >= params["minOrganic"]
    mask &= df["fee_tvl_ratio"].fillna(-1) >= params["minFeeActiveTvlRatio"]
    mask &= df["entry_mcap"].fillna(-1) >= params["minMcap"]

    age_blocked = df.apply(
        lambda r: token_age_blocked(r["pool_age_hours_at_deploy"], params["tokenEarlyWindowMaxHours"], params["tokenCooldownHours"]),
        axis=1,
    )
    mask &= ~age_blocked

    cd_blocked = df.apply(
        lambda r: cooldown_blocked(r["deploy_sequence"], r["_prior_deploys"], params["repeatDeployCooldownTriggerCount"], params["repeatDeployCooldownMinFeeEarnedPct"]),
        axis=1,
    )
    mask &= ~cd_blocked

    deployed = df[mask]
    n = len(deployed)
    total_pnl = deployed["pnl_usd"].sum()
    win_rate = (deployed["pnl_pct"] > 0).mean() if n else np.nan
    pnl_per_position = total_pnl / n if n else np.nan
    gross_profit = deployed.loc[deployed["pnl_usd"] > 0, "pnl_usd"].sum()
    gross_loss = -deployed.loc[deployed["pnl_usd"] < 0, "pnl_usd"].sum()  # positive number
    profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else (np.inf if gross_profit > 0 else np.nan)
    worst_loss = deployed["pnl_usd"].min() if n else np.nan
    return {
        "deployed_count": n,
        "blocked_count": len(df) - n,
        "total_pnl_usd": total_pnl,
        "win_rate": win_rate,
        "pnl_per_position": pnl_per_position,
        "gross_profit_usd": gross_profit,
        "gross_loss_usd": gross_loss,
        "profit_factor": profit_factor,
        "worst_single_loss_usd": worst_loss,
        **params,
    }


def run_grid(df, grid, label):
    keys = list(grid.keys())
    combos = list(itertools.product(*grid.values()))
    print(f"\n{label}: {len(combos)} combinations over {len(df)} positions")
    results = []
    for combo in combos:
        params = dict(zip(keys, combo))
        results.append(evaluate(df, params))
    return pd.DataFrame(results)


def print_top(results, n=8, sort_by="total_pnl_usd", min_deployed=15):
    eligible = results[results["deployed_count"] >= min_deployed]
    top = eligible.sort_values(sort_by, ascending=False).head(n)
    cols = ["tokenEarlyWindowMaxHours", "tokenCooldownHours", "repeatDeployCooldownTriggerCount",
            "repeatDeployCooldownMinFeeEarnedPct", "minOrganic", "minFeeActiveTvlRatio", "minMcap",
            "deployed_count", "win_rate", "profit_factor", "gross_loss_usd", "total_pnl_usd"]
    with pd.option_context("display.width", 220, "display.max_columns", None):
        print(top[cols].to_string(index=False, formatters={
            "win_rate": "{:.0%}".format,
            "profit_factor": "{:.2f}".format,
            "gross_loss_usd": "${:.2f}".format,
            "total_pnl_usd": "${:.2f}".format,
            "minFeeActiveTvlRatio": "{:.2f}".format,
        }))


def bucket_partition_search(df, live_params, param_keys_fixed):
    """Partitions positions by pool age at deploy (independent of any
    candidate config — a real, data-driven split, not circular with the
    thing being tuned) and grid-searches ONLY the quality filters
    (minOrganic/minFeeActiveTvlRatio/minMcap) within each bucket, holding
    age-window/cooldown params at the live config's values (they don't mean
    anything within an already-fixed age bucket). Answers: does the optimal
    quality bar differ for a genuinely-new token vs an older/reopened one?
    """
    bins = [-0.01, 6, 30, np.inf]
    labels = ["new (<=6h)", "cooldown-window (6-30h)", "reopened (30h+)"]
    df = df.copy()
    df["age_bucket"] = pd.cut(df["pool_age_hours_at_deploy"], bins=bins, labels=labels)

    quality_grid = {
        "minOrganic": [50, 60, 70, 80],
        "minFeeActiveTvlRatio": [0.03, 0.05, 0.10],
        "minMcap": [100_000, 150_000, 300_000, 400_000],
    }
    keys = list(quality_grid.keys())
    combos = list(itertools.product(*quality_grid.values()))

    print(f"\n=== Partitioned by pool age at deploy — best quality filter PER bucket ===")
    for label in labels:
        bucket_df = df[df["age_bucket"] == label]
        if len(bucket_df) < 20:
            print(f"\n  -- {label}: only {len(bucket_df)} positions, too few to search --")
            continue
        rows = []
        for combo in combos:
            params = {**live_params, **dict(zip(keys, combo))}
            rows.append(evaluate(bucket_df, params))
        res = pd.DataFrame(rows)
        min_dep = max(10, int(len(bucket_df) * 0.15))
        eligible = res[(res["deployed_count"] >= min_dep) & (res["profit_factor"] >= 1.3)]
        if eligible.empty:
            eligible = res[res["deployed_count"] >= min_dep]
        top = eligible.sort_values("total_pnl_usd", ascending=False).head(3)
        print(f"\n  -- {label}: {len(bucket_df)} historical deploys --")
        cols = keys + ["deployed_count", "win_rate", "profit_factor", "gross_loss_usd", "total_pnl_usd"]
        with pd.option_context("display.width", 220, "display.max_columns", None):
            print(top[cols].to_string(index=False, formatters={
                "win_rate": "{:.0%}".format, "profit_factor": "{:.2f}".format,
                "gross_loss_usd": "${:.2f}".format, "total_pnl_usd": "${:.2f}".format,
                "minFeeActiveTvlRatio": "{:.2f}".format,
            }))


def main():
    with open(CONFIG_PATH) as f:
        cfg = json.load(f)

    df = load_positions()
    print(f"Loaded {len(df)} real historical deploys (chronologically sorted)")

    live_params = {
        "tokenEarlyWindowMaxHours": cfg.get("tokenEarlyWindowMaxHours", 6),
        "tokenCooldownHours": cfg.get("tokenCooldownHours", 24),
        "repeatDeployCooldownTriggerCount": cfg.get("repeatDeployCooldownTriggerCount", 2),
        "repeatDeployCooldownMinFeeEarnedPct": cfg.get("repeatDeployCooldownMinFeeEarnedPct", 0),
        "minOrganic": cfg.get("minOrganic", 60),
        "minFeeActiveTvlRatio": cfg.get("minFeeActiveTvlRatio", 0.05),
        "minMcap": cfg.get("minMcap", 150000),
    }
    print("\n=== Live config baseline ===")
    print(json.dumps(evaluate(df, live_params), indent=2, default=str))

    grid = {
        "tokenEarlyWindowMaxHours": [3, 6, 12],
        "tokenCooldownHours": [8, 14, 24],
        "repeatDeployCooldownTriggerCount": [1, 2, 3],
        "repeatDeployCooldownMinFeeEarnedPct": [0, 20, 50],
        "minOrganic": [50, 60, 70, 80],
        "minFeeActiveTvlRatio": [0.03, 0.05, 0.10],
        "minMcap": [100_000, 150_000, 300_000, 400_000],
    }

    split = int(len(df) * 0.7)
    train, test = df.iloc[:split], df.iloc[split:]
    print(f"\nChronological split for overfit check: train n={len(train)}, test n={len(test)}")

    train_results = run_grid(train, grid, "TRAIN grid search")
    param_keys = list(grid.keys())

    # Volume floor: require deploying at least half as often as the live
    # config does on this split, so "optimal" can't mean "barely deploy."
    live_train_n = evaluate(train, live_params)["deployed_count"]
    min_dep_train = max(15, int(live_train_n * 0.5))
    print(f"\nVolume floor for TRAIN: >= {min_dep_train} deploys (half of live config's {live_train_n})")

    print(f"\n=== Top 8 configs on TRAIN ONLY, by total_pnl_usd, profit_factor>=1.3, deployed>={min_dep_train} ===")
    train_eligible = train_results[(train_results["deployed_count"] >= min_dep_train) & (train_results["profit_factor"] >= 1.3)]
    print_top(train_eligible, n=8, sort_by="total_pnl_usd", min_deployed=min_dep_train)
    print("  ^ WARNING: selected on train only — check the held-out validation below before trusting this.")

    # Validate the top-5 configs against the held-out test set.
    top5 = train_eligible.sort_values("total_pnl_usd", ascending=False).head(5)
    print("\n=== Those same top-5 (train) configs, re-evaluated on held-out TEST set ===")
    rows = []
    for _, r in top5.iterrows():
        params = {k: r[k] for k in param_keys}
        test_result = evaluate(test, params)
        rows.append({**params, "train_pnl_usd": r["total_pnl_usd"], "train_profit_factor": r["profit_factor"],
                     "test_pnl_usd": test_result["total_pnl_usd"], "test_profit_factor": test_result["profit_factor"],
                     "test_deployed": test_result["deployed_count"]})
    test_df = pd.DataFrame(rows)
    with pd.option_context("display.width", 220, "display.max_columns", None):
        print(test_df.to_string(index=False, formatters={
            "train_pnl_usd": "${:.2f}".format, "test_pnl_usd": "${:.2f}".format,
            "train_profit_factor": "{:.2f}".format, "test_profit_factor": "{:.2f}".format,
            "minFeeActiveTvlRatio": "{:.2f}".format,
        }))

    live_train = evaluate(train, live_params)
    live_test = evaluate(test, live_params)
    print(f"\n  Live config for comparison: train total_pnl=${live_train['total_pnl_usd']:.2f} "
          f"(n={live_train['deployed_count']}, pf={live_train['profit_factor']:.2f}), "
          f"test total_pnl=${live_test['total_pnl_usd']:.2f} "
          f"(n={live_test['deployed_count']}, pf={live_test['profit_factor']:.2f})")

    # The actually-defensible selection: run the FULL grid on both splits,
    # apply the SAME volume floor + profit-factor bar to both, and keep only
    # combos that clear both bars on BOTH splits — real (if crude)
    # cross-validation, not "best on the data we happened to look at first."
    print("\n=== Full grid re-run on TEST, merged with TRAIN — configs good on BOTH splits ===")
    test_results = run_grid(test, grid, "TEST grid search")
    live_test_n = evaluate(test, live_params)["deployed_count"]
    min_dep_test = max(10, int(live_test_n * 0.5))

    tr = train_results.add_prefix("train_")
    te = test_results.add_prefix("test_")
    for k in param_keys:
        tr[k] = tr[f"train_{k}"]
        te[k] = te[f"test_{k}"]
    merged = tr.merge(te, on=param_keys)
    merged = merged[
        (merged["train_deployed_count"] >= min_dep_train) & (merged["train_profit_factor"] >= 1.3) &
        (merged["test_deployed_count"] >= min_dep_test) & (merged["test_profit_factor"] >= 1.3)
    ]
    merged["combined_total_pnl"] = merged["train_total_pnl_usd"] + merged["test_total_pnl_usd"]

    robust = merged.sort_values("combined_total_pnl", ascending=False).head(8)
    cols = param_keys + ["train_deployed_count", "train_profit_factor", "train_total_pnl_usd",
                          "test_deployed_count", "test_profit_factor", "test_total_pnl_usd"]
    with pd.option_context("display.width", 240, "display.max_columns", None):
        print(f"  {len(merged)} combos clear profit_factor>=1.3 AND the volume floor on BOTH splits\n")
        print(robust[cols].to_string(index=False, formatters={
            "train_profit_factor": "{:.2f}".format, "test_profit_factor": "{:.2f}".format,
            "train_total_pnl_usd": "${:.2f}".format, "test_total_pnl_usd": "${:.2f}".format,
            "minFeeActiveTvlRatio": "{:.2f}".format,
        }))

    bucket_partition_search(df, live_params, param_keys)

    # ------------------------------------------------------------------
    # "Most greedy": pure max total_pnl_usd, NO profit_factor gate — happy
    # to accept a worse loss profile / lower win rate if it drags in enough
    # extra upside to raise the total. Same volume floor as before (a config
    # that only deploys twice can't be meaningfully "greedy"), but nothing
    # else holding it back. Still cross-validated on both splits so it's at
    # least not a train-only fluke — greedy is a risk stance, not a license
    # to overfit.
    print("\n" + "=" * 78)
    print("MOST GREEDY: max total_pnl_usd, no profit-factor gate (accepts more risk)")
    print("=" * 78)
    greedy_merged = tr.merge(te, on=param_keys)
    greedy_merged = greedy_merged[
        (greedy_merged["train_deployed_count"] >= min_dep_train) &
        (greedy_merged["test_deployed_count"] >= min_dep_test)
    ]
    greedy_merged["combined_total_pnl"] = greedy_merged["train_total_pnl_usd"] + greedy_merged["test_total_pnl_usd"]
    greedy_top = greedy_merged.sort_values("combined_total_pnl", ascending=False).head(8)
    cols_greedy = param_keys + ["train_deployed_count", "train_profit_factor", "train_total_pnl_usd",
                                 "test_deployed_count", "test_profit_factor", "test_total_pnl_usd",
                                 "combined_total_pnl"]
    with pd.option_context("display.width", 250, "display.max_columns", None):
        print(greedy_top[cols_greedy].to_string(index=False, formatters={
            "train_profit_factor": "{:.2f}".format, "test_profit_factor": "{:.2f}".format,
            "train_total_pnl_usd": "${:.2f}".format, "test_total_pnl_usd": "${:.2f}".format,
            "combined_total_pnl": "${:.2f}".format, "minFeeActiveTvlRatio": "{:.2f}".format,
        }))

    # Also show the single best train-only greedy pick (no cross-split
    # requirement at all) so you can see the ceiling if you don't care about
    # robustness — and how it does on test, as a warning.
    train_greedy = train_results[train_results["deployed_count"] >= min_dep_train].sort_values("total_pnl_usd", ascending=False).head(1)
    if not train_greedy.empty:
        r = train_greedy.iloc[0]
        params = {k: r[k] for k in param_keys}
        test_check = evaluate(test, params)
        print(f"\n  Train-only greedy ceiling (ignores test entirely): total_pnl=${r['total_pnl_usd']:.2f} "
              f"(n={r['deployed_count']}, pf={r['profit_factor']:.2f}) on train — "
              f"same config on test: total_pnl=${test_check['total_pnl_usd']:.2f} "
              f"(n={test_check['deployed_count']}, pf={test_check['profit_factor']:.2f})")

    print("\nDone. Caveat: n=316 single historical run on one chronological split — "
          "treat the robust (both-splits) table as a direction-finder (which parameters move "
          "outcomes, which way, and how consistently), not a final production config.")


if __name__ == "__main__":
    main()
