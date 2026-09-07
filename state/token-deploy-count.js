/**
 * Per-token (base_mint) historical deploy count — token-deploy-count.json.
 *
 * WHY THIS EXISTS
 * ---------------
 * pool-memory.json's per-entry `total_deploys` counts deploys into ONE
 * pool. The repeat-deploy-cooldown taper (see state/pool-memory.js) needs
 * a count of how many times a TOKEN has been deployed into, across every
 * pool it's ever traded in — a pump.fun graduation, a relaunch, or the
 * same token appearing under a different pool address would all be
 * undercounted by reading any single pool-memory.json entry alone.
 *
 * No such aggregate existed anywhere before this file. It's seeded once
 * from history by scripts/backfill-token-deploy-counts.js (sums
 * `deploys.length` across every pool-memory.json entry sharing a
 * base_mint), then kept live automatically — recordPoolDeploy() in
 * state/pool-memory.js calls incrementTokenDeployCount() on every closed
 * deploy going forward, so no further backfill is ever needed after the
 * one-time seed.
 *
 * Shape: `{ [base_mint]: { total_deploys, last_updated } }`.
 */

import { repoPath } from "../repo-root.js";
import { loadCached, saveJson } from "./json-store.js";

const TOKEN_DEPLOY_COUNT_FILE = repoPath("token-deploy-count.json");

function load() {
  return loadCached(TOKEN_DEPLOY_COUNT_FILE, () => ({}), "token_deploy_count");
}

function save(data) {
  saveJson(TOKEN_DEPLOY_COUNT_FILE, data, "token_deploy_count");
}

/** Current historical deploy count for `baseMint`. 0 if never seen. */
export function getTokenDeployCount(baseMint) {
  if (!baseMint) return 0;
  const db = load();
  return Number(db[baseMint]?.total_deploys ?? 0);
}

/**
 * Increment `baseMint`'s count by 1 and persist. Called once per closed
 * deploy (see state/pool-memory.js's recordPoolDeploy) — this is what
 * keeps the file accurate going forward with zero manual re-backfilling.
 * No-op (returns 0) if `baseMint` is falsy, matching every other
 * base-mint-scoped helper in this codebase (e.g. setBaseMintCooldown).
 */
export function incrementTokenDeployCount(baseMint) {
  if (!baseMint) return 0;
  const db = load();
  const entry = db[baseMint] ?? { total_deploys: 0 };
  entry.total_deploys = Number(entry.total_deploys ?? 0) + 1;
  entry.last_updated = new Date().toISOString();
  db[baseMint] = entry;
  save(db);
  return entry.total_deploys;
}

/**
 * Bulk-seed the whole file in one write — used only by
 * scripts/backfill-token-deploy-counts.js's one-time historical backfill.
 * `counts` is `{ [base_mint]: number }`; overwrites the file entirely
 * (the backfill script always recomputes from the full pool-memory.json
 * history, so a partial merge would just be stale data left behind).
 */
export function seedTokenDeployCounts(counts) {
  const now = new Date().toISOString();
  const db = {};
  for (const [baseMint, total] of Object.entries(counts)) {
    db[baseMint] = { total_deploys: total, last_updated: now };
  }
  save(db);
  return db;
}
