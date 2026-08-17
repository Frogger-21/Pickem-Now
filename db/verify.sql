-- Run after schema.sql. Confirms the objects exist, the privileges landed, and
-- the generated columns actually compute — the three things "Success. No rows
-- returned" does not tell you.
--
-- Expected output:
--
--   tables                           | picks, results, users
--   views                            | graded_picks, picks_with_results,
--                                    | record_by_league, record_by_market,
--                                    | record_by_side, season_table,
--                                    | week_records, week_winners
--   generated columns                | picks.line, picks.total
--   service_role grants              | non-zero, across 3 tables
--   anon grants (must be 0)          | 0
--   authenticated grants (must be 0) | 0
--   probe: line / total              | -6.5 / 47.5
--   probe: unparseable number        | null (correct)

-- Two probe rows. Inserted as their own statement because a data-modifying
-- WITH is only legal at the top level of a query — inside a subquery Postgres
-- rejects it outright.
insert into picks (id, week, email, user_name, league, game_id, market, meta) values
  ('__verify_probe1__', '__verify__', 'probe@example.invalid', 'probe',
   'NFL', '__verify__', 'spread', '{"line":-6.5,"total":47.5}'::jsonb),
  ('__verify_probe2__', '__verify__', 'probe@example.invalid', 'probe',
   'NFL', '__verify__', 'spread', '{"line":"pk"}'::jsonb);

select 'tables' as check, coalesce(string_agg(table_name, ', ' order by table_name), '(none)') as result
from information_schema.tables
where table_schema = 'public' and table_type = 'BASE TABLE'

union all
select 'views', coalesce(string_agg(table_name, ', ' order by table_name), '(none)')
from information_schema.views
where table_schema = 'public'

union all
select 'generated columns', coalesce(string_agg(table_name || '.' || column_name, ', ' order by column_name), '(NONE — to_num failed)')
from information_schema.columns
where table_schema = 'public' and is_generated = 'ALWAYS'

union all
select 'service_role grants', count(*)::text || ' privileges across ' || count(distinct table_name)::text || ' table(s)'
from information_schema.role_table_grants
where grantee = 'service_role' and table_schema = 'public'

union all
select 'anon grants (must be 0)', count(*)::text
from information_schema.role_table_grants
where grantee = 'anon' and table_schema = 'public'

union all
select 'authenticated grants (must be 0)', count(*)::text
from information_schema.role_table_grants
where grantee = 'authenticated' and table_schema = 'public'

-- The real test of to_num() and the generated columns: the values below were
-- never written, only the jsonb was. If they are right, the whole mechanism
-- the app depends on works.
union all
select 'probe: line / total',
       coalesce(line::text, '?') || ' / ' || coalesce(total::text, '?')
from picks where id = '__verify_probe1__'

union all
select 'probe: unparseable number',
       coalesce(line::text, 'null (correct)')
from picks where id = '__verify_probe2__';

delete from picks where week = '__verify__';
