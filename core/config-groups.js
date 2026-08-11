/**
 * Single source of truth for how user-config.json's flat keys map onto
 * grouped sections on disk — screening / management / strategy / schedule /
 * llm / darwin / hiveMind / api / pnl / opportunity / regime / gmgn / risk /
 * connection, mirroring core/config.js's own section names 1:1.
 *
 * Design: the on-disk field name for every key is UNCHANGED from its
 * historical flat name — grouping only changes *where* the key lives
 * (nested one level under its group), never what it's called. This means
 * every existing `u.someKey` read in core/config.js keeps working verbatim
 * once the raw parsed JSON is run through flattenConfig() once at load
 * time — no per-field rewrites needed anywhere that reads config.
 *
 * Keys NOT listed here (chartIndicators, _lastAgentTune, _lastEvolved,
 * _positionsAtEvolution, preset, walletKey, and anything future/unknown)
 * stay exactly where they are — top-level, ungrouped. chartIndicators was
 * already its own nested object before this existed and keeps that shape.
 *
 * flattenConfig(nested) -> flat:  merges every recognized group's children
 *   up to the top level. Idempotent — safe to call on an already-flat (or
 *   partially-flat) object, so it tolerates a VPS/Supabase copy that hasn't
 *   been migrated yet.
 * groupConfig(flat) -> nested:  the inverse, using this same table.
 *
 * Used by: core/config.js (load + reloadScreeningThresholds), setup.js,
 * tools/executor.js (applyConfigChanges persistence), state/lessons.js
 * (evolveThresholds persistence), integrations/supabase-config.js (Supabase
 * itself stays FLAT by design — this is only for the local file boundary),
 * scripts/push-config.js, scripts/reconcile-user-config.js.
 */

export const KEY_GROUPS = {
  // ── screening ──
  excludeHighSupplyConcentration: "screening",
  minFeeActiveTvlRatio: "screening",
  minTvl: "screening",
  maxTvl: "screening",
  minVolume: "screening",
  minOrganic: "screening",
  minQuoteOrganic: "screening",
  minHolders: "screening",
  minMcap: "screening",
  maxMcap: "screening",
  minBinStep: "screening",
  maxBinStep: "screening",
  timeframe: "screening",
  category: "screening",
  minTokenFeesSol: "screening",
  useDiscordSignals: "screening",
  discordSignalMode: "screening",
  avoidPvpSymbols: "screening",
  blockPvpSymbols: "screening",
  maxBotHoldersPct: "screening",
  maxTop10Pct: "screening",
  loneCandidateMinDegen: "screening",
  allowedLaunchpads: "screening",
  blockedLaunchpads: "screening",
  minTokenAgeHours: "screening",
  maxTokenAgeHours: "screening",
  hysteresisRejectionCount: "screening",
  hysteresisWindowHours: "screening",
  hysteresisMarginPct: "screening",
  tokenAgeWindowEnabled: "screening",
  tokenEarlyWindowMaxHours: "screening",
  tokenCooldownHours: "screening",
  reconConcurrency: "screening",
  reconDeadlineSec: "screening",
  enrichTimeoutMs: "screening",

  // ── management ──
  minClaimAmount: "management",
  autoSwapAfterClaim: "management",
  autoSwapRetryAttempts: "management",
  autoSwapRetryDelayMs: "management",
  outOfRangeBinsToClose: "management",
  outOfRangeWaitMinutes: "management",
  oorCooldownTriggerCount: "management",
  oorCooldownHours: "management",
  repeatDeployCooldownEnabled: "management",
  repeatDeployCooldownTriggerCount: "management",
  repeatDeployCooldownHours: "management",
  repeatDeployCooldownScope: "management",
  repeatDeployCooldownMinFeeEarnedPct: "management",
  repeatDeployCooldownMinFeeYieldPct: "management", // legacy alt name, same guard
  minVolumeToRebalance: "management",
  stopLossPct: "management",
  emergencyPriceDropPct: "management", // legacy alt name for stopLossPct
  takeProfitPct: "management",
  takeProfitFeePct: "management", // legacy alt name for takeProfitPct
  minFeePerTvl24h: "management",
  minAgeBeforeYieldCheck: "management",
  maxTvlSnapshotAgeHours: "management",
  maxTvlDeclinePctForDeploy: "management",
  fastExitOnOorEnabled: "management",
  fastExitStopLossFraction: "management",
  avoidPinThresholdPct: "management",
  avoidPinMinDeploys: "management",
  repeatDeploySizeTaperEnabled: "management",
  repeatDeploySizeTaperPct: "management",
  repeatDeployStopLossFraction: "management",
  minSolToOpen: "management",
  deployAmountSol: "management",
  gasReserve: "management",
  positionSizePct: "management",
  trailingTakeProfit: "management",
  trailingTriggerPct: "management",
  trailingDropPct: "management",
  pnlSanityMaxDiffPct: "management",
  solMode: "management",
  insuranceEnabled: "management",
  insurancePct: "management",
  insuranceTriggerFraction: "management",
  insuranceMaxPoolPct: "management",

  // ── strategy ──
  strategy: "strategy",
  minBinsBelow: "strategy",
  maxBinsBelow: "strategy",
  defaultBinsBelow: "strategy",
  binsBelow: "strategy", // legacy, superseded by min/max/defaultBinsBelow

  // ── schedule ──
  managementIntervalMin: "schedule",
  screeningIntervalMin: "schedule",
  healthCheckIntervalMin: "schedule",

  // ── llm ──
  temperature: "llm",
  maxTokens: "llm",
  maxSteps: "llm",
  managementModel: "llm",
  screeningModel: "llm",
  generalModel: "llm",
  llmModel: "llm",
  llmBaseUrl: "llm",
  llmApiKey: "llm",

  // ── darwin ──
  darwinEnabled: "darwin",
  darwinWindowDays: "darwin",
  darwinRecalcEvery: "darwin",
  darwinBoost: "darwin",
  darwinDecay: "darwin",
  darwinFloor: "darwin",
  darwinCeiling: "darwin",
  darwinMinSamples: "darwin",

  // ── hiveMind ──
  hiveMindUrl: "hiveMind",
  hiveMindApiKey: "hiveMind",
  agentId: "hiveMind",
  hiveMindPullMode: "hiveMind",

  // ── api ──
  agentMeridianApiUrl: "api",
  publicApiKey: "api",
  lpAgentRelayEnabled: "api",

  // ── pnl ──
  pnlRpcUrl: "pnl",
  pnlSource: "pnl",
  pnlPollIntervalSec: "pnl",
  pnlDepositCacheTtlSec: "pnl",
  pnlConfirmTicks: "pnl",

  // ── opportunity ──
  opportunityPollEnabled: "opportunity",
  opportunityPollIntervalSec: "opportunity",
  opportunityPollLimit: "opportunity",
  opportunityMinScore: "opportunity",
  opportunitySmartWalletBonus: "opportunity",
  degenTargetVolRatio: "opportunity",
  degenTargetLpCount: "opportunity",
  degenTargetFeeRatio: "opportunity",
  degenTargetLiquidity: "opportunity",

  // ── regime ──
  regimeDetectionEnabled: "regime",
  regimeSlowCutoff: "regime",
  regimeHotCutoff: "regime",
  regimeRelaxAfterFails: "regime",
  regimeSuppressMinutes: "regime",

  // ── gmgn ──
  gmgnApiKey: "gmgn",
  gmgnBaseUrl: "gmgn",
  gmgnRequestDelayMs: "gmgn",
  gmgnMaxRetries: "gmgn",
  gmgnFeeSource: "gmgn",

  // ── risk ──
  maxPositions: "risk",
  maxDeployAmount: "risk",

  // ── connection / runtime (infra, not a "behavior") ──
  rpcUrl: "connection",
  walletKey: "connection",
  dryRun: "connection",
  telegramChatId: "connection",
  telegramTopicId: "connection",
};

const GROUP_NAMES = new Set(Object.values(KEY_GROUPS));

/**
 * Nested (or partially-nested, or flat) -> fully flat. Merges every
 * recognized group object's children up to the top level; anything not a
 * recognized group name (chartIndicators, _lastAgentTune, preset, unknown
 * future keys, or a key that's already flat) passes through untouched.
 * Idempotent.
 */
export function flattenConfig(raw) {
  if (!raw || typeof raw !== "object") return raw ?? {};
  const flat = {};
  for (const [key, value] of Object.entries(raw)) {
    if (GROUP_NAMES.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
      for (const [innerKey, innerVal] of Object.entries(value)) {
        flat[innerKey] = innerVal;
      }
    } else {
      flat[key] = value;
    }
  }
  return flat;
}

/**
 * Flat -> nested. Every key in KEY_GROUPS is written under its group;
 * anything else stays top-level. Groups are emitted in a stable order for
 * readable diffs; empty groups are omitted.
 */
export function groupConfig(flat) {
  if (!flat || typeof flat !== "object") return flat ?? {};
  const groups = {};
  const top = {};
  for (const [key, value] of Object.entries(flat)) {
    const group = KEY_GROUPS[key];
    if (group) {
      groups[group] ??= {};
      groups[group][key] = value;
    } else {
      top[key] = value;
    }
  }
  const orderedGroupNames = [
    "screening", "management", "strategy", "schedule", "llm", "darwin",
    "hiveMind", "api", "pnl", "opportunity", "regime", "gmgn", "risk", "connection",
  ];
  const result = { ...top };
  for (const name of orderedGroupNames) {
    if (groups[name]) result[name] = groups[name];
  }
  // Any group name not in the explicit order (shouldn't happen, but don't drop data)
  for (const [name, obj] of Object.entries(groups)) {
    if (!(name in result)) result[name] = obj;
  }
  return result;
}
