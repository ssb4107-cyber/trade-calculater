-- Checks new permissions and runs synthetic account fixtures only inside a rollback.
-- Does not read or modify existing users' documents.
begin;
do $$
declare
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  operation uuid := gen_random_uuid();
  snapshot_id bigint;
  first_result jsonb;
  result jsonb;
  versions jsonb := '{"portfolioStocks":2,"silverStrategySettings":1,"stockHistory":1}';
  values_json jsonb := '{"portfolioStocks":[],"silverStrategySettings":{"darkMode":true},"stockHistory":[]}';
  signature text;
  denied boolean;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.silver_snapshots'::regclass)
    or has_table_privilege('anon', 'public.silver_snapshots', 'SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('authenticated', 'public.silver_snapshots', 'INSERT,UPDATE,DELETE')
    or not has_table_privilege('authenticated', 'public.silver_snapshots', 'SELECT') then
    raise exception 'Snapshot table permissions incorrect';
  end if;
  foreach signature in array array[
    'public.silver_list_snapshots()', 'public.silver_read_snapshot(bigint)',
    'public.silver_create_snapshot()', 'public.silver_restore_documents(jsonb,jsonb,uuid,uuid)'
  ] loop
    if has_function_privilege('anon', signature, 'EXECUTE')
      or not has_function_privilege('authenticated', signature, 'EXECUTE')
      or (select prosecdef from pg_proc where oid = to_regprocedure(signature)) then
      raise exception 'Snapshot public RPC permissions incorrect: %', signature;
    end if;
  end loop;
  if has_schema_privilege('anon', 'silver_private', 'USAGE') then
    raise exception 'Private schema exposed to anonymous requests';
  end if;
  insert into auth.users(id) values (a), (b);
  perform set_config('request.jwt.claim.sub', a::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perform public.silver_import_local(
    '{"portfolioStocks":[{"id":"synthetic-stock","positions":[]}],"silverStrategySettings":{},"stockHistory":[]}',
    '{}', gen_random_uuid());
  perform public.silver_write_document('portfolioStocks', '[]', 1, gen_random_uuid());
  perform public.silver_write_document('portfolioStocks', '[]', 2, gen_random_uuid());
  if (select count(*) from public.silver_snapshots where reason = 'automatic') <> 1 then
    raise exception 'Automatic daily backup duplicated or missing';
  end if;
  snapshot_id := (public.silver_create_snapshot()->>'id')::bigint;
  if public.silver_read_snapshot(snapshot_id) is null then raise exception 'Own backup unavailable'; end if;
  result := public.silver_restore_documents(values_json, versions, operation, a);
  if result->>'restored' is distinct from 'false' or result->>'reason' is distinct from 'conflict' then
    raise exception 'Stale restore accepted';
  end if;
  versions := jsonb_set(versions, '{portfolioStocks}', '3');
  first_result := public.silver_restore_documents(values_json, versions, operation, a);
  if first_result->>'restored' is distinct from 'true' or jsonb_array_length(first_result->'documents') <> 3 then
    raise exception 'Atomic account restore failed';
  end if;
  result := public.silver_restore_documents(values_json, versions, operation, a);
  if result is distinct from first_result then raise exception 'Restore retry duplicated'; end if;
  if (select count(*) from public.silver_snapshots where reason = 'before_restore') <> 1 then
    raise exception 'Pre-restore backup duplicated or missing';
  end if;
  if public.silver_read_snapshot((first_result->'before_snapshot'->>'id')::bigint)->'silverStrategySettings'
    is distinct from '{}'::jsonb then raise exception 'Pre-restore values not preserved'; end if;
  denied := false;
  begin
    delete from public.silver_snapshots where id = snapshot_id;
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'Direct backup delete accepted'; end if;
  perform set_config('request.jwt.claim.sub', b::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', b, 'role', 'authenticated')::text, true);
  if public.silver_list_snapshots() is distinct from '[]'::jsonb
    or public.silver_read_snapshot(snapshot_id) is not null then raise exception 'Other account backup visible'; end if;
  denied := false;
  begin
    perform public.silver_restore_documents(values_json, versions, gen_random_uuid(), a);
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'Account change bypassed restore ownership'; end if;
  execute 'reset role';
end $$;
rollback;
select 'PASS: snapshot permissions, daily backup, isolation, atomic restore, conflict, retry, pre-restore backup; fixtures rolled back' as deployment_check;
