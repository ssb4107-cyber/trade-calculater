-- Run on the deployed database as its administrator. Test users and documents
-- exist only inside this transaction and are rolled back. This checks database
-- authorization, not Supabase Auth login or a browser's session handling.
begin;
do $$
declare
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  operation uuid := gen_random_uuid();
  first_result jsonb;
  result jsonb;
  denied boolean;
  requests integer;
begin
  insert into auth.users(id) values (a), (b);
  perform set_config('request.jwt.claim.sub', a::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  first_result := public.silver_write_document('portfolioStocks', '[{"id":"live-A","positions":[]}]', 0, operation);
  if first_result->>'saved' is distinct from 'true' or first_result->'document'->>'owner_id' is distinct from a::text then
    raise exception 'Initial account-owned write failed';
  end if;
  result := public.silver_write_document('portfolioStocks', '[{"id":"live-A","positions":[]}]', 0, operation);
  if result is distinct from first_result then raise exception 'Idempotent retry failed'; end if;
  result := public.silver_write_document('portfolioStocks', '[]', 0, gen_random_uuid());
  if result->>'saved' is distinct from 'false' then raise exception 'Stale write accepted'; end if;
  result := public.silver_write_document('portfolioStocks', '[{"id":"live-A","positions":[]},{"id":"live-B","positions":[]}]', 1, gen_random_uuid());
  if result->'document'->>'version' is distinct from '2' then raise exception 'Versioned write failed'; end if;

  denied := false;
  begin
    update public.silver_documents set value = '[]' where owner_id = a;
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'Direct write allowed'; end if;
  denied := false;
  begin
    perform public.silver_write_document('portfolioStocks', '[{"id":"invalid","positions":[{"id":1,"buyQty":1,"buyPrice":10,"trades":[{"id":1,"type":"SELL","qty":2,"price":12}]}]}]', 2, gen_random_uuid());
  exception when raise_exception then denied := true;
  end;
  if not denied then raise exception 'Oversale accepted'; end if;
  for requests in 1..12 loop
    if public.silver_market_allow() is distinct from true then raise exception 'Quota rejected too early'; end if;
  end loop;
  if public.silver_market_allow() is distinct from false then raise exception 'Quota limit bypassed'; end if;

  perform set_config('request.jwt.claim.sub', b::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', b, 'role', 'authenticated')::text, true);
  if exists(select 1 from public.silver_read_all()) then raise exception 'Other account visible'; end if;
  if public.silver_read_operation(operation) is not null or silver_private.silver_read_operation(operation) is not null then
    raise exception 'Other account operation visible';
  end if;
  result := public.silver_import_local('{"portfolioStocks":[],"silverStrategySettings":{},"stockHistory":[]}', '{"portfolioStocks":"exact original text"}', gen_random_uuid());
  if result->>'imported' is distinct from 'true' or jsonb_array_length(result->'documents') <> 3 then
    raise exception 'Atomic import failed';
  end if;
  if not exists(select 1 from public.silver_recovery_backups where owner_id = b and original = 'exact original text') then
    raise exception 'Raw backup missing';
  end if;

  execute 'reset role';
  execute 'set local role anon';
  denied := false;
  begin
    perform public.silver_read_all();
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'Anonymous read allowed'; end if;
  execute 'reset role';
end $$;
rollback;
select 'PASS: deployed database isolation, CAS, idempotence, validation, import, quota; fixtures rolled back' as deployment_check;
