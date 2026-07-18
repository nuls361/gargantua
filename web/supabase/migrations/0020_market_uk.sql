-- Market becomes a real dimension: dach | uk | other (was effectively dach/other).
-- Reclassify GB creators as UK and backfill the legacy null-market batch from country.
update tt_creators set market = 'uk'
  where country in ('GB', 'UK') and (market is null or market = 'other');
update tt_creators set market = 'dach'
  where country in ('DE', 'AT', 'CH') and market is null;
update tt_creators set market = 'other'
  where country is not null and country not in ('DE', 'AT', 'CH', 'GB', 'UK') and market is null;

-- brand_overview gains a UK yield column alongside DACH.
drop view if exists brand_overview;
create view brand_overview as
select
  b.id, b.handle, b.name, b.market, b.status, b.discovered_via, b.notes,
  b.follower_count, b.created_at,
  coalesce(s.found, 0)    as creators_found,
  coalesce(s.dach, 0)     as creators_dach,
  coalesce(s.uk, 0)       as creators_uk,
  coalesce(s.email, 0)    as creators_email,
  coalesce(s.enriched, 0) as creators_enriched,
  s.last_seen
from brands b
left join (
  select source_brand,
    count(*)                                             as found,
    count(*) filter (where market = 'dach')              as dach,
    count(*) filter (where market = 'uk')                as uk,
    count(*) filter (where email is not null)             as email,
    count(*) filter (where enrichment_status = 'enriched') as enriched,
    max(first_seen_at)                                    as last_seen
  from tt_creators where source_brand is not null group by source_brand
) s on s.source_brand = b.handle;

grant select on brand_overview to authenticated;
