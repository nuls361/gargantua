-- =============================================================
-- Owned TikTok creator index (replaces ClickAnalytic as the Search backend).
--   tt_creators / tt_posts are the DISCOVERY POOL, kept separate from the
--   `creators` table (which is the outreach/working set the tool manages).
--   Naht A: clickanalytic-search reads tt_creators instead of the vendor API.
-- Additive only — does not touch existing tables.
-- =============================================================

create table if not exists tt_creators (
  sec_uid             text primary key,          -- stable TikTok key (handles change)
  handle              text,       -- the @username (uniqueId)
  tiktok_id           text,
  display_name        text,       -- TikTok "nickname" = the display name
  bio                 text,
  -- measured
  follower_count      integer,
  following_count     integer,
  heart_count         bigint,
  video_count         integer,
  verified            boolean,
  is_private          boolean,
  language            text,
  bio_link            text,
  -- derived (search-facing)
  email               text,
  email_source        text,
  email_type          text,      -- freemail | management | none | invalid
  country             text,       -- DE | AT | CH | GB
  country_confidence  real,
  dach_lang_ratio     real,
  engagement_median   real,       -- % (per-post, per creator)
  posting_per_week    real,
  sponsored_count     integer,
  -- categorization (primary = 1:1 with the Search niche filter)
  category            text,
  category_secondary  text,
  sub_niche           text,
  category_confidence real,
  category_source     text,
  -- precomputed at load so Search hits ONE table (no join)
  avg_views           bigint,
  posts_stored        integer,
  posts_90d           integer,
  last_post_at        timestamptz,
  -- housekeeping
  qualify_status      text,
  discovered_via      text,
  discovered_from     text,
  completeness        real,
  first_seen_at       timestamptz,
  last_enriched_at    timestamptz,
  tiktok_url          text generated always as ('https://www.tiktok.com/@' || handle) stored
);

create index if not exists tt_creators_category_idx   on tt_creators (category);
create index if not exists tt_creators_country_idx     on tt_creators (country);
create index if not exists tt_creators_followers_idx   on tt_creators (follower_count);
create index if not exists tt_creators_engagement_idx  on tt_creators (engagement_median);
create index if not exists tt_creators_handle_idx      on tt_creators (lower(handle));

create table if not exists tt_posts (
  aweme_id          text primary key,
  creator_sec_uid   text references tt_creators (sec_uid) on delete cascade,
  caption           text,
  hashtags          jsonb,
  mentions          jsonb,
  sound_id          text,
  sound_title       text,
  play              integer,
  digg              integer,
  comment           integer,
  share             integer,
  collect           integer,
  duration_s        real,
  region            text,
  desc_language     text,
  share_url         text,
  created_at        bigint
  -- embedding vector(N) added in the Stage-5 lookalike migration (pgvector)
);

create index if not exists tt_posts_creator_idx on tt_posts (creator_sec_uid);

-- Brands extracted from creators' post @-mentions — the advertiser-sales lead list.
create table if not exists tt_brands (
  brand             text primary key,   -- mentioned handle (lowercased)
  mentions          integer,            -- total @-mentions across the index
  distinct_creators integer,            -- how many different creators mention it (breadth)
  sponsored_posts   integer,            -- mentions in posts flagged sponsored
  example_creators  jsonb,              -- a few creator handles that mention it
  looks_like_brand  boolean,
  captured_at       timestamptz default now()
);
create index if not exists tt_brands_creators_idx on tt_brands (distinct_creators desc);

-- ---------- RLS ----------
-- Search runs as the authenticated user (anon key + session) and only READS.
-- The loader writes with the service-role key, which bypasses RLS.
alter table tt_creators enable row level security;
alter table tt_posts    enable row level security;
alter table tt_brands   enable row level security;

drop policy if exists "authenticated read" on tt_creators;
create policy "authenticated read" on tt_creators
  for select to authenticated using (true);

drop policy if exists "authenticated read" on tt_posts;
create policy "authenticated read" on tt_posts
  for select to authenticated using (true);

drop policy if exists "authenticated read" on tt_brands;
create policy "authenticated read" on tt_brands
  for select to authenticated using (true);
