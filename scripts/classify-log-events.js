#!/usr/bin/env node
/**
 * Scans logs/agent-*.log for anomaly-shaped log lines (tags ending in
 * _ERROR/_WARN, plus SAFETY_BLOCK and the bare WARN/ERROR tags), classifies
 * each one via util/event-codes.js, and prints a frequency report grouped
 * by code — so a recurring incident (Helius rate limits, deploy simulation
 * failures, hallucinated deploy reports, ...) shows up as one line with a
 * count instead of needing a fresh grep-and-diagnose session every time.
 *
 * Any line that doesn't match a known rule falls into GENERAL_ERROR — never
 * silently dropped — and this script prints a sample of what actually
 * landed there, specifically so those samples can be reviewed and, if a
 * real pattern emerges, promoted into util/event-codes.js.
 *
 * Usage:
 *   node scripts/classify-log-events.js                  # all available logs
 *   node scripts/classify-log-events.js --since=2026-09-01
 *   node scripts/classify-log-events.js --general-sample=20   # show more/fewer
 *                                                                GENERAL_ERROR examples
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { classifyEvent, EVENT_CODES } from "../util/event-codes.js";

const args = process.argv.slice(2);
const sinceArg = args.find((a) => a.startsWith("--since="))?.split("=")[1] ?? null;
const generalSampleSize = Number(args.find((a) => a.startsWith("--general-sample="))?.split("=")[1] ?? 5);

// Tags worth classifying — deliberately excludes pure operational tags
// (CRON, STATE, PNL_TICK, POSITIONS, DEPLOY, CLOSE, SCREENING, AGENT, ...)
// whose normal-path volume (hundreds of thousands of lines) would drown out
// the anomaly signal this report exists to surface.
const ANOMALY_TAG_PATTERN = /^(WARN|ERROR|[A-Z_]+_(WARN|ERROR))$/;

const logsDir = repoPath("logs");
const files = fs.readdirSync(logsDir)
  .filter((f) => /^agent-\d{4}-\d{2}-\d{2}\.log$/.test(f))
  .filter((f) => !sinceArg || f.slice(6, 16) >= sinceArg)
  .sort();

if (files.length === 0) {
  console.error(`No matching logs/agent-*.log files found${sinceArg ? ` since ${sinceArg}` : ""}.`);
  process.exit(1);
}

const LINE_RE = /^\[[\d\-T:.Z]+\]\s*\[([A-Z_]+)\]\s*(.*)$/;

const counts = new Map(); // code -> count
const examplesByCode = new Map(); // code -> [{date, message}]
let totalLines = 0;
let totalAnomalyLines = 0;

for (const file of files) {
  const date = file.slice(6, 16);
  const content = fs.readFileSync(`${logsDir}/${file}`, "utf8");
  for (const rawLine of content.split("\n")) {
    if (!rawLine) continue;
    totalLines++;
    const m = rawLine.match(LINE_RE);
    if (!m) continue;
    const [, tag, message] = m;
    if (!ANOMALY_TAG_PATTERN.test(tag)) continue;
    totalAnomalyLines++;

    const { code } = classifyEvent(tag, message);
    counts.set(code, (counts.get(code) ?? 0) + 1);
    if (!examplesByCode.has(code)) examplesByCode.set(code, []);
    const examples = examplesByCode.get(code);
    if (examples.length < generalSampleSize) examples.push({ date, message: message.slice(0, 160) });
  }
}

console.log(`Scanned ${files.length} log file(s) (${files[0].slice(6, 16)} → ${files[files.length - 1].slice(6, 16)}), ${totalLines} lines, ${totalAnomalyLines} anomaly-tagged.\n`);

const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
const codeWidth = Math.max(...sorted.map(([c]) => c.length), "CODE".length);
console.log(`${"CODE".padEnd(codeWidth)}  COUNT  CATEGORY       LABEL`);
console.log("─".repeat(codeWidth + 70));
for (const [code, count] of sorted) {
  const entry = EVENT_CODES[code] ?? { category: "?", label: "?" };
  console.log(`${code.padEnd(codeWidth)}  ${String(count).padStart(5)}  ${entry.category.padEnd(13)}  ${entry.label}`);
}

const generalCount = counts.get("GENERAL_ERROR") ?? 0;
if (generalCount > 0) {
  console.log(`\n⚠️  ${generalCount} unclassified event(s) fell into GENERAL_ERROR. Sample:`);
  for (const { date, message } of examplesByCode.get("GENERAL_ERROR")) {
    console.log(`  [${date}] ${message}`);
  }
  console.log(`\nIf any of these represent a real recurring pattern, add a rule for it in util/event-codes.js.`);
} else {
  console.log(`\nNo unclassified events — every anomaly-tagged line in this window matched a known pattern.`);
}
