-- Real per-list counts (pipeline stage + contact state) so the workspace funnel and the
-- send button reflect the WHOLE list, not just the rows currently loaded into the table.
create or replace function list_stats(p_list_id uuid)
returns json language sql stable as $$
  select json_build_object(
    'total', (select count(*) from creators where list_id = p_list_id),
    'status', (
      select coalesce(json_object_agg(status, n), '{}'::json)
      from (select status, count(*) n from creators where list_id = p_list_id group by status) a
    ),
    'contact', (
      select coalesce(json_object_agg(cs, n), '{}'::json)
      from (
        select contact_state(last_outcome, do_not_contact, next_eligible_at, contact_count) cs,
               count(*) n
        from creators where list_id = p_list_id group by 1
      ) b
    )
  );
$$;

grant execute on function list_stats(uuid) to authenticated;
