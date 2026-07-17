-- Free-text label applied to leads in bulk at import time (e.g. a niche,
-- source list, or batch tag), independent of the uk/dach region.
alter table creators add column if not exists label text;
create index if not exists creators_label_idx on creators (label);
