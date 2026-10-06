-- Whyline tables. Run once in the Supabase SQL editor.
-- Prefixed so they can share a project with other apps.

create table if not exists whyline_workspaces (
  id bigint generated always as identity primary key,
  name text not null,
  key_hash text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists whyline_events (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references whyline_workspaces(id) on delete cascade,
  ts timestamptz not null default now(),
  agent text not null,
  kind text not null,
  author text,
  session text,
  prompt text,
  summary text,
  files jsonb not null default '[]',
  commit_sha text
);

create index if not exists whyline_events_ws on whyline_events (workspace_id, id);

-- RLS on with no policies: the anon/public key gets nothing; only the server's service role key can read or write.
alter table whyline_workspaces enable row level security;
alter table whyline_events enable row level security;
