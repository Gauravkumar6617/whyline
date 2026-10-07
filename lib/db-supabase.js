// Cloud storage: Supabase Postgres through its REST API (PostgREST), so no client dependency.
// Tables are created by supabase.sql. RLS is on with no policies, so only the service role key can read them.

const COLUMNS = 'id,ts,agent,kind,author,session,prompt,summary,files,commit_sha';

async function rest(path, init = {}) {
  // The Vercel Supabase integration sets NEXT_PUBLIC_SUPABASE_URL; plain SUPABASE_URL works too.
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY must be set');
  const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1${path}`, {
    ...init,
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

const insert = (table, row, query = '', prefer = '') =>
  rest(`/${table}?select=id${query}`, { method: 'POST', headers: { prefer: `return=representation${prefer}` }, body: JSON.stringify(row) })
    .then(([r]) => r?.id);

export const supabaseDb = {
  createWorkspace: (name, keyHash, ipHash) => insert('whyline_workspaces', { name, key_hash: keyHash, creator_ip_hash: ipHash }),

  // Hashes and shas are hex, ids/limits are integers (checked in handle.js), so they're safe in the query string.
  async countWorkspacesSince(ipHash, isoTime) {
    return (await rest(`/whyline_workspaces?select=id&creator_ip_hash=eq.${ipHash}&created_at=gte.${isoTime}`)).length;
  },

  async workspaceByHash(keyHash) {
    const [ws] = await rest(`/whyline_workspaces?select=id,name&key_hash=eq.${keyHash}`);
    return ws ?? null;
  },

  // Returns { id, duplicate }. ON CONFLICT DO NOTHING on the (workspace_id, event_id) unique index, so concurrent retries
  // store one row; an ignored row comes back empty and the stored one is looked up. event_id is [\w-] (handle.js).
  async insertEvent(e) {
    const row = { ...e };
    if (row.ts === null) delete row.ts; // let the column default (now()) apply
    const id = await insert('whyline_events', row, '&on_conflict=workspace_id,event_id', ',resolution=ignore-duplicates');
    if (id !== undefined) return { id, duplicate: false };
    const [stored] = await rest(`/whyline_events?select=id&workspace_id=eq.${e.workspace_id}&event_id=eq.${e.event_id}`);
    return { id: stored.id, duplicate: true };
  },

  listEvents: (workspaceId, { since, before, commit, limit }) =>
    rest(`/whyline_events?select=${COLUMNS}&workspace_id=eq.${workspaceId}&id=gt.${since}` +
      (before ? `&id=lt.${before}` : '') + (commit ? `&commit_sha=eq.${commit}` : '') + `&order=id.desc&limit=${limit}`),
};
