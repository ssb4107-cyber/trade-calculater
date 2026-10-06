-- Keep privileged compound operations outside the Data API's public schema.
create schema if not exists silver_private;
revoke all on schema silver_private from public, anon;
grant usage on schema silver_private to authenticated;

alter function public.silver_read_operation(uuid) set schema silver_private;
alter function public.silver_write_document(text, jsonb, bigint, uuid, text) set schema silver_private;
alter function public.silver_import_local(jsonb, jsonb, uuid) set schema silver_private;
alter function public.silver_market_allow() set schema silver_private;

create function public.silver_read_operation(p_mutation uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select silver_private.silver_read_operation(p_mutation);
$$;
create function public.silver_write_document(p_key text, p_value jsonb, p_version bigint, p_mutation uuid, p_backup text default null)
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select silver_private.silver_write_document(p_key, p_value, p_version, p_mutation, p_backup);
$$;
create function public.silver_import_local(p_values jsonb, p_originals jsonb, p_mutation uuid)
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select silver_private.silver_import_local(p_values, p_originals, p_mutation);
$$;
create function public.silver_market_allow()
returns boolean language sql volatile security invoker set search_path = '' as $$
  select silver_private.silver_market_allow();
$$;

revoke all on function public.silver_read_operation(uuid),
  public.silver_write_document(text, jsonb, bigint, uuid, text),
  public.silver_import_local(jsonb, jsonb, uuid), public.silver_market_allow() from public, anon;
grant execute on function public.silver_read_operation(uuid),
  public.silver_write_document(text, jsonb, bigint, uuid, text),
  public.silver_import_local(jsonb, jsonb, uuid), public.silver_market_allow() to authenticated;

-- The original function grants move with their OIDs; explicitly preserve restrictions.
revoke all on all functions in schema silver_private from public, anon;
grant execute on all functions in schema silver_private to authenticated;

create index silver_recovery_backups_owner_created_idx on public.silver_recovery_backups(owner_id, created_at desc);
create index silver_mutations_owner_created_idx on public.silver_mutations(owner_id, created_at desc);
