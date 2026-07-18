-- Pre-CRM redesign — axis 2: contact-state, denormalized onto creators.
-- Additive + non-breaking: the existing `status` column and its 4 writers keep working;
-- this adds an independent contact-memory so every view can show 🟢/🟡/✅/❌/⛔/⏳ at a glance
-- and the 60-day re-contact buffer can gate new batches. Full history stays in campaign_sends.

alter table creators add column if not exists first_contacted_at timestamptz;
alter table creators add column if not exists last_contacted_at  timestamptz;
alter table creators add column if not exists contact_count       int not null default 0;
alter table creators add column if not exists last_outcome        text;   -- sent|replied|bounced|unsubscribed|null
alter table creators add column if not exists next_eligible_at    timestamptz;
alter table creators add column if not exists do_not_contact      boolean not null default false;

create index if not exists creators_next_eligible_idx on creators (next_eligible_at);
create index if not exists creators_last_outcome_idx  on creators (last_outcome);

-- ---- Backfill from the send history (campaign_sends) + current status ----
with agg as (
  select creator_id, count(*) n, min(sent_at) first_at, max(sent_at) last_at
  from campaign_sends group by creator_id
)
update creators c set
  contact_count      = a.n,
  first_contacted_at = a.first_at,
  last_contacted_at  = a.last_at,
  next_eligible_at   = a.last_at + interval '60 days',
  last_outcome       = case
                         when c.status = 'replied'        then 'replied'
                         when c.status = 'bounced'        then 'bounced'
                         when c.status = 'do_not_contact' then 'unsubscribed'
                         else 'sent' end,
  do_not_contact     = (c.status = 'do_not_contact')
from agg a
where a.creator_id = c.id;

-- ---- Single source of truth for the contact-state pill (used by UI + segment RPCs) ----
-- 6 states -> ampeln: never🟢 · contacted🟡 · replied✅ · bounced❌ · dnc⛔ · cooldown⏳
create or replace function contact_state(
  p_last_outcome text, p_dnc boolean, p_next_eligible timestamptz, p_count int
) returns text language sql stable as $$
  select case
    when p_dnc or p_last_outcome = 'unsubscribed' then 'dnc'
    when p_last_outcome = 'bounced'               then 'bounced'
    when p_last_outcome = 'replied'               then 'replied'
    when coalesce(p_count, 0) = 0                  then 'never'
    when p_next_eligible is not null and p_next_eligible > now() then 'cooldown'
    else 'contacted'   -- contacted, cooldown elapsed, no reply -> eligible again (recycle)
  end
$$;
