-- Phase H4: dictionary search, draft edits with a reason that publish as a revision + event, decisions on
-- reclassification requests (grouped per entry, answered to clients through GET reclassification-requests),
-- editable taxonomy (deprecation needs a replacement) and the daily digest.

-- Drafts: an edit is saved with a reason and stays private until "Publish" (clients never see a draft).
create table public.entry_drafts (
  entry_id uuid primary key references public.entries (id) on delete cascade,
  canonical_name text check (char_length(btrim(canonical_name)) between 1 and 300),
  vendor text check (char_length(vendor) <= 300),
  description text check (char_length(description) <= 1000),
  category_id uuid references public.categories (id) on delete restrict,
  attention_override public.attention_level,
  clear_attention boolean not null default false,
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  saved_by uuid references auth.users (id) on delete set null,
  saved_at timestamptz not null default now()
);

alter table public.entry_drafts enable row level security;
revoke all on table public.entry_drafts from anon, authenticated;
create policy "Hub admins read entry_drafts" on public.entry_drafts for select to authenticated using ((select public.is_hub_admin()));
grant select on table public.entry_drafts to authenticated;

-- Search ----------------------------------------------------------------------------------------

create or replace function public.search_entries(
  p_query text default null, p_status public.entry_status default null, p_kind public.entry_kind default null,
  p_category_id uuid default null, p_sort text default 'reports', p_limit integer default 25, p_offset integer default 0
)
returns table (
  id uuid, kind public.entry_kind, source text, match_key text, canonical_name text, vendor text,
  category_id uuid, category_name text, level1_name text, attention_level public.attention_level,
  method public.entry_method, confidence numeric, status public.entry_status, revision integer,
  reports_count integer, has_draft boolean, open_requests bigint, total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.kind, e.source, e.match_key, e.canonical_name, e.vendor, e.category_id, c.name, p.name,
    coalesce(e.attention_override, c.attention_level), e.method, e.confidence, e.status, e.revision, e.reports_count,
    exists (select 1 from public.entry_drafts d where d.entry_id = e.id),
    (select count(*) from public.reclassification_requests r where r.entry_id = e.id and r.status = 'open'),
    count(*) over ()
  from public.entries e
  left join public.categories c on c.id = e.category_id
  left join public.categories p on p.id = c.parent_id
  where public.is_hub_admin()
    and (p_status is null or e.status = p_status)
    and (p_kind is null or e.kind = p_kind)
    and (p_category_id is null or e.category_id = p_category_id)
    and (nullif(btrim(coalesce(p_query, '')), '') is null
         or e.canonical_name ilike '%' || btrim(p_query) || '%' or e.vendor ilike '%' || btrim(p_query) || '%'
         or e.match_key ilike '%' || btrim(p_query) || '%')
  order by
    case when p_sort = 'name' then lower(e.canonical_name) end asc,
    case when p_sort = 'updated' then e.updated_at end desc,
    e.reports_count desc, lower(e.canonical_name)
  limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0);
$$;

-- Edit and publish -------------------------------------------------------------------------------

create or replace function public.save_entry_draft(
  p_entry_id uuid, p_name text, p_vendor text, p_description text, p_category_id uuid,
  p_attention public.attention_level, p_clear_attention boolean, p_reason text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins edit the dictionary' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A change reason is required' using errcode = '22023';
  end if;
  if p_category_id is not null and not exists (select 1 from public.categories where id = p_category_id and parent_id is not null and not deprecated) then
    raise exception 'Choose a level-2 category' using errcode = '22023';
  end if;
  insert into public.entry_drafts (entry_id, canonical_name, vendor, description, category_id, attention_override, clear_attention, reason, saved_by)
  values (p_entry_id, nullif(btrim(p_name), ''), nullif(btrim(p_vendor), ''), nullif(btrim(p_description), ''), p_category_id, p_attention,
          coalesce(p_clear_attention, false), btrim(p_reason), auth.uid())
  on conflict (entry_id) do update set canonical_name = excluded.canonical_name, vendor = excluded.vendor, description = excluded.description,
    category_id = excluded.category_id, attention_override = excluded.attention_override, clear_attention = excluded.clear_attention,
    reason = excluded.reason, saved_by = excluded.saved_by, saved_at = now();
  insert into public.audit_log (user_id, action, target, data) values (auth.uid(), 'save entry draft', p_entry_id::text, jsonb_build_object('reason', btrim(p_reason)));
end;
$$;

create or replace function public.discard_entry_draft(p_entry_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins edit the dictionary' using errcode = '42501';
  end if;
  delete from public.entry_drafts where entry_id = p_entry_id;
end;
$$;

-- Applies the draft (or just publishes the entry as it is, with a reason): next revision with its snapshot,
-- a dictionary event, the next global seq. method becomes manual: an admin decided.
create or replace function public.publish_entry_edit(p_entry_id uuid, p_reason text default null)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  e public.entries;
  d public.entry_drafts;
  v_category uuid;
  v_event public.event_type;
  v_seq bigint;
  v_reason text;
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins publish' using errcode = '42501';
  end if;
  select * into e from public.entries where id = p_entry_id for update;
  if e.id is null then
    raise exception 'Entry not found' using errcode = 'P0002';
  end if;
  select * into d from public.entry_drafts where entry_id = p_entry_id;
  v_category := coalesce(d.category_id, e.category_id);
  v_reason := coalesce(d.reason, nullif(btrim(coalesce(p_reason, '')), ''));
  if v_category is null then
    raise exception 'Choose a category before publishing' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'A change reason is required' using errcode = '22023';
  end if;

  v_event := case
    when e.status = 'deprecated' or e.status <> 'published' then 'published'
    when v_category is distinct from e.category_id then 'reclassified'
    when d.description is distinct from e.description and d.description is not null then 'description_changed'
    else 'published' end;

  update public.entries set
    canonical_name = coalesce(d.canonical_name, canonical_name),
    vendor = case when d.entry_id is not null then coalesce(d.vendor, vendor) else vendor end,
    description = case when d.entry_id is not null then coalesce(d.description, description) else description end,
    category_id = v_category,
    attention_override = case when d.clear_attention then null else coalesce(d.attention_override, attention_override) end,
    method = 'manual', confidence = null, model_version = null,
    status = 'published', revision = revision + 1, reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
  where id = p_entry_id;

  insert into public.dictionary_events (entry_id, type) values (p_entry_id, v_event) returning seq into v_seq;
  update public.entries set seq = v_seq where id = p_entry_id returning * into e;
  insert into public.entry_revisions (entry_id, revision, snapshot, changed_by, change_reason)
  values (p_entry_id, e.revision, to_jsonb(e), auth.uid(), v_reason);
  delete from public.entry_drafts where entry_id = p_entry_id;
  insert into public.audit_log (user_id, action, target, data) values (auth.uid(), 'publish entry', p_entry_id::text, jsonb_build_object('revision', e.revision, 'reason', v_reason));
  return v_seq;
end;
$$;

-- Reclassification requests ---------------------------------------------------------------------

-- One decision for every open request on an entry (they are grouped in the console).
--   accept: publishes p_category_id (default: the suggestion of the oldest request); requests suggesting it are
--           accepted, the others superseded. reject: closes them all with the note.
create or replace function public.decide_entry_requests(p_entry_id uuid, p_accept boolean, p_note text, p_category_id uuid default null)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_category uuid;
  v_n integer;
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins decide requests' using errcode = '42501';
  end if;
  if not exists (select 1 from public.reclassification_requests where entry_id = p_entry_id and status = 'open') then
    raise exception 'No open requests for this entry' using errcode = '22023';
  end if;
  if not p_accept then
    update public.reclassification_requests set status = 'rejected', admin_note = left(nullif(btrim(coalesce(p_note, '')), ''), 1000),
      decided_at = now(), decided_by = auth.uid()
    where entry_id = p_entry_id and status = 'open';
    get diagnostics v_n = row_count;
    insert into public.audit_log (user_id, action, target, data) values (auth.uid(), 'reject requests', p_entry_id::text, jsonb_build_object('count', v_n, 'note', p_note));
    return v_n;
  end if;

  select coalesce(p_category_id, (select suggested_category_id from public.reclassification_requests
                                  where entry_id = p_entry_id and status = 'open' and suggested_category_id is not null order by created_at limit 1))
  into v_category;
  if v_category is null then
    raise exception 'Choose the category to publish' using errcode = '22023';
  end if;
  insert into public.entry_drafts (entry_id, category_id, reason, saved_by)
  values (p_entry_id, v_category, 'Accepted reclassification request', auth.uid())
  on conflict (entry_id) do update set category_id = excluded.category_id, reason = 'Accepted reclassification request', saved_by = excluded.saved_by, saved_at = now();
  perform public.publish_entry_edit(p_entry_id);

  update public.reclassification_requests set
    status = case when suggested_category_id = v_category then 'accepted' else 'superseded' end::public.request_status,
    admin_note = left(nullif(btrim(coalesce(p_note, '')), ''), 1000), decided_at = now(), decided_by = auth.uid()
  where entry_id = p_entry_id and status = 'open';
  get diagnostics v_n = row_count;
  insert into public.audit_log (user_id, action, target, data) values (auth.uid(), 'accept requests', p_entry_id::text, jsonb_build_object('count', v_n, 'category_id', v_category));
  return v_n;
end;
$$;

-- Open requests grouped by entry for the Inbox.
create view public.v_request_groups
with (security_invoker = true)
as
select e.id as entry_id, e.canonical_name, e.vendor, e.kind, e.source, e.status as entry_status,
  cur.name as current_category, cur.id as current_category_id,
  count(*) as requests, count(distinct r.client_id) as clients,
  min(r.created_at) as oldest, max(r.created_at) as newest,
  jsonb_agg(jsonb_build_object('public_id', r.public_id, 'client', cl.name, 'suggested_category_id', r.suggested_category_id,
    'suggested', coalesce(s.name, 'Other'), 'reason', r.reason, 'evidence_url', r.evidence_url, 'created_at', r.created_at) order by r.created_at) as items
from public.reclassification_requests r
join public.entries e on e.id = r.entry_id
join public.clients cl on cl.id = r.client_id
left join public.categories cur on cur.id = e.category_id
left join public.categories s on s.id = r.suggested_category_id
where r.status = 'open'
group by e.id, cur.id;

revoke all on table public.v_request_groups from anon, authenticated;
grant select on table public.v_request_groups to authenticated;

-- Taxonomy --------------------------------------------------------------------------------------

create or replace function public.update_category(p_category_id uuid, p_name text, p_description text, p_reason text)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_seq bigint;
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins edit the taxonomy' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null or nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'A name and a change reason are required' using errcode = '22023';
  end if;
  update public.categories set name = btrim(p_name), description = nullif(btrim(coalesce(p_description, '')), ''), revision = revision + 1, updated_at = now()
  where id = p_category_id;
  if not found then
    raise exception 'Category not found' using errcode = 'P0002';
  end if;
  insert into public.dictionary_events (category_id, type) values (p_category_id, 'category_changed') returning seq into v_seq;
  update public.categories set seq = v_seq where id = p_category_id;
  insert into public.audit_log (user_id, action, target, data) values (auth.uid(), 'edit category', p_category_id::text, jsonb_build_object('reason', btrim(p_reason)));
  return v_seq;
end;
$$;

-- A level-2 category is retired only with a replacement: its entries move there (as reclassified events).
create or replace function public.deprecate_category(p_category_id uuid, p_replacement_id uuid, p_reason text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  e record;
  v_moved integer := 0;
  v_seq bigint;
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins edit the taxonomy' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A change reason is required' using errcode = '22023';
  end if;
  if p_replacement_id is null or p_replacement_id = p_category_id
     or not exists (select 1 from public.categories where id = p_replacement_id and parent_id is not null and not deprecated)
     or not exists (select 1 from public.categories where id = p_category_id and parent_id is not null and not deprecated) then
    raise exception 'Choose a different, active level-2 category as the replacement' using errcode = '22023';
  end if;
  for e in select id, status, method, confidence, model_version from public.entries where category_id = p_category_id loop
    perform public.publish_entry(e.id, p_replacement_id, 'manual', null, null, auth.uid(), 'Category deprecated: ' || btrim(p_reason),
      case when e.status = 'deprecated' then 'deprecated' else 'published' end::public.entry_status);
    v_moved := v_moved + 1;
  end loop;
  update public.reclassification_requests set suggested_category_id = p_replacement_id where suggested_category_id = p_category_id and status = 'open';
  update public.categories set deprecated = true, revision = revision + 1, updated_at = now() where id = p_category_id;
  insert into public.dictionary_events (category_id, type) values (p_category_id, 'category_changed') returning seq into v_seq;
  update public.categories set seq = v_seq where id = p_category_id;
  insert into public.audit_log (user_id, action, target, data)
  values (auth.uid(), 'deprecate category', p_category_id::text, jsonb_build_object('replacement', p_replacement_id, 'entries_moved', v_moved, 'reason', btrim(p_reason)));
  return v_moved;
end;
$$;

-- Daily digest ----------------------------------------------------------------------------------

-- New pending titles of the last 24 hours with their report counts (what the 08:00 email lists).
create or replace function public.build_digest()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'pending_total', (select count(*) from public.entries where status = 'pending'),
    'open_requests', (select count(*) from public.reclassification_requests where status = 'open'),
    'proposals', (select count(*) from public.v_proposals),
    'new_titles', coalesce((
      select jsonb_agg(jsonb_build_object('name', canonical_name, 'kind', kind, 'reports', reports_count) order by reports_count desc, canonical_name)
      from (select * from public.entries where status = 'pending' and first_reported_at > now() - interval '24 hours' order by reports_count desc limit 50) n), '[]'));
$$;

-- 08:00 America/Sao_Paulo (UTC-3 all year) = 11:00 UTC. The url is the jev function's with /digest.
create or replace function public.invoke_digest()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'jev_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  if v_url is null or v_secret is null then
    return null;
  end if;
  return net.http_post(url := regexp_replace(v_url, '/jev/?$', '/digest'), body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret), timeout_milliseconds := 60000);
end;
$$;

select cron.unschedule(jobid) from cron.job where jobname = 'daily-digest';
select cron.schedule('daily-digest', '0 11 * * *', 'select public.invoke_digest()');

-- Access ----------------------------------------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'search_entries(text, public.entry_status, public.entry_kind, uuid, text, integer, integer)',
    'save_entry_draft(uuid, text, text, text, uuid, public.attention_level, boolean, text)', 'discard_entry_draft(uuid)',
    'publish_entry_edit(uuid, text)', 'decide_entry_requests(uuid, boolean, text, uuid)', 'update_category(uuid, text, text, text)',
    'deprecate_category(uuid, uuid, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['build_digest()', 'invoke_digest()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
