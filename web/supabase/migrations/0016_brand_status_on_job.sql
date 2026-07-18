-- Close the loop: when a brand scrape_job finishes, flip the brand from
-- candidate/queued -> harvested so the Brands page reflects reality automatically.
create or replace function tg_brand_status_on_job() returns trigger language plpgsql as $$
begin
  if new.source_type = 'brand' and new.status = 'done'
     and old.status is distinct from 'done' then
    update brands set status = 'harvested'
    where handle = new.source_value and status in ('candidate', 'queued');
  end if;
  return new;
end $$;

drop trigger if exists brand_status_on_job on scrape_jobs;
create trigger brand_status_on_job after update on scrape_jobs
  for each row execute function tg_brand_status_on_job();
