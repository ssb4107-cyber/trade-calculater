-- Read-only deployment check; does not read or change any user's documents.
do $$
declare
  table_name text;
  function_name text;
begin
  foreach table_name in array array[
    'public.silver_documents', 'public.silver_recovery_backups',
    'public.silver_mutations', 'public.silver_market_limits'
  ] loop
    if not coalesce((select relrowsecurity from pg_class where oid = to_regclass(table_name)), false) then
      raise exception 'Missing table or RLS disabled: %', table_name;
    end if;
    if has_table_privilege('anon', table_name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege('authenticated', table_name, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'Unexpected direct access: %', table_name;
    end if;
  end loop;

  if not has_table_privilege('authenticated', 'public.silver_documents', 'SELECT')
    or not has_table_privilege('authenticated', 'public.silver_recovery_backups', 'SELECT')
    or has_table_privilege('authenticated', 'public.silver_mutations', 'SELECT')
    or has_table_privilege('authenticated', 'public.silver_market_limits', 'SELECT') then
    raise exception 'Unexpected authenticated read permissions';
  end if;

  foreach function_name in array array[
    'public.silver_read_all()', 'public.silver_read_document(text)',
    'public.silver_read_operation(uuid)',
    'public.silver_write_document(text,jsonb,bigint,uuid,text)',
    'public.silver_import_local(jsonb,jsonb,uuid)', 'public.silver_market_allow()'
  ] loop
    if to_regprocedure(function_name) is null then
      raise exception 'Missing function: %', function_name;
    end if;
    if has_function_privilege('anon', function_name, 'EXECUTE')
      or not has_function_privilege('authenticated', function_name, 'EXECUTE') then
      raise exception 'Unexpected function access: %', function_name;
    end if;
  end loop;

  if to_regprocedure('public.silver_validate_document(text,jsonb)') is null
    or has_function_privilege('anon', 'public.silver_validate_document(text,jsonb)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.silver_validate_document(text,jsonb)', 'EXECUTE') then
    raise exception 'Unexpected validation function access';
  end if;
end $$;

select 'PASS: storage schema, RLS and RPC permissions' as deployment_check;
