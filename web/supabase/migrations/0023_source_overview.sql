-- One overview for the non-brand discovery sources (sound / creator seed / hashtag):
-- per source_value, how many creators + DACH/UK yield. Powers the Sounds / Creator seeds
-- management pages (Brands keep their own table for curation status).
create or replace view source_overview as
select source_type, source_value,
  count(*)                                             as creators_found,
  count(*) filter (where market = 'dach')              as creators_dach,
  count(*) filter (where market = 'uk')                as creators_uk,
  count(*) filter (where email is not null)             as creators_email,
  count(*) filter (where enrichment_status = 'enriched') as creators_enriched,
  max(first_seen_at)                                    as last_seen
from tt_creators
where source_type in ('sound', 'creator', 'hashtag') and source_value is not null
group by source_type, source_value;
grant select on source_overview to authenticated;
