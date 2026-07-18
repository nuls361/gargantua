-- CSV / imported creators should carry a niche too. When we already know the creator
-- from the pool (tt_creators, categorized from posts), copy that category onto the CRM
-- row — free, no fetch. Backfill existing rows + keep it flowing on every new insert.
-- (Creators NOT in the pool still need a content fetch to categorize — that's the
-- worker's job, a follow-up.)

update creators c set category = t.category
from tt_creators t
where lower(c.handle) = lower(t.handle)
  and c.category is null and t.category is not null;

create or replace function tg_creator_pool_category() returns trigger language plpgsql as $$
begin
  if new.category is null and new.handle is not null then
    select category into new.category from tt_creators
    where lower(handle) = lower(new.handle) and category is not null limit 1;
  end if;
  return new;
end $$;

drop trigger if exists creator_pool_category on creators;
create trigger creator_pool_category before insert on creators
  for each row execute function tg_creator_pool_category();
