#!/usr/bin/env node
/**
 * Reconcile user-config.json with priority: Supabase > local > VPS.
 *
 * Called by scripts/pull-vps-state.sh after it copies the VPS's
 * user-config.json to a temp path (passed as argv[2]). Never invoked
 * standalone in normal use, but safe to run directly for a dry check:
 *
 *   node scripts/reconcile-user-config.js /path/to/vps-user-config.json
 *
 * What it does, in order:
 *   1. Pulls Supabase (if configured) via the existing pullSupabaseConfig() —
 *      remote wins on any key it has. This is the SAME pull path the running
 *      agent uses; nothing new is invented here.
 *   2. Fills any key still missing from the (now Supabase-merged) local file
 *      using the VPS copy — gap-fill ONLY. A key VPS has that local/Supabase
 *      also have is never overwritten by the VPS value.
 *   3. Prints a diff report: every key where the VPS copy disagrees with the
 *      final local value, so you can SEE what was deliberately not applied.
 *
 * Read-only against Supabase and the VPS copy. The only write is to this
 * machine's local user-config.json.
 */

import fs from "fs";
import { loadEnv } from "../util/envcrypt.js";
import { repoPath } from "../repo-root.js";

loadEnv();

const vpsConfigPath = process.argv[2];
if (!vpsConfigPath) {
  console.error("Usage: node scripts/reconcile-user-config.js <path-to-vps-user-config.json>");
  process.exit(1);
}

const LOCAL_PATH = repoPath("user-config.json");

function readJson(path, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

const { isSupabaseConfigEnabled, pullSupabaseConfig } = await import("../integrations/supabase-config.js");

// ── Step 1: Supabase > local (highest priority) ──────────────────
if (isSupabaseConfigEnabled()) {
  console.log("  [1/3] Pulling Supabase (highest priority)...");
  await pullSupabaseConfig();
} else {
  console.log("  [1/3] Supabase not configured — skipping (local stays authoritative)");
}

// ── Step 2: local > VPS (gap-fill only, lowest priority) ──────────
console.log("  [2/3] Filling gaps from the VPS copy (lowest priority — never overrides)...");
const local = readJson(LOCAL_PATH, {});
const vps = readJson(vpsConfigPath, {});

const filledFromVps = [];
for (const [key, value] of Object.entries(vps)) {
  if (!(key in local)) {
    local[key] = value;
    filledFromVps.push(key);
  }
}

if (filledFromVps.length > 0) {
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(local, null, 2));
  console.log(`    Filled ${filledFromVps.length} key(s) missing locally, from the VPS copy: ${filledFromVps.join(", ")}`);
} else {
  console.log("    No gaps — local already has every key the VPS copy has.");
}

// ── Step 3: diff report (informational, no further writes) ───────
console.log("  [3/3] Comparing final local value against the VPS copy, key by key...");
const diffs = [];
for (const [key, vpsValue] of Object.entries(vps)) {
  const localValue = local[key];
  if (JSON.stringify(localValue) !== JSON.stringify(vpsValue)) {
    diffs.push({ key, local: localValue, vps: vpsValue });
  }
}

if (diffs.length > 0) {
  console.log(`\n    ${diffs.length} key(s) differ from the VPS copy (local/Supabase value KEPT, VPS value ignored by design):`);
  for (const d of diffs) {
    console.log(`      ${d.key}: local=${JSON.stringify(d.local)}  vps=${JSON.stringify(d.vps)}`);
  }
} else {
  console.log("\n    user-config.json matches the VPS copy exactly for every shared key.");
}

console.log("\n  Nothing was written to Supabase or the VPS — read-only against both.");
