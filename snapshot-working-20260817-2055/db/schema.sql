-- Pickem Now — Postgres schema
--
-- Paste the whole file into the Supabase SQL editor and run it. It is
-- idempotent: running it twice changes nothing the second time.
--
-- Design notes worth knowing before you change anything:
--
--   * `meta` stays jsonb rather than being flattened, because the Apps Script
--     grader reads it as a blob and flattening it would mean rewriting the one
--     piece of code you least want to touch. The numbers inside it are still
--     queryable — `line` and `total` are generated columns pulled out of the
--     json and stored as real numerics, so they index and aggregate like any
--     other column while the app carries on reading `meta`.
--
--   * Scores are `int` and nullable. Null means "not known", which is the
--     distinction the whole grader hangs on: a missing score must never be
--     read as nil-nil.

-- ---------------------------------------------------------------- helpers

-- A cast that returns null instead of raising. Generated columns need an
-- immutable expression that cannot fail, and `meta->>'line'` is free-form
-- text that occasionally isn't a number.
create or replace function to_num(t text)
returns numeric
language plpgsql
immutable
as $$
begin
  return t::numeric;
exception when others then
  return null;
end;
$$;

-- Profit on one unit staked, from American odds. A win at -110 returns 0.909,
-- a win at +150 returns 1.5, a loss is -1, a push is 0. Unpriced picks are
-- treated as -110, which is the standard number for a spread or a total.
create or replace function unit_pnl(status text, odds numeric)
returns numeric
language sql
immutable
as $$
  select case
    when status = 'win' then
      case when coalesce(nullif(odds, 0), -110) > 0
           then coalesce(nullif(odds, 0), -110) / 100.0
           else 100.0 / abs(coalesce(nullif(odds, 0), -110))
      end
    when status = 'loss' then -1.0
    else 0.0
  end;
$$;

-- ---------------------------------------------------------------- tables

-- Note for the migration: the Users sheet holds free text, so roles arrive as
-- '', 'Admin', ' admin ' and so on. They must be trimmed, lowercased and
-- defaulted to 'player' on the way in or this constraint rejects them.
create table if not exists users (
  email      text primary key,
  role       text not null default 'player'
             check (role in ('player', 'admin')),
  created_at timestamptz not null default now()
);

create table if not exists results (
  game_id     text primary key,
  league      text not null,
  home_team   text not null,
  away_team   text not null,
  home_score  int,                        -- null means unknown, never zero
  away_score  int,
  completed   boolean not null default false,
  commence    timestamptz,
  last_update timestamptz,
  fetched_at  timestamptz not null default now()
);

create table if not exists picks (
  id         text primary key,
  week       text not null,
  email      text not null,
  user_name  text not null,
  league     text not null,
  game_id    text not null,
  matchup    text,
  market     text not null,
  kind       text,
  selection  text,
  odds       numeric,
  meta       jsonb not null default '{}'::jsonb,
  -- An ungraded pick is the empty string in the sheet, not 'pending'. The
  -- migration has to map '' onto 'pending' or every ungraded row is rejected.
  status     text not null default 'pending'
             check (status in ('pending', 'win', 'loss', 'push')),
  created_at timestamptz not null default now(),

  -- Pulled out of meta so SQL can use them. Read-only: write to meta.
  line  numeric generated always as (to_num(meta ->> 'line'))  stored,
  total numeric generated always as (to_num(meta ->> 'total')) stored
);

-- ---------------------------------------------------------------- indexes

create index if not exists picks_week_idx    on picks (week);
create index if not exists picks_email_idx   on picks (lower(email));
create index if not exists picks_game_idx    on picks (game_id);
create index if not exists picks_user_idx    on picks (user_name);
-- The auto-grader asks for exactly this set every six hours.
create index if not exists picks_pending_idx on picks (game_id) where status = 'pending';
create index if not exists results_open_idx  on results (league) where not completed;

-- ---------------------------------------------------------------- views
-- These are for you, not for the app. The app still aggregates in Apps Script
-- so its existing tests keep protecting it; these exist so a SQL client or a
-- notebook can ask real questions.

-- The self-test week is scaffolding and must never appear in analysis.
create or replace view graded_picks as
  select * from picks
  where week <> '__selftest__'
    and status in ('win', 'loss', 'push');

-- One row per player per week.
create or replace view week_records as
  select week,
         user_name,
         count(*) filter (where status = 'win')     as wins,
         count(*) filter (where status = 'loss')    as losses,
         count(*) filter (where status = 'push')    as pushes,
         count(*) filter (where status = 'pending') as pending,
         count(*)                                   as total,
         round(sum(unit_pnl(status, odds)), 3)      as units
  from picks
  where week <> '__selftest__'
  group by week, user_name;

-- Who won each week. A week with anything still pending has no winner, which
-- is the same rule the scoreboard uses.
create or replace view week_winners as
  with decided as (
    select week from week_records group by week having sum(pending) = 0
  ),
  ranked as (
    select r.*, rank() over (partition by r.week order by r.wins desc, r.losses asc) as rk
    from week_records r join decided d using (week)
  )
  select week, user_name, wins, losses from ranked where rk = 1;

-- Season table.
create or replace view season_table as
  select user_name,
         (select count(*) from week_winners w where w.user_name = r.user_name) as weeks_won,
         sum(wins)   as wins,
         sum(losses) as losses,
         sum(pushes) as pushes,
         round(sum(wins)::numeric / nullif(sum(wins) + sum(losses), 0), 3) as win_pct,
         round(sum(units), 3) as units
  from week_records r
  group by user_name
  order by weeks_won desc, wins desc, losses asc;

-- Are you better on dogs or on chalk?
create or replace view record_by_side as
  select user_name,
         case when line > 0 then 'underdog'
              when line < 0 then 'favorite'
              else 'pickem' end as side,
         count(*) filter (where status = 'win')  as wins,
         count(*) filter (where status = 'loss') as losses,
         round(count(*) filter (where status = 'win')::numeric
               / nullif(count(*) filter (where status in ('win','loss')), 0), 3) as win_pct,
         round(sum(unit_pnl(status, odds)), 3) as units
  from graded_picks
  where market = 'spread' and line is not null
  group by user_name, side
  order by user_name, side;

-- Is the moneyline pick helping or is it a tax?
create or replace view record_by_market as
  select user_name, market,
         count(*) filter (where status = 'win')  as wins,
         count(*) filter (where status = 'loss') as losses,
         round(sum(unit_pnl(status, odds)), 3)   as units
  from graded_picks
  group by user_name, market
  order by user_name, market;

create or replace view record_by_league as
  select user_name, league,
         count(*) filter (where status = 'win')  as wins,
         count(*) filter (where status = 'loss') as losses,
         round(sum(unit_pnl(status, odds)), 3)   as units
  from graded_picks
  group by user_name, league
  order by user_name, league;

-- Every pick with the final score beside it. This is the one to join your EPA
-- and SP+ tables onto — it has the line, the result and the margin in one row.
create or replace view picks_with_results as
  select p.id, p.week, p.user_name, p.league, p.market, p.kind, p.selection,
         p.line, p.total, p.odds, p.status,
         r.home_team, r.away_team, r.home_score, r.away_score,
         (r.home_score - r.away_score)     as home_margin,
         (r.home_score + r.away_score)     as combined_score,
         unit_pnl(p.status, p.odds)        as units
  from picks p
  left join results r on r.game_id = p.game_id
  where p.week <> '__selftest__';

-- ---------------------------------------------------------------- security
-- The browser never talks to this database — it talks to Apps Script, which
-- holds the service key. So no anonymous role needs any access at all. RLS on
-- with no policies denies everyone except the service key, which bypasses it.

alter table picks   enable row level security;
alter table results enable row level security;
alter table users   enable row level security;

-- Privileges, stated outright rather than inherited.
--
-- The project is created with "automatically expose new tables" off, which is
-- the right setting — it means nothing reaches the Data API by accident. But
-- it also means default privileges will not hand these tables to anybody, so
-- the grants have to be explicit or PostgREST returns 404 for tables that
-- plainly exist. That failure looks like a missing table and wastes an hour.
--
-- Guarded by role existence so this file also runs on a plain Postgres that
-- has never heard of Supabase's roles.
do $$
declare
  r record;
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema public to service_role';
    execute 'grant all privileges on all tables in schema public to service_role';
    execute 'grant all privileges on all sequences in schema public to service_role';
    execute 'grant execute on all functions in schema public to service_role';
  end if;

  -- Belt and braces: whatever the project defaults were, the public roles get
  -- nothing. Every request arrives as service_role from Apps Script.
  for r in select rolname from pg_roles where rolname in ('anon', 'authenticated')
  loop
    execute format('revoke all on all tables in schema public from %I', r.rolname);
    execute format('revoke all on all sequences in schema public from %I', r.rolname);
  end loop;
end
$$;
