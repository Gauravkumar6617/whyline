import { DatabaseSync } from 'node:sqlite';

// Self-hosted / local storage. Same shape as lib/db-supabase.js.
export function sqliteDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      creator_ip_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
      ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      agent TEXT NOT NULL,
      kind TEXT NOT NULL,
      author TEXT, session TEXT, prompt TEXT, summary TEXT, files TEXT, commit_sha TEXT
    );
    CREATE INDEX IF NOT EXISTS events_ws ON events(workspace_id, id);
  `);

  return {
    async createWorkspace(name, keyHash, ipHash) {
      return Number(db.prepare('INSERT INTO workspaces (name, key_hash, creator_ip_hash) VALUES (?, ?, ?)').run(name, keyHash, ipHash).lastInsertRowid);
    },
    async countWorkspacesSince(ipHash, isoTime) {
      return db.prepare('SELECT count(*) AS n FROM workspaces WHERE creator_ip_hash = ? AND created_at >= ?').get(ipHash, isoTime).n;
    },
    async workspaceByHash(keyHash) {
      return db.prepare('SELECT id, name FROM workspaces WHERE key_hash = ?').get(keyHash) ?? null;
    },
    async insertEvent(e) {
      return Number(db.prepare(
        `INSERT INTO events (workspace_id, ts, agent, kind, author, session, prompt, summary, files, commit_sha)
         VALUES (?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(e.workspace_id, e.ts, e.agent, e.kind, e.author, e.session, e.prompt, e.summary, JSON.stringify(e.files), e.commit_sha)
        .lastInsertRowid);
    },
    async listEvents(workspaceId, { since, before, commit, limit }) {
      return db.prepare(
        `SELECT id, ts, agent, kind, author, session, prompt, summary, files, commit_sha
         FROM events WHERE workspace_id = ? AND id > ? AND (? IS NULL OR id < ?) AND (? IS NULL OR commit_sha = ?)
         ORDER BY id DESC LIMIT ?`,
      ).all(workspaceId, since, before, before, commit, commit, limit).map((e) => ({ ...e, files: JSON.parse(e.files) }));
    },
  };
}
