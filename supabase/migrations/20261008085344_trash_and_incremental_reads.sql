-- Removed items are captured in the same transaction as the document write.
create table public.silver_trash (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('stock','position','trade','history')),
  label text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index silver_trash_owner_created_idx on public.silver_trash(owner_id, created_at desc, id desc);
alter table public.silver_trash enable row level security;
revoke all on public.silver_trash from public, anon, authenticated;
grant select on public.silver_trash to authenticated;
create policy silver_trash_read_own on public.silver_trash for select to authenticated
  using ((select auth.uid()) = owner_id);

create function silver_private.silver_keep_deleted(p_kind text, p_label text, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare owner uuid := auth.uid(); n bigint; bytes bigint;
begin
  if owner is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(owner::text, 0));
  select count(*), coalesce(sum(octet_length(payload::text)),0) into n, bytes from public.silver_trash where owner_id = owner;
  if n >= 200 or bytes + octet_length(p_payload::text) > 20971520 then raise exception 'Trash full'; end if;
  insert into public.silver_trash(owner_id, kind, label, payload) values(owner, p_kind, left(p_label,500), p_payload);
end; $$;

create function silver_private.silver_capture_deleted()
returns trigger language plpgsql security definer set search_path = '' as $$
declare s jsonb; ns jsonb; p jsonb; np jsonb; t jsonb; removed jsonb;
begin
  if auth.uid() is distinct from old.owner_id or coalesce(current_setting('silver.restoring', true),'') = '1' then return new; end if;
  if old.key = 'portfolioStocks' then
    for s in select * from jsonb_array_elements(old.value) loop
      select item into ns from jsonb_array_elements(new.value) item where item->>'id' = s->>'id';
      if ns is null then
        perform silver_private.silver_keep_deleted('stock', coalesce(s->>'displayName',s->>'name',s->>'symbol',s->>'id'), jsonb_build_object('item',s));
        continue;
      end if;
      for p in select * from jsonb_array_elements(s->'positions') loop
        select item into np from jsonb_array_elements(ns->'positions') item where item->>'id' = p->>'id';
        if np is null then
          perform silver_private.silver_keep_deleted('position', coalesce(s->>'displayName',s->>'id') || ' · 포지션 #' || coalesce(p->>'number',p->>'id'),
            jsonb_build_object('item',p,'stock_id',s->>'id'));
          continue;
        end if;
        for t in select * from jsonb_array_elements(p->'trades') loop
          if not exists(select 1 from jsonb_array_elements(np->'trades') item where item->>'id' = t->>'id') then
            perform silver_private.silver_keep_deleted('trade', coalesce(s->>'displayName',s->>'id') || ' · 매도 ' || (t->>'qty') || '주',
              jsonb_build_object('item',t,'stock_id',s->>'id','position_id',p->>'id'));
          end if;
        end loop;
      end loop;
    end loop;
  elsif old.key = 'stockHistory' then
    select jsonb_agg(item) into removed from jsonb_array_elements(old.value) item
      where not exists(select 1 from jsonb_array_elements(new.value) n where n->>'id' = item->>'id');
    if removed is not null then
      perform silver_private.silver_keep_deleted('history', '계산 기록 ' || jsonb_array_length(removed)::text || '건', jsonb_build_object('item',removed));
    end if;
  end if;
  return new;
end; $$;
create trigger silver_document_trash before update on public.silver_documents
  for each row execute function silver_private.silver_capture_deleted();

-- Recompute derived totals after restoring a position or sale; validate oversales separately.
create function silver_private.silver_recalculate_portfolio(p_value jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare s jsonb; p jsonb; t jsonb; stocks jsonb := '[]'; positions jsonb; trades jsonb; sold numeric; pnl numeric;
begin
  for s in select * from jsonb_array_elements(p_value) loop
    positions := '[]';
    for p in select * from jsonb_array_elements(s->'positions') loop
      sold := 0; pnl := 0; trades := '[]';
      for t in select * from jsonb_array_elements(p->'trades') loop
        sold := sold + (t->>'qty')::numeric;
        pnl := pnl + ((t->>'price')::numeric - (p->>'buyPrice')::numeric) * (t->>'qty')::numeric;
        trades := trades || jsonb_build_array(t || jsonb_build_object('realizedPnL', ((t->>'price')::numeric - (p->>'buyPrice')::numeric) * (t->>'qty')::numeric));
      end loop;
      positions := positions || jsonb_build_array(p || jsonb_build_object('trades', trades,
        'remainQty', (p->>'buyQty')::numeric - sold, 'realizedPnL', pnl,
        'status', case when sold >= (p->>'buyQty')::numeric then 'CLOSED' when sold > 0 then 'PARTIAL' else 'OPEN' end));
    end loop;
    stocks := stocks || jsonb_build_array(s || jsonb_build_object('positions',positions));
  end loop;
  return stocks;
end; $$;

create function public.silver_list_trash()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',id::text,'kind',kind,'label',label,'created_at',created_at)
    order by created_at desc,id desc),'[]'::jsonb) from public.silver_trash where owner_id = (select auth.uid());
$$;

create function silver_private.silver_trash_action(p_id bigint, p_action text, p_mutation uuid, p_owner uuid)
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
create function public.silver_trash_action(p_id bigint,p_action text,p_mutation uuid,p_owner uuid)
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select silver_private.silver_trash_action(p_id,p_action,p_mutation,p_owner);
$$;

create function public.silver_read_changes(p_versions jsonb)
returns setof public.silver_documents language sql stable security invoker set search_path = '' as $$
  select d.* from public.silver_documents d where owner_id = (select auth.uid())
    and version > coalesce((p_versions->>key)::bigint,0);
$$;
create function silver_private.silver_operation_status(p_mutation uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('saved',result->'saved','key',result->'document'->'key')
    from public.silver_mutations where owner_id = (select auth.uid()) and mutation_id = p_mutation;
$$;
create function public.silver_operation_status(p_mutation uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select silver_private.silver_operation_status(p_mutation);
$$;

revoke all on function silver_private.silver_keep_deleted(text,text,jsonb), silver_private.silver_capture_deleted(),
  silver_private.silver_recalculate_portfolio(jsonb), silver_private.silver_trash_action(bigint,text,uuid,uuid),
  silver_private.silver_operation_status(uuid) from public,anon,authenticated;
grant execute on function silver_private.silver_trash_action(bigint,text,uuid,uuid), silver_private.silver_operation_status(uuid) to authenticated;
revoke all on function public.silver_list_trash(), public.silver_trash_action(bigint,text,uuid,uuid),
  public.silver_read_changes(jsonb), public.silver_operation_status(uuid) from public,anon;
grant execute on function public.silver_list_trash(), public.silver_trash_action(bigint,text,uuid,uuid),
  public.silver_read_changes(jsonb), public.silver_operation_status(uuid) to authenticated;
