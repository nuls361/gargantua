-- Track how many existing leads an import enriched (updated), in addition to
-- how many were newly inserted.
alter table imports add column if not exists updated int not null default 0;
