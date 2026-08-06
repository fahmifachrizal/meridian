/**
 * Offline unit tests for Telegram message formatting.
 *
 * safeTruncate is the one with teeth. Every send/edit path used to do a bare
 * `.slice(0, 4096)`; a cut landing inside <pre> or <b> leaves an unclosed tag,
 * Telegram rejects the whole message with a 400, and postTelegram swallows
 * that into a log line — so the update vanished entirely rather than arriving
 * clipped. These cases lock in: never over the limit (closing tags count
 * toward it), never an unbalanced tag, never half an HTML entity.
 *
 * Run: NODE_ENV=test node test/test-telegram-format.js
 */

import { createSuite } from "./lib/test-kit.js";
import { safeTruncate, escapeHtml, TELEGRAM_LIMIT } from "../integrations/telegram.js";
import {
  card,
  compactLine,
  fmtSignedPct,
  fmtAmount,
  fmtAge,
  positionBlock,
  noDeployReport,
} from "../integrations/telegram-format.js";

const suite = createSuite("telegram-format — safe, compact messages");
const { section, check, finish } = suite;

const body = (s) => s.replace(/\n…$/, "");
const balanced = (s) => {
  const opens = [...s.matchAll(/<([a-z]+)>/g)].map((m) => m[1]);
  const closes = [...s.matchAll(/<\/([a-z]+)>/g)].map((m) => m[1]);
  return opens.length === closes.length && opens.every((t) => closes.includes(t));
};

section("safeTruncate — never produces a message Telegram will reject");
{
  const cases = [
    ["plain long text", "x".repeat(5000)],
    ["cut inside <pre>", `<pre>${"y".repeat(5000)}</pre>`],
    ["nested <b><code>", `<b>bold <code>${"z".repeat(5000)}</code></b>`],
    ["entity at the boundary", `${"a".repeat(4090)}&amp;${"b".repeat(50)}`],
    ["deeply nested tags", `<b><i><u><code>${"q".repeat(5000)}</code></u></i></b>`],
    ["tag straddling the cut", `${"c".repeat(4088)}<b>hello</b>${"d".repeat(100)}`],
  ];

  for (const [name, input] of cases) {
    const out = safeTruncate(input);
    check(`${name}: within Telegram's limit (${out.length})`, out.length <= TELEGRAM_LIMIT);
    check(`${name}: tags balanced`, balanced(body(out)));
    check(`${name}: no half-written entity`, !/&[a-z]{0,8}$/.test(body(out)));
    check(`${name}: no half-written tag`, !/<[^>]*$/.test(body(out)));
  }
}

section("safeTruncate — leaves short input alone");
{
  check("short HTML is untouched", safeTruncate("<b>hi</b>") === "<b>hi</b>");
  check("empty input is safe", safeTruncate("") === "");
  check("nullish input is safe", safeTruncate(null) === "");
  const exact = "e".repeat(TELEGRAM_LIMIT);
  check("exactly at the limit is untouched", safeTruncate(exact) === exact);
  check("one over the limit is truncated", safeTruncate("e".repeat(TELEGRAM_LIMIT + 1)).length <= TELEGRAM_LIMIT);
}

section("Formatters");
{
  check("fmtSignedPct adds an explicit +", fmtSignedPct(0.59) === "+0.59%");
  check("fmtSignedPct keeps -", fmtSignedPct(-12.3) === "-12.30%");
  check("fmtSignedPct handles junk", fmtSignedPct(undefined) === "?");
  check("fmtAmount uses the unit", fmtAmount(39.65, "◎") === "◎39.65");
  check("fmtAmount handles junk", fmtAmount(null, "$") === "$?");
  check("fmtAge minutes", fmtAge(44) === "44m");
  check("fmtAge hours", fmtAge(192) === "3h12m");
  check("fmtAge days", fmtAge(3120) === "2d4h");
  check("fmtAge handles junk", fmtAge(-1) === "?");

  check("compactLine joins with a separator", compactLine("a", "b") === "a · b");
  check("compactLine drops nullish/empty segments", compactLine("a", null, "", undefined, "b") === "a · b");
  check("compactLine escapes its input", compactLine("<script>").includes("&lt;script&gt;"));
}

section("card");
{
  const c = card("KIO-SOL", [["Value", "◎39.65"], ["PnL", "+0.59%"]]);
  check("title is bolded", c.startsWith("<b>KIO-SOL</b>"));
  check("rows render in a <pre> block", c.includes("<pre>") && c.includes("Value"));
  check("empty rows produce no table", !card("Title", []).includes("<pre>"));
  const evil = card("<b>x</b>", [["k", "<i>v</i>"]]);
  check("title is escaped, not injected", evil.includes("&lt;b&gt;x&lt;/b&gt;"));
  check("values are escaped, not injected", evil.includes("&lt;i&gt;v&lt;/i&gt;"));
}

section("positionBlock — the compact /pool replacement");
{
  const p = {
    pair: "KIO-SOL",
    total_value_usd: 39.65,
    pnl_pct: 0.59,
    in_range: true,
    unclaimed_fees_usd: 0.83,
    age_minutes: 44,
    active_bin: -467,
    lower_bin: -500,
    upper_bin: -443,
    fee_per_tvl_24h: 74.33,
  };
  const out = positionBlock(p);
  const lines = out.split("\n");
  check("renders in 4 lines, not a 20-row table", lines.length === 4);
  check("leads with the pair", lines[0] === "<b>KIO-SOL</b>");
  check("value/pnl/status on one line", lines[1] === "◎39.65 · +0.59% · 🟢 in range");
  check("fees/age/bin on one line", lines[2] === "fees ◎0.83 · 44m · bin -467 (-500→-443)");
  check("yield line present", lines[3].includes("74.3%/24h"));
  check("no markdown table pipes anywhere", !out.includes("|"));

  const oor = positionBlock({ ...p, in_range: false, minutes_out_of_range: 12 });
  check("out-of-range shows the OOR duration", oor.includes("🔴 OOR 12m"));

  const acting = positionBlock(p, { action: "CLOSE" });
  check("a non-STAY action is surfaced", acting.includes("→ CLOSE"));
  // NB: assert on the action marker, not a bare "→" — the bin range legitimately
  // contains an arrow ("bin -467 (-500→-443)").
  check("STAY is not surfaced as noise", !positionBlock(p, { action: "STAY" }).includes("→ STAY"));

  const sparse = positionBlock({ pair: "X-SOL" });
  check("missing fields don't crash or emit 'undefined'", !sparse.includes("undefined"));
}

section("noDeployReport");
{
  const r = noDeployReport({ best: "Chiikawa-SOL", reason: "terrible memory", rejected: ["A: bad", "B: worse"] });
  check("has a bold header", r.startsWith("⛔ <b>No deploy</b>"));
  check("names the best candidate", r.includes("best  Chiikawa-SOL"));
  check("includes the reason", r.includes("terrible memory"));
  check("lists rejections as bullets", r.includes("• A: bad") && r.includes("• B: worse"));
  check("caps the rejection list at 5", noDeployReport({ rejected: Array.from({ length: 20 }, (_, i) => `r${i}`) }).split("•").length - 1 === 5);
  check("empty input still renders a header", noDeployReport().startsWith("⛔"));
  check("escapes untrusted pool names", noDeployReport({ best: "<b>evil</b>" }).includes("&lt;b&gt;"));

  // runScreeningCycle carries screenReport as plain text and escapes it
  // wholesale at finalize, so tags emitted here would show up as literal
  // &lt;b&gt; in the chat.
  const plain = noDeployReport({ best: "X-SOL", reason: "thin", rejected: ["A — bad"], html: false });
  check("plain mode emits no HTML tags at all", !/<[a-z/]/i.test(plain));
  check("plain mode keeps the same structure", plain.includes("best  X-SOL") && plain.includes("• A — bad"));
  check("plain mode does not double-escape", !noDeployReport({ best: "a&b", html: false }).includes("&amp;"));
}

section("escapeHtml");
{
  check("escapes the three dangerous chars", escapeHtml('<a>&') === "&lt;a&gt;&amp;");
  check("handles nullish", escapeHtml(null) === "");
}

process.exit(finish());
