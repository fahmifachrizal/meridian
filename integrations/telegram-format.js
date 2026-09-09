/**
 * Shared Telegram message formatting — one house style.
 *
 * WHY THIS EXISTS
 * ---------------
 * Three problems this fixes:
 *
 * 1. UNSAFE TRUNCATION. Every send/edit path used a bare `.slice(0, 4096)`.
 *    A cut landing inside <pre> or <b> leaves an unclosed tag, Telegram
 *    rejects the whole message with a 400, and postTelegram swallows it into
 *    a log line — so the update vanishes silently. safeTruncate() cuts on a
 *    tag boundary and closes what it opened.
 *
 * 2. DIVERGENT STYLES. htmlTable() existed in telegram.js but was never
 *    called; the management cycle reimplemented it inline with the same
 *    label width. Three live-message titles used three different
 *    conventions. card() is now the single entry point.
 *
 * 3. VERBOSITY. Telegram is a phone-first surface. compactLine() and the
 *    formatters here favour one dense line over a labelled table wherever the
 *    labels carry no information.
 */

// safeTruncate lives in telegram.js (transport primitive) and is re-exported
// here so callers have one formatting import.
import { escapeHtml, htmlTable, safeTruncate, TELEGRAM_LIMIT } from "./telegram.js";
import { classifyEvent } from "../util/event-codes.js";

export { safeTruncate, TELEGRAM_LIMIT };

/**
 * Resolve a caught error's TEXT via the event-codes taxonomy
 * (util/event-codes.js) — a recognized pattern (Helius rate limits,
 * Jupiter swap failures, LLM provider errors, a stale blockhash, ...)
 * becomes a stable, human-readable sentence instead of whatever raw
 * exception string happened to be thrown. Unrecognized errors
 * (GENERAL_ERROR) are NEVER hidden or paraphrased — they keep their full
 * original message, exactly as before this existed, so a genuinely novel
 * or user-input-specific error (an invalid /setcfg key, an out-of-range
 * /close index) never loses detail behind a generic label.
 *
 * `tag` is optional (mirrors this repo's `log(tag, message)` convention)
 * — most Telegram command-handler catches have no natural tag, and that's
 * fine, since most taxonomy rules match on message content alone
 * regardless of tag.
 */
export function describeErrorForTelegram(message, tag = "") {
  const { code, label } = classifyEvent(tag, message);
  return code === "GENERAL_ERROR" ? message : label;
}

/** Same resolution as describeErrorForTelegram(), with a "Prefix: " wrapper — the shape every top-level command-handler catch wants. */
export function formatErrorForTelegram(message, { tag = "", prefix = "Error" } = {}) {
  return `${prefix}: ${describeErrorForTelegram(message, tag)}`;
}

/**
 * A titled block: bold heading, optional aligned label/value table, optional
 * free-text footer. `rows` are [label, value] pairs; empty values drop out.
 *
 * Both sides are escaped by htmlTable/escapeHtml, so callers pass raw values.
 */
export function card(title, rows = [], { footer = null, labelWidth = 11 } = {}) {
  const parts = [];
  if (title) parts.push(`<b>${escapeHtml(title)}</b>`);
  const table = rows.length ? htmlTable(rows, { labelWidth }) : "";
  if (table) parts.push(table);
  if (footer) parts.push(escapeHtml(footer));
  return parts.join("\n");
}

/**
 * Join values into one dense line — "◎39.65 · +0.59% · 🟢 in range".
 * Nullish and empty segments are dropped so callers don't need guards.
 */
export function compactLine(...segments) {
  return segments
    .filter((s) => s !== null && s !== undefined && s !== "")
    .map((s) => escapeHtml(String(s)))
    .join(" · ");
}

// Number(null) and Number("") are both 0, so a plain Number.isFinite check
// would render missing data as a confident "◎0.00". Showing a real zero for
// "we don't know" is worse than showing "?" — the operator reads these to
// decide whether to intervene.
function toNumber(value) {
  if (value === null || value === undefined || value === "") return NaN;
  return Number(value);
}

/** Signed percentage, e.g. "+0.59%" / "-12.30%". */
export function fmtSignedPct(value, digits = 2) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return "?";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

/** Currency-ish amount in the operator's chosen unit (◎ SOL or $ USD). */
export function fmtAmount(value, unit = "◎", digits = 2) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return `${unit}?`;
  return `${unit}${n.toFixed(digits)}`;
}

/** "44m" / "3h12m" / "2d4h" — compact enough for a status line. */
export function fmtAge(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m < 0) return "?";
  if (m < 60) return `${Math.round(m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${Math.round(m % 60)}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

/**
 * One position rendered as a compact block — the shape that replaces the
 * ~20-line markdown table an LLM used to emit for /pool:
 *
 *   KIO-SOL
 *   ◎39.65 · +0.59% · 🟢 in range
 *   fees ◎0.83 · 44m · bin -467 (-500→-443)
 *   yield 74.3%/24h
 */
export function positionBlock(p, { unit = "◎", action = null } = {}) {
  const range = (p.lower_bin != null && p.upper_bin != null) ? `${p.lower_bin}→${p.upper_bin}` : null;
  const status = p.in_range ? "🟢 in range" : `🔴 OOR ${Math.round(p.minutes_out_of_range ?? 0)}m`;

  const lines = [
    `<b>${escapeHtml(p.pair || p.pool_name || "unknown")}</b>`,
    compactLine(fmtAmount(p.total_value_usd, unit), fmtSignedPct(p.pnl_pct), status),
    compactLine(
      p.unclaimed_fees_usd != null ? `fees ${fmtAmount(p.unclaimed_fees_usd, unit)}` : null,
      fmtAge(p.age_minutes),
      p.active_bin != null ? `bin ${p.active_bin}${range ? ` (${range})` : ""}` : (range ? `bins ${range}` : null),
    ),
    p.fee_per_tvl_24h != null ? compactLine(`yield ${Number(p.fee_per_tvl_24h).toFixed(1)}%/24h`) : null,
    action && action !== "STAY" ? `→ ${escapeHtml(action)}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

function fmtPctPlain(value, digits = 2) {
  const n = toNumber(value);
  return Number.isFinite(n) ? `${n.toFixed(digits)}%` : "?";
}

function fmtPriceRange(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "?";
  return v < 0.0001 ? v.toExponential(3) : v.toFixed(6);
}

/**
 * The "deployed" report — built here, deterministically, for the same
 * reason noDeployReport() is: an LLM asked to hand-format an aligned
 * metrics table drifts (padding, units, invented numbers) over time in a
 * way a template can't. Every number comes from deploy_position's own tool
 * result or the winning candidate's own recon data, never re-derived by
 * the LLM. `why` is the one piece of genuine LLM synthesis left — a short
 * opinion sentence, not a data point, so a bad format there can't corrupt
 * the numbers around it.
 */
export function deployedReport({
  poolName, poolAddress, amountSol, strategy, activeBin,
  priceRange, rangeCoverage, insuranceUsd,
  feeTvlRatio, volume, tvl, organicScore, mcap, ageHours,
  top10Pct, botsPct, smartWalletNames,
  why, position, tx,
} = {}) {
  const org = toNumber(organicScore);
  const conviction = !Number.isFinite(org) ? null
    : org >= 85 ? "🟢 HIGH CONVICTION"
    : org >= 70 ? "🟡 MODERATE CONVICTION"
    : "🟠 LOW CONVICTION";
  const badgeLine = [
    conviction,
    Number.isFinite(org) ? `Score ${org}` : null,
    ageHours != null ? `${fmtAge(Number(ageHours) * 60)} old` : null,
  ].filter(Boolean).join(" · ");

  const rows = [
    ["Amount", fmtAmount(amountSol, "◎")],
    insuranceUsd > 0 ? ["Insured", fmtAmount(insuranceUsd, "$")] : null,
    strategy ? ["Strategy", strategy] : null,
    activeBin != null ? ["Bin", activeBin] : null,
    priceRange ? ["Range", `${fmtPriceRange(priceRange.min)} – ${fmtPriceRange(priceRange.max)}`] : null,
    rangeCoverage ? ["Down", fmtPctPlain(rangeCoverage.downside_pct)] : null,
    rangeCoverage ? ["Up", fmtPctPlain(rangeCoverage.upside_pct)] : null,
    rangeCoverage ? ["Width", fmtPctPlain(rangeCoverage.width_pct)] : null,
    feeTvlRatio != null ? ["Fee/TVL", fmtPctPlain(feeTvlRatio)] : null,
    volume != null ? ["Vol 24h", fmtAmount(volume, "$", 0)] : null,
    tvl != null ? ["TVL", fmtAmount(tvl, "$", 0)] : null,
    mcap != null ? ["MCap", fmtAmount(mcap, "$", 0)] : null,
    top10Pct != null ? ["Top10", fmtPctPlain(top10Pct)] : null,
    botsPct != null ? ["Bots", fmtPctPlain(botsPct)] : null,
    ["Smart $", smartWalletNames?.length ? smartWalletNames.join(", ") : "none"],
  ].filter(Boolean);

  const lines = [
    `🚀 <b>Deployed</b> — <b>${escapeHtml(poolName ?? "unknown")}</b>`,
    badgeLine ? escapeHtml(badgeLine) : null,
    htmlTable(rows),
    why ? `why  ${escapeHtml(String(why).trim().slice(0, 200))}` : null,
    poolAddress ? `Pool <code>${escapeHtml(String(poolAddress).slice(0, 8))}…</code>` : null,
    position ? `Position <code>${escapeHtml(String(position).slice(0, 8))}…</code>` : null,
    tx ? `Tx <code>${escapeHtml(String(tx).slice(0, 16))}…</code>` : null,
  ].filter(Boolean);
  return safeTruncate(lines.join("\n"));
}

/**
 * The "no deploy" report. Built here so the JS-generated version and the
 * LLM-prompted template can no longer drift apart — they previously lived in
 * two places with the same section headers.
 */
export function noDeployReport({ best = null, reason = null, rejected = [], html = true } = {}) {
  // Two render modes, one structure. runScreeningCycle carries `screenReport`
  // as PLAIN TEXT and escapes it wholesale at finalize time, so that caller
  // passes html:false; anything writing straight to a Telegram HTML message
  // uses the default. Emitting tags into the plain path would render them as
  // literal &lt;b&gt;.
  const esc = html ? escapeHtml : (v) => String(v ?? "");
  const lines = [html ? "⛔ <b>No deploy</b>" : "⛔ NO DEPLOY"];
  if (best) lines.push(`best  ${esc(best)}`);
  if (reason) lines.push(`why   ${esc(reason)}`);
  if (rejected.length) {
    lines.push(rejected.slice(0, 5).map((r) => `• ${esc(String(r))}`).join("\n"));
  }
  return lines.join("\n");
}
