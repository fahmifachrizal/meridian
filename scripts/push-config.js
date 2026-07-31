#!/usr/bin/env node
/**
 * Push the local user-config.json up to Supabase — OPERATOR ACTION ONLY.
 *
 * The agent never calls this. Supabase is the operator's source of truth and
 * the running agent only ever pulls from it (see supabase-config.js and the
 * note in tools/executor.js#applyConfigChanges). This script is the one
 * sanctioned way for a human to publish a new baseline.
 *
 * Run: node scripts/push-config.js [--yes]
 */

import { loadEnv } from "../util/envcrypt.js";
import { repoPath } from "../repo-root.js";
import fs from "fs";

loadEnv();

const { isSupabaseConfigEnabled, pushSupabaseConfig } = await import("../integrations/supabase-config.js");

if (!isSupabaseConfigEnabled()) {
  console.error("Supabase is not configured — set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_SCHEMA, SUPABASE_DB_TABLENAME in .env");
  process.exit(1);
}

const local = JSON.parse(fs.readFileSync(repoPath("user-config.json"), "utf8"));
const keys = Object.keys(local).filter((k) => !k.startsWith("_"));

// Secrets live in this file too — make the operator see that before publishing.
// Key name alone is too noisy (maxTokens, tokenCooldownHours, ...) — a real
// secret is a long opaque string, so require both signals.
const SECRETISH = /apikey|api_key|secret|mnemonic|private|passwd|password|_token$|^token$/i;
const secrets = keys.filter((k) => SECRETISH.test(k) && typeof local[k] === "string" && local[k].length > 20);

console.log(`About to push ${keys.length} keys to Supabase.`);
if (secrets.length > 0) {
  console.log(`\n  WARNING — these carry secret-looking values and will be stored in plaintext:`);
  for (const k of secrets) console.log(`    - ${k}`);
}

if (!process.argv.includes("--yes")) {
  console.log(`\nRe-run with --yes to confirm.`);
  process.exit(0);
}

const ok = await pushSupabaseConfig();
console.log(ok ? `Pushed ${keys.length} keys.` : "Push failed — see log above.");
process.exit(ok ? 0 : 1);
