-- Users and access, like the client (Endpoint Inventory 20261028000000_users_and_access.sql).
--   Roles: admin (everything), operator (curates: edits and publishes entries, decides proposals and
--   requests, runs Jev and Research, reads engine usage), viewer (reads and searches).
--   Access rules: an exact email (any role) or an email domain (viewer or operator, never admin).
--   Auth creates an account only for an email with a rule (the first account of an empty Hub is admin).
-- is_hub_admin() keeps its name and now means "role = admin", so every admin-only RPC (settings, keys,
-- prices, clients, taxonomy edits) is unchanged.

-- 1. Members and roles --------------------------------------------------------------------------------
create type public.hub_role as enum ('admin', 'operator', 'viewer');

create table public.hub_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  role public.hub_role not null,
  added_at timestamptz not null default now()
);

insert into public.hub_members (user_id, email, role, added_at)
select a.user_id, coalesce(u.email, ''), 'admin', a.added_at
from public.hub_admins a
join auth.users u on u.id = a.user_id;

create or replace function public.hub_role()
returns public.hub_role
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.hub_members where user_id = auth.uid();
$$;

create or replace function public.is_hub_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.hub_role() = 'admin', false);
$$;

create or replace function public.can_curate()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.hub_role() in ('admin', 'operator'), false);
$$;

create or replace function public.is_hub_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.hub_role() is not null;
$$;

-- Admin email (digest, requests, engine pauses) goes to the admins only.
create or replace function public.hub_admin_emails()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select u.email::text from public.hub_members m join auth.users u on u.id = m.user_id where m.role = 'admin' and u.email is not null;
$$;

alter table public.hub_members enable row level security;
create policy "Members read their own row" on public.hub_members for select to authenticated using (user_id = (select auth.uid()));
create policy "Admins read every member" on public.hub_members for select to authenticated using ((select public.is_hub_admin()));
revoke all on table public.hub_members from anon, authenticated;
grant select on table public.hub_members to authenticated;

drop table public.hub_admins;

-- 2. Read policies by role ------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  -- Every member reads the dictionary, the Inbox and the runs.
  foreach t in array array['categories', 'entries', 'entry_revisions', 'dictionary_events', 'submissions', 'reclassification_requests',
                           'classification_runs', 'classification_results', 'research_dossiers'] loop
    execute format('drop policy "Hub admins read %s" on public.%I', t, t);
    execute format('create policy "Members read %s" on public.%I for select to authenticated using ((select public.is_hub_member()))', t, t);
  end loop;
  -- Operators and admins read engine settings, prices, calls and the research queue (Engines & usage).
  foreach t in array array['engine_settings', 'ai_prices', 'ai_calls', 'research_queue'] loop
    execute format('drop policy "Hub admins read %s" on public.%I', t, t);
    execute format('create policy "Curators read %s" on public.%I for select to authenticated using ((select public.can_curate()))', t, t);
  end loop;
  -- clients, audit_log and provider_keys keep their admin-only policies.
end;
$$;

drop policy "Hub admins read entry_drafts" on public.entry_drafts;
create policy "Members read entry_drafts" on public.entry_drafts for select to authenticated using ((select public.is_hub_member()));

drop policy "Hub admins read notifications" on public.notifications;
create policy "Members read notifications" on public.notifications for select to authenticated using ((select public.is_hub_member()));
drop policy "Hub admins mark notifications read" on public.notifications;
create policy "Curators mark notifications read" on public.notifications for update to authenticated
  using ((select public.can_curate())) with check ((select public.can_curate()));

-- Client names for every member (requests show who asked); contacts and key prefixes stay admin-only in
-- clients. The view runs as its owner and filters members itself.
create view public.client_names
with (security_barrier = true)
as
select c.id, c.name from public.clients c where public.is_hub_member();

revoke all on table public.client_names from anon, authenticated;
grant select on table public.client_names to authenticated;

create or replace view public.v_request_groups
with (security_invoker = true)
as
select e.id as entry_id,
  e.canonical_name,
  e.vendor,
  e.kind,
  e.source,
  e.status as entry_status,
  cur.name as current_category,
  cur.id as current_category_id,
  count(*) as requests,
  count(distinct r.client_id) as clients,
  min(r.created_at) as oldest,
  max(r.created_at) as newest,
  jsonb_agg(jsonb_build_object('public_id', r.public_id, 'client', cl.name, 'suggested_category_id', r.suggested_category_id,
    'suggested', coalesce(s.name, 'Other'), 'reason', r.reason, 'evidence_url', r.evidence_url, 'created_at', r.created_at) order by r.created_at) as items
from public.reclassification_requests r
join public.entries e on e.id = r.entry_id
left join public.client_names cl on cl.id = r.client_id
left join public.categories cur on cur.id = e.category_id
left join public.categories s on s.id = r.suggested_category_id
where r.status = 'open'
group by e.id, cur.id;

-- 3. Curator RPCs: the same bodies with "admin" widened to "admin or operator" ---------------------------
do $$
declare
  f record;
  v_def text;
begin
  for f in
    select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('accept_all_above', 'decide_entry_requests', 'decide_proposal', 'discard_entry_draft',
      'publish_entry_edit', 'revert_auto_publish', 'save_entry_draft', 'engine_status', 'engine_usage_detail')
  loop
    v_def := pg_get_functiondef(f.oid);
    if position('public.is_hub_admin()' in v_def) = 0 then
      raise exception 'public.% has no admin check to widen', f.proname;
    end if;
    v_def := replace(v_def, 'public.is_hub_admin()', 'public.can_curate()');
    v_def := replace(v_def, '''Only hub admins ', '''Only hub admins and operators ');
    execute v_def;
  end loop;

  -- Every member searches the dictionary.
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'search_entries';
  execute replace(v_def, 'public.is_hub_admin()', 'public.is_hub_member()');
end;
$$;

-- 4. Access rules ---------------------------------------------------------------------------------------
create table public.access_rules (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('email', 'domain')),
  value text not null,
  role public.hub_role not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (kind, value),
  -- A domain never grants admin.
  check (kind = 'email' or role in ('viewer', 'operator')),
  check (value = lower(btrim(value))),
  check (
    (kind = 'email' and value ~ '^[^@[:space:]]+@[a-z0-9.-]+\.[a-z]{2,}$')
    or (kind = 'domain' and value ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$')
  )
);

comment on table public.access_rules is 'Who may get a Hub account: an exact email (any role) or an email domain (viewer or operator).';

alter table public.access_rules enable row level security;
create policy "Admins read access rules" on public.access_rules for select to authenticated using ((select public.is_hub_admin()));
revoke all on table public.access_rules from anon, authenticated;
grant select on table public.access_rules to authenticated;

-- The role a new account with this email gets: the email rule first, then the domain rule; null = no access.
create or replace function public.access_role_for(p_email text)
returns public.hub_role
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select r.role from public.access_rules r where r.kind = 'email' and r.value = lower(btrim(p_email))),
    (select r.role from public.access_rules r where r.kind = 'domain' and r.value = split_part(lower(btrim(p_email)), '@', 2))
  );
$$;

-- Accounts created by Auth (GoTrue connects as supabase_auth_admin) need a rule, except while the Hub has
-- no members (the first account becomes admin). Accounts inserted by database roles (tests, scripts) pass.
create or replace function public.check_new_user_allowed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if session_user = 'supabase_auth_admin'
     and exists (select 1 from public.hub_members)
     and public.access_role_for(new.email) is null then
    raise exception 'No access for %: ask a hub admin to add your email or your domain', new.email using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger before_auth_user_created
  before insert on auth.users
  for each row execute function public.check_new_user_allowed();

-- A new account becomes a member with its rule's role; the first member of an empty Hub is admin.
-- Accounts without a rule (made by scripts) get no membership: scripts add it themselves.
create or replace function public.handle_new_hub_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.hub_role;
begin
  perform pg_advisory_xact_lock(hashtext('public.handle_new_hub_user'));
  v_role := case when not exists (select 1 from public.hub_members) then 'admin'::public.hub_role else public.access_role_for(new.email) end;
  if v_role is not null then
    insert into public.hub_members (user_id, email, role) values (new.id, coalesce(new.email, ''), v_role)
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_hub_user();

revoke all on function public.check_new_user_allowed() from public, anon, authenticated;
revoke all on function public.handle_new_hub_user() from public, anon, authenticated;

-- 5. Admin RPCs (audited) -----------------------------------------------------------------------------------
create or replace function public.list_users()
returns table (id uuid, email text, role public.hub_role, added_at timestamptz, last_sign_in_at timestamptz, access text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins manage users' using errcode = '42501';
  end if;
  return query
    select m.user_id, m.email, m.role, m.added_at, u.last_sign_in_at,
      case
        when exists (select 1 from public.access_rules r where r.kind = 'email' and r.value = lower(m.email)) then 'email'
        when exists (select 1 from public.access_rules r where r.kind = 'domain' and r.value = split_part(lower(m.email), '@', 2)) then 'domain'
        else 'account'
      end
    from public.hub_members m
    left join auth.users u on u.id = m.user_id
    order by m.email;
end;
$$;

create or replace function public.set_user_role(p_user_id uuid, p_role public.hub_role)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_old public.hub_role;
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins manage users' using errcode = '42501';
  end if;
  select email, role into v_email, v_old from public.hub_members where user_id = p_user_id for update;
  if v_email is null then
    raise exception 'User not found' using errcode = 'P0002';
  end if;
  if v_old = 'admin' and p_role <> 'admin' and (select count(*) from public.hub_members where role = 'admin') <= 1 then
    raise exception 'Keep at least one admin' using errcode = '22023';
  end if;
  update public.hub_members set role = p_role where user_id = p_user_id;
  -- An email rule for this user follows the change, so a removed and re-invited account gets it back.
  update public.access_rules set role = p_role where kind = 'email' and value = lower(v_email);
  insert into public.audit_log (user_id, action, target, data)
  values (auth.uid(), 'set user role', 'hub_members:' || p_user_id, jsonb_build_object('email', v_email, 'from', v_old, 'to', p_role));
end;
$$;

-- Deletes the account (membership cascades) and its email rule. A domain rule still lets the person sign
-- in again with that role; remove the domain too to block them.
create or replace function public.remove_user(p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_role public.hub_role;
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins manage users' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'You cannot remove yourself' using errcode = '22023';
  end if;
  select email, role into v_email, v_role from public.hub_members where user_id = p_user_id;
  if v_email is null then
    raise exception 'User not found' using errcode = 'P0002';
  end if;
  if v_role = 'admin' and (select count(*) from public.hub_members where role = 'admin') <= 1 then
    raise exception 'Keep at least one admin' using errcode = '22023';
  end if;
  delete from public.access_rules where kind = 'email' and value = lower(v_email);
  delete from auth.users where id = p_user_id;
  insert into public.audit_log (user_id, action, target, data)
  values (auth.uid(), 'remove user', 'hub_members:' || p_user_id, jsonb_build_object('email', v_email, 'role', v_role));
end;
$$;

-- Email rules are written by manage-users together with the invitation; this RPC writes domain rules
-- (and email rules, for scripts).
create or replace function public.add_access_rule(p_kind text, p_value text, p_role public.hub_role)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_value text := lower(btrim(coalesce(p_value, '')));
  v_id uuid;
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins manage access' using errcode = '42501';
  end if;
  if p_kind = 'domain' then
    v_value := ltrim(v_value, '@');
  end if;
  insert into public.access_rules (kind, value, role, created_by)
  values (p_kind, v_value, p_role, auth.uid())
  on conflict (kind, value) do update set role = excluded.role
  returning id into v_id;
  insert into public.audit_log (user_id, action, target, data)
  values (auth.uid(), 'add access rule', 'access_rules:' || v_id, jsonb_build_object('kind', p_kind, 'value', v_value, 'role', p_role));
  return v_id;
end;
$$;

create or replace function public.delete_access_rule(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rule public.access_rules;
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins manage access' using errcode = '42501';
  end if;
  delete from public.access_rules where id = p_id returning * into v_rule;
  if v_rule.id is null then
    raise exception 'Rule not found' using errcode = 'P0002';
  end if;
  insert into public.audit_log (user_id, action, target, data)
  values (auth.uid(), 'delete access rule', 'access_rules:' || p_id, jsonb_build_object('kind', v_rule.kind, 'value', v_rule.value, 'role', v_rule.role));
end;
$$;

-- manage-users (service role): gives an existing account with this email the role of its access rule.
-- Returns false when there is no such account (then the function sends an invitation instead).
create or replace function public.ensure_hub_member(p_email text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role public.hub_role := public.access_role_for(p_email);
  v_rows integer;
begin
  if v_role is null then
    return false;
  end if;
  insert into public.hub_members (user_id, email, role)
  select u.id, lower(u.email), v_role from auth.users u where lower(u.email) = lower(btrim(p_email))
  on conflict (user_id) do update set role = excluded.role;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.ensure_hub_member(text) from public, anon, authenticated;
grant execute on function public.ensure_hub_member(text) to service_role;

do $$
declare
  f text;
begin
  foreach f in array array[
    'hub_role()', 'can_curate()', 'is_hub_member()', 'is_hub_admin()', 'list_users()', 'set_user_role(uuid, public.hub_role)', 'remove_user(uuid)',
    'add_access_rule(text, text, public.hub_role)', 'delete_access_rule(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  -- Edge Functions check the role of a caller's email server-side.
  revoke all on function public.access_role_for(text) from public, anon, authenticated;
  grant execute on function public.access_role_for(text) to service_role;
end;
$$;
