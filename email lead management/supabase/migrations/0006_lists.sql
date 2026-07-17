-- =============================================================
-- List-based lead management: source → list → enrich → Instantly.
-- Adds `lists`, extends `creators`, migrates backfilled leads into legacy lists.
-- =============================================================

create table if not exists lists (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  kind text not null default 'working' check (kind in ('working', 'legacy', 'filtered')),
  created_at timestamptz default now()
);

alter table lists enable row level security;
create policy "authenticated full access" on lists
  for all to authenticated using (true) with check (true);

-- System lists: one static Filtered bucket + the two legacy buckets.
insert into lists (name, kind) values
  ('Filtered', 'filtered'),
  ('UK Legacy', 'legacy'),
  ('DACH Legacy', 'legacy')
on conflict (name) do nothing;

-- ---- Extend creators for the list workflow ----
alter table creators add column if not exists list_id uuid references lists(id);
alter table creators add column if not exists platform text;
alter table creators add column if not exists handle text;
alter table creators add column if not exists enriched_payload jsonb;
alter table creators add column if not exists enriched_at timestamptz;
alter table creators add column if not exists filter_reason text;

create index if not exists creators_list_id_idx on creators (list_id);
create index if not exists creators_platform_handle_idx on creators (platform, handle);

-- New statuses: sourced (in a list, pre-enrich), enriched (passed cleaning),
-- filtered (failed cleaning, in the Filtered list).
alter table creators drop constraint if exists creators_status_check;
alter table creators add constraint creators_status_check
  check (status in (
    'new', 'queued', 'in_instantly', 'replied', 'bounced', 'do_not_contact',
    'sourced', 'enriched', 'filtered'
  ));

-- ---- Migrate the 8,561 backfilled leads into legacy lists ----
-- Region + list inferred from the campaign name.
update creators c
set list_id = (select id from lists where name = 'UK Legacy'),
    region_label = 'uk'
from campaigns ca
where c.campaign_id = ca.id
  and (ca.name like 'UK%' or ca.name like '%ENG%');

update creators c
set list_id = (select id from lists where name = 'DACH Legacy'),
    region_label = 'dach'
from campaigns ca
where c.campaign_id = ca.id
  and (ca.name like 'DE%' or ca.name like '%GER%' or ca.name = '2026_NewYear_Food');

-- Existing leads are TikTok; carry the handle over where we have one.
update creators set platform = 'tiktok' where platform is null;
update creators set handle = tiktok_username
  where handle is null and tiktok_username is not null;
