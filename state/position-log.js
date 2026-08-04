import { log } from "../logger.js";

function getSupabaseCreds() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const schema = process.env.SUPABASE_DB_SCHEMA;
  return { url, key, schema };
}

export function isPositionLogEnabled() {
  const { url, key, schema } = getSupabaseCreds();
  return !!(url && key && schema);
}

function headers({ schema, key, write = false }) {
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    ...(write ? { "content-profile": schema, "content-type": "application/json" } : { "accept-profile": schema }),
  };
}

async function getRow(table, positionId) {
  const { url, key, schema } = getSupabaseCreds();
  const res = await fetch(`${url}/rest/v1/${table}?position_id=eq.${encodeURIComponent(positionId)}&select=position_id`, {
    headers: headers({ schema, key }),
  });
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

// Insert a new deploy_position row (status defaults to 'open' on the table).
export async function recordDeploy(fields) {
  if (!isPositionLogEnabled()) return null;
  const { url, key, schema } = getSupabaseCreds();
  try {
    const res = await fetch(`${url}/rest/v1/deploy_position`, {
      method: "POST",
      headers: { ...headers({ schema, key, write: true }), prefer: "return=minimal" },
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      log("position_log_warn", `recordDeploy failed: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
      return false;
    }
    return true;
  } catch (error) {
    log("position_log_warn", `recordDeploy failed: ${error.message}`);
    return false;
  }
}

// Flip deploy_position.status to 'closed' and insert the matching closed_position row.
// If no deploy_position row exists yet (position predates this feature, or the
// deploy-side log call failed), insert a minimal placeholder first so the
// closed_position foreign key never fails.
export async function recordClose(fields) {
  if (!isPositionLogEnabled()) return null;
  const { url, key, schema } = getSupabaseCreds();
  const positionId = fields.position_id;
  if (!positionId) return null;

  try {
    const existing = await getRow("deploy_position", positionId);
    if (!existing) {
      const placeholderRes = await fetch(`${url}/rest/v1/deploy_position`, {
        method: "POST",
        headers: { ...headers({ schema, key, write: true }), prefer: "return=minimal,resolution=merge-duplicates" },
        body: JSON.stringify({ position_id: positionId, status: "closed" }),
      });
      if (!placeholderRes.ok) {
        log("position_log_warn", `recordClose placeholder insert failed: ${placeholderRes.status} ${await placeholderRes.text().catch(() => "")}`.slice(0, 300));
      }
    } else {
      const patchRes = await fetch(`${url}/rest/v1/deploy_position?position_id=eq.${encodeURIComponent(positionId)}`, {
        method: "PATCH",
        headers: { ...headers({ schema, key, write: true }), prefer: "return=minimal" },
        body: JSON.stringify({ status: "closed" }),
      });
      if (!patchRes.ok) {
        log("position_log_warn", `recordClose status update failed: ${patchRes.status} ${await patchRes.text().catch(() => "")}`.slice(0, 300));
      }
    }

    const insertRes = await fetch(`${url}/rest/v1/closed_position`, {
      method: "POST",
      headers: { ...headers({ schema, key, write: true }), prefer: "return=minimal,resolution=merge-duplicates" },
      body: JSON.stringify(fields),
    });
    if (!insertRes.ok) {
      log("position_log_warn", `recordClose insert failed: ${insertRes.status} ${await insertRes.text().catch(() => "")}`.slice(0, 300));
      return false;
    }
    return true;
  } catch (error) {
    log("position_log_warn", `recordClose failed: ${error.message}`);
    return false;
  }
}
