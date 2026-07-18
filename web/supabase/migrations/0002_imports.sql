-- =============================================================
-- Import history: one row per CSV upload, with its filter/dedupe stats.
-- =============================================================

create table if not exists imports (
  id uuid primary key default gen_random_uuid(),
  file_name text,
  region_label text check (region_label in ('uk', 'dach')),
  total_rows int not null default 0,
  kept int not null default 0,
  inserted int not null default 0,
  skipped_duplicates int not null default 0,
  removed_breakdown jsonb,
  uploaded_by text,
  created_at timestamptz default now()
);

create index if not exists imports_created_at_idx on imports (created_at desc);

alter table imports enable row level security;

create policy "authenticated full access" on imports
  for all to authenticated using (true) with check (true);
