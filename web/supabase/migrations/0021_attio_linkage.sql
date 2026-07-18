-- Attio / Songpush reconciliation: flag creators that are already Songpush users and
-- keep the SongPush admin link. Written by reconcile_attio.py (matches tt_creators.handle
-- against Attio's users.user_name_tiktok; the unique key is Attio's url_tiktok_using_id).
alter table tt_creators add column if not exists is_songpush_user   boolean;
alter table tt_creators add column if not exists attio_record_id    text;
alter table tt_creators add column if not exists songpush_admin_url text;
alter table tt_creators add column if not exists attio_user_type    text;   -- Creator | Manager
alter table tt_creators add column if not exists attio_status       text;   -- Active | Billing Setup | ...
alter table tt_creators add column if not exists attio_checked_at   timestamptz;
create index if not exists tt_creators_songpush_idx on tt_creators (is_songpush_user);
