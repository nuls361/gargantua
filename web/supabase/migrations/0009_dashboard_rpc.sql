-- =============================================================
-- Dashboard: leads loaded per day (time series for the chart).
-- Returns one row per day with how many creators were added that day.
-- SQL function runs with the caller's RLS (authenticated can read creators).
-- =============================================================

create or replace function public.leads_by_day()
returns table(day date, n bigint)
language sql
stable
as $$
  select date_added::date as day, count(*)::bigint as n
  from creators
  group by 1
  order by 1;
$$;

grant execute on function public.leads_by_day() to authenticated;

-- Make PostgREST pick up the new function immediately.
notify pgrst, 'reload schema';
