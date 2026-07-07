-- Local Trivia Ladder — monthly leaderboard schema (Supabase / Postgres)
-- =========================================================================
-- Backs the three RPCs the front-end calls in js/leaderboard.js:
--   submit_score(p_game, p_player, p_token, p_name, p_score)
--   rename_player(p_player, p_token, p_name)
--   get_leaderboard(p_game, p_month) -> [{ name, score, player_id }]
--
-- Design notes:
--  * No accounts. Each browser mints a random player_id + secret token and
--    keeps them in localStorage. The token is the only credential — the
--    FIRST write for a player_id claims it; later writes must match.
--  * Only the BEST score per (game, player, month) is kept. Months are keyed
--    'YYYY-MM' in America/New_York, so boards roll over at Vermont midnight
--    and past months stay "cemented".
--  * The tables are locked (RLS on, no policies). The anon key can ONLY reach
--    the data through the SECURITY DEFINER functions below, which run as the
--    owner and bypass RLS. Never grant direct table access to anon.
--
-- Safe to run more than once (idempotent).

-- ------------------------------------------------------------------ tables
create table if not exists public.players (
  player_id  uuid        primary key,
  token      text        not null,
  name       text        not null default 'Anonymous',
  created_at timestamptz not null default now()
);

create table if not exists public.scores (
  game       text        not null,
  player_id  uuid        not null references public.players(player_id) on delete cascade,
  month_key  text        not null,                  -- 'YYYY-MM' (America/New_York)
  score      integer     not null check (score >= 0),
  updated_at timestamptz not null default now(),
  primary key (game, player_id, month_key)
);

-- fast "top N for this game+month" reads
create index if not exists scores_board_idx
  on public.scores (game, month_key, score desc);

-- --------------------------------------------------------------------- lock
-- RLS on + no policies = no direct PostgREST access for anon/authenticated.
-- Everything must go through the RPCs below.
alter table public.players enable row level security;
alter table public.scores  enable row level security;

-- ----------------------------------------------------------------- helpers
-- Claim-or-verify a player_id against its token, and (re)set the name.
-- Raises 'bad token' if the id exists with a different token.
create or replace function public.claim_player(
  p_player uuid, p_token text, p_name text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
begin
  select token into v_token from players where player_id = p_player;

  if v_token is null then
    insert into players (player_id, token, name)
    values (p_player, p_token, left(coalesce(p_name, 'Anonymous'), 20));
  elsif v_token <> p_token then
    raise exception 'bad token';
  elsif coalesce(p_name, '') <> '' then
    update players set name = left(p_name, 20) where player_id = p_player;
  end if;
end;
$$;

-- -------------------------------------------------------------------- RPCs
create or replace function public.submit_score(
  p_game text, p_player uuid, p_token text, p_name text, p_score integer
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- ignore junk submissions rather than error out
  if p_score is null or p_score <= 0 or coalesce(p_name, '') = '' then
    return;
  end if;

  perform claim_player(p_player, p_token, p_name);

  insert into scores (game, player_id, month_key, score)
  values (
    p_game,
    p_player,
    to_char(now() at time zone 'America/New_York', 'YYYY-MM'),
    p_score
  )
  on conflict (game, player_id, month_key) do update
    set score      = greatest(scores.score, excluded.score),
        updated_at = now();
end;
$$;

create or replace function public.rename_player(
  p_player uuid, p_token text, p_name text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(p_name, '') = '' then
    return;
  end if;
  perform claim_player(p_player, p_token, p_name);
end;
$$;

-- Best-first, capped so a public anon key can't pull the whole table.
create or replace function public.get_leaderboard(
  p_game text, p_month text
) returns table (name text, score integer, player_id uuid)
language sql
security definer
set search_path = public
as $$
  select p.name, s.score, s.player_id
  from scores s
  join players p on p.player_id = s.player_id
  where s.game = p_game
    and s.month_key = p_month
  order by s.score desc, s.updated_at asc
  limit 100;
$$;

-- -------------------------------------------------------------------- grants
-- Deny direct table access; allow only the RPCs.
revoke all on public.players from anon, authenticated;
revoke all on public.scores  from anon, authenticated;

revoke all on function public.claim_player(uuid, text, text)                 from anon, authenticated;
grant execute on function public.submit_score(text, uuid, text, text, integer) to anon, authenticated;
grant execute on function public.rename_player(uuid, text, text)               to anon, authenticated;
grant execute on function public.get_leaderboard(text, text)                   to anon, authenticated;
