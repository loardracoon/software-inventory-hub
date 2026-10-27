-- Phase H2: the client API (Edge Functions dictionary-changes, titles-submit, reclassification-requests)
-- runs these functions with the service role, after client_call() has authenticated the key. Clients
-- are untrusted: what they send becomes pending entries, counts and open requests, never a change to
-- the published dictionary. Hub admins manage clients (keys shown once, stored as sha256).

-- Rate limit: calls per client and minute.
create table public.client_rate (
  client_id uuid not null references public.clients (id) on delete cascade,
  minute timestamptz not null,
  calls integer not null default 0,
  primary key (client_id, minute)
);

alter table public.client_rate enable row level security;
revoke all on table public.client_rate from anon, authenticated;

-- Authenticates one API call. status: 200 ok, 401 unknown or revoked key, 429 over 60 calls/minute
-- (retry_after seconds until the next minute). Counts the call and updates last_seen_at.
create or replace function public.client_call(p_key_hash text)
returns table (client_id uuid, client_name text, status integer, retry_after integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  c public.clients;
  v_calls integer;
  v_minute timestamptz := date_trunc('minute', now());
begin
  select * into c from public.clients where key_hash = lower(p_key_hash);
  if c.id is null or c.status <> 'active' then
    return query select null::uuid, null::text, 401, null::integer;
    return;
  end if;
  insert into public.client_rate as r (client_id, minute, calls) values (c.id, v_minute, 1)
  on conflict (client_id, minute) do update set calls = r.calls + 1
  returning r.calls into v_calls;
  update public.clients set last_seen_at = now() where id = c.id;
  delete from public.client_rate where minute < now() - interval '10 minutes';
  if v_calls > 60 then
    return query select c.id, c.name, 429, greatest(1, ceil(extract(epoch from (v_minute + interval '1 minute' - now())))::integer);
    return;
  end if;
  return query select c.id, c.name, 200, null::integer;
end;
$$;

-- GET dictionary-changes: the current published state of every entry and category changed after
-- p_since, in seq order, p_limit items per page. Published fields only; deprecated entries included so
-- clients drop them; pending and proposed entries never leave the Hub.
create or replace function public.dictionary_changes(p_client_id uuid, p_since bigint, p_limit integer default 1000)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), 1000);
  v_items jsonb;
  v_next bigint;
  v_more boolean;
begin
  with changed as (
    select c.seq, 'category' as type, jsonb_build_object(
        'id', c.id, 'slug', c.slug, 'parent_id', c.parent_id, 'name', c.name, 'description', c.description,
        'attention_level', c.attention_level, 'sophos_firewall_category', c.sophos_firewall_category,
        'revision', c.revision, 'seq', c.seq, 'deprecated', c.deprecated) as item
    from public.categories c
    where c.seq > p_since
    union all
    select e.seq, 'entry', jsonb_build_object(
        'kind', e.kind, 'source', e.source, 'match_key', e.match_key, 'canonical_name', e.canonical_name,
        'vendor', e.vendor, 'description', e.description, 'category_id', e.category_id,
        'attention_level', coalesce(e.attention_override, c.attention_level), 'confidence', e.confidence,
        'method', e.method, 'revision', e.revision, 'status', e.status, 'seq', e.seq)
    from public.entries e
    left join public.categories c on c.id = e.category_id
    where e.seq > p_since and e.status in ('published', 'deprecated')
  ),
  page as (
    select * from changed order by seq limit v_limit + 1
  )
  select
    coalesce(jsonb_agg(jsonb_build_object('type', type, 'item', item) order by seq) filter (where rn <= v_limit), '[]'),
    max(seq) filter (where rn <= v_limit),
    count(*) > v_limit
  into v_items, v_next, v_more
  from (select *, row_number() over (order by seq) as rn from page) p;

  v_next := coalesce(v_next, p_since);
  update public.clients set last_seq = greatest(last_seq, v_next) where id = p_client_id;
  return jsonb_build_object(
    'categories', coalesce((select jsonb_agg(x -> 'item') from jsonb_array_elements(v_items) x where x ->> 'type' = 'category'), '[]'),
    'entries', coalesce((select jsonb_agg(x -> 'item') from jsonb_array_elements(v_items) x where x ->> 'type' = 'entry'), '[]'),
    'next_seq', v_next,
    'has_more', v_more
  );
end;
$$;

-- POST titles-submit (validated by the Edge Function first): every title is stored in submissions;
-- unknown ones become pending entries; reports_count counts distinct clients.
create or replace function public.submit_titles(p_client_id uuid, p_titles jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  t jsonb;
  v_new integer := 0;
  v_known integer := 0;
  v_entry uuid;
  v_inserted boolean;
  v_seen_before boolean;
  v_client text;
begin
  if jsonb_typeof(p_titles) <> 'array' or jsonb_array_length(p_titles) > 500 then
    raise exception 'titles must be an array of at most 500' using errcode = '22023';
  end if;
  for t in select x from jsonb_array_elements(p_titles) x loop
    select exists (
      select 1 from public.submissions s
      where s.client_id = p_client_id and s.kind = (t ->> 'kind')::public.entry_kind and s.source = t ->> 'source' and s.match_key = t ->> 'match_key'
    ) into v_seen_before;

    insert into public.submissions (client_id, kind, source, match_key, name, vendor, description)
    values (p_client_id, (t ->> 'kind')::public.entry_kind, t ->> 'source', t ->> 'match_key', t ->> 'name', t ->> 'vendor', left(t ->> 'description', 1000));

    insert into public.entries as e (kind, source, match_key, canonical_name, vendor, description, reports_count, first_reported_at, last_reported_at)
    values ((t ->> 'kind')::public.entry_kind, t ->> 'source', t ->> 'match_key', t ->> 'name', t ->> 'vendor', left(t ->> 'description', 1000), 1, now(), now())
    on conflict (kind, source, match_key) do update set
      reports_count = e.reports_count + case when v_seen_before then 0 else 1 end,
      last_reported_at = now(),
      -- Fill gaps of a pending entry from later reports; published entries are only changed by admins.
      vendor = case when e.status = 'pending' then coalesce(e.vendor, excluded.vendor) else e.vendor end,
      description = case when e.status = 'pending' then coalesce(e.description, excluded.description) else e.description end
    returning e.id, (xmax = 0) into v_entry, v_inserted;
    if v_inserted then v_new := v_new + 1; else v_known := v_known + 1; end if;
  end loop;

  if v_new > 0 then
    select name into v_client from public.clients where id = p_client_id;
    insert into public.notifications (type, ref_id, title)
    values ('new_title', p_client_id::text, format('%s new title%s reported by %s', v_new, case when v_new = 1 then '' else 's' end, v_client));
  end if;
  return jsonb_build_object('accepted', v_new + v_known, 'new', v_new, 'known', v_known);
end;
$$;

-- POST reclassification-requests: opens a request, or returns the client's open one for that entry.
-- An unknown title becomes a pending entry so the request has something to point at.
create or replace function public.open_reclassification_request(
  p_client_id uuid, p_kind text, p_source text, p_match_key text, p_suggested_category_id uuid, p_reason text, p_evidence_url text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  e public.entries;
  r public.reclassification_requests;
  v_client text;
  v_current text;
  v_suggested text;
begin
  if p_suggested_category_id is not null and not exists (
    select 1 from public.categories where id = p_suggested_category_id and parent_id is not null and not deprecated
  ) then
    raise exception 'suggested_category_id must be a level-2 category' using errcode = '22023';
  end if;

  insert into public.entries as x (kind, source, match_key, canonical_name)
  values (p_kind::public.entry_kind, p_source, p_match_key, p_match_key)
  on conflict (kind, source, match_key) do nothing;
  select * into e from public.entries where kind = p_kind::public.entry_kind and source = p_source and match_key = p_match_key;

  select * into r from public.reclassification_requests where client_id = p_client_id and entry_id = e.id and status = 'open';
  if r.id is not null then
    return jsonb_build_object('id', r.public_id, 'status', r.status, 'created', false);
  end if;

  insert into public.reclassification_requests (client_id, entry_id, current_category_id, suggested_category_id, reason, evidence_url)
  values (p_client_id, e.id, e.category_id, p_suggested_category_id, btrim(p_reason), nullif(btrim(coalesce(p_evidence_url, '')), ''))
  returning * into r;

  select name into v_client from public.clients where id = p_client_id;
  select name into v_current from public.categories where id = e.category_id;
  select name into v_suggested from public.categories where id = p_suggested_category_id;
  insert into public.notifications (type, ref_id, title)
  values ('reclassification_request', r.public_id,
    left(format('%s: %s → %s, requested by %s', e.canonical_name, coalesce(v_current, 'Unclassified'), coalesce(v_suggested, 'Other'), v_client), 300));

  return jsonb_build_object('id', r.public_id, 'status', r.status, 'created', true,
    'title', e.canonical_name, 'current_category', coalesce(v_current, 'Unclassified'),
    'suggested_category', coalesce(v_suggested, 'Other'), 'client', v_client, 'reason', r.reason);
end;
$$;

-- GET reclassification-requests?ids=: only the caller's own requests.
create or replace function public.request_statuses(p_client_id uuid, p_ids text[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.public_id, 'status', r.status, 'admin_note', r.admin_note) order by r.public_id), '[]')
  from public.reclassification_requests r
  where r.client_id = p_client_id and r.public_id = any (p_ids[1:100]);
$$;

-- Who gets the request emails.
create or replace function public.hub_admin_emails()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select u.email::text from public.hub_admins a join auth.users u on u.id = a.user_id where u.email is not null;
$$;

-- Console › Clients ------------------------------------------------------------------------------
-- The key is generated here, returned once and stored only as its sha256.

create or replace function public.new_client_key()
returns text
language sql
volatile
set search_path = ''
as $$
  select 'hubk_' || encode(extensions.gen_random_bytes(24), 'hex');
$$;

create or replace function public.create_client(p_name text, p_contact_email text)
returns table (client_id uuid, client_key text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := public.new_client_key();
  v_id uuid;
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins manage clients' using errcode = '42501';
  end if;
  insert into public.clients (name, contact_email, key_prefix, key_hash)
  values (btrim(p_name), lower(btrim(p_contact_email)), left(v_key, 11), encode(sha256(convert_to(v_key, 'UTF8')), 'hex'))
  returning id into v_id;
  insert into public.audit_log (user_id, action, target, data)
  values (auth.uid(), 'create client', v_id::text, jsonb_build_object('name', btrim(p_name), 'key_prefix', left(v_key, 11)));
  return query select v_id, v_key;
end;
$$;

create or replace function public.rotate_client_key(p_client_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := public.new_client_key();
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins manage clients' using errcode = '42501';
  end if;
  update public.clients set key_prefix = left(v_key, 11), key_hash = encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), status = 'active'
  where id = p_client_id;
  if not found then
    raise exception 'Client not found' using errcode = 'P0002';
  end if;
  insert into public.audit_log (user_id, action, target, data)
  values (auth.uid(), 'rotate client key', p_client_id::text, jsonb_build_object('key_prefix', left(v_key, 11)));
  return v_key;
end;
$$;

create or replace function public.revoke_client(p_client_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins manage clients' using errcode = '42501';
  end if;
  update public.clients set status = 'revoked' where id = p_client_id;
  if not found then
    raise exception 'Client not found' using errcode = 'P0002';
  end if;
  insert into public.audit_log (user_id, action, target, data) values (auth.uid(), 'revoke client', p_client_id::text, null);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'client_call(text)', 'dictionary_changes(uuid, bigint, integer)', 'submit_titles(uuid, jsonb)',
    'open_reclassification_request(uuid, text, text, text, uuid, text, text)', 'request_statuses(uuid, text[])',
    'hub_admin_emails()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['create_client(text, text)', 'rotate_client_key(uuid)', 'revoke_client(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  execute 'revoke all on function public.new_client_key() from public, anon, authenticated';
end;
$$;
