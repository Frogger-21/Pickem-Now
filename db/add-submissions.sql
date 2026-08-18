-- ---------------------------------------------------------------- audit
-- Picks carry a timestamp, but resubmitting deletes the old rows and writes
-- new ones, so the picks alone can only say when somebody last wrote - never
-- that they wrote three times, or what changed between them.
--
-- This does not prevent anyone claiming to be anyone; the email field is still
-- the identity. It makes that visible, which is the thing usually wanted.

create table if not exists submissions (
  id        text primary key,
  at        timestamptz not null default now(),
  week      text not null,
  email     text not null,
  user_name text not null,
  picks     int  not null default 0,
  replaced  int  not null default 0
);

create index if not exists submissions_week_idx  on submissions (week);
create index if not exists submissions_email_idx on submissions (lower(email));

alter table submissions enable row level security;

-- Same grant story as the rest: service_role only, nothing for the public
-- roles. Repeated here so this block can be run on its own against an
-- existing database.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all privileges on table submissions to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table submissions from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table submissions from authenticated';
  end if;
end
$$;

-- Who resubmitted, and how often. The interesting rows are the ones above 1.
create or replace view submission_activity as
  select week, user_name,
         count(*)                    as submissions,
         min(at)                     as first_at,
         max(at)                     as last_at,
         sum(replaced)               as picks_replaced
  from submissions
  group by week, user_name
  order by week desc, last_at desc;
