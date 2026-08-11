import { discoverPools, getPoolDetail, getTopCandidates } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  searchPools,
} from "./dlmm.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../state/lessons.js";
import { setPositionInstruction, setPositionInsuranceSettled, getTrackedPosition } from "../state/state.js";

import { getPoolMemory, addPoolNote } from "../state/pool-memory.js";
import { checkTvlDecline, recordTvlSnapshot } from "../guards/04-tvl-decline.js";
import { computeDeployTaper } from "../guards/05-repeat-deploy-taper.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../state/strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../state/token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../state/dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../state/smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, reloadScreeningThresholds, MIN_SAFE_BINS_BELOW, round2 } from "../core/config.js";
import { flattenConfig, groupConfig } from "../core/config-groups.js";
import { getRecentDecisions } from "../state/decision-log.js";
import { recordDeploy, recordClose } from "../state/position-log.js";
import fs from "fs";
import { execSync, spawn } from "child_process";
import { REPO_ROOT, repoPath } from "../repo-root.js";
import { normalizeTimeframe, scaleScreeningToTimeframe } from "../core/screening-scales.js";

const USER_CONFIG_PATH = repoPath("user-config.json");
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap, notifyConfigChange, notifyInsuranceSettled } from "../integrations/telegram.js";

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function poolDetailTvl(pool) {
  return numberOrNull(pool?.tvl ?? pool?.active_tvl ?? pool?.liquidity);
}

function poolDetailBinStep(pool) {
  return numberOrNull(pool?.dlmm_params?.bin_step ?? pool?.pool_config?.bin_step);
}

function poolDetailFeeActiveTvlRatio(pool) {
  return numberOrNull(pool?.fee_active_tvl_ratio);
}

function poolDetailVolatility(pool) {
  return numberOrNull(pool?.volatility);
}

async function fetchFreshPoolDetail(poolAddress, timeframe = config.screening.timeframe || "5m") {
  const encodedTimeframe = encodeURIComponent(timeframe);
  const filter = encodeURIComponent(`pool_address=${poolAddress}`);
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=${encodedTimeframe}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data?.data || [])[0] ?? null;
}

async function validateDeployPoolThresholds(args) {
  let detail;
  try {
    detail = await fetchFreshPoolDetail(args.pool_address);
    if (!detail) throw new Error(`Pool ${args.pool_address} not found`);
  } catch (error) {
    return {
      pass: false,
      reason: `Could not verify pool screening thresholds before deploy: ${error.message}`,
    };
  }

  const tvl = poolDetailTvl(detail);
  const minTvl = numberOrNull(config.screening.minTvl);
  const maxTvl = numberOrNull(config.screening.maxTvl);
  if (tvl == null) {
    return {
      pass: false,
      reason: "Could not verify pool TVL before deploy.",
    };
  }
  if (minTvl != null && minTvl > 0 && tvl < minTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is below configured minTvl $${minTvl}.`,
    };
  }
  if (maxTvl != null && maxTvl > 0 && tvl > maxTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is above configured maxTvl $${maxTvl}.`,
    };
  }

  // Guard #4 (see guards/04-tvl-decline.js): reject a pool whose TVL is
  // actively collapsing right now, even if the absolute value still clears
  // minTvl. Fails open if there's no recent-enough observation to compare
  // against.
  const tvlDeclineCheck = checkTvlDecline(args.pool_address, tvl, config.management);
  if (tvlDeclineCheck.blocked) {
    return { pass: false, reason: tvlDeclineCheck.reason };
  }
  recordTvlSnapshot(args.pool_address, tvl);

  const feeActiveTvlRatio = poolDetailFeeActiveTvlRatio(detail);
  const minFeeActiveTvlRatio = numberOrNull(config.screening.minFeeActiveTvlRatio);
  if (
    minFeeActiveTvlRatio != null &&
    minFeeActiveTvlRatio > 0 &&
    (feeActiveTvlRatio == null || feeActiveTvlRatio < minFeeActiveTvlRatio)
  ) {
    return {
      pass: false,
      reason: `Pool fee/active-TVL ${feeActiveTvlRatio ?? "unknown"}% is below configured minFeeActiveTvlRatio ${minFeeActiveTvlRatio}%.`,
    };
  }

  const volatilityTimeframe = getVolatilityTimeframe(config.screening.timeframe || "5m");
  let volatilityDetail = detail;
  if ((config.screening.timeframe || "5m") !== volatilityTimeframe) {
    try {
      volatilityDetail = await fetchFreshPoolDetail(args.pool_address, volatilityTimeframe);
    } catch (error) {
      return {
        pass: false,
        reason: `Could not verify pool ${volatilityTimeframe} volatility before deploy: ${error.message}`,
      };
    }
  }

  const volatility = poolDetailVolatility(volatilityDetail);
  if (volatility == null || volatility <= 0) {
    return {
      pass: false,
      reason: `Pool ${volatilityTimeframe} volatility ${volatility ?? "unknown"} is unusable. Refusing deploy.`,
    };
  }

  const actualBinStep = poolDetailBinStep(detail);
  const minStep = numberOrNull(config.screening.minBinStep);
  const maxStep = numberOrNull(config.screening.maxBinStep);
  if (actualBinStep != null && minStep != null && actualBinStep < minStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is below configured minBinStep ${minStep}.`,
    };
  }
  if (actualBinStep != null && maxStep != null && actualBinStep > maxStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is above configured maxBinStep ${maxStep}.`,
    };
  }

  const baseMint = detail?.token_x?.address || detail?.base_token_address || null;
  const entryMarketData = {
    entry_mcap: numberOrNull(detail?.token_x?.market_cap ?? detail?.base_token_market_cap),
    entry_tvl: tvl,
    entry_volume: numberOrNull(detail?.volume),
    entry_holders: numberOrNull(detail?.base_token_holders ?? detail?.token_x?.holders),
    base_mint: baseMint,
    launchpad: detail?.token_x?.launchpad || detail?.token_x?.launchpad_platform || detail?.base_token_launchpad || detail?.launchpad || null,
    token_age_hours: detail?.token_x?.created_at
      ? Math.floor((Date.now() - detail.token_x.created_at) / 3_600_000)
      : null,
    // Pool's own age, not the token's mint date — for a pump.fun graduation
    // the pool can be created weeks after the token itself (see guard #1/#5).
    pool_age_hours: (detail?.pool_created_at ?? detail?.token_x?.created_at)
      ? (Date.now() - (detail.pool_created_at ?? detail.token_x.created_at)) / 3_600_000
      : null,
  };

  // Audit + smart-wallet snapshot — best-effort, never blocks the deploy.
  try {
    if (baseMint) {
      const tokenInfo = await getTokenInfo({ query: baseMint });
      const audit = tokenInfo?.results?.[0]?.audit;
      if (audit) {
        entryMarketData.top10_pct = numberOrNull(audit.top_holders_pct);
        entryMarketData.bot_holders_pct = numberOrNull(audit.bot_holders_pct);
      }
    }
    const smartWallets = await checkSmartWalletsOnPool({ pool_address: args.pool_address });
    entryMarketData.smart_wallets_count = Array.isArray(smartWallets?.in_pool) ? smartWallets.in_pool.length : null;
  } catch (error) {
    log("deploy_audit_warn", `Could not fetch entry audit snapshot: ${error.message}`);
  }

  return { pass: true, entryMarketData };
}

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

function coerceBoolean(value, key) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new Error(`${key} must be true or false`);
}

function coerceFiniteNumber(value, key) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a finite number`);
  return n;
}

function coerceString(value, key) {
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value.trim();
}

function coerceStringArray(value, key) {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`);
  return value.map((entry) => coerceString(entry, key)).filter(Boolean);
}

function normalizeConfigValue(key, value) {
  const booleanKeys = new Set([
    "excludeHighSupplyConcentration",
    "useDiscordSignals",
    "avoidPvpSymbols",
    "blockPvpSymbols",
    "autoSwapAfterClaim",
    "trailingTakeProfit",
    "solMode",
    "darwinEnabled",
    "lpAgentRelayEnabled",
  ]);
  const arrayKeys = new Set(["allowedLaunchpads", "blockedLaunchpads"]);
  const stringKeys = new Set([
    "timeframe",
    "category",
    "discordSignalMode",
    "strategy",
    "managementModel",
    "screeningModel",
    "generalModel",
    "hiveMindUrl",
    "hiveMindApiKey",
    "agentId",
    "hiveMindPullMode",
    "publicApiKey",
    "agentMeridianApiUrl",
    "pnlSource",
    "pnlRpcUrl",
    "gmgnFeeSource",
    "gmgnApiKey",
  ]);
  if (value === null) return null;
  if (booleanKeys.has(key)) return coerceBoolean(value, key);
  if (arrayKeys.has(key)) return coerceStringArray(value, key);
  if (stringKeys.has(key)) return coerceString(value, key);
  return coerceFiniteNumber(value, key);
}

// Flat key → config section mapping (covers everything in config.js).
// Shared by update_config (LLM/CLI-driven) and applyConfigChanges' other
// internal callers (e.g. market-regime auto-switching) — hoisted to module
// level so it's built once, not per call.
export const CONFIG_MAP = {
  // screening
  minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
  excludeHighSupplyConcentration: ["screening", "excludeHighSupplyConcentration"],
  minTvl: ["screening", "minTvl"],
  maxTvl: ["screening", "maxTvl"],
  minVolume: ["screening", "minVolume"],
  minOrganic: ["screening", "minOrganic"],
  minQuoteOrganic: ["screening", "minQuoteOrganic"],
  minHolders: ["screening", "minHolders"],
  minMcap: ["screening", "minMcap"],
  maxMcap: ["screening", "maxMcap"],
  minBinStep: ["screening", "minBinStep"],
  maxBinStep: ["screening", "maxBinStep"],
  timeframe: ["screening", "timeframe"],
  category: ["screening", "category"],
  minTokenFeesSol: ["screening", "minTokenFeesSol"],
  useDiscordSignals: ["screening", "useDiscordSignals"],
  discordSignalMode: ["screening", "discordSignalMode"],
  avoidPvpSymbols: ["screening", "avoidPvpSymbols"],
  blockPvpSymbols: ["screening", "blockPvpSymbols"],
  maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
  maxTop10Pct: ["screening", "maxTop10Pct"],
  allowedLaunchpads: ["screening", "allowedLaunchpads"],
  blockedLaunchpads: ["screening", "blockedLaunchpads"],
  minTokenAgeHours: ["screening", "minTokenAgeHours"],
  maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
  minFeePerTvl24h: ["management", "minFeePerTvl24h"],
  loneCandidateMinDegen: ["screening", "loneCandidateMinDegen"],
  // guard #3 — rejection hysteresis
  hysteresisRejectionCount: ["screening", "hysteresisRejectionCount"],
  hysteresisWindowHours: ["screening", "hysteresisWindowHours"],
  hysteresisMarginPct: ["screening", "hysteresisMarginPct"],
  // guard #1 — token-age deploy window
  tokenAgeWindowEnabled: ["screening", "tokenAgeWindowEnabled"],
  tokenEarlyWindowMaxHours: ["screening", "tokenEarlyWindowMaxHours"],
  tokenCooldownHours: ["screening", "tokenCooldownHours"],
  // candidate recon — concurrency + deadline for the screening enrichment phase
  reconConcurrency: ["screening", "reconConcurrency"],
  reconDeadlineSec: ["screening", "reconDeadlineSec"],
  enrichTimeoutMs: ["screening", "enrichTimeoutMs"],
  // management
  minClaimAmount: ["management", "minClaimAmount"],
  autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
  autoSwapRetryAttempts: ["management", "autoSwapRetryAttempts"],
  autoSwapRetryDelayMs: ["management", "autoSwapRetryDelayMs"],
  outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
  outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
  oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
  oorCooldownHours: ["management", "oorCooldownHours"],
  repeatDeployCooldownEnabled: ["management", "repeatDeployCooldownEnabled"],
  repeatDeployCooldownTriggerCount: ["management", "repeatDeployCooldownTriggerCount"],
  repeatDeployCooldownHours: ["management", "repeatDeployCooldownHours"],
  repeatDeployCooldownScope: ["management", "repeatDeployCooldownScope"],
  repeatDeployCooldownMinFeeEarnedPct: ["management", "repeatDeployCooldownMinFeeEarnedPct"],
  minVolumeToRebalance: ["management", "minVolumeToRebalance"],
  stopLossPct: ["management", "stopLossPct"],
  takeProfitPct: ["management", "takeProfitPct"],
  takeProfitFeePct: ["management", "takeProfitPct"],
  trailingTakeProfit: ["management", "trailingTakeProfit"],
  trailingTriggerPct: ["management", "trailingTriggerPct"],
  trailingDropPct: ["management", "trailingDropPct"],
  pnlSanityMaxDiffPct: ["management", "pnlSanityMaxDiffPct"],
  // guard #4 — pre-deploy TVL/mcap decline check
  maxTvlSnapshotAgeHours: ["management", "maxTvlSnapshotAgeHours"],
  maxTvlDeclinePctForDeploy: ["management", "maxTvlDeclinePctForDeploy"],
  // guard #6 — fast OOR + negative-PnL exit
  fastExitOnOorEnabled: ["management", "fastExitOnOorEnabled"],
  fastExitStopLossFraction: ["management", "fastExitStopLossFraction"],
  // guard #7 — AVOID-tagged pinned lessons
  avoidPinThresholdPct: ["management", "avoidPinThresholdPct"],
  avoidPinMinDeploys: ["management", "avoidPinMinDeploys"],
  // guard #5 — repeat-deploy size taper + tightened stop-loss
  repeatDeploySizeTaperEnabled: ["management", "repeatDeploySizeTaperEnabled"],
  repeatDeploySizeTaperPct: ["management", "repeatDeploySizeTaperPct"],
  repeatDeployStopLossFraction: ["management", "repeatDeployStopLossFraction"],
  // market regime detection (decision-tree config auto-fork)
  regimeDetectionEnabled: ["regime", "enabled"],
  regimeSlowCutoff: ["regime", "slowCutoff"],
  regimeHotCutoff: ["regime", "hotCutoff"],
  regimeRelaxAfterFails: ["regime", "relaxAfterFails"],
  regimeSuppressMinutes: ["regime", "suppressMinutes"],
  // pnl poller
  pnlConfirmTicks: ["pnl", "confirmTicks"],
  // opportunity poller (interval/enabled changes apply on next restart)
  opportunityPollEnabled: ["opportunity", "enabled"],
  opportunityPollIntervalSec: ["opportunity", "pollIntervalSec"],
  opportunityPollLimit: ["opportunity", "limit"],
  opportunityMinScore: ["opportunity", "minScore"],
  opportunitySmartWalletBonus: ["opportunity", "smartWalletScoreBonus"],
  degenTargetVolRatio: ["opportunity", "targetVolRatio"],
  degenTargetLpCount: ["opportunity", "targetLpCount"],
  degenTargetFeeRatio: ["opportunity", "targetFeeRatio"],
  degenTargetLiquidity: ["opportunity", "targetLiquidity"],
  solMode: ["management", "solMode"],
  insuranceEnabled: ["management", "insuranceEnabled"],
  insurancePct: ["management", "insurancePct"],
  insuranceTriggerFraction: ["management", "insuranceTriggerFraction"],
  minSolToOpen: ["management", "minSolToOpen"],
  deployAmountSol: ["management", "deployAmountSol"],
  gasReserve: ["management", "gasReserve"],
  positionSizePct: ["management", "positionSizePct"],
  minAgeBeforeYieldCheck: ["management", "minAgeBeforeYieldCheck"],
  // risk
  maxPositions: ["risk", "maxPositions"],
  maxDeployAmount: ["risk", "maxDeployAmount"],
  // schedule
  managementIntervalMin: ["schedule", "managementIntervalMin"],
  screeningIntervalMin: ["schedule", "screeningIntervalMin"],
  healthCheckIntervalMin: ["schedule", "healthCheckIntervalMin"],
  // models
  managementModel: ["llm", "managementModel"],
  screeningModel: ["llm", "screeningModel"],
  generalModel: ["llm", "generalModel"],
  temperature: ["llm", "temperature"],
  maxTokens: ["llm", "maxTokens"],
  maxSteps: ["llm", "maxSteps"],
  // strategy
  strategy: ["strategy", "strategy"],
  binsBelow: ["strategy", "maxBinsBelow", ["maxBinsBelow"]],
  minBinsBelow: ["strategy", "minBinsBelow"],
  maxBinsBelow: ["strategy", "maxBinsBelow"],
  defaultBinsBelow: ["strategy", "defaultBinsBelow"],
  // hivemind
  hiveMindUrl: ["hiveMind", "url"],
  hiveMindApiKey: ["hiveMind", "apiKey"],
  agentId: ["hiveMind", "agentId"],
  hiveMindPullMode: ["hiveMind", "pullMode"],
  // meridian api / relay
  publicApiKey: ["api", "publicApiKey"],
  agentMeridianApiUrl: ["api", "url"],
  lpAgentRelayEnabled: ["api", "lpAgentRelayEnabled"],
  // pnl fetcher / poller
  pnlSource: ["pnl", "source", ["pnlSource"]],
  pnlRpcUrl: ["pnl", "rpcUrl", ["pnlRpcUrl"]],
  pnlPollIntervalSec: ["pnl", "pollIntervalSec", ["pnlPollIntervalSec"]],
  pnlDepositCacheTtlSec: ["pnl", "depositCacheTtlSec", ["pnlDepositCacheTtlSec"]],
  // gmgn fee source
  gmgnFeeSource: ["gmgn", "feeSource", ["gmgnFeeSource"]],
  gmgnApiKey: ["gmgn", "apiKey", ["gmgnApiKey"]],
  // chart indicators
  chartIndicatorsEnabled: ["indicators", "enabled", ["chartIndicators", "enabled"]],
  indicatorEntryPreset: ["indicators", "entryPreset", ["chartIndicators", "entryPreset"]],
  indicatorExitPreset: ["indicators", "exitPreset", ["chartIndicators", "exitPreset"]],
  rsiLength: ["indicators", "rsiLength", ["chartIndicators", "rsiLength"]],
  indicatorIntervals: ["indicators", "intervals", ["chartIndicators", "intervals"]],
  indicatorCandles: ["indicators", "candles", ["chartIndicators", "candles"]],
  rsiOversold: ["indicators", "rsiOversold", ["chartIndicators", "rsiOversold"]],
  rsiOverbought: ["indicators", "rsiOverbought", ["chartIndicators", "rsiOverbought"]],
  requireAllIntervals: ["indicators", "requireAllIntervals", ["chartIndicators", "requireAllIntervals"]],
};

const CONFIG_MAP_LOWER = Object.fromEntries(
  Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
);

/**
 * Apply a set of flat config changes to the live config object and persist
 * them to user-config.json — the shared mutate+persist+notify pipeline used
 * by both the update_config tool (LLM/CLI-driven, one call at a time) and
 * the market-regime auto-switcher (index.js, applies a whole regime profile
 * at once). Extracted verbatim from the former update_config handler body —
 * behavior/return shape is unchanged for existing callers.
 */
export function applyConfigChanges(changes, { reason = "", lessonTags = ["self_tune", "config_change"] } = {}) {
  const applied = {};
  const unknown = [];

  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    return { success: false, error: "changes must be an object", reason };
  }

  const STRATEGY_BIN_KEYS = new Set(["binsBelow", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow"]);
  for (const [key, val] of Object.entries(changes)) {
    const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
    if (!match) { unknown.push(key); continue; }
    try {
      let normalizedVal = val;
      if (STRATEGY_BIN_KEYS.has(match[0])) {
        const numericVal = Number(val);
        if (!Number.isFinite(numericVal)) {
          throw new Error(`${match[0]} must be a finite number`);
        }
        normalizedVal = Math.max(MIN_SAFE_BINS_BELOW, Math.round(numericVal));
      } else {
        normalizedVal = normalizeConfigValue(match[0], val);
      }
      applied[match[0]] = normalizedVal;
    } catch (error) {
      return { success: false, error: error.message, key: match[0], reason };
    }
  }

  if (Object.keys(applied).length === 0) {
    log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
    return { success: false, unknown, reason };
  }

  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try {
      userConfig = flattenConfig(JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")));
    } catch (error) {
      return { success: false, error: `Invalid user-config.json: ${error.message}`, reason };
    }
  }

  // Auto-scale fee/volume when timeframe changes (unless user set them explicitly in same call).
  if (applied.timeframe != null && applied.minFeeActiveTvlRatio == null && applied.minVolume == null) {
    const tf = normalizeTimeframe(applied.timeframe);
    applied.timeframe = tf;
    const scaled = scaleScreeningToTimeframe(tf);
    applied.minFeeActiveTvlRatio = scaled.minFeeActiveTvlRatio;
    applied.minVolume = scaled.minVolume;
    applied._timeframeScaled = true;
    log("config", `timeframe ${tf} → auto-scaled minFeeActiveTvlRatio=${scaled.minFeeActiveTvlRatio}, minVolume=${scaled.minVolume}`);
  }

  // Apply to live config immediately after the persisted config is known-good.
  const configChanges = [];
  for (const [key, val] of Object.entries(applied)) {
    if (key.startsWith("_")) continue;
    const [section, field] = CONFIG_MAP[key];
    const before = config[section][field];
    config[section][field] = val;
    log("config", `update_config: config.${section}.${field} ${before} → ${val} (verify: ${config[section][field]})`);
    if (before !== val) configChanges.push({ key, from: before, to: val });
  }
  if (
    applied.binsBelow != null ||
    applied.minBinsBelow != null ||
    applied.maxBinsBelow != null ||
    applied.defaultBinsBelow != null
  ) {
    config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW)));
    config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(Number(config.strategy.maxBinsBelow ?? config.strategy.minBinsBelow)));
    config.strategy.defaultBinsBelow = Math.max(
      config.strategy.minBinsBelow,
      Math.min(
        config.strategy.maxBinsBelow,
        Math.round(Number(config.strategy.defaultBinsBelow ?? config.strategy.maxBinsBelow)),
      ),
    );
  }

  for (const [key, val] of Object.entries(applied)) {
    if (key.startsWith("_")) continue;
    const persistPath = CONFIG_MAP[key]?.[2];
    if (Array.isArray(persistPath) && persistPath.length > 0) {
      let target = userConfig;
      for (const part of persistPath.slice(0, -1)) {
        if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) {
          target[part] = {};
        }
        target = target[part];
      }
      target[persistPath[persistPath.length - 1]] = val;
    } else {
      userConfig[key] = val;
    }
  }
  userConfig._lastAgentTune = new Date().toISOString();
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(groupConfig(userConfig), null, 2));
  // NOTE: deliberately does NOT push to Supabase. Supabase is the operator's
  // source of truth and is PULL-ONLY for the agent — nothing the agent decides
  // may propagate upstream and overwrite the operator's baseline. Pushing is an
  // explicit operator action (scripts/push-config.js / `node cli.js config push`).
  notifyConfigChange(configChanges, { source: reason || "update_config" }).catch(() => {});

  // Restart cron jobs if intervals changed
  const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null || applied.pnlPollIntervalSec != null;
  if (intervalChanged && _cronRestarter) {
    _cronRestarter();
    log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m, pnlPoll: ${config.pnl.pollIntervalSec}s`);
  }

  // Skip repeated volatility-driven interval changes; they are operational tuning, not reusable lessons.
  const lessonsKeys = Object.keys(applied).filter(
    k => !k.startsWith("_") && k !== "managementIntervalMin" && k !== "screeningIntervalMin"
  );
  if (lessonsKeys.length > 0) {
    const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
    addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, lessonTags);
  }

  log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
  return { success: true, applied, unknown, reason };
}

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        if (!process.env.pm_id) {
          const child = spawn(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: "inherit",
            cwd: REPO_ROOT,
          });
          child.unref();
        }
        process.exit(0);
      }, 3000);
      const restartMode = process.env.pm_id
        ? "PM2 detected — exiting in 3s so PM2 can restart the managed process."
        : "Restarting in 3s...";
      return { success: true, updated: true, message: `Updated! ${restartMode}\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  get_recent_decisions: ({ limit } = {}) => ({ decisions: getRecentDecisions(limit || 6) }),
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => applyConfigChanges(changes, { reason }),
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Self-funded insurance pool — a small % of every deploy (management.
 * insurancePct) is skimmed to CASH at deploy time (see tools/dlmm.js's
 * deployPosition()) and held aside in the same wallet. It's POOLED, not
 * per-position: one position's own skim is far too small (~$0.17 on a
 * typical deploy) to matter against a real ~$7-20 loss on its own — the
 * mechanism only works because most positions never draw on it, so it
 * accumulates across many deploys (~47 wins per big loss, historically)
 * before a severe loss draws on the aggregate.
 *
 * Sizing/derivation: see the plan that introduced this (win/loss
 * occurrence data from lessons.json — 47.3 wins per big loss, six sizing
 * methods landing 0.25%-0.6%, rounded up to 1% for swap-fee headroom).
 */

/** Live CASH balance in the wallet — the pool IS this balance, no separate running counter to keep in sync. */
async function getInsurancePoolBalance() {
  const { tokens } = await getWalletBalances();
  const cashEntry = (tokens || []).find((t) => t.mint === config.tokens.CASH);
  return Number(cashEntry?.usd ?? cashEntry?.balance) || 0;
}

/**
 * How much (if anything) to draw from the pooled insurance balance at
 * close, given this position's outcome. Only a severe loss (pnl_pct at or
 * below stopLossPct * triggerFraction) draws anything — draws enough to
 * bring this position back to breakeven, capped at whatever the pool
 * actually holds (cold-start: right after enabling this feature, before
 * ~47 wins have accumulated, a severe loss may only be partially covered).
 * Exported for unit testing — pure, no I/O.
 */
export function computeInsuranceWithdraw({ poolUsd, pnlUsd, pnlPct, stopLossPct, triggerFraction }) {
  if (!poolUsd || poolUsd <= 0) return 0; // zero-insurance guard — nothing accumulated yet
  if (pnlUsd == null || pnlPct == null) return 0; // can't evaluate without a real PnL result

  const triggerPct = Number(stopLossPct) * Number(triggerFraction ?? 0.5);
  if (pnlPct <= triggerPct) {
    return Math.min(poolUsd, Math.abs(pnlUsd));
  }
  return 0; // any non-severe outcome (win, mild loss) — let the pool keep accumulating
}

/**
 * Swap a base token back to SOL with retry. Jupiter can transiently fail (no route,
 * quote error) and a single attempt silently leaves the token unsold — this retries
 * with a delay, re-fetching the balance each attempt (amounts can shift on partial
 * fills). Treats both a throw AND result.success===false / missing tx as failure.
 * Returns { swapped, result, token } — swapped=false if nothing to do or all attempts failed.
 */
async function swapBaseToSolWithRetry(baseMint, label) {
  const attempts = Math.max(1, Number(config.management.autoSwapRetryAttempts ?? 3));
  const delayMs = Math.max(0, Number(config.management.autoSwapRetryDelayMs ?? 3000));
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const balances = await getWalletBalances({});
      const token = balances.tokens?.find((t) => t.mint === baseMint);
      if (!token || token.usd < 0.10) {
        // Nothing left to swap (already sold or dust) — treat as done.
        return { swapped: attempt > 1, result: null, token: null };
      }
      log("executor", `Auto-swapping ${label} ${token.symbol || baseMint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL (attempt ${attempt}/${attempts})`);
      const swapResult = await swapToken({ input_mint: baseMint, output_mint: "SOL", amount: token.balance });
      const ok = swapResult && swapResult.success !== false && !swapResult.error && (swapResult.tx || swapResult.amount_out);
      if (ok) return { swapped: true, result: swapResult, token };
      lastErr = swapResult?.error || swapResult?.reason || "swap returned no tx";
    } catch (e) {
      lastErr = e.message;
    }
    log("executor_warn", `Auto-swap ${label} attempt ${attempt}/${attempts} failed: ${lastErr}`);
    if (attempt < attempts) await sleep(delayMs);
  }
  log("executor_warn", `Auto-swap ${label} failed after ${attempts} attempts — base token left unsold (${baseMint.slice(0, 8)})`);
  return { swapped: false, result: null, token: null };
}

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  if (PROTECTED_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      if (name === "swap_token" && result.tx) {
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        notifyDeploy({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, position: result.position, tx: result.txs?.[0] ?? result.tx, priceRange: result.price_range, rangeCoverage: result.range_coverage, binStep: result.bin_step, baseFee: result.base_fee }).catch(() => {});
        recordDeploy({
          position_id: result.position,
          pool_address: result.pool ?? args.pool_address ?? null,
          pool_name: result.pool_name ?? args.pool_name ?? null,
          base_mint: args.base_mint ?? null,
          strategy: result.strategy ?? args.strategy ?? null,
          bin_step: result.bin_step ?? null,
          base_fee: result.base_fee ?? null,
          lower_bin: result.bin_range?.min ?? null,
          upper_bin: result.bin_range?.max ?? null,
          active_bin: result.bin_range?.active ?? null,
          lower_price: result.price_range?.min ?? null,
          upper_price: result.price_range?.max ?? null,
          price: result.range_coverage?.active_price ?? null,
          mcap: args.entry_mcap ?? null,
          tvl: args.entry_tvl ?? null,
          volume: args.entry_volume ?? null,
          holders: args.entry_holders ?? null,
          top10_pct: args.top10_pct ?? null,
          bot_holders_pct: args.bot_holders_pct ?? null,
          smart_wallets_count: args.smart_wallets_count ?? null,
          launchpad: args.launchpad ?? null,
          token_age_hours: args.token_age_hours ?? null,
          volatility: args.volatility ?? null,
          fee_tvl_ratio: args.fee_tvl_ratio ?? null,
          organic_score: args.organic_score ?? null,
          amount_sol: args.amount_y ?? args.amount_sol ?? null,
          amount_x: result.amount_x ?? args.amount_x ?? null,
          amount_y: result.amount_y ?? args.amount_y ?? null,
          initial_value_usd: args.initial_value_usd ?? null,
          downside_coverage_pct: result.range_coverage?.downside_pct ?? null,
          upside_coverage_pct: result.range_coverage?.upside_pct ?? null,
          total_width_pct: result.range_coverage?.width_pct ?? null,
          total_bins: (result.bin_range?.min != null && result.bin_range?.max != null) ? (result.bin_range.max - result.bin_range.min + 1) : null,
          wide_range: result.wide_range ?? null,
          tx_signatures: JSON.stringify(result.txs || []),
        }).catch(() => {});
      } else if (name === "close_position") {
        // Deterministically computed by JS (state.js's updatePnlAndCheckExits /
        // getDeterministicCloseRule, or a trailing-TP note) before the LLM is
        // ever invoked — no LLM call involved in producing this text.
        const closeReason = result.close_reason ?? args.reason ?? null;
        notifyClose({ pair: result.pool_name || args.position_address?.slice(0, 8), pnlUsd: result.pnl_usd ?? 0, pnlPct: result.pnl_pct ?? 0, solReturned: result.sol_returned, reason: closeReason }).catch(() => {});
        recordClose({
          position_id: args.position_address,
          pool_address: result.pool ?? null,
          pool_name: result.pool_name ?? null,
          base_mint: result.base_mint ?? null,
          strategy: result.strategy ?? null,
          bin_step: result.bin_step ?? null,
          lower_bin: result.bin_range?.min ?? null,
          upper_bin: result.bin_range?.max ?? null,
          mcap: result.exit_mcap ?? null,
          tvl: result.exit_tvl ?? null,
          volume: result.exit_volume ?? null,
          top10_pct: result.top10_pct ?? null,
          bot_holders_pct: result.bot_holders_pct ?? null,
          smart_wallets_count: result.smart_wallets_count ?? null,
          launchpad: result.launchpad ?? null,
          token_age_hours: result.token_age_hours ?? null,
          volatility: result.volatility ?? null,
          fee_tvl_ratio: result.fee_tvl_ratio ?? null,
          organic_score: result.organic_score ?? null,
          tx_signatures: JSON.stringify([...(result.claim_txs || []), ...(result.close_txs || [])]),
          pnl_usd: result.pnl_usd ?? null,
          pnl_pct: result.pnl_pct ?? null,
          pnl_true_usd: result.pnl_true_usd ?? null,
          fees_earned_usd: result.fees_earned_usd ?? null,
          fees_earned_sol: result.fees_earned_sol ?? null,
          sol_returned: result.sol_returned ?? null,
          final_value_usd: result.final_value_usd ?? null,
          initial_value_usd: result.initial_value_usd ?? null,
          minutes_held: result.minutes_held ?? null,
          minutes_out_of_range: result.minutes_out_of_range ?? null,
          minutes_in_range: result.minutes_in_range ?? null,
          range_efficiency: (result.minutes_held > 0 && result.minutes_in_range != null)
            ? parseFloat(((result.minutes_in_range / result.minutes_held) * 100).toFixed(1))
            : null,
          close_reason: closeReason,
        }).catch(() => {});
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
        }
        // Auto-swap base token back to SOL unless user said to hold (retried).
        if (!args.skip_swap && result.base_mint) {
          const { swapped, result: swapResult } = await swapBaseToSolWithRetry(result.base_mint, "after close");
          if (swapped) {
            // Tell the model the swap already happened so it doesn't call swap_token again
            result.auto_swapped = true;
            result.auto_swap_note = `Base token already auto-swapped back to SOL (${result.base_mint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
            if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;
          }
        }
        // Insurance pool settlement — independent of the base-token swap
        // above (insurance is already CASH, not the base token). Never
        // touches result.pnl_usd/pnl_pct — those stay the true trading
        // outcome for Darwin weighting / lesson analysis.
        if (config.management.insuranceEnabled) {
          const tracked = getTrackedPosition(args.position_address);
          const poolUsd = await getInsurancePoolBalance();
          const withdrawUsd = computeInsuranceWithdraw({
            poolUsd,
            pnlUsd: result.pnl_usd,
            pnlPct: result.pnl_pct,
            stopLossPct: config.management.stopLossPct,
            triggerFraction: config.management.insuranceTriggerFraction,
          });
          if (withdrawUsd > 0) {
            const insuranceSwap = await swapToken({
              input_mint: config.tokens.CASH,
              output_mint: config.tokens.SOL,
              amount: withdrawUsd,
            });
            if (insuranceSwap?.success) {
              setPositionInsuranceSettled(args.position_address, withdrawUsd);
              notifyInsuranceSettled({
                pair: result.pool_name,
                withdrawnUsd: withdrawUsd,
                poolRemainingUsd: Math.max(0, poolUsd - withdrawUsd),
                solReceived: insuranceSwap.amount_out,
              }).catch(() => {});
            } else {
              log("insurance_warn", `Insurance settle swap failed for ${args.position_address}: ${insuranceSwap?.error || "unknown error"}`);
            }
          } else if (tracked?.insurance_usdc_amount > 0) {
            setPositionInsuranceSettled(args.position_address, 0);
          }
        }
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        await swapBaseToSolWithRetry(result.base_mint, "after claim");
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      const poolThresholds = await validateDeployPoolThresholds(args);
      if (!poolThresholds.pass) return poolThresholds;
      if (poolThresholds.entryMarketData) Object.assign(args, poolThresholds.entryMarketData);

      // Reject pools with bin_step out of configured range
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      const deployAmountY = Number(args.amount_y ?? args.amount_sol ?? 0);
      const deployAmountX = Number(args.amount_x ?? 0);
      if (Number.isFinite(deployAmountX) && deployAmountX > 0) {
        return {
          pass: false,
          reason: "This agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.",
        };
      }
      const requestedBinsBelow = Number(args.bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow);
      const requestedBinsAbove = Number(args.bins_above ?? 0);
      const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
      const isSingleSidedSol = deployAmountY > 0 && deployAmountX <= 0;
      const requestedTotalBins = requestedBinsBelow + requestedBinsAbove;
      const requestedVolatility = args.volatility == null ? null : Number(args.volatility);
      if (args.volatility != null && (!Number.isFinite(requestedVolatility) || requestedVolatility <= 0)) {
        return {
          pass: false,
          reason: `volatility ${args.volatility} is invalid. Refusing deploy because the volatility feed is unusable.`,
        };
      }
      if (
        args.downside_pct == null &&
        args.upside_pct == null &&
        (
          !Number.isFinite(requestedBinsBelow) ||
          !Number.isFinite(requestedBinsAbove) ||
          !Number.isInteger(requestedBinsBelow) ||
          !Number.isInteger(requestedBinsAbove) ||
          requestedBinsBelow < 0 ||
          requestedBinsAbove < 0 ||
          requestedTotalBins < minBinsBelow
        )
      ) {
        return {
          pass: false,
          reason: `deploy range ${requestedTotalBins} total bins is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.downside_pct == null &&
        (!Number.isFinite(requestedBinsBelow) || !Number.isInteger(requestedBinsBelow) || requestedBinsBelow < minBinsBelow)
      ) {
        return {
          pass: false,
          reason: `bins_below ${args.bins_below ?? "missing"} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.upside_pct == null &&
        (!Number.isFinite(requestedBinsAbove) || !Number.isInteger(requestedBinsAbove) || requestedBinsAbove !== 0)
      ) {
        return {
          pass: false,
          reason: "Single-side SOL deploy must use bins_above=0.",
        };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools
      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Guard #5 (see guards/05-repeat-deploy-taper.js): taper size + tighten
      // stop-loss on a 2nd+ deploy into a pool still inside its
      // early-momentum window — the exact scenario where guards 1/2/3
      // can't help yet (no repeat-deploy history, no prior close, still
      // within the allowed age window).
      const taperResult = computeDeployTaper(args.pool_address, deployAmountY, args.pool_age_hours, config);
      let amountY = taperResult.amountY;
      const taperSizeCap = taperResult.taperSizeCap;
      if (taperResult.tapered) {
        args.amount_y = taperResult.amountY;
        args.stop_loss_pct_override = taperResult.stopLossOverride;
      }

      // Check amount limits
      if (!Number.isFinite(amountY) || amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      // A guard #5 taper intentionally goes below the normal floor — use its
      // own (still >= 0.1 SOL) cap as the floor instead of the standard one.
      // Both sides rounded to 2dp before comparing: computeDeployAmount()
      // (core/config.js) hands the LLM an already-2dp-rounded number, but
      // config.management.deployAmountSol itself is a raw float (e.g.
      // 0.7 * 0.85 is stored as ~0.59499999999999997) — comparing that
      // directly against the rounded amount the LLM was told to use could
      // reject a technically-correct deploy by less than half a cent.
      const minDeploy = round2(taperSizeCap != null ? taperSizeCap : Math.max(0.1, config.management.deployAmountSol));
      const roundedAmountY = round2(amountY);
      if (roundedAmountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${roundedAmountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
        };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      // Check SOL balance
      if (process.env.DRY_RUN !== "true") {
        const balance = await getWalletBalances();
        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          };
        }
      }

      return { pass: true };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason: "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason: "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
