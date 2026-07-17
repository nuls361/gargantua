-- =============================================================
-- Send history + Recycle list.
-- creators.campaign_id only holds the *current* campaign. To know which
-- campaigns a creator has already received (and how many), we need a history:
-- one row per (creator, campaign) with the send date.
-- =============================================================

create table if not exists campaign_sends (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references creators(id) on delete cascade,
  campaign_id uuid references campaigns(id) on delete set null,
  sent_at timestamptz not null default now(),
  created_at timestamptz default now()
);

-- One row per creator↔campaign; re-sends to the same campaign refresh sent_at.
create unique index if not exists campaign_sends_uniq
  on campaign_sends (creator_id, campaign_id);
create index if not exists campaign_sends_creator_idx on campaign_sends (creator_id);
create index if not exists campaign_sends_sent_at_idx on campaign_sends (sent_at);

alter table campaign_sends enable row level security;
create policy "authenticated full access" on campaign_sends
  for all to authenticated using (true) with check (true);

-- Backfill from current state: every creator with a campaign has received it,
-- dated by when it went into Instantly.
insert into campaign_sends (creator_id, campaign_id, sent_at)
select id, campaign_id, coalesce(added_to_instantly_at, date_added)
from creators
where campaign_id is not null
on conflict (creator_id, campaign_id) do nothing;

-- ---- Recycle: creators not mailed in p_days, still active (in_instantly) ----
create or replace function public.recycle_candidates(p_days int default 30)
returns table(
  id uuid,
  handle text,
  tiktok_username text,
  email text,
  region_label text,
  label text,
  last_sent timestamptz,
  days_idle int,
  campaign_count bigint,
  campaigns text[]
)
language sql
stable
as $$
  select
    c.id, c.handle, c.tiktok_username, c.email, c.region_label, c.label,
    max(cs.sent_at) as last_sent,
    (extract(epoch from (now() - max(cs.sent_at))) / 86400)::int as days_idle,
    count(distinct cs.campaign_id) as campaign_count,
    array_agg(distinct ca.name) filter (where ca.name is not null) as campaigns
  from creators c
  join campaign_sends cs on cs.creator_id = c.id
  left join campaigns ca on ca.id = cs.campaign_id
  where c.status = 'in_instantly'
  group by c.id
  having max(cs.sent_at) <= now() - make_interval(days => p_days)
  order by max(cs.sent_at) asc
  limit 1000;
$$;
grant execute on function public.recycle_candidates(int) to authenticated;

create or replace function public.recycle_count(p_days int default 30)
returns bigint
language sql
stable
as $$
  select count(*) from (
    select c.id
    from creators c
    join campaign_sends cs on cs.creator_id = c.id
    where c.status = 'in_instantly'
    group by c.id
    having max(cs.sent_at) <= now() - make_interval(days => p_days)
  ) t;
$$;
grant execute on function public.recycle_count(int) to authenticated;

notify pgrst, 'reload schema';
