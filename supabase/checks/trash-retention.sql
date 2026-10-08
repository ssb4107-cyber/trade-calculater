-- Synthetic accounts only. Existing user documents and trash are never read or removed.
begin;
do $$
declare a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); expired_id bigint; valid_id bigint;
  before_docs jsonb; result jsonb; receipt uuid := gen_random_uuid(); denied boolean; listing jsonb;
begin
  insert into auth.users(id) values(a),(b);
  insert into public.silver_trash(owner_id,kind,label,payload,created_at)
    values(a,'history','expired','{"item":[{"id":100,"price":10,"pct":1}]}',now()-interval '7 months') returning id into expired_id;
  insert into public.silver_trash(owner_id,kind,label,payload,created_at)
    values(a,'history','valid','{"item":[{"id":101,"price":10,"pct":1}]}',now()-interval '5 months') returning id into valid_id;
  insert into public.silver_trash(owner_id,kind,label,payload,created_at) values
    (a,'history','leap end','{"item":[]}','2023-08-31 12:00:00+00'),
    (a,'history','month end','{"item":[]}','2024-08-31 12:00:00+00'),
    (a,'history','Korean month end','{"item":[]}','2026-03-30 16:00:00+00'),
    (a,'history','deadline','{"item":[]}',(now() at time zone 'Asia/Seoul'-interval '6 months') at time zone 'Asia/Seoul'),
    (b,'history','other expired','{"item":[]}',now()-interval '7 months'),
    (b,'history','other valid','{"item":[]}',now());
  if (select expires_at from public.silver_trash where owner_id=a and label='leap end') <> '2024-02-29 12:00:00+00'::timestamptz
    or (select expires_at from public.silver_trash where owner_id=a and label='month end') <> '2025-02-28 12:00:00+00'::timestamptz
    or (select expires_at from public.silver_trash where owner_id=a and label='Korean month end') <> '2026-09-29 16:00:00+00'::timestamptz
    then raise exception 'Calendar month end or leap year expiry incorrect'; end if;
  execute 'set local time zone ''America/New_York''';
  if (select expires_at from public.silver_trash where owner_id=a and label='month end') <> '2025-02-28 12:00:00+00'::timestamptz
    then raise exception 'Session timezone changed expiry'; end if;
  execute 'set local time zone ''UTC''';
  perform set_config('request.jwt.claim.sub',a::text,true);
  execute 'set local role authenticated';
  perform public.silver_write_document('stockHistory','[]',0,gen_random_uuid());
  listing := public.silver_list_trash();
  if jsonb_array_length(listing) <> 1 or listing->0->>'id' <> valid_id::text or not (listing->0 ? 'expires_at')
    or exists(select 1 from public.silver_trash where id=expired_id) then raise exception 'Expired trash visible through RPC or direct select'; end if;
  denied := false;
  begin perform public.silver_trash_action(expired_id,'restore',gen_random_uuid(),a);
  exception when raise_exception then
    if sqlerrm <> 'Trash item expired' then raise; end if; denied := true;
  end;
  if not denied or public.silver_read_document('stockHistory')->'value' <> '[]'::jsonb then raise exception 'Expired item restored'; end if;
  result := public.silver_trash_action(valid_id,'restore',receipt,a);
  if result->'document'->'value'->0->>'id' <> '101' or result is distinct from public.silver_trash_action(valid_id,'restore',receipt,a)
    then raise exception 'Valid item restore or idempotent retry failed'; end if;
  denied := false;
  begin perform public.silver_trash_action(expired_id,'restore',gen_random_uuid(),b);
  exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'Wrong owner bypassed expiry'; end if;
  denied := false;
  begin delete from public.silver_trash;
  exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'Client directly removed trash'; end if;

  execute 'reset role';
  delete from public.silver_trash where owner_id=a;
  insert into public.silver_trash(owner_id,kind,label,payload,created_at)
    select a,'history','expired capacity','{"item":[]}'::jsonb,now()-interval '7 months' from generate_series(1,200);
  execute 'set local role authenticated';
  perform public.silver_write_document('stockHistory','[]',2,gen_random_uuid());
  if jsonb_array_length(public.silver_list_trash()) <> 1 or public.silver_read_document('stockHistory')->>'version' <> '3'
    then raise exception 'Expired capacity blocked an atomic deletion'; end if;
  execute 'reset role';
  if (select count(*) from public.silver_trash where owner_id=a) <> 1
    or not exists(select 1 from public.silver_trash where owner_id=b and label='other expired')
    then raise exception 'Per-account capacity cleanup lost valid or other-account trash'; end if;
  select jsonb_agg(to_jsonb(d) order by owner_id,key) into before_docs from public.silver_documents d where owner_id in(a,b);
  -- Same expiry predicate as the scheduled job, restricted to synthetic accounts.
  delete from public.silver_trash where owner_id in(a,b) and expires_at <= now();
  if exists(select 1 from public.silver_trash where owner_id in(a,b) and expires_at <= now())
    or not exists(select 1 from public.silver_trash where owner_id=b and label='other valid')
    or before_docs is distinct from (select jsonb_agg(to_jsonb(d) order by owner_id,key) from public.silver_documents d where owner_id in(a,b))
    then raise exception 'Scheduled cleanup lost valid trash or active documents'; end if;
  if exists(select 1 from pg_namespace where nspname='cron') then
    if has_schema_privilege('authenticated','cron','usage') or has_schema_privilege('anon','cron','usage')
      then raise exception 'Client can access maintenance scheduler'; end if;
  end if;
end;
$$;
rollback;
select 'PASS: six calendar months, month-end/leap-year dates, timezone consistency, expiry visibility/restore denial, valid restore retry, account isolation, expired capacity cleanup and maintenance data protection; fixtures rolled back' as retention_check;
