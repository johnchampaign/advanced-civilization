-- Apply this to your Supabase project (SQL editor or `supabase db push`).
-- The table prefix `dbf_` (digital boardgame framework) avoids collisions with
-- any other tables in your project.

create table if not exists dbf_games (
  game_id     text primary key,
  players     jsonb not null,
  tokens      jsonb not null,
  emails      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  resolved    boolean not null default false,
  reminder    jsonb                                  -- stale-turn-reminder bookkeeping (GameServer.sweepTurnReminders)
);
-- Existing databases created before the `reminder` column was added:
--   alter table dbf_games add column if not exists reminder jsonb;
create index if not exists dbf_games_active on dbf_games(game_id) where resolved = false;

create table if not exists dbf_snapshots (
  game_id     text not null references dbf_games(game_id) on delete cascade,
  turn        integer not null,
  state       text not null,
  created_at  timestamptz not null default now(),
  primary key (game_id, turn)
);
create index if not exists dbf_snapshots_latest on dbf_snapshots(game_id, turn desc);

-- Player-to-player chat — stored out of game state (never touches snapshots /
-- redaction). Sender seat is stamped server-side from the auth token.
create table if not exists dbf_messages (
  id          bigint generated always as identity primary key,
  game_id     text not null references dbf_games(game_id) on delete cascade,
  seat        text not null,
  body        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists dbf_messages_game on dbf_messages(game_id, created_at);

create table if not exists dbf_reports (
  report_id        text primary key,
  game_id          text not null,
  reporter_side    text not null,
  turn_number      integer not null,
  server_snapshot  text not null,
  reporter_view    text not null,
  client_log       jsonb not null default '[]'::jsonb,
  message          text not null,
  severity         text not null,
  category         text,                  -- game-defined area tag (e.g. 'multiplayer'); opaque to the framework
  app_id           text,                  -- deployment-stamped app identifier; isolates this game's reports on a shared backend
  client_build     text,
  user_agent       text,
  created_at       timestamptz not null default now(),
  resolution       jsonb
);
-- Existing databases created before the `category` column was added:
--   alter table dbf_reports add column if not exists category text;
-- Existing databases created before the `app_id` column was added:
--   alter table dbf_reports add column if not exists app_id text;
create index if not exists dbf_reports_created on dbf_reports(created_at desc);
create index if not exists dbf_reports_severity on dbf_reports(severity);
create index if not exists dbf_reports_category on dbf_reports(category);
create index if not exists dbf_reports_app on dbf_reports(app_id);
create index if not exists dbf_reports_unresolved on dbf_reports(report_id) where resolution is null;
create index if not exists dbf_reports_game on dbf_reports(game_id);

-- Row-level security — REQUIRED, not optional.
-- These tables hold secrets (dbf_games.tokens), unredacted game state
-- (dbf_snapshots.state — hidden hands!), and chat. All access goes through your
-- server endpoints using the SERVICE-ROLE key, which BYPASSES RLS. Enabling RLS
-- with NO policies therefore denies the public anon key everything (which is
-- now in client bundles for Realtime) while the server keeps full access.
-- Realtime *broadcast* doesn't touch these tables, so it's unaffected.
-- WITHOUT this, anyone with the project URL + anon key can read tokens and
-- everyone's hidden state. (Supabase flags it as rls_disabled_in_public.)
alter table dbf_games     enable row level security;
alter table dbf_snapshots enable row level security;
alter table dbf_messages  enable row level security;
alter table dbf_reports   enable row level security;
