-- Carry reach signals from the harvest base (tt_creators) onto CRM/list members so a
-- list can be filtered by the SAME criteria as Search (followers, engagement).
-- Existing rows stay null (they predate the harvest base); new cuts from Search fill them.
alter table public.creators add column if not exists follower_count    integer;
alter table public.creators add column if not exists engagement_median real;

create index if not exists creators_follower_count_idx on public.creators (follower_count);
