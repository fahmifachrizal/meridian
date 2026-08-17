import fs from "fs";
import { REPO_ROOT, repoPath } from "../repo-root.js";
import { getScreeningDefaultsForTimeframe, normalizeTimeframe, scaleScreeningToTimeframe, TIMEFRAME_SCREENING_SCALES } from "./screening-scales.js";
import { flattenConfig } from "./config-groups.js";

export { REPO_ROOT, repoPath, getScreeningDefaultsForTimeframe, normalizeTimeframe, scaleScreeningToTimeframe, TIMEFRAME_SCREENING_SCALES };

const USER_CONFIG_PATH = repoPath("user-config.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;

// user-config.json is stored grouped on disk (screening/management/etc,
// see core/config-groups.js) but every read below still uses the historical
// flat key names — flattening once here means nothing past this line needs
// to know the file is grouped.
const u = flattenConfig(
  fs.existsSync(USER_CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
    : {},
);
export const MIN_SAFE_BINS_BELOW = 35;

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const legacyBinsBelow = numericConfig(u.binsBelow);
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 69);
const configuredDefaultBinsBelow = numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.agentMeridianApiUrl) process.env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;
if (u.telegramChatId) process.env.TELEGRAM_CHAT_ID ||= String(u.telegramChatId);

const indicatorUserConfig = u.chartIndicators ?? {};

// Optional standalone GMGN config file (mirrors user-config layering)
const GMGN_CONFIG_PATH = repoPath("gmgn-config.json");
const gmgnUserConfig = fs.existsSync(GMGN_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(GMGN_CONFIG_PATH, "utf8"))
  : {};
if (gmgnUserConfig.apiKey || u.gmgnApiKey) {
  process.env.GMGN_API_KEY ||= gmgnUserConfig.apiKey || u.gmgnApiKey;
}

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    excludeHighSupplyConcentration: u.excludeHighSupplyConcentration ?? true,
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    useDiscordSignals: u.useDiscordSignals ?? false,
    discordSignalMode: u.discordSignalMode ?? "merge", // merge | only
    avoidPvpSymbols:   u.avoidPvpSymbols   ?? true, // avoid exact-symbol rivals with real active pools
    blockPvpSymbols:   u.blockPvpSymbols   ?? false, // hard-filter PVP rivals before the LLM sees them
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    loneCandidateMinDegen: u.loneCandidateMinDegen ?? 50, // degen score that lets a SOLO candidate deploy without a narrative
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
    // Rejection hysteresis (guard #3) — repeated borderline rejections tighten the bar
    hysteresisRejectionCount: u.hysteresisRejectionCount ?? 2,
    hysteresisWindowHours:    u.hysteresisWindowHours    ?? 24,
    hysteresisMarginPct:      u.hysteresisMarginPct      ?? 5,
    // Token-age deploy window (guard #1) — early momentum, then cooldown, then reopen
    tokenAgeWindowEnabled:    u.tokenAgeWindowEnabled    ?? true,
    tokenEarlyWindowMaxHours: u.tokenEarlyWindowMaxHours ?? 6,
    tokenCooldownHours:       u.tokenCooldownHours       ?? 24,
    // Candidate recon (screening cycle) — bounded concurrency + hard deadline.
    // Replaces a sequential loop whose worst case was candidates x timeout.
    reconConcurrency:  u.reconConcurrency  ?? 4,    // candidates enriched in parallel
    reconDeadlineSec:  u.reconDeadlineSec  ?? 60,   // hard cap on the whole recon phase
    enrichTimeoutMs:   u.enrichTimeoutMs   ?? 8000, // per-request cap for advisory enrichment
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    autoSwapRetryAttempts: u.autoSwapRetryAttempts ?? 3,    // retries for base→SOL auto-swap on Jupiter failure
    autoSwapRetryDelayMs:  u.autoSwapRetryDelayMs  ?? 3000, // delay between auto-swap retries
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 2,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -50,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    // Pre-deploy TVL/mcap decline check (guard #4)
    maxTvlSnapshotAgeHours:    u.maxTvlSnapshotAgeHours    ?? 4,
    maxTvlDeclinePctForDeploy: u.maxTvlDeclinePctForDeploy ?? 20,
    // Fast OOR + negative-PnL exit (guard #6)
    fastExitOnOorEnabled:    u.fastExitOnOorEnabled    ?? true,
    fastExitStopLossFraction: u.fastExitStopLossFraction ?? 0.5,
    // AVOID-tagged pinned lessons (guard #7)
    avoidPinThresholdPct: u.avoidPinThresholdPct ?? -10,
    avoidPinMinDeploys:   u.avoidPinMinDeploys   ?? 2,
    // Repeat-deploy size taper + tightened stop-loss (guard #5) — a 2nd+ deploy
    // into the same pool while it's still within the early-momentum window
    // (screening.tokenEarlyWindowMaxHours) is strictly higher variance than the
    // 1st, so it risks less capital and gets cut faster if wrong.
    repeatDeploySizeTaperEnabled: u.repeatDeploySizeTaperEnabled ?? true,
    repeatDeploySizeTaperPct: Array.isArray(u.repeatDeploySizeTaperPct) ? u.repeatDeploySizeTaperPct : [0.6, 0.4],
    repeatDeployStopLossFraction: u.repeatDeployStopLossFraction ?? 0.5,
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
    // Self-funded insurance pool: a small % of every deploy is swapped to
    // tokens.INSURANCE_TOKEN and held aside in the same wallet (never touches deploy sizing —
    // computeDeployAmount() only reads .sol). Pooled, not per-position:
    // most positions never draw on it, so it accumulates across many
    // deploys and only a severe loss (stopLossPct * insuranceTriggerFraction)
    // draws from the aggregate pool. Sized from real win/loss occurrence
    // data (~47 wins per big loss) — see the plan that introduced this.
    insuranceEnabled:          u.insuranceEnabled          ?? false,
    insurancePct:              u.insurancePct              ?? 1,
    insuranceTriggerFraction:  u.insuranceTriggerFraction  ?? 0.5,
    // Deploy-time cap: stop skimming once the pool reaches this % of the
    // estimated total portfolio (wallet SOL + all open positions' SOL-
    // equivalent value) — a backstop shouldn't itself become a large,
    // unbounded slice of the portfolio.
    insuranceMaxPoolPct:       u.insuranceMaxPoolPct       ?? 30,

    // Guard #8 — weekend fresh-token repeat block (see guards/08-weekend-
    // fresh-repeat.js for the data behind this). Caps a base_mint to one
    // deploy per weekend session, but only when that token's FIRST deploy
    // the session was into a pool under weekendGuardMaxFreshAgeHours old —
    // locked in at session-open, not re-checked per repeat, since the
    // catastrophic legs this guards against are often already >6h old by
    // the time they fire. Window default: Sat 18:00 -> Mon 04:00 WIB.
    weekendGuardEnabled:         u.weekendGuardEnabled         ?? true,
    weekendGuardMaxFreshAgeHours: u.weekendGuardMaxFreshAgeHours ?? 6,
    weekendGuardStartDow:        u.weekendGuardStartDow        ?? 6, // Saturday
    weekendGuardStartHour:       u.weekendGuardStartHour       ?? 18,
    weekendGuardEndDow:          u.weekendGuardEndDow          ?? 1, // Monday
    weekendGuardEndHour:         u.weekendGuardEndHour         ?? 4,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     u.strategy     ?? "bid_ask",
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        u.darwinEnabled     ?? true,
    windowDays:     u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwinRecalcEvery ?? 5,    // recalc every N closes
    boostFactor:    u.darwinBoost       ?? 1.05,
    decayFactor:    u.darwinDecay       ?? 0.95,
    weightFloor:    u.darwinFloor       ?? 0.3,
    weightCeiling:  u.darwinCeiling     ?? 2.5,
    minSamples:     u.darwinMinSamples  ?? 10,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    // JitoSOL (Jito Staked SOL) — the token the insurance pool
    // (management.insurance*) is held in. Deliberately SOL-tracking, not
    // USD-stable: the pool earns staking yield and the withdrawal swap
    // back to SOL is near-1:1, at the cost of losing the "holds its USD
    // value during a SOL crash" hedge a stablecoin would have provided —
    // an explicit operator tradeoff (previously CASH, a USD stablecoin;
    // see git history if you need to revert). Verified via Jupiter's asset
    // API before use: isVerified=true, "original-lst"/"verified"/"yield"
    // tags, ~186.9K holders, ~$750M liquidity, freeze authority disabled.
    INSURANCE_TOKEN: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  },

  // ─── HiveMind ─────────────────────────
  hiveMind: {
    url: nonEmptyString(u.hiveMindUrl, DEFAULT_HIVEMIND_URL),
    apiKey: nonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY, DEFAULT_HIVEMIND_API_KEY),
    agentId: u.agentId ?? null,
    pullMode: u.hiveMindPullMode ?? "auto",
  },

  api: {
    url: nonEmptyString(u.agentMeridianApiUrl, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL),
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY),
    lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
  },

  // ─── PnL fetcher / poller (public infra: RPC + Meteora deposits + Jupiter) ──
  pnl: {
    // Live position value comes from on-chain reads on this RPC.
    // Defaults to the public pump.helius endpoint so the aggressive poller
    // never burns the main RPC_URL or the LPAgent sponsor budget.
    rpcUrl: nonEmptyString(u.pnlRpcUrl, process.env.PNL_RPC_URL, "https://pump.helius-rpc.com"),
    source: nonEmptyString(u.pnlSource, "rpc"), // rpc | meteora (fallback-only)
    pollIntervalSec: Number(u.pnlPollIntervalSec ?? 3),
    depositCacheTtlSec: Number(u.pnlDepositCacheTtlSec ?? 300),
    // Consecutive confirming polls required before a peak is raised or an exit fires.
    // At a 3s poll cadence, 2 ticks ≈ 3-6s — filters single-tick noise without the
    // old fixed 15s setTimeout recheck.
    confirmTicks: Number(u.pnlConfirmTicks ?? 2),
  },

  // ─── Opportunity poller (catches strong pools between screening cycles) ──
  opportunity: {
    enabled: u.opportunityPollEnabled ?? true,
    pollIntervalSec: Number(u.opportunityPollIntervalSec ?? 45),
    limit: Number(u.opportunityPollLimit ?? 10),
    // Pre-gate: only trigger the full deploy decision when the best candidate's
    // Degen Score (0..100) clears this bar — avoids running screening every 45s.
    minScore: Number(u.opportunityMinScore ?? 40),
    // A smart wallet (from the agentmeridian server) sitting on the pool LOWERS the
    // effective minScore by this much — a strong signal nudges a borderline pool through.
    smartWalletScoreBonus: Number(u.opportunitySmartWalletBonus ?? 20),
    // Degen Score targets (each sub-score saturates at its target). Tune to calibrate.
    // Inputs are normalized to a fixed 30m reference window, so these are timeframe-independent.
    targetVolRatio: Number(u.degenTargetVolRatio ?? 20),     // (30m) volume/active_tvl for full trading sub-score
    targetLpCount: Number(u.degenTargetLpCount ?? 40),       // (30m) unique_lps + positions_created for full LP sub-score
    targetFeeRatio: Number(u.degenTargetFeeRatio ?? 0.20),   // (30m) fee/active_tvl for full fee sub-score (tune per timeframe; fees don't normalize as cleanly as volume)
    // active_tvl ($) for full liquidity sub-score. NOT timeframe-scaled. Set near your
    // active-TVL floor (≈ minTvl) so it acts as a dust floor, not a stretch goal — the
    // screening minTvl filter already removes tiny pools.
    targetLiquidity: Number(u.degenTargetLiquidity ?? 20000),
  },

  // ─── Market regime detection (decision-tree config auto-fork) ──
  regime: {
    enabled: u.regimeDetectionEnabled ?? true,
    // classifyRegime()'s median-degenScore cutoffs — below slowCutoff -> "slow",
    // at/above hotCutoff -> "hot", otherwise "normal". Re-evaluated once per
    // screening cycle against that cycle's getTopCandidates() result.
    slowCutoff: Number(u.regimeSlowCutoff ?? 15),
    hotCutoff: Number(u.regimeHotCutoff ?? 45),
    // Consecutive no-deploy screening cycles before force-relaxing back to
    // "normal" — recovers from the tightened-regime feedback loop where a
    // strict profile starves classifyRegime() of candidates to reclassify from.
    relaxAfterFails: Number(u.regimeRelaxAfterFails ?? 3),
    // After relaxing out of a regime, block re-entry into *that same* regime
    // for this long, so the agent cannot oscillate tighten→starve→relax→repeat.
    // Other regimes stay reachable, so adaptation is not frozen.
    suppressMinutes: Number(u.regimeSuppressMinutes ?? 120),
  },

  // ─── GMGN (fee source for minTokenFeesSol gate) ──────────────
  gmgn: {
    apiKey: nonEmptyString(gmgnUserConfig.apiKey, u.gmgnApiKey, process.env.GMGN_API_KEY),
    baseUrl: nonEmptyString(gmgnUserConfig.baseUrl, u.gmgnBaseUrl, "https://openapi.gmgn.ai"),
    requestDelayMs: Number(gmgnUserConfig.requestDelayMs ?? u.gmgnRequestDelayMs ?? 2500),
    maxRetries: Number(gmgnUserConfig.maxRetries ?? u.gmgnMaxRetries ?? 2),
    // gmgn = use GMGN total_fee for global_fees_sol; jupiter = legacy Jupiter fees
    feeSource: nonEmptyString(gmgnUserConfig.feeSource, u.gmgnFeeSource, "gmgn"),
  },

  jupiter: {
    // Internal Jupiter Ultra settings; override by env only, do not expose in user-config.
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount:
      process.env.JUPITER_REFERRAL_ACCOUNT ??
      "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 50,
    ),
  },

  indicators: {
    enabled: indicatorUserConfig.enabled ?? false,
    entryPreset: indicatorUserConfig.entryPreset ?? "supertrend_break",
    exitPreset: indicatorUserConfig.exitPreset ?? "supertrend_break",
    rsiLength: indicatorUserConfig.rsiLength ?? 2,
    intervals: Array.isArray(indicatorUserConfig.intervals)
      ? indicatorUserConfig.intervals
      : ["5_MINUTE"],
    candles: indicatorUserConfig.candles ?? 298,
    rsiOversold: indicatorUserConfig.rsiOversold ?? 30,
    rsiOverbought: indicatorUserConfig.rsiOverbought ?? 80,
    requireAllIntervals: indicatorUserConfig.requireAllIntervals ?? false,
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
// SOL amounts are always compared/displayed at 2-decimal precision. A raw
// float like 0.7 * 0.85 is stored internally as ~0.59499999999999997, so
// comparing an unrounded config value against an already-rounded amount
// (e.g. what computeDeployAmount() below hands the LLM) can reject a
// technically-valid deploy by less than half a cent. Round BOTH sides
// through this before comparing anywhere SOL amounts meet a floor/ceiling.
export function round2(n) {
  return parseFloat(Number(n).toFixed(2));
}

export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return round2(result);
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  try {
    if (!fs.existsSync(USER_CONFIG_PATH)) return;
    const fresh = flattenConfig(JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minTokenFeesSol  != null) s.minTokenFeesSol  = fresh.minTokenFeesSol;
    if (fresh.maxTop10Pct      != null) s.maxTop10Pct      = fresh.maxTop10Pct;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
    if (fresh.hysteresisRejectionCount != null) s.hysteresisRejectionCount = fresh.hysteresisRejectionCount;
    if (fresh.hysteresisWindowHours    != null) s.hysteresisWindowHours    = fresh.hysteresisWindowHours;
    if (fresh.hysteresisMarginPct      != null) s.hysteresisMarginPct      = fresh.hysteresisMarginPct;
    if (fresh.tokenAgeWindowEnabled    !== undefined) s.tokenAgeWindowEnabled    = fresh.tokenAgeWindowEnabled;
    if (fresh.tokenEarlyWindowMaxHours != null) s.tokenEarlyWindowMaxHours = fresh.tokenEarlyWindowMaxHours;
    if (fresh.tokenCooldownHours       != null) s.tokenCooldownHours       = fresh.tokenCooldownHours;
    const minBinsBelow = numericConfig(fresh.minBinsBelow) ?? config.strategy.minBinsBelow;
    const maxBinsBelow = numericConfig(fresh.maxBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.maxBinsBelow;
    const defaultBinsBelow = numericConfig(fresh.defaultBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.defaultBinsBelow ?? maxBinsBelow;
    config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(minBinsBelow));
    config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(maxBinsBelow));
    config.strategy.defaultBinsBelow = Math.max(
      config.strategy.minBinsBelow,
      Math.min(config.strategy.maxBinsBelow, Math.round(defaultBinsBelow)),
    );
  } catch { /* ignore */ }
}
