import fs from "fs";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";
import { flattenConfig, groupConfig } from "../core/config-groups.js";

const USER_CONFIG_PATH = repoPath("user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ALLOWED_USER_IDS = new Set(
  String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

let chatId = null;
let messageThreadId = null;
let _offset  = 0;
let _polling = false;
let _liveMessageDepth = 0;
let _warnedMissingChatId = false;
let _warnedMissingAllowedUsers = false;

function nonEmptyChatId(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

// ─── chatId persistence ──────────────────────────────────────────
function resolveChatId() {
  const fromEnv = nonEmptyChatId(process.env.TELEGRAM_CHAT_ID);
  let fromConfig = null;
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = flattenConfig(JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")));
      fromConfig = nonEmptyChatId(cfg.telegramChatId);
    }
  } catch (error) {
    log("telegram_warn", `Invalid user-config.json; chatId not loaded: ${error.message}`);
  }
  // user-config wins when set; otherwise fall back to .env
  const resolved = fromConfig || fromEnv || null;
  return resolved != null ? String(resolved) : null;
}

// Forum/topic thread id — messages post into this topic when set.
// user-config.telegramTopicId wins over TELEGRAM_TOPIC_ID env.
function resolveTopicId() {
  const fromEnv = nonEmptyChatId(process.env.TELEGRAM_TOPIC_ID);
  let fromConfig = null;
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = flattenConfig(JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")));
      fromConfig = nonEmptyChatId(cfg.telegramTopicId);
    }
  } catch { /* resolveChatId already logs invalid-config warnings */ }
  const resolved = fromConfig || fromEnv || null;
  return resolved != null ? Number(resolved) : null;
}

function loadChatId() {
  chatId = resolveChatId();
  messageThreadId = resolveTopicId();
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? flattenConfig(JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")))
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(groupConfig(cfg), null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

function isAuthorizedIncomingMessage(msg) {
  const incomingChatId = String(msg.chat?.id || "");
  const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
  const chatType = msg.chat?.type || "unknown";

  if (!chatId) {
    if (!_warnedMissingChatId) {
      log("telegram_warn", "Ignoring inbound Telegram messages because TELEGRAM_CHAT_ID / user-config.telegramChatId is not configured. Auto-registration is disabled for safety.");
      _warnedMissingChatId = true;
    }
    return false;
  }

  if (incomingChatId !== String(chatId)) return false;

  if (chatType !== "private" && ALLOWED_USER_IDS.size === 0) {
    if (!_warnedMissingAllowedUsers) {
      log("telegram_warn", "Ignoring group Telegram messages because TELEGRAM_ALLOWED_USER_IDS is not configured. Set explicit allowed user IDs for command/control.");
      _warnedMissingAllowedUsers = true;
    }
    return false;
  }

  if (ALLOWED_USER_IDS.size > 0) {
    if (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId)) return false;
  }

  return true;
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

async function postTelegram(method, body) {
  if (!TOKEN || !chatId) return null;
  // editMessageText targets an existing message_id — thread id is irrelevant there.
  const threadFields =
    messageThreadId != null && method !== "editMessageText"
      ? { message_thread_id: messageThreadId }
      : {};
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...threadFields, ...body }),
    });
    if (!res.ok) {
      const err = await res.text();
      if (res.status === 401) {
        log("telegram_error", `${method} 401 Unauthorized — check TELEGRAM_BOT_TOKEN in .env (invalid, revoked, or encrypted without .envrypt key)`);
      } else {
        log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      }
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

async function postTelegramRaw(method, body) {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      if (res.status === 401) {
        log("telegram_error", `${method} 401 Unauthorized — check TELEGRAM_BOT_TOKEN in .env (invalid, revoked, or encrypted without .envrypt key)`);
      } else {
        log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      }
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

export async function sendMessage(text, { parseMode } = {}) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", {
    text: safeTruncate(String(text)),
    ...(parseMode ? { parse_mode: parseMode } : {}),
  });
}

/** Escape text for safe embedding in an HTML-parse-mode Telegram message. */
export function escapeHtml(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const TELEGRAM_LIMIT = 4096;

// Tags this repo actually emits; anything else is escaped before it gets here.
const KNOWN_TAGS = ["b", "i", "u", "s", "code", "pre", "a"];

/**
 * Truncate to Telegram's limit WITHOUT leaving an unclosed tag.
 *
 * Every send/edit path used to do a bare `.slice(0, 4096)`. A cut landing
 * inside <pre> or <b> makes Telegram reject the whole message with a 400,
 * which postTelegram swallows into a log line — so the update silently
 * vanished instead of arriving truncated. This cuts on a tag boundary (and
 * outside HTML entities) then closes whatever is still open.
 *
 * Lives here rather than in telegram-format.js so the dependency runs one
 * way: transport primitives here, presentation there.
 */
export function safeTruncate(html, limit = TELEGRAM_LIMIT) {
  const text = String(html ?? "");
  if (text.length <= limit) return text;

  const ellipsis = "\n…";

  // Which tags are still open at a given cut point, innermost last.
  const openAt = (slice) => {
    const open = [];
    const tagRe = /<(\/?)([a-zA-Z]+)(?:\s[^>]*)?>/g;
    let m;
    while ((m = tagRe.exec(slice)) !== null) {
      const [, slash, rawName] = m;
      const name = rawName.toLowerCase();
      if (!KNOWN_TAGS.includes(name)) continue;
      if (slash) {
        const idx = open.lastIndexOf(name);
        if (idx !== -1) open.splice(idx, 1);
      } else {
        open.push(name);
      }
    }
    return open;
  };

  const adjust = (cut) => {
    // Never cut inside a tag: back up past a dangling "<...".
    // Search below `cut` because slice(0, cut) excludes index `cut` itself.
    const lastOpen = text.lastIndexOf("<", cut - 1);
    const lastClose = text.lastIndexOf(">", cut - 1);
    if (lastOpen > lastClose) cut = lastOpen;
    // Never cut inside an HTML entity ("&amp;") — half an entity renders as junk.
    const lastAmp = text.lastIndexOf("&", cut - 1);
    const lastSemi = text.lastIndexOf(";", cut - 1);
    if (lastAmp > lastSemi && cut - lastAmp < 12) cut = lastAmp;
    return cut;
  };

  // The closing tags count toward the limit, so budget for them and re-check:
  // shortening the cut can change which tags are open.
  let cut = adjust(limit - ellipsis.length);
  for (let pass = 0; pass < 3; pass++) {
    const closers = openAt(text.slice(0, cut)).map((t) => `</${t}>`).join("");
    const budget = limit - ellipsis.length - closers.length;
    if (cut <= budget) break;
    cut = adjust(budget);
  }

  const out = text.slice(0, cut);
  const closers = openAt(out).reverse().map((t) => `</${t}>`).join("");
  return out + closers + ellipsis;
}

export async function sendMessageWithButtons(text, inlineKeyboard) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", {
    text: safeTruncate(String(text)),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function sendHTML(html) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: safeTruncate(html), parse_mode: "HTML" });
}

export async function editMessage(text, messageId, { parseMode } = {}) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: safeTruncate(String(text)),
    ...(parseMode ? { parse_mode: parseMode } : {}),
  });
}

export async function editMessageWithButtons(text, messageId, inlineKeyboard) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: safeTruncate(String(text)),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!TOKEN || !callbackQueryId) return null;
  return postTelegramRaw("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: String(text).slice(0, 200) } : {}),
  });
}

export function hasActiveLiveMessage() {
  return _liveMessageDepth > 0;
}

function createTypingIndicator() {
  if (!TOKEN || !chatId) {
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    await postTelegram("sendChatAction", { action: "typing" });
    timer = setTimeout(() => {
      tick().catch(() => null);
    }, 4000);
  }

  tick().catch(() => null);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function toolLabel(name) {
  const labels = {
    get_token_info: "get token info",
    get_token_narrative: "get token narrative",
    get_token_holders: "get token holders",
    get_top_candidates: "get top candidates",
    get_pool_detail: "get pool detail",
    get_active_bin: "get active bin",
    deploy_position: "deploy position",
    close_position: "close position",
    claim_fees: "claim fees",
    swap_token: "swap token",
    update_config: "update config",
    get_my_positions: "get positions",
    get_wallet_balance: "get wallet balance",
    check_smart_wallets_on_pool: "check smart wallets",
    study_top_lpers: "study top LPers",
    get_top_lpers: "get top LPers",
    search_pools: "search pools",
    discover_pools: "discover pools",
  };
  return labels[name] || name.replace(/_/g, " ");
}

function summarizeToolResult(name, result) {
  if (!result) return "";
  if (result.error) return result.error;
  if (result.reason && result.blocked) return result.reason;
  switch (name) {
    case "deploy_position":
      return result.position ? `position ${String(result.position).slice(0, 8)}...` : "submitted";
    case "close_position":
      return result.success ? "closed" : (result.reason || "failed");
    case "claim_fees":
      return result.claimed_amount != null ? `claimed ${result.claimed_amount}` : "done";
    case "update_config":
      return Object.keys(result.applied || {}).join(", ") || "updated";
    case "get_top_candidates":
      return `${result.candidates?.length ?? 0} candidates`;
    case "get_my_positions":
      return `${result.total_positions ?? result.positions?.length ?? 0} positions`;
    case "get_wallet_balance":
      return `${result.sol ?? "?"} SOL`;
    case "study_top_lpers":
    case "get_top_lpers":
      return `${result.lpers?.length ?? 0} LPers`;
    default:
      return result.success === false ? "failed" : "done";
  }
}

export async function createLiveMessage(title, intro = "Starting...", { parseMode } = {}) {
  if (!TOKEN || !chatId) return null;
  const typing = createTypingIndicator();

  const state = {
    title,
    intro,
    toolLines: [],
    footer: "",
    messageId: null,
    flushTimer: null,
    flushPromise: null,
    flushRequested: false,
    parseMode: parseMode || null,
  };

  function render() {
    const sections = [state.title];
    if (state.intro) sections.push(state.intro);
    if (state.toolLines.length > 0) sections.push(state.toolLines.join("\n"));
    if (state.footer) sections.push(state.footer);
    return safeTruncate(sections.join("\n\n"));
  }

  async function flushNow() {
    state.flushTimer = null;
    state.flushRequested = false;
    const text = render();
    if (!state.messageId) {
      const sent = await sendMessage(text, { parseMode: state.parseMode });
      state.messageId = sent?.result?.message_id ?? null;
      return;
    }
    await editMessage(text, state.messageId, { parseMode: state.parseMode });
  }

  function scheduleFlush(delay = 300) {
    if (state.flushTimer) {
      state.flushRequested = true;
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushPromise = flushNow().catch(() => null);
    }, delay);
  }

  async function upsertToolLine(name, icon, suffix = "") {
    // Tool names are fixed/known-safe; suffix carries dynamic tool-result
    // text (error messages, reasons) that must be escaped whenever this
    // message is in HTML mode, or one stray `<`/`&` breaks the whole render.
    const label = state.parseMode === "HTML" ? escapeHtml(toolLabel(name)) : toolLabel(name);
    const safeSuffix = suffix && state.parseMode === "HTML" ? escapeHtml(suffix) : suffix;
    const line = `${icon} ${label}${safeSuffix ? ` ${safeSuffix}` : ""}`;
    const idx = state.toolLines.findIndex((entry) => entry.includes(` ${label}`));
    if (idx >= 0) state.toolLines[idx] = line;
    else state.toolLines.push(line);
    scheduleFlush();
  }

  _liveMessageDepth += 1;
  await flushNow();

  return {
    async toolStart(name) {
      await upsertToolLine(name, "ℹ️", "...");
    },
    async toolFinish(name, result, success) {
      const icon = success ? "✅" : "❌";
      const summary = summarizeToolResult(name, result);
      await upsertToolLine(name, icon, summary ? `— ${summary}` : "");
    },
    async note(text) {
      state.intro = text;
      scheduleFlush();
    },
    async finalize(finalText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = finalText;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
    async fail(errorText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = `❌ ${errorText}`;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
  };
}


// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const callback = update.callback_query;
        if (callback?.data && callback?.message) {
          const callbackMsg = {
            chat: callback.message.chat,
            from: callback.from,
            text: callback.data,
          };
          if (!isAuthorizedIncomingMessage(callbackMsg)) continue;
          await onMessage({
            ...callbackMsg,
            isCallback: true,
            callbackQueryId: callback.id,
            callbackData: callback.data,
            messageId: callback.message.message_id,
          });
          continue;
        }
        const msg = update.message;
        if (!msg?.text) continue;
        if (!isAuthorizedIncomingMessage(msg)) continue;
        await onMessage(msg);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

const BOT_COMMANDS = [
  { command: "help",       description: "Show commands" },
  { command: "status",     description: "Wallet + positions snapshot" },
  { command: "wallet",     description: "Wallet, deploy amount, HiveMind status" },
  { command: "positions",  description: "List open positions" },
  { command: "pool",       description: "Detailed info for one open position" },
  { command: "close",      description: "Close one position by index" },
  { command: "closeall",   description: "Close all open positions" },
  { command: "set",        description: "Set note/instruction on position" },
  { command: "config",     description: "Show important runtime config" },
  { command: "settings",   description: "Button menu for common config" },
  { command: "setcfg",     description: "Update persisted config key" },
  { command: "screen",     description: "Refresh deterministic candidate list" },
  { command: "candidates", description: "Show latest cached candidates" },
  { command: "deploy",     description: "Deploy candidate by cached index" },
  { command: "briefing",   description: "Morning briefing" },
  { command: "hive",       description: "HiveMind sync status" },
  { command: "pause",      description: "Stop cron cycles" },
  { command: "resume",     description: "Start cron cycles again" },
  { command: "stop",       description: "Shut down agent" },
];

async function registerCommands() {
  if (!BASE) return;
  try {
    await fetch(`${BASE}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: BOT_COMMANDS }),
    });
    log("telegram", "Bot commands registered");
  } catch (e) {
    log("telegram_warn", `Failed to register bot commands: ${e.message}`);
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  loadChatId();
  if (!chatId) {
    log("telegram_warn", "TELEGRAM_CHAT_ID not set in .env or user-config.telegramChatId — outbound notifications and inbound control disabled until configured.");
  }
  _polling = true;
  poll(onMessage); // fire-and-forget
  registerCommands();
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────
/**
 * Render a label/value table inside a <pre> block — the house style for every
 * structured notification. Keeps columns aligned in Telegram's monospace font
 * and escapes both sides, so dynamic values can never break the HTML parse.
 */
export function htmlTable(rows, { labelWidth = 11 } = {}) {
  const body = rows
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([label, value]) => `${escapeHtml(String(label)).padEnd(labelWidth)}${escapeHtml(String(value))}`)
    .join("\n");
  return body ? `<pre>${body}</pre>` : "";
}

function fmtPrice(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "?";
  return v < 0.0001 ? v.toExponential(3) : v.toFixed(6);
}

export async function notifyDeploy({ pair, amountSol, position, tx, priceRange, rangeCoverage, binStep, baseFee, insuranceUsd }) {
  if (hasActiveLiveMessage()) return;
  const rows = [
    ["Amount", `◎${amountSol}`],
    ["Bin step", binStep ?? undefined],
    ["Base fee", baseFee != null ? `${baseFee}%` : undefined],
  ];
  if (priceRange) rows.push(["Range", `${fmtPrice(priceRange.min)} – ${fmtPrice(priceRange.max)}`]);
  if (rangeCoverage) {
    rows.push(["Down", fmtPct(rangeCoverage.downside_pct)]);
    rows.push(["Up", fmtPct(rangeCoverage.upside_pct)]);
    rows.push(["Width", fmtPct(rangeCoverage.width_pct)]);
  }
  // Only shown when the insurance pool is enabled and actually skimmed
  // something for this deploy (tools/dlmm.js's deployPosition()).
  if (insuranceUsd > 0) rows.push(["Insured", `$${Number(insuranceUsd).toFixed(2)}`]);
  await sendHTML(
    `🚀 <b>Deployed</b> — <b>${escapeHtml(pair)}</b>\n` +
    htmlTable(rows) +
    `\nPosition <code>${escapeHtml(String(position ?? "").slice(0, 8))}…</code>` +
    `\nTx <code>${escapeHtml(String(tx ?? "").slice(0, 16))}…</code>`
  );
}

/**
 * `insurance`, when the pool is enabled for this position, tells the full
 * receive/withdraw flow in one line rather than a separate message:
 *   - contributedUsd: what THIS position skimmed in at deploy time
 *   - withdrawnUsd: what was drawn from the POOLED balance at this close
 *     (0 for the common case — most closes don't draw anything, see
 *     computeInsuranceWithdraw() in tools/executor.js)
 *   - poolAfterUsd: the aggregate wallet insurance balance after this close
 *   - failed: true if a withdrawal was owed (withdrawUsd > 0) but the
 *     settle swap itself errored — rendered distinctly from "kept" so a
 *     real failure is never silently reported as "nothing needed
 *     withdrawing" (a real bug this fixed: every withdrawal failed
 *     on-chain but the old message said "kept" either way)
 */
export async function notifyClose({ pair, pnlUsd, pnlPct, solReturned, reason, insurance }) {
  if (hasActiveLiveMessage()) return;
  const up = (pnlUsd ?? 0) >= 0;
  const sign = up ? "+" : "";
  let insuranceLine = "";
  if (insurance && insurance.contributedUsd != null) {
    const { contributedUsd, withdrawnUsd, poolAfterUsd, failed } = insurance;
    insuranceLine = failed
      ? `\n⚠️ Insurance: contributed $${contributedUsd.toFixed(2)}, withdrawal FAILED (pool still $${poolAfterUsd.toFixed(2)}) — check logs`
      : withdrawnUsd > 0
        ? `\n🛟 Insurance: contributed $${contributedUsd.toFixed(2)}, drew $${withdrawnUsd.toFixed(2)} from pool (pool now $${poolAfterUsd.toFixed(2)})`
        : `\nInsurance: contributed $${contributedUsd.toFixed(2)}, kept (pool now $${poolAfterUsd.toFixed(2)})`;
  }
  const badgeLine = `${up ? "🟢 WIN" : "🔴 LOSS"} · ${sign}${(pnlPct ?? 0).toFixed(2)}%`;
  await sendHTML(
    `${up ? "🟢" : "🔴"} <b>Closed</b> — <b>${escapeHtml(pair)}</b>\n` +
    `${badgeLine}\n` +
    htmlTable([
      ["PnL", `${sign}$${(pnlUsd ?? 0).toFixed(2)}`],
      ["PnL %", `${sign}${(pnlPct ?? 0).toFixed(2)}%`],
      ["Returned", solReturned != null ? `◎${Number(solReturned).toFixed(4)}` : undefined],
    ]) +
    (reason ? `\nReason: ${escapeHtml(String(reason))}` : "") +
    insuranceLine
  );
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `🔄 <b>Swapped</b> — ${escapeHtml(inputSymbol)} → ${escapeHtml(outputSymbol)}\n` +
    htmlTable([
      ["In", amountIn ?? "?"],
      ["Out", amountOut ?? "?"],
    ]) +
    `\nTx <code>${escapeHtml(String(tx ?? "").slice(0, 16))}…</code>`
  );
}

export async function notifyConfigChange(changes, { source } = {}) {
  if (hasActiveLiveMessage()) return;
  if (!Array.isArray(changes) || changes.length === 0) return;
  await sendHTML(
    `⚙️ <b>Config change</b>${source ? ` — <i>${escapeHtml(source)}</i>` : ""}\n` +
    htmlTable(changes.map(({ key, from, to }) => [key, `${from} → ${to}`]), { labelWidth: 24 })
  );
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `⚠️ <b>Out of Range</b> — <b>${escapeHtml(pair)}</b>\n` +
    htmlTable([["Duration", `${minutesOOR}m`]])
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}
