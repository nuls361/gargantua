-- Keep contact-state live WITHOUT touching the edge functions: triggers react to the
-- writes those functions already make.
--   push-to-instantly  -> INSERTs campaign_sends  -> bump contact-state (a send happened)
--   instantly-webhook  -> UPDATEs creators.status  -> derive last_outcome / DNC / stop buffer

-- ---- a send happened (campaign_sends row) ----
create or replace function tg_bump_contact_on_send() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    update creators set
      contact_count      = contact_count + 1,
      first_contacted_at = least(coalesce(first_contacted_at, new.sent_at), new.sent_at),
      last_contacted_at  = greatest(coalesce(last_contacted_at, new.sent_at), new.sent_at),
      next_eligible_at   = new.sent_at + interval '60 days',
      last_outcome       = case when last_outcome in ('replied','bounced','unsubscribed')
                                then last_outcome else 'sent' end
    where id = new.creator_id;
  elsif new.sent_at is distinct from old.sent_at then          -- re-send to same campaign
    update creators set
      last_contacted_at = greatest(coalesce(last_contacted_at, new.sent_at), new.sent_at),
      next_eligible_at  = new.sent_at + interval '60 days'
    where id = new.creator_id;
  end if;
  return new;
end $$;

drop trigger if exists bump_contact_on_send on campaign_sends;
create trigger bump_contact_on_send after insert or update on campaign_sends
  for each row execute function tg_bump_contact_on_send();

-- ---- webhook set a status -> reflect it on the contact-state axis ----
create or replace function tg_sync_contact_on_status() returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'replied' then
      new.last_outcome := 'replied';
    elsif new.status = 'bounced' then
      new.last_outcome := 'bounced';
      new.next_eligible_at := null;              -- never re-contact a bounce
    elsif new.status = 'do_not_contact' then
      new.last_outcome := 'unsubscribed';
      new.do_not_contact := true;
      new.next_eligible_at := null;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists sync_contact_on_status on creators;
create trigger sync_contact_on_status before update on creators
  for each row execute function tg_sync_contact_on_status();
