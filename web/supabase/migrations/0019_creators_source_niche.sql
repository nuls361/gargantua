-- Carry niche + provenance into the CRM working set when a creator is sourced from
-- the pool (tt_creators) into a list. Closes the "source label + interest in the CRM" gap.
alter table creators add column if not exists category     text;
alter table creators add column if not exists source_type  text;   -- brand|hashtag|creator|sound
alter table creators add column if not exists source_value text;   -- @brand / #tag / sound:id / @seed
create index if not exists creators_handle_lower_idx on creators (lower(handle));
