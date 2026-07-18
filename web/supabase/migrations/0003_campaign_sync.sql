-- =============================================================
-- Make `campaigns` a mirror of Instantly campaigns.
--  - unique key on instantly_campaign_id (upsert target for the sync)
--  - instantly_status: raw Instantly status code (0 draft,1 active,2 paused,3 done)
--  - synced_at: last time this row was refreshed from Instantly
-- The old UNIQUE(name) is dropped: Instantly is the source of truth via its id,
-- and two campaigns could in principle share a display name.
-- =============================================================

alter table campaigns drop constraint if exists campaigns_name_key;

alter table campaigns add column if not exists instantly_status int;
alter table campaigns add column if not exists synced_at timestamptz;

alter table campaigns drop constraint if exists campaigns_instantly_campaign_id_key;
alter table campaigns
  add constraint campaigns_instantly_campaign_id_key unique (instantly_campaign_id);
