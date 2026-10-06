// Cloud storage: Supabase Postgres through its REST API (PostgREST), so no client dependency.
// Tables are created by supabase.sql. RLS is on with no policies, so only the service role key can read them.

const COLUMNS = 'id,ts,agent,kind,author,session,prompt,summary,files,commit_sha';

async function rest(path, init = {}) {
  const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = process.env;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1${path}`, {
    ...init,
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

const insert = (table, row) =>
  rest(`/${table}?select=id`, { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify(row) })
    .then(([r]) => r.id);

export const supabaseDb = {
  createWorkspace: (name, keyHash) => insert('whyline_workspaces', { name, key_hash: keyHash }),

  // keyHash is hex, workspaceId/since/limit are integers (checked in handle.js), so they're safe in the query string.
  async workspaceByHash(keyHash) {
    const [ws] = await rest(`/whyline_workspaces?select=id,name&key_hash=eq.${keyHash}`);
    return ws ?? null;
  },

  async insertEvent(e) {
    const row = { ...e };
    if (row.ts === null) delete row.ts; // let the column default (now()) apply
    return insert('whyline_events', row);
  },

  listEvents: (workspaceId, since, limit) =>
    rest(`/whyline_events?select=${COLUMNS}&workspace_id=eq.${workspaceId}&id=gt.${since}&order=id.desc&limit=${limit}`),
};
