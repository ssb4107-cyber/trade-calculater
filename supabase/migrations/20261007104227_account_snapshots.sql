-- Complete account snapshots. Direct writes are denied; privileged routines stay private.
create table public.silver_snapshots (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  documents jsonb not null check (jsonb_typeof(documents) = 'object' and octet_length(documents::text) <= 16777216),
  reason text not null check (reason in ('automatic', 'manual', 'before_restore')),
  created_at timestamptz not null default now()
);
create index silver_snapshots_owner_created_idx on public.silver_snapshots(owner_id, created_at desc, id desc);
alter table public.silver_snapshots enable row level security;
revoke all on public.silver_snapshots from public, anon, authenticated;
grant select on public.silver_snapshots to authenticated;
create policy silver_snapshots_read_own on public.silver_snapshots for select to authenticated
  using ((select auth.uid()) = owner_id);

create function silver_private.silver_snapshot_account(p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare owner uuid := auth.uid(); snapshot public.silver_snapshots; values_json jsonb;
begin
  if owner is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_reason is null or p_reason not in ('automatic', 'manual', 'before_restore') then raise exception 'Invalid reason'; end if;
  perform pg_advisory_xact_lock(hashtextextended(owner::text, 0));
  if p_reason = 'automatic' then
    select * into snapshot from public.silver_snapshots where owner_id = owner and reason = 'automatic'
      and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
      order by id desc limit 1;
    if found then return jsonb_build_object('id', snapshot.id::text, 'created_at', snapshot.created_at, 'reason', snapshot.reason); end if;
  end if;
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into values_json from public.silver_documents where owner_id = owner;
  if values_json = '{}'::jsonb and p_reason = 'automatic' then return null; end if;
  values_json := jsonb_build_object('portfolioStocks', '[]'::jsonb, 'silverStrategySettings', '{}'::jsonb, 'stockHistory', '[]'::jsonb) || values_json;
  insert into public.silver_snapshots(owner_id, documents, reason) values (owner, values_json, p_reason) returning * into snapshot;
  -- Keep at most 20 snapshots and ~36 MiB per account, always retaining the newest two.
  delete from public.silver_snapshots where owner_id = owner and id in (
    select id from (
      select id, row_number() over (order by created_at desc, id desc) as n,
        sum(octet_length(documents::text)) over (order by created_at desc, id desc) as bytes
      from public.silver_snapshots where owner_id = owner
    ) kept where n > 20 or (n > 2 and bytes > 37748736)
  );
  return jsonb_build_object('id', snapshot.id::text, 'created_at', snapshot.created_at, 'reason', snapshot.reason);
end; $$;

create function silver_private.silver_snapshot_before_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() = old.owner_id and coalesce(current_setting('silver.restoring', true), '') <> '1' then
    perform silver_private.silver_snapshot_account('automatic');
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end; $$;
create trigger silver_document_snapshot before update or delete on public.silver_documents
  for each row execute function silver_private.silver_snapshot_before_change();

create function public.silver_list_snapshots()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id::text, 'created_at', created_at, 'reason', reason)
    order by created_at desc, id desc), '[]'::jsonb)
  from public.silver_snapshots where owner_id = (select auth.uid());
$$;
create function public.silver_read_snapshot(p_id bigint)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select documents from public.silver_snapshots where id = p_id and owner_id = (select auth.uid());
$$;
create function public.silver_create_snapshot()
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select silver_private.silver_snapshot_account('manual');
$$;

create function silver_private.silver_restore_documents(p_values jsonb, p_versions jsonb, p_mutation uuid, p_owner uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare owner uuid := auth.uid(); k text; actual_version bigint; result jsonb; before_id jsonb; prior_setting text;
begin
  if owner is null or owner is distinct from p_owner then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(owner::text, 0));
  select m.result into result from public.silver_mutations m where owner_id = owner and mutation_id = p_mutation;
  if found then return result; end if;
  if p_mutation is null or jsonb_typeof(p_values) is distinct from 'object' or jsonb_typeof(p_versions) is distinct from 'object'
      or not p_values ?& array['portfolioStocks','silverStrategySettings','stockHistory']
      or exists(select 1 from jsonb_object_keys(p_values) keys(key) where key not in ('portfolioStocks','silverStrategySettings','stockHistory'))
      then raise exception 'Invalid restore'; end if;
  foreach k in array array['portfolioStocks','silverStrategySettings','stockHistory'] loop
    perform public.silver_validate_document(k, p_values->k);
    if jsonb_typeof(p_versions->k) is distinct from 'number' or (p_versions->>k)::numeric < 0
        or (p_versions->>k)::numeric <> trunc((p_versions->>k)::numeric) then raise exception 'Invalid version'; end if;
    select version into actual_version from public.silver_documents where owner_id = owner and key = k;
    if coalesce(actual_version, 0) <> (p_versions->>k)::bigint then
      return jsonb_build_object('restored', false, 'reason', 'conflict');
    end if;
  end loop;
  before_id := silver_private.silver_snapshot_account('before_restore');
  prior_setting := current_setting('silver.restoring', true);
  perform set_config('silver.restoring', '1', true);
  foreach k in array array['portfolioStocks','silverStrategySettings','stockHistory'] loop
    insert into public.silver_documents(owner_id, key, value, version) values (owner, k, p_values->k, 1)
      on conflict (owner_id, key) do update set value = excluded.value, version = silver_documents.version + 1, updated_at = now();
  end loop;
  perform set_config('silver.restoring', coalesce(prior_setting, ''), true);
  select jsonb_build_object('restored', true, 'before_snapshot', before_id,
    'documents', jsonb_agg(to_jsonb(d) order by key)) into result from public.silver_documents d where owner_id = owner;
  insert into public.silver_mutations(owner_id, mutation_id, result) values (owner, p_mutation, result);
  delete from public.silver_mutations where owner_id = owner and created_at < now() - interval '1 day';
  delete from public.silver_mutations where owner_id = owner and mutation_id in
    (select mutation_id from public.silver_mutations where owner_id = owner order by created_at desc offset 100);
  return result;
end; $$;
create function public.silver_restore_documents(p_values jsonb, p_versions jsonb, p_mutation uuid, p_owner uuid)
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select silver_private.silver_restore_documents(p_values, p_versions, p_mutation, p_owner);
$$;

revoke all on function silver_private.silver_snapshot_account(text), silver_private.silver_snapshot_before_change(),
  silver_private.silver_restore_documents(jsonb,jsonb,uuid,uuid) from public, anon, authenticated;
-- before_restore snapshots are made only inside the atomic restore routine.
grant execute on function silver_private.silver_snapshot_account(text), silver_private.silver_restore_documents(jsonb,jsonb,uuid,uuid) to authenticated;
revoke all on function public.silver_list_snapshots(), public.silver_read_snapshot(bigint), public.silver_create_snapshot(),
  public.silver_restore_documents(jsonb,jsonb,uuid,uuid) from public, anon;
grant execute on function public.silver_list_snapshots(), public.silver_read_snapshot(bigint), public.silver_create_snapshot(),
  public.silver_restore_documents(jsonb,jsonb,uuid,uuid) to authenticated;
