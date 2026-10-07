-- Account-owned documents with atomic compare-and-swap and idempotent retries.
create table if not exists public.silver_documents (
  owner_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (key in ('portfolioStocks', 'silverStrategySettings', 'stockHistory')),
  value jsonb not null,
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  primary key (owner_id, key)
);
create table if not exists public.silver_recovery_backups (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  original text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.silver_mutations (
  owner_id uuid not null references auth.users(id) on delete cascade,
  mutation_id uuid not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, mutation_id)
);
alter table public.silver_documents enable row level security;
alter table public.silver_recovery_backups enable row level security;
alter table public.silver_mutations enable row level security;
create policy silver_documents_read_own on public.silver_documents for select to authenticated using ((select auth.uid()) = owner_id);
create policy silver_backups_read_own on public.silver_recovery_backups for select to authenticated using ((select auth.uid()) = owner_id);
revoke all on public.silver_documents, public.silver_recovery_backups, public.silver_mutations from anon, authenticated;
grant select on public.silver_documents, public.silver_recovery_backups to authenticated;

create or replace function public.silver_validate_document(p_key text, p_value jsonb)
returns void language plpgsql set search_path = '' as $$
declare s jsonb; p jsonb; t jsonb; ids text[]; pos_ids text[]; trade_ids text[]; sold numeric;
begin
  if p_value is null or octet_length(p_value::text) > 5242880 then raise exception 'Invalid document size'; end if;
  if p_key = 'silverStrategySettings' then
    if jsonb_typeof(p_value) <> 'object' or coalesce(p_value->>'finnhubApiKey', '') <> '' then raise exception 'Invalid settings'; end if;
  elsif p_key = 'stockHistory' then
    if jsonb_typeof(p_value) <> 'array' then raise exception 'Invalid history'; end if;
    ids := '{}';
    for p in select * from jsonb_array_elements(p_value) loop
      if jsonb_typeof(p->'id') is distinct from 'number' or (p->>'id') = any(ids)
          or jsonb_typeof(p->'price') is distinct from 'number' or jsonb_typeof(p->'pct') is distinct from 'number'
          or not coalesce((p->>'price')::numeric > 0 and (p->>'pct')::numeric > 0, false) then raise exception 'Invalid history item'; end if;
      ids := array_append(ids, p->>'id');
    end loop;
  elsif p_key = 'portfolioStocks' then
    if jsonb_typeof(p_value) <> 'array' then raise exception 'Invalid portfolio'; end if;
    ids := '{}';
    for s in select * from jsonb_array_elements(p_value) loop
      if not coalesce(jsonb_typeof(s->'id') = 'string' and length(s->>'id') > 0, false)
          or (s->>'id') = any(ids) or jsonb_typeof(s->'positions') is distinct from 'array' then raise exception 'Invalid stock identity'; end if;
      ids := array_append(ids, s->>'id'); pos_ids := '{}';
      for p in select * from jsonb_array_elements(s->'positions') loop
        if jsonb_typeof(p->'id') is distinct from 'number' or (p->>'id') = any(pos_ids)
            or jsonb_typeof(p->'buyQty') is distinct from 'number' or jsonb_typeof(p->'buyPrice') is distinct from 'number'
            or not coalesce((p->>'buyQty')::numeric >= 0 and (p->>'buyPrice')::numeric >= 0, false)
            or jsonb_typeof(p->'trades') is distinct from 'array' then raise exception 'Invalid position'; end if;
        pos_ids := array_append(pos_ids, p->>'id'); trade_ids := '{}'; sold := 0;
        for t in select * from jsonb_array_elements(p->'trades') loop
          if jsonb_typeof(t->'id') is distinct from 'number' or (t->>'id') = any(trade_ids)
              or jsonb_typeof(t->'qty') is distinct from 'number' or jsonb_typeof(t->'price') is distinct from 'number'
              or (t->>'type') is distinct from 'SELL'
              or not coalesce((t->>'qty')::numeric >= 0 and (t->>'price')::numeric >= 0, false) then raise exception 'Invalid sale'; end if;
          trade_ids := array_append(trade_ids, t->>'id'); sold := sold + (t->>'qty')::numeric;
        end loop;
        if sold > (p->>'buyQty')::numeric then raise exception 'Sale exceeds holding'; end if;
      end loop;
    end loop;
  else raise exception 'Invalid document key'; end if;
end; $$;
revoke all on function public.silver_validate_document(text, jsonb) from public, anon, authenticated;

create or replace function public.silver_read_all()
returns setof public.silver_documents language sql stable security invoker set search_path = '' as $$
  select * from public.silver_documents where owner_id = (select auth.uid());
$$;
create or replace function public.silver_read_document(p_key text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select to_jsonb(d) from public.silver_documents d where owner_id = (select auth.uid()) and key = p_key;
$$;

create or replace function public.silver_read_operation(p_mutation uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select result from public.silver_mutations where owner_id = (select auth.uid()) and mutation_id = p_mutation;
$$;
revoke all on function public.silver_read_operation(uuid) from public, anon;
grant execute on function public.silver_read_operation(uuid) to authenticated;

create or replace function public.silver_write_document(p_key text, p_value jsonb, p_version bigint, p_mutation uuid, p_backup text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare owner uuid := auth.uid(); current_doc public.silver_documents; result jsonb;
begin
  if owner is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(owner::text, 0));
  select m.result into result from public.silver_mutations m where owner_id = owner and mutation_id = p_mutation;
  if found then return result; end if;
  perform public.silver_validate_document(p_key, p_value);
  select * into current_doc from public.silver_documents where owner_id = owner and key = p_key for update;
  if coalesce(current_doc.version, 0) <> p_version then return jsonb_build_object('saved', false); end if;
  if p_backup is not null then
    if octet_length(p_backup) > 5242880 then raise exception 'Backup too large'; end if;
    insert into public.silver_recovery_backups(owner_id, key, original) values (owner, p_key, p_backup);
  end if;
  insert into public.silver_documents(owner_id, key, value, version) values (owner, p_key, p_value, 1)
    on conflict (owner_id, key) do update set value = excluded.value, version = silver_documents.version + 1, updated_at = now()
    returning * into current_doc;
  result := jsonb_build_object('saved', true, 'document', to_jsonb(current_doc));
  insert into public.silver_mutations(owner_id, mutation_id, result) values (owner, p_mutation, result);
  delete from public.silver_mutations where owner_id = owner and created_at < now() - interval '1 day';
  delete from public.silver_mutations where owner_id = owner and mutation_id in
    (select mutation_id from public.silver_mutations where owner_id = owner order by created_at desc offset 100);
  return result;
end; $$;

create or replace function public.silver_import_local(p_values jsonb, p_originals jsonb, p_mutation uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare owner uuid := auth.uid(); k text; result jsonb;
begin
  if owner is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(owner::text, 0));
  select m.result into result from public.silver_mutations m where owner_id = owner and mutation_id = p_mutation;
  if found then return result; end if;
  if exists(select 1 from public.silver_documents where owner_id = owner) then return jsonb_build_object('imported', false); end if;
  if octet_length(p_originals::text) > 15728640 then raise exception 'Backup too large'; end if;
  foreach k in array array['portfolioStocks', 'silverStrategySettings', 'stockHistory'] loop
    perform public.silver_validate_document(k, p_values->k);
    insert into public.silver_documents(owner_id, key, value) values(owner, k, p_values->k);
    if p_originals->>k is not null then insert into public.silver_recovery_backups(owner_id, key, original) values(owner, k, p_originals->>k); end if;
  end loop;
  select jsonb_build_object('imported', true, 'documents', jsonb_agg(to_jsonb(d))) into result
    from public.silver_documents d where owner_id = owner;
  insert into public.silver_mutations(owner_id, mutation_id, result) values(owner, p_mutation, result);
  return result;
end; $$;

revoke all on function public.silver_read_all(), public.silver_read_document(text), public.silver_write_document(text, jsonb, bigint, uuid, text), public.silver_import_local(jsonb, jsonb, uuid) from public, anon;
grant execute on function public.silver_read_all(), public.silver_read_document(text), public.silver_write_document(text, jsonb, bigint, uuid, text), public.silver_import_local(jsonb, jsonb, uuid) to authenticated;

-- Only authenticated members can request market data; limit external quota per account.
create table if not exists public.silver_market_limits (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  requests integer not null
);
alter table public.silver_market_limits enable row level security;
revoke all on public.silver_market_limits from anon, authenticated;
create or replace function public.silver_market_allow()
returns boolean language plpgsql security definer set search_path = '' as $$
declare owner uuid := auth.uid(); count_now integer;
begin
  if owner is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  insert into public.silver_market_limits values(owner, now(), 1)
    on conflict(owner_id) do update set
      requests = case when silver_market_limits.window_start < now() - interval '1 minute' then 1 else silver_market_limits.requests + 1 end,
      window_start = case when silver_market_limits.window_start < now() - interval '1 minute' then now() else silver_market_limits.window_start end
    returning requests into count_now;
  return count_now <= 12;
end; $$;
revoke all on function public.silver_market_allow() from public, anon;
grant execute on function public.silver_market_allow() to authenticated;
