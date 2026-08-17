-- Normalise week labels, merge the split slate, drop the abandoned week.
--
-- Run the SELECTs first and read them. Then run the UPDATEs and the DELETE.
-- Supabase will warn about a destructive operation on the last one; that is
-- correct, it deletes five rows.
--
-- Where the labels came from: the Sheet's week column was a date cell, so it
-- stringified to "Wed Sep 24 2025 00:00:00 GMT-0500 (Central Daylight Time)".
-- Sorted as text that orders by day name and then month name, which is why the
-- week dropdown had September above October.


-- ===========================================================================
-- 1. PREVIEW. Changes nothing. Check the "becomes" column looks right.
-- ===========================================================================
select
  week                                                        as current_label,
  to_char(
    to_date(substring(week from '^\w{3} (\w{3} \d{2} \d{4})'), 'Mon DD YYYY'),
    'YYYY-MM-DD')                                             as becomes,
  count(*)                                                    as picks,
  count(distinct user_name)                                   as players
from picks
where week ~ '^\w{3} \w{3} \d{2} \d{4}'
group by 1, 2
order by 2;

-- Anything NOT matching that shape is listed here. Expect no rows; if there
-- are any, they are left untouched by everything below and want a look.
select week, count(*) as picks
from picks
where week !~ '^\w{3} \w{3} \d{2} \d{4}'
group by 1;


-- ===========================================================================
-- 2. CONVERT to a sortable date. "Wed Sep 24 2025 ..." -> "2025-09-24"
--    Only rows in the old shape are touched, so this is safe to re-run: a
--    second pass matches nothing.
-- ===========================================================================
update picks
set week = to_char(
    to_date(substring(week from '^\w{3} (\w{3} \d{2} \d{4})'), 'Mon DD YYYY'),
    'YYYY-MM-DD')
where week ~ '^\w{3} \w{3} \d{2} \d{4}';


-- ===========================================================================
-- 3. MERGE the split slate.
--
--    One player submitted on Tuesday Sep 30 for the Wednesday Oct 1 slate, so
--    it became a week of its own. A week with one player has a guaranteed
--    winner, so that was a phantom week win in the standings - and the Oct 1
--    week was decided against a field of seven instead of eight.
-- ===========================================================================
update picks set week = '2025-10-01' where week = '2025-09-30';


-- ===========================================================================
-- 4. DELETE the abandoned final week.
--
--    2025-12-10 has one player and five picks, all still pending, so it can
--    never resolve and sits permanently undecided in the dropdown. Deleting
--    pending picks does not move anyone's record.
--
--    Look before you leap:
-- ===========================================================================
select user_name, status, count(*)
from picks where week = '2025-12-10'
group by 1, 2;

-- Then:
delete from picks where week = '2025-12-10';


-- ===========================================================================
-- 5. VERIFY. Weeks in real order, with a week number derived by position.
--    Expect 14 weeks, 40 picks each, 8 players - bar the last two.
-- ===========================================================================
select
  row_number() over (order by week)  as wk,
  week,
  count(*)                           as picks,
  count(distinct user_name)          as players
from picks
where week ~ '^\d{4}-\d{2}-\d{2}$'
group by week
order by week;
