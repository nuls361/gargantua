-- Brand management: curate the brands the scraper discovers, see their DACH yield,
-- and re-harvest with one click (insert a scrape_jobs row -> the Railway worker runs it).
-- The brands themselves are seeded from the source_brand tags already on tt_creators.

create table if not exists brands (
  id             bigint generated always as identity primary key,
  handle         text unique not null,      -- @kessberlin (canonical TikTok handle)
  name           text,
  market         text,                      -- dach | other | null (manual classification)
  status         text not null default 'candidate'
                 check (status in ('candidate','queued','harvested','good','rejected')),
  discovered_via text,                       -- harvest | ai_loop | apollo | manual
  notes          text,
  follower_count int,
  created_at     timestamptz not null default now()
);

-- seed from everything we've already harvested (proven brands with real yield)
insert into brands (handle, status, discovered_via)
select distinct source_brand, 'harvested', 'harvest'
from tt_creators
where source_brand is not null
on conflict (handle) do nothing;

-- live yield per brand, joined from tt_creators (always current, no denormalization)
create or replace view brand_overview as
select
  b.id, b.handle, b.name, b.market, b.status, b.discovered_via, b.notes,
  b.follower_count, b.created_at,
  coalesce(s.found, 0)    as creators_found,
  coalesce(s.dach, 0)     as creators_dach,
  coalesce(s.email, 0)    as creators_email,
  coalesce(s.enriched, 0) as creators_enriched,
  s.last_seen
from brands b
left join (
  select source_brand,
    count(*)                                         as found,
    count(*) filter (where market = 'dach')          as dach,
    count(*) filter (where email is not null)         as email,
    count(*) filter (where enrichment_status='enriched') as enriched,
    max(first_seen_at)                                as last_seen
  from tt_creators
  where source_brand is not null
  group by source_brand
) s on s.source_brand = b.handle;

alter table brands enable row level security;
create policy "brands full access" on brands for all to authenticated using (true) with check (true);
grant select, insert, update, delete on brands to authenticated;
grant select on brand_overview to authenticated;
