-- Phase 1 — team-facing scraper infrastructure (lives in lbug, the CRM project).
-- Additive only: no existing table is touched.
--   scrape_jobs        team + autonomous scrape requests (the work queue)
--   tt_creator_sources link table: creator <-> every source that surfaced them
--   spend_ledger       durable per-call spend, drives the budget governor
-- Plus: generalize the source tag on tt_creators (source_type / source_value).

-- ---------------------------------------------------------------- scrape_jobs
create table if not exists public.scrape_jobs (
  id           bigint generated always as identity primary key,
  source_type  text not null check (source_type in ('brand','hashtag','creator','sound')),
  source_value text not null,
  requested_by text,                                   -- team member; null = autonomous
  status       text not null default 'pending'
               check (status in ('pending','running','done','error','canceled')),
  options      jsonb not null default '{}'::jsonb,     -- {enrich, dach_only, pages, budget_usd}
  stats        jsonb not null default '{}'::jsonb,     -- {found, stored, enriched, spent_usd}
  error        text,
  priority     int   not null default 100,             -- lower = sooner (team < autonomous)
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
create index if not exists scrape_jobs_queue_idx
  on public.scrape_jobs (status, priority, created_at);

-- ------------------------------------------------------- tt_creator_sources
create table if not exists public.tt_creator_sources (
  sec_uid       text not null,
  source_type   text not null,
  source_value  text not null,
  job_id        bigint references public.scrape_jobs(id) on delete set null,
  requested_by  text,
  first_seen_at timestamptz not null default now(),
  primary key (sec_uid, source_type, source_value)
);
create index if not exists tt_creator_sources_secuid_idx
  on public.tt_creator_sources (sec_uid);

-- --------------------------------------------------------------- spend_ledger
create table if not exists public.spend_ledger (
  id      bigint generated always as identity primary key,
  ts      timestamptz not null default now(),
  job_id  bigint references public.scrape_jobs(id) on delete set null,
  channel text,                                        -- repost|hashtag|creator|sound|enrich|discover
  calls   int     not null default 1,
  usd     numeric not null default 0
);
create index if not exists spend_ledger_ts_idx on public.spend_ledger (ts);

-- ------------------------------------------- generalize source tag on creators
alter table public.tt_creators add column if not exists source_type      text;
alter table public.tt_creators add column if not exists source_value     text;
alter table public.tt_creators add column if not exists comment_de_ratio real;  -- audience-language rescue signal

-- ------------------------------------------------------------------------ RLS
-- Read-model for logged-in team members; the worker uses the service_role key
-- (bypasses RLS entirely). Matches the tt_creators/CRM policy shape.
alter table public.scrape_jobs        enable row level security;
alter table public.tt_creator_sources enable row level security;
alter table public.spend_ledger       enable row level security;

-- team can see + submit jobs
create policy "jobs read"   on public.scrape_jobs        for select to authenticated using (true);
create policy "jobs insert" on public.scrape_jobs        for insert to authenticated with check (true);
-- team can see the source tags (Search filter) and the spend
create policy "sources read" on public.tt_creator_sources for select to authenticated using (true);
create policy "spend read"   on public.spend_ledger        for select to authenticated using (true);

grant select, insert on public.scrape_jobs        to authenticated;
grant select          on public.tt_creator_sources to authenticated;
grant select          on public.spend_ledger        to authenticated;
