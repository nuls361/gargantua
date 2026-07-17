-- =============================================================
-- Pre-CRM: TikTok creator email lead management
-- Initial schema, RLS, and seed data
-- =============================================================

-- ---------- Tables ----------

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  instantly_campaign_id text,
  created_at timestamptz default now()
);

create table if not exists creators (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  -- Cross-batch dedupe key. Imports upsert onConflict = email_normalized
  -- with ignoreDuplicates so re-importing the same address is a no-op.
  email_normalized text generated always as (lower(trim(email))) stored unique,
  tiktok_username text,
  region_label text check (region_label in ('uk', 'dach')),
  source_file text,
  status text default 'new'
    check (status in ('new', 'queued', 'in_instantly', 'replied', 'bounced', 'do_not_contact')),
  campaign_id uuid references campaigns(id),
  date_added timestamptz default now(),
  added_to_instantly_at timestamptz
);

create index if not exists creators_status_idx on creators (status);
create index if not exists creators_region_label_idx on creators (region_label);
create index if not exists creators_campaign_id_idx on creators (campaign_id);
-- NOTE: the UNIQUE constraint on email_normalized already creates a b-tree
-- index on that column, so a separate explicit index would be redundant.
-- (Kept as a comment intentionally rather than duplicating the index.)

create table if not exists blocked_domains (
  domain text primary key,
  reason text default 'agency',
  created_at timestamptz default now()
);

create table if not exists webhook_log (
  id bigint generated always as identity primary key,
  received_at timestamptz default now(),
  event_type text,
  lead_email text,
  payload jsonb
);

-- ---------- Row Level Security ----------
-- Frontend uses the anon key + a Supabase auth session; every table is
-- locked down to the `authenticated` role. Edge functions use the service
-- role key, which bypasses RLS entirely.

alter table campaigns enable row level security;
alter table creators enable row level security;
alter table blocked_domains enable row level security;
alter table webhook_log enable row level security;

create policy "authenticated full access" on campaigns
  for all to authenticated using (true) with check (true);

create policy "authenticated full access" on creators
  for all to authenticated using (true) with check (true);

create policy "authenticated full access" on blocked_domains
  for all to authenticated using (true) with check (true);

-- webhook_log: authenticated users may read the audit trail but not write it
-- (only the service-role edge function inserts rows).
create policy "authenticated read" on webhook_log
  for select to authenticated using (true);

-- ---------- Seed: known agency / management domains ----------

insert into blocked_domains (domain) values
  ('flairmgmt.com'),
  ('socialflairmanagement.com'),
  ('hushmanagement.co.uk'),
  ('musetheagency.com'),
  ('brothermodels.com'),
  ('thefourmodels.com'),
  ('beunscripted.co.uk'),
  ('grail-talent.com'),
  ('komi.group'),
  ('jadoremodels.co.uk'),
  ('m-models.co.uk'),
  ('nemesisdigital.co.uk'),
  ('burstcreators.com'),
  ('clickstalentagency.com'),
  ('be-talent.co.uk'),
  ('lensmgmt.com'),
  ('theangelsmgmt.com'),
  ('niche-commercial.com'),
  ('jaidemgmt.com'),
  ('aquariuscreative.co.uk'),
  ('lyntheagency.de'),
  ('nuancemanagement.de'),
  ('wantmoreagency.de'),
  ('tindler.de'),
  ('true-talent.de'),
  ('ykonic-talents.com'),
  ('lizaagency.com'),
  ('fameday.de'),
  ('socialcreate.de'),
  ('markenkinder.com'),
  ('arsagendi.com'),
  ('skylinemanagement.de'),
  ('heyems-mgmt.com'),
  ('pinksugaragency.de'),
  ('janinareich-agency.de'),
  ('notyourmanagement.de'),
  ('oezkanentertainment.com'),
  ('petillermanagement.com'),
  ('scoutedagency.com'),
  ('sareagency.com'),
  ('zodiacglobal.com'),
  ('migosmedia.com')
on conflict (domain) do nothing;
