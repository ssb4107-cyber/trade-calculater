-- Six calendar months in Korea, independent of the querying session timezone.
alter table public.silver_trash add column expires_at timestamptz
  generated always as ((created_at at time zone 'Asia/Seoul' + interval '6 months') at time zone 'Asia/Seoul') stored;
create index silver_trash_expires_idx on public.silver_trash(expires_at);

alter policy silver_trash_read_own on public.silver_trash
  using ((select auth.uid()) = owner_id and expires_at > (select now()));

create or replace function public.silver_list_trash()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',id::text,'kind',kind,'label',label,
    'created_at',created_at,'expires_at',expires_at) order by created_at desc,id desc),'[]'::jsonb)
    from public.silver_trash where owner_id = (select auth.uid()) and expires_at > now();
$$;

create or replace function silver_private.silver_keep_deleted(p_kind text, p_label text, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare owner uuid := auth.uid(); n bigint; bytes bigint;
begin
  if owner is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(owner::text, 0));
  -- Expired items do not prevent a new deletion even before the scheduled cleanup.
  delete from public.silver_trash where owner_id = owner and expires_at <= now();
  select count(*), coalesce(sum(octet_length(payload::text)),0) into n, bytes from public.silver_trash where owner_id = owner;
  if n >= 200 or bytes + octet_length(p_payload::text) > 20971520 then raise exception 'Trash full'; end if;
  insert into public.silver_trash(owner_id, kind, label, payload) values(owner, p_kind, left(p_label,500), p_payload);
end; $$;

create or replace function silver_private.silver_trash_action(p_id bigint, p_action text, p_mutation uuid, p_owner uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare owner uuid := auth.uid(); entry public.silver_trash; doc public.silver_documents; result jsonb;
  v jsonb; s jsonb; p jsonb; item jsonb; si integer; pi integer; k text; largest numeric;
begin
  if owner is null or owner is distinct from p_owner then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_mutation is null or p_action is null or p_action not in ('restore','delete','empty') then raise exception 'Invalid trash action'; end if;
  perform pg_advisory_xact_lock(hashtextextended(owner::text,0));
  select m.result into result from public.silver_mutations m where owner_id = owner and mutation_id = p_mutation;
  if found then return result; end if;
  if p_action = 'empty' then
    delete from public.silver_trash where owner_id = owner;
    result := '{"done":true}'::jsonb;
  else
    select * into entry from public.silver_trash where owner_id = owner and id = p_id for update;
    if not found then raise exception 'Trash item missing'; end if;
    if p_action = 'delete' then
      delete from public.silver_trash where owner_id = owner and id = p_id;
      result := '{"done":true}'::jsonb;
    else
      -- Enforce expiry on the server, including a list left open before its deadline.
      if entry.expires_at <= now() then raise exception 'Trash item expired'; end if;
      k := case when entry.kind = 'history' then 'stockHistory' else 'portfolioStocks' end;
      select * into doc from public.silver_documents where owner_id = owner and key = k for update;
      v := coalesce(doc.value,'[]'::jsonb); item := entry.payload->'item';
      if entry.kind = 'stock' then
        if exists(select 1 from jsonb_array_elements(v) e where e->>'id' = item->>'id') then raise exception 'Restore duplicate'; end if;
        v := v || jsonb_build_array(item);
      elsif entry.kind = 'history' then
        if exists(select 1 from jsonb_array_elements(v) e join jsonb_array_elements(item) t on e->>'id' = t->>'id') then raise exception 'Restore duplicate'; end if;
        v := item || v;
      else
        select (ordinality-1)::integer, e into si,s from jsonb_array_elements(v) with ordinality e(e,ordinality)
          where e->>'id' = entry.payload->>'stock_id';
        if s is null then raise exception 'Restore parent missing'; end if;
        if entry.kind = 'position' then
          if exists(select 1 from jsonb_array_elements(s->'positions') e where e->>'id' = item->>'id') then raise exception 'Restore duplicate'; end if;
          if exists(select 1 from jsonb_array_elements(s->'positions') e where e->>'number' = item->>'number') then
            select coalesce(max((e->>'number')::numeric),0)+1 into largest from jsonb_array_elements(s->'positions') e;
            item := item || jsonb_build_object('number',largest);
          end if;
          v := jsonb_set(v,array[si::text,'positions'],(s->'positions') || jsonb_build_array(item));
        else
          select (ordinality-1)::integer,e into pi,p from jsonb_array_elements(s->'positions') with ordinality e(e,ordinality)
            where e->>'id' = entry.payload->>'position_id';
          if p is null then raise exception 'Restore parent missing'; end if;
          if exists(select 1 from jsonb_array_elements(p->'trades') e where e->>'id' = item->>'id') then raise exception 'Restore duplicate'; end if;
          v := jsonb_set(v,array[si::text,'positions',pi::text,'trades'],(p->'trades') || jsonb_build_array(item));
        end if;
      end if;
      perform public.silver_validate_document(k,v);
      if k = 'portfolioStocks' then v := silver_private.silver_recalculate_portfolio(v); end if;
      insert into public.silver_documents(owner_id,key,value,version) values(owner,k,v,1)
        on conflict(owner_id,key) do update set value = excluded.value, version = silver_documents.version+1, updated_at = now() returning * into doc;
      delete from public.silver_trash where owner_id = owner and id = p_id;
      result := jsonb_build_object('done',true,'document',to_jsonb(doc));
    end if;
  end if;
  insert into public.silver_mutations(owner_id,mutation_id,result) values(owner,p_mutation,result);
  delete from public.silver_mutations where owner_id = owner and created_at < now()-interval '1 day';
  delete from public.silver_mutations where owner_id = owner and mutation_id in
    (select mutation_id from public.silver_mutations where owner_id = owner order by created_at desc offset 100);
  return result;
end; $$;

revoke all on function silver_private.silver_keep_deleted(text,text,jsonb) from public, anon, authenticated;
revoke all on function silver_private.silver_trash_action(bigint,text,uuid,uuid) from public, anon;
grant execute on function silver_private.silver_trash_action(bigint,text,uuid,uuid) to authenticated;
revoke all on function public.silver_list_trash() from public, anon;
grant execute on function public.silver_list_trash() to authenticated;

-- Hosted Supabase has pg_cron. Embedded PostgreSQL tests have no scheduler extension.
do $schedule$
begin
  if exists(select 1 from pg_available_extensions where name = 'pg_cron') then
    execute 'create extension if not exists pg_cron with schema pg_catalog';
    execute 'revoke all on schema cron from public, anon, authenticated';
    execute 'grant usage on schema cron to postgres';
    execute 'grant all privileges on all tables in schema cron to postgres';
    execute $job$select cron.schedule('silver-trash-retention', '0 * * * *',
      'delete from public.silver_trash where expires_at <= now();')$job$;
  end if;
end;
$schedule$;
