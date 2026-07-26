import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { reloadScreeningThresholds } from "./config.js";
import { notifyConfigChange } from "./telegram.js";

const USER_CONFIG_PATH = repoPath("user-config.json");

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const schema = process.env.SUPABASE_DB_SCHEMA;
  const table = process.env.SUPABASE_DB_TABLENAME;
  return { url, key, schema, table };
}

export function isSupabaseConfigEnabled() {
  const { url, key, schema, table } = getSupabaseConfig();
  return !!(url && key && schema && table);
}

function readUserConfig() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

// Pull all key/value rows from Supabase and merge them into the local
// user-config.json (remote wins). Reloads the in-memory config afterward
// so the screening section picks up changes without a restart — other
// sections still need a restart, same limitation as evolveThresholds().
export async function pullSupabaseConfig() {
  if (!isSupabaseConfigEnabled()) return null;
  const { url, key, schema, table } = getSupabaseConfig();
  try {
    const res = await fetch(`${url}/rest/v1/${table}?select=key,value`, {
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "accept-profile": schema,
      },
    });
    if (!res.ok) {
      log("supabase_config_warn", `pull failed: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
      return null;
    }
    const rows = await res.json();
    if (!Array.isArray(rows)) return null;

    const local = readUserConfig();
    const changes = [];
    for (const row of rows) {
      if (!row?.key) continue;
      const before = local[row.key];
      const beforeStr = JSON.stringify(before);
      const afterStr = JSON.stringify(row.value);
      if (beforeStr !== afterStr) {
        changes.push({ key: row.key, from: before === undefined ? "(unset)" : beforeStr, to: afterStr });
      }
      local[row.key] = row.value;
    }

    if (changes.length === 0) {
      log("supabase_config", `pulled ${rows.length} keys from Supabase (no changes, skipped write)`);
      return local;
    }

    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(local, null, 2));
    reloadScreeningThresholds();
    log("supabase_config", `pulled ${rows.length} keys from Supabase (${changes.length} changed)`);
    notifyConfigChange(changes, { source: "Supabase pull" }).catch(() => {});
    return local;
  } catch (error) {
    log("supabase_config_warn", `pull failed: ${error.message}`);
    return null;
  }
}

// Push the current local user-config.json up to Supabase as a per-key upsert.
// Requires a unique constraint on the `key` column for on_conflict to work.
export async function pushSupabaseConfig() {
  if (!isSupabaseConfigEnabled()) return null;
  const { url, key, schema, table } = getSupabaseConfig();
  const local = readUserConfig();
  const rows = Object.entries(local)
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, v]) => ({ key: k, value: v, updated_at: new Date().toISOString() }));
  if (rows.length === 0) return null;

  try {
    const res = await fetch(`${url}/rest/v1/${table}?on_conflict=key`, {
      method: "POST",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-profile": schema,
        "content-type": "application/json",
        prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    });
    if (!res.ok) {
      log("supabase_config_warn", `push failed: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
      return false;
    }
    log("supabase_config", `pushed ${rows.length} keys to Supabase`);
    return true;
  } catch (error) {
    log("supabase_config_warn", `push failed: ${error.message}`);
    return false;
  }
}

const PULL_INTERVAL_MS = 15 * 60 * 1000;
let _pullTimer = null;

export function startSupabaseConfigBackgroundSync() {
  if (!isSupabaseConfigEnabled() || _pullTimer) return null;
  _pullTimer = setInterval(() => {
    pullSupabaseConfig().catch(() => null);
  }, PULL_INTERVAL_MS);
  return _pullTimer;
}
