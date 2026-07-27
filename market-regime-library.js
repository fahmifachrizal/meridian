/**
 * Market Regime Library — persistent store of market-condition config profiles.
 *
 * Mirrors strategy-library.js's shape ({ active, <items> }) but on a different
 * axis: strategy-library.js holds a user's LP-shape playbook (manually
 * selected), this holds the config diff each market regime (Slow/Normal/Hot)
 * applies automatically once detected (see market-regime.js).
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const REGIME_FILE = repoPath("market-regime-profiles.json");

function load() {
  if (!fs.existsSync(REGIME_FILE)) return { active: null, regimes: {} };
  try {
    return JSON.parse(fs.readFileSync(REGIME_FILE, "utf8"));
  } catch {
    return { active: null, regimes: {} };
  }
}

function save(data) {
  fs.writeFileSync(REGIME_FILE, JSON.stringify(data, null, 2));
}

// ─── Default Regimes ────────────────────────────────────────────
// `changes` uses the exact same flat keys as tools/executor.js's CONFIG_MAP,
// so a profile can be handed straight to applyConfigChanges() with no
// translation layer. Numbers adapted from setup.js's safe/moderate/degen
// presets, reframed on the market-condition axis instead of risk-appetite.
const DEFAULT_REGIMES = {
  slow: {
    id: "slow",
    label: "Slow",
    description: "Thin volume/liquidity — spot strategy, looser thresholds, conservative exits and sizing.",
    changes: {
      strategy: "spot",
      minVolume: 10000,
      minFeeActiveTvlRatio: 2.0,
      minOrganic: 75,
      minTvl: 20000,
      maxTvl: 200000,
      stopLossPct: -10,
      takeProfitPct: 3,
      minAgeBeforeYieldCheck: 90,
      deployAmountSol: 0.35,
      positionSizePct: 0.25,
    },
  },
  normal: {
    id: "normal",
    label: "Normal",
    description: "Typical market activity — bid_ask strategy, standard thresholds/exits/sizing.",
    changes: {
      strategy: "bid_ask",
      minVolume: 2000,
      minFeeActiveTvlRatio: 0.4,
      minOrganic: 70,
      minTvl: 10000,
      maxTvl: 150000,
      stopLossPct: -15,
      takeProfitPct: 5,
      minAgeBeforeYieldCheck: 60,
      deployAmountSol: 0.5,
      positionSizePct: 0.35,
    },
  },
  hot: {
    id: "hot",
    label: "Hot",
    description: "Broad, strong candidate activity — bid_ask strategy, tighter thresholds, faster/wider exits, bigger sizing.",
    changes: {
      strategy: "bid_ask",
      minVolume: 1000,
      minFeeActiveTvlRatio: 0.15,
      minOrganic: 60,
      minTvl: 5000,
      maxTvl: 100000,
      stopLossPct: -25,
      takeProfitPct: 10,
      minAgeBeforeYieldCheck: 30,
      deployAmountSol: 0.6,
      positionSizePct: 0.5,
    },
  },
};

function ensureDefaultRegimes() {
  const db = load();
  let added = false;
  for (const [id, regime] of Object.entries(DEFAULT_REGIMES)) {
    if (!db.regimes[id]) {
      db.regimes[id] = {
        ...regime,
        added_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      added = true;
    }
  }
  if (added) {
    if (!db.active) db.active = "normal";
    save(db);
    log("regime", "Preloaded default market regime profiles");
  }
}

ensureDefaultRegimes();

// ─── Read/Write ──────────────────────────────────────────────────

/**
 * Get a regime profile by id (with its `changes` map).
 */
export function getRegimeProfile({ id }) {
  if (!id) return { error: "id required" };
  const db = load();
  const regime = db.regimes[id];
  if (!regime) return { error: `Regime "${id}" not found`, available: Object.keys(db.regimes) };
  return { ...regime, is_active: db.active === id };
}

/**
 * List all regime profiles with a summary.
 */
export function listRegimeProfiles() {
  const db = load();
  const regimes = Object.values(db.regimes).map((r) => ({
    id: r.id,
    label: r.label,
    description: r.description,
    active: db.active === r.id,
  }));
  return { active: db.active, count: regimes.length, regimes };
}

/**
 * Set the active regime — called automatically by the screening cycle
 * when classifyRegime() detects a change, or manually for testing/override.
 */
export function setActiveRegime({ id }) {
  if (!id) return { error: "id required" };
  const db = load();
  if (!db.regimes[id]) return { error: `Regime "${id}" not found`, available: Object.keys(db.regimes) };
  db.active = id;
  save(db);
  log("regime", `Active market regime set to: ${db.regimes[id].label}`);
  return { active: id, label: db.regimes[id].label };
}

/**
 * Get the currently active regime — used by the screening cycle to detect
 * a change (compare against classifyRegime()'s freshly detected regime).
 */
export function getActiveRegime() {
  const db = load();
  if (!db.active || !db.regimes[db.active]) return null;
  return db.regimes[db.active];
}
