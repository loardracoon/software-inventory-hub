-- Phase H6: product grouping. Entries whose names differ only by version or architecture ("7-Zip 23.01
-- (x64)", "7-Zip 26.05 (x64)", "7-Zip") and vendor spelling ("Microsoft Corporation", "Microsoft Corp.")
-- belong to one product and share one classification.
--
-- * Entries stay the unit of the client contract: each keeps its (kind, source, match_key) and its own row
--   in dictionary-changes, which now also carries product_id and product_key.
-- * Classification belongs to the product: publish_entry copies a publish to the other entries of the
--   product (same category, attention, method and confidence, so older clients accept it), and a new
--   entry of a classified product is published at once.
-- * The product key is computed here in SQL (immutable functions); the client uses the same functions
--   and the same test vectors.

-- 1. Normalization -------------------------------------------------------------------------------------

-- "7-Zip 23.01 (x64)" → "7-Zip"; "WindowsAppRuntime.1.8" → "WindowsAppRuntime"; "Microsoft Visual C++
-- 2015-2022 Redistributable (x64) - 14.38.33135" → "Microsoft Visual C++ 2015-2022 Redistributable".
-- A version needs a dot (or follows a letter and a dot), so years, "Java 8 Update 401" and "python3.12" stay.
create or replace function public.product_name(p_name text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_current text := btrim(coalesce(p_name, ''));
  v_previous text;
begin
  loop
    v_previous := v_current;
    v_current := regexp_replace(v_current,
      '\s*\((?:\s*(?:x64|x86|x86_64|amd64|arm64|aarch64|64-bit|32-bit|64 bit|32 bit|v?\d+(?:\.\d+)+),?\s*)+\)', '', 'gi');
    v_current := regexp_replace(v_current, '\s+-\s+v?\d+(?:\.\d+)+\S*$', '', 'i');
    v_current := regexp_replace(v_current, '\s+(?:v?\d+(?:\.\d+)+[\w.+-]*|x64|x86|amd64|arm64)$', '', 'i');
    -- Dotted package-style names: "Microsoft.UI.Xaml.2.8", "WindowsAppRuntime.2".
    v_current := regexp_replace(v_current, '(?<=[[:alpha:]])\.\d+(?:\.\d+)*$', '');
    v_current := btrim(v_current);
    exit when v_current = v_previous;
  end loop;
  return case when v_current = '' then btrim(coalesce(p_name, '')) else v_current end;
end;
$$;

-- "Microsoft Corporation" = "Microsoft Corp." = "microsoft"; legal suffixes and punctuation do not count.
create or replace function public.vendor_key(p_vendor text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_key text := btrim(regexp_replace(lower(coalesce(p_vendor, '')), '[^[:alnum:]]+', ' ', 'g'));
  v_previous text;
begin
  loop
    v_previous := v_key;
    v_key := btrim(regexp_replace(v_key,
      '\s(?:inc|incorporated|corp|corporation|co|company|ltd|limited|llc|gmbh|ag|ab|sa|srl|sarl|bv|oy|plc|pty|kk)$', ''));
    exit when v_key = v_previous;
  end loop;
  return v_key;
end;
$$;

-- The natural key: kind | vendor key | product name in lower case.
create or replace function public.product_natural_key(p_kind text, p_name text, p_vendor text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_kind || '|' || public.vendor_key(p_vendor) || '|' || lower(public.product_name(p_name));
$$;

-- 2. Products ----------------------------------------------------------------------------------------------
create table public.vendor_aliases (
  alias_key text primary key check (alias_key = public.vendor_key(alias_key) and alias_key <> ''),
  vendor_key text not null check (vendor_key = public.vendor_key(vendor_key) and vendor_key <> ''),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (alias_key <> vendor_key)
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  kind public.entry_kind not null,
  product_key text not null unique,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 300),
  vendor text,
  created_at timestamptz not null default now()
);

alter table public.entries
  add column product_id uuid references public.products (id) on delete set null,
  -- An admin or operator moved or split this entry: automatic grouping leaves it alone.
  add column product_locked boolean not null default false;

create index entries_product_idx on public.entries (product_id);

-- The key with vendor aliases applied (what grouping uses).
create or replace function public.product_key_for(p_kind text, p_name text, p_vendor text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p_kind || '|' || coalesce((select a.vendor_key from public.vendor_aliases a where a.alias_key = public.vendor_key(p_vendor)), public.vendor_key(p_vendor))
    || '|' || lower(public.product_name(p_name));
$$;

-- The product of a key, created on first use.
create or replace function public.product_for(p_kind public.entry_kind, p_name text, p_vendor text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := public.product_key_for(p_kind::text, p_name, p_vendor);
  v_id uuid;
begin
  select id into v_id from public.products where product_key = v_key;
  if v_id is null then
    insert into public.products (kind, product_key, display_name, vendor)
    values (p_kind, v_key, left(public.product_name(p_name), 300), p_vendor)
    on conflict (product_key) do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from public.products where product_key = v_key;
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.entries_assign_product()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not new.product_locked then
    new.product_id := public.product_for(new.kind, new.canonical_name, new.vendor);
  end if;
  return new;
end;
$$;

create trigger entries_assign_product
  before insert or update of kind, canonical_name, vendor, product_locked on public.entries
  for each row execute function public.entries_assign_product();

-- Backfill: every existing entry joins its product (the trigger runs on this update).
update public.entries set product_locked = product_locked;

-- Recomputes the product of every unlocked entry (after a vendor alias changes) and drops empty products.
create or replace function public.regroup_products()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_moved integer;
begin
  with target as (
    select e.id, public.product_for(e.kind, e.canonical_name, e.vendor) as product_id
    from public.entries e where not e.product_locked
  )
  update public.entries e set product_id = t.product_id
  from target t where t.id = e.id and e.product_id is distinct from t.product_id;
  get diagnostics v_moved = row_count;
  delete from public.products p where not exists (select 1 from public.entries e where e.product_id = p.id);
  return v_moved;
end;
$$;

-- 3. One classification per product ------------------------------------------------------------------------

-- Copies the classification of p_entry_id to the other entries of its product that differ. Published:
-- every other entry (pending, proposed, published elsewhere, deprecated) is published the same way.
-- Deprecated: only the published ones follow. Runs inside publish_entry; hub.propagating stops the loop.
create or replace function public.propagate_product(p_entry_id uuid, p_actor uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  e public.entries;
  s public.entries;
  v_count integer := 0;
begin
  select * into e from public.entries where id = p_entry_id;
  if e.product_id is null or e.status not in ('published', 'deprecated') then
    return 0;
  end if;
  perform set_config('hub.propagating', 'on', true);
  for s in
    select * from public.entries x
    where x.product_id = e.product_id and x.id <> e.id
      and case when e.status = 'deprecated' then x.status = 'published'
               else x.status <> 'published' or x.category_id is distinct from e.category_id
                    or x.attention_override is distinct from e.attention_override end
    order by x.id
    for update
  loop
    update public.entries set attention_override = e.attention_override where id = s.id;
    perform public.publish_entry(s.id, e.category_id, e.method, e.confidence, e.model_version, p_actor,
      format('Same product as %s', e.canonical_name), e.status);
    v_count := v_count + 1;
  end loop;
  perform set_config('hub.propagating', 'off', true);
  return v_count;
end;
$$;

create or replace function public.publish_entry(
  p_entry_id uuid, p_category_id uuid, p_method public.entry_method, p_confidence numeric, p_model_version text,
  p_actor uuid, p_reason text, p_status public.entry_status default 'published'
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  e public.entries;
  v_was_published boolean;
  v_old_category uuid;
  v_seq bigint;
begin
  select status = 'published', category_id into v_was_published, v_old_category from public.entries where id = p_entry_id for update;
  if v_was_published is null then
    raise exception 'Entry not found' using errcode = 'P0002';
  end if;

  update public.entries set
    category_id = p_category_id,
    method = p_method,
    confidence = p_confidence,
    model_version = p_model_version,
    status = p_status,
    revision = revision + 1,
    reviewed_by = coalesce(p_actor, reviewed_by),
    reviewed_at = case when p_actor is not null then now() else reviewed_at end,
    updated_at = now()
  where id = p_entry_id
  returning * into e;

  insert into public.dictionary_events (entry_id, type)
  values (p_entry_id, case
      when p_status = 'deprecated' then 'deprecated'
      when v_was_published and v_old_category is distinct from p_category_id then 'reclassified'
      else 'published' end::public.event_type)
  returning seq into v_seq;
  update public.entries set seq = v_seq where id = p_entry_id returning * into e;

  insert into public.entry_revisions (entry_id, revision, snapshot, changed_by, change_reason)
  values (p_entry_id, e.revision, to_jsonb(e), p_actor, left(p_reason, 1000));

  -- The other entries of the product follow (not while a propagation is already running).
  if coalesce(current_setting('hub.propagating', true), 'off') <> 'on' then
    perform public.propagate_product(p_entry_id, p_actor);
  end if;
  return v_seq;
end;
$$;

-- A new entry of a product that is already published is published at once with the same classification,
-- so a new version-named title never waits in the Inbox.
create or replace function public.publish_like_product(p_entry_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  e public.entries;
  src public.entries;
begin
  select * into e from public.entries where id = p_entry_id;
  if e.product_id is null or e.status <> 'pending' then
    return false;
  end if;
  select * into src from public.entries x
  where x.product_id = e.product_id and x.id <> e.id and x.status = 'published'
  order by x.reviewed_at desc nulls last, x.updated_at desc
  limit 1;
  if src.id is null then
    return false;
  end if;
  perform set_config('hub.propagating', 'on', true);
  update public.entries set attention_override = src.attention_override where id = e.id;
  perform public.publish_entry(e.id, src.category_id, src.method, src.confidence, src.model_version, null,
    format('Same product as %s', src.canonical_name), 'published');
  perform set_config('hub.propagating', 'off', true);
  return true;
end;
$$;

-- Existing pending entries of a product that already has a published entry take its classification now
-- (proposals stay for a person to decide).
select public.publish_like_product(e.id)
from public.entries e
where e.status = 'pending'
  and exists (select 1 from public.entries x where x.product_id = e.product_id and x.id <> e.id and x.status = 'published')
order by e.id;

-- titles-submit: unchanged, plus the product step for new entries.
do $$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'submit_titles';
  if v_def is null or position('if v_inserted then v_new := v_new + 1; else v_known := v_known + 1; end if;' in v_def) = 0 then
    raise exception 'submit_titles has changed: update this migration';
  end if;
  execute replace(v_def,
    'if v_inserted then v_new := v_new + 1; else v_known := v_known + 1; end if;',
    'if v_inserted then v_new := v_new + 1; perform public.publish_like_product(v_entry); else v_known := v_known + 1; end if;');
end;
$$;

-- 4. Product views and actions -------------------------------------------------------------------------------

-- One row per product: aliases, status, and whether the published aliases disagree.
create view public.v_products
with (security_invoker = true)
as
select p.id, p.kind, p.product_key, p.display_name, p.vendor,
  count(e.id) as aliases,
  count(e.id) filter (where e.status = 'pending') as pending,
  count(e.id) filter (where e.status = 'published') as published,
  sum(e.reports_count) as reports,
  count(distinct (e.category_id, e.attention_override)) filter (where e.status = 'published') > 1 as conflict,
  (array_agg(e.id order by e.reviewed_at desc nulls last, e.updated_at desc) filter (where e.status = 'published'))[1] as lead_entry_id
from public.products p
join public.entries e on e.product_id = p.id
group by p.id;

-- Products whose published aliases disagree (Inbox › Grouping review). The suggestion is the most
-- recently reviewed alias (manual decisions first).
create view public.v_product_conflicts
with (security_invoker = true)
as
select p.id as product_id, p.display_name, p.vendor,
  jsonb_agg(jsonb_build_object('entry_id', e.id, 'canonical_name', e.canonical_name, 'category_id', e.category_id,
    'category', c.name, 'method', e.method, 'reviewed_at', e.reviewed_at, 'attention_override', e.attention_override)
    order by (e.method = 'manual') desc, e.reviewed_at desc nulls last, e.updated_at desc) as aliases
from public.products p
join public.entries e on e.product_id = p.id and e.status = 'published'
left join public.categories c on c.id = e.category_id
group by p.id
having count(distinct (e.category_id, e.attention_override)) > 1;

-- Grouping review: publish this alias's classification to the whole product.
create or replace function public.resolve_product_conflict(p_entry_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  e public.entries;
  v_count integer;
begin
  if not public.can_curate() then
    raise exception 'Only hub admins and operators group products' using errcode = '42501';
  end if;
  select * into e from public.entries where id = p_entry_id and status = 'published';
  if e.id is null then
    raise exception 'Choose a published entry' using errcode = 'P0002';
  end if;
  v_count := public.propagate_product(p_entry_id, auth.uid());
  insert into public.audit_log (user_id, action, target, data)
  values (auth.uid(), 'resolve product conflict', 'products:' || e.product_id, jsonb_build_object('entry_id', p_entry_id, 'changed', v_count));
  return v_count;
end;
$$;

-- Move an entry to another product (p_product_id) or split it into a product of its own (null). The
-- entry keeps its classification; it is locked so automatic grouping leaves it there.
create or replace function public.set_entry_product(p_entry_id uuid, p_product_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  e public.entries;
  v_target uuid := p_product_id;
begin
  if not public.can_curate() then
    raise exception 'Only hub admins and operators group products' using errcode = '42501';
  end if;
  select * into e from public.entries where id = p_entry_id for update;
  if e.id is null then
    raise exception 'Entry not found' using errcode = 'P0002';
  end if;
  if v_target is null then
    insert into public.products (kind, product_key, display_name, vendor)
    values (e.kind, public.product_key_for(e.kind::text, e.canonical_name, e.vendor) || '#' || e.id, left(e.canonical_name, 300), e.vendor)
    returning id into v_target;
  elsif not exists (select 1 from public.products where id = v_target and kind = e.kind) then
    raise exception 'Choose a product of the same kind' using errcode = '22023';
  end if;
  update public.entries set product_id = v_target, product_locked = true where id = p_entry_id;
  delete from public.products p where p.id = e.product_id and not exists (select 1 from public.entries x where x.product_id = p.id);
  insert into public.audit_log (user_id, action, target, data)
  values (auth.uid(), case when p_product_id is null then 'split product' else 'move to product' end, 'entries:' || p_entry_id,
    jsonb_build_object('from', e.product_id, 'to', v_target));
  return v_target;
end;
$$;

-- Admins: vendor spellings the rules miss ("Adobe Systems Incorporated" → "adobe"). Regroups at once.
create or replace function public.set_vendor_alias(p_alias text, p_vendor text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_alias text := public.vendor_key(p_alias);
  v_vendor text := public.vendor_key(p_vendor);
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins manage vendor aliases' using errcode = '42501';
  end if;
  if v_alias = '' or v_vendor = '' or v_alias = v_vendor then
    raise exception 'Enter two different vendor names' using errcode = '22023';
  end if;
  insert into public.vendor_aliases (alias_key, vendor_key, created_by) values (v_alias, v_vendor, auth.uid())
  on conflict (alias_key) do update set vendor_key = excluded.vendor_key;
  insert into public.audit_log (user_id, action, target, data)
  values (auth.uid(), 'set vendor alias', 'vendor_aliases:' || v_alias, jsonb_build_object('alias', v_alias, 'vendor', v_vendor));
  return public.regroup_products();
end;
$$;

create or replace function public.delete_vendor_alias(p_alias text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins manage vendor aliases' using errcode = '42501';
  end if;
  delete from public.vendor_aliases where alias_key = public.vendor_key(p_alias);
  insert into public.audit_log (user_id, action, target, data)
  values (auth.uid(), 'delete vendor alias', 'vendor_aliases:' || public.vendor_key(p_alias), null);
  return public.regroup_products();
end;
$$;

-- Dictionary search: with p_group, one row per product (its most reported spelling) and the number of
-- spellings; without it, every entry as before.
drop function public.search_entries(text, public.entry_status, public.entry_kind, uuid, text, integer, integer);

create function public.search_entries(
  p_query text default null, p_status public.entry_status default null, p_kind public.entry_kind default null,
  p_category_id uuid default null, p_sort text default 'reports', p_limit integer default 25, p_offset integer default 0,
  p_group boolean default false
)
returns table (
  id uuid, kind public.entry_kind, source text, match_key text, canonical_name text, vendor text, category_id uuid, category_name text,
  level1_name text, attention_level public.attention_level, method public.entry_method, confidence numeric, status public.entry_status,
  revision integer, reports_count integer, has_draft boolean, open_requests bigint, product_id uuid, product_name text, aliases bigint,
  total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with matched as (
    select e.id, e.kind, e.source, e.match_key, e.canonical_name, e.vendor, e.category_id, c.name as category_name, p.name as level1_name,
      coalesce(e.attention_override, c.attention_level) as attention_level, e.method, e.confidence, e.status, e.revision, e.reports_count,
      e.updated_at, e.product_id, pr.display_name as product_name,
      row_number() over (partition by coalesce(e.product_id, e.id) order by e.reports_count desc, e.updated_at desc) as rn
    from public.entries e
    left join public.categories c on c.id = e.category_id
    left join public.categories p on p.id = c.parent_id
    left join public.products pr on pr.id = e.product_id
    where public.is_hub_member()
      and (p_status is null or e.status = p_status)
      and (p_kind is null or e.kind = p_kind)
      and (p_category_id is null or e.category_id = p_category_id)
      and (nullif(btrim(coalesce(p_query, '')), '') is null
           or e.canonical_name ilike '%' || btrim(p_query) || '%' or e.vendor ilike '%' || btrim(p_query) || '%'
           or e.match_key ilike '%' || btrim(p_query) || '%' or pr.display_name ilike '%' || btrim(p_query) || '%')
  )
  select m.id, m.kind, m.source, m.match_key, m.canonical_name, m.vendor, m.category_id, m.category_name, m.level1_name,
    m.attention_level, m.method, m.confidence, m.status, m.revision, m.reports_count,
    exists (select 1 from public.entry_drafts d where d.entry_id = m.id),
    (select count(*) from public.reclassification_requests r where r.entry_id = m.id and r.status = 'open'),
    m.product_id, m.product_name,
    (select count(*) from public.entries x where x.product_id = m.product_id),
    count(*) over ()
  from matched m
  where not p_group or m.rn = 1
  order by
    case when p_sort = 'name' then lower(coalesce(case when p_group then m.product_name end, m.canonical_name)) end asc,
    case when p_sort = 'updated' then m.updated_at end desc,
    m.reports_count desc, lower(m.canonical_name)
  limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0);
$$;

revoke all on function public.search_entries(text, public.entry_status, public.entry_kind, uuid, text, integer, integer, boolean) from public, anon;
grant execute on function public.search_entries(text, public.entry_status, public.entry_kind, uuid, text, integer, integer, boolean) to authenticated;

-- 5. dictionary-changes carries the product (additive: older clients ignore the new fields) ----------------
do $$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'dictionary_changes';
  if position('''method'', e.method, ''revision'', e.revision, ''status'', e.status, ''seq'', e.seq)' in v_def) = 0 then
    raise exception 'dictionary_changes has changed: update this migration';
  end if;
  v_def := replace(v_def,
    '''method'', e.method, ''revision'', e.revision, ''status'', e.status, ''seq'', e.seq)',
    '''method'', e.method, ''revision'', e.revision, ''status'', e.status, ''seq'', e.seq, ''product_id'', e.product_id, ''product_key'', pr.product_key)');
  v_def := replace(v_def,
    'left join public.categories c on c.id = e.category_id
    where e.seq > p_since',
    'left join public.categories c on c.id = e.category_id
    left join public.products pr on pr.id = e.product_id
    where e.seq > p_since');
  if position('left join public.products pr' in v_def) = 0 then
    raise exception 'dictionary_changes join not found: update this migration';
  end if;
  execute v_def;
end;
$$;

-- 6. Access -------------------------------------------------------------------------------------------------
alter table public.products enable row level security;
alter table public.vendor_aliases enable row level security;
create policy "Members read products" on public.products for select to authenticated using ((select public.is_hub_member()));
create policy "Members read vendor aliases" on public.vendor_aliases for select to authenticated using ((select public.is_hub_member()));
revoke all on table public.products, public.vendor_aliases, public.v_products, public.v_product_conflicts from anon, authenticated;
grant select on table public.products, public.vendor_aliases, public.v_products, public.v_product_conflicts to authenticated;

do $$
declare
  f text;
begin
  foreach f in array array['product_name(text)', 'vendor_key(text)', 'product_natural_key(text, text, text)'] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['resolve_product_conflict(uuid)', 'set_entry_product(uuid, uuid)', 'set_vendor_alias(text, text)', 'delete_vendor_alias(text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['product_key_for(text, text, text)', 'product_for(public.entry_kind, text, text)', 'regroup_products()',
                           'propagate_product(uuid, uuid)', 'publish_like_product(uuid)', 'entries_assign_product()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end;
$$;
