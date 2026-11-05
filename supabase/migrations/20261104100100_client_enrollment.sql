-- Phase H8: an Endpoint Inventory installation asks for a client key from its own Settings (Edge Function
-- client-enrollments). The installation makes the key and sends only its SHA-256 hash; the key never travels.
-- The request waits as a 'pending' client (client_call refuses it) until its contact confirms the email address
-- and then a hub admin approves it, or the domain of that confirmed address is on the auto-approve list.
-- Requests left open expire after 14 days. Every limit below is a constant on purpose: this endpoint is public.

-- 1. Settings (one row). Off by default: a self-hosted Hub has no public request endpoint until its admin opens it.
create table public.enrollment_settings (
  id integer primary key default 1 check (id = 1),
  enabled boolean not null default false,
  -- Empty: any domain may ask (after email confirmation). Else only these domains.
  allowed_domains text[] not null default '{}',
  -- Requests from these domains are approved as soon as the email is confirmed.
  auto_approve_domains text[] not null default '{}',
  updated_at timestamptz,
  updated_by uuid references auth.users (id) on delete set null
);
insert into public.enrollment_settings (id) values (1);
alter table public.enrollment_settings enable row level security;
revoke all on table public.enrollment_settings from anon, authenticated;

-- 2. Requests.
create type public.enrollment_status as enum ('unverified', 'pending', 'approved', 'rejected', 'expired', 'cancelled');

alter table public.clients add column organization text check (organization is null or char_length(organization) <= 120);

create table public.client_enrollments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients (id) on delete set null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  organization text check (organization is null or char_length(organization) <= 120),
  contact_email text not null check (contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and contact_email = lower(contact_email)),
  reason text check (reason is null or char_length(reason) <= 500),
  -- The version of the consent text the requester agreed to (AI processing of title metadata).
  consent_version text not null check (char_length(consent_version) between 1 and 40),
  client_version text check (client_version is null or char_length(client_version) <= 60),
  -- SHA-256 of the installation's key (never the key): the installation reads its status with the key even after a
  -- rejected or expired request removed the pending client.
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  ip text check (ip is null or char_length(ip) <= 64),
  status public.enrollment_status not null default 'unverified',
  verify_token_hash text unique check (verify_token_hash is null or verify_token_hash ~ '^[0-9a-f]{64}$'),
  verify_expires_at timestamptz,
  verified_at timestamptz,
  auto_approved boolean not null default false,
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 500),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days'
);
create index client_enrollments_status_idx on public.client_enrollments (status, created_at desc);
create index client_enrollments_ip_idx on public.client_enrollments (ip, created_at);
create index client_enrollments_email_idx on public.client_enrollments (contact_email, created_at);
create index client_enrollments_client_idx on public.client_enrollments (client_id);

alter table public.client_enrollments enable row level security;
revoke all on table public.client_enrollments from anon, authenticated;
grant select on table public.client_enrollments to authenticated;
create policy "Hub admins read access requests" on public.client_enrollments
  for select to authenticated using ((select public.is_hub_admin()));

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('reclassification_request', 'new_title', 'jev_proposal', 'research', 'budget', 'system', 'access_request'));

-- 3. Functions for the Edge Function (service role).
create or replace function public.enrollment_domain(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(split_part(p_email, '@', 2));
$$;

-- Ends open requests past their 14 days: the pending client goes, the request stays as 'expired'.
create or replace function public.expire_enrollments()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_clients uuid[];
  v_count integer;
begin
  -- Separate statements: the client delete sets client_id to null on these requests (on delete set null).
  select coalesce(array_agg(client_id) filter (where client_id is not null), '{}') into v_clients
  from (select client_id from public.client_enrollments
        where status in ('unverified', 'pending') and expires_at <= now() for update) x;
  update public.client_enrollments set status = 'expired', verify_token_hash = null
  where status in ('unverified', 'pending') and expires_at <= now();
  get diagnostics v_count = row_count;
  delete from public.clients where id = any (v_clients) and status = 'pending';
  return v_count;
end;
$$;

-- p: { name, organization, contact_email, reason, key_hash, key_prefix, consent_version, client_version, ip,
--      token_hash }. outcome: created | ignored (accepted, nothing stored or sent) | disabled | domain | rate_ip | busy
create or replace function public.enrollment_create(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s public.enrollment_settings;
  v_email text := lower(btrim(p ->> 'contact_email'));
  v_domain text := public.enrollment_domain(lower(btrim(p ->> 'contact_email')));
  v_ip text := nullif(left(p ->> 'ip', 64), '');
  v_client uuid;
  v_id uuid;
begin
  select * into s from public.enrollment_settings where id = 1;
  if not s.enabled then
    return jsonb_build_object('outcome', 'disabled');
  end if;
  if cardinality(s.allowed_domains) > 0 and not v_domain = any (s.allowed_domains) then
    return jsonb_build_object('outcome', 'domain');
  end if;
  -- One address: at most 3 requests an hour and 10 a day.
  if v_ip is not null and (
    (select count(*) from public.client_enrollments where ip = v_ip and created_at > now() - interval '1 hour') >= 3
    or (select count(*) from public.client_enrollments where ip = v_ip and created_at > now() - interval '1 day') >= 10
  ) then
    return jsonb_build_object('outcome', 'rate_ip');
  end if;
  perform public.expire_enrollments();
  if (select count(*) from public.client_enrollments where status in ('unverified', 'pending')) >= 50 then
    return jsonb_build_object('outcome', 'busy');
  end if;
  -- Silent limits (no sign to the caller that the address is known): 3 requests a day for one email, 3 live
  -- keys for one email, and a key hash that already exists.
  if (select count(*) from public.client_enrollments where contact_email = v_email and created_at > now() - interval '1 day') >= 3
     or (select count(*) from public.clients where contact_email = v_email and status in ('active', 'pending')) >= 3
     or exists (select 1 from public.clients where key_hash = lower(p ->> 'key_hash'))
     or exists (select 1 from public.client_enrollments where key_hash = lower(p ->> 'key_hash')) then
    return jsonb_build_object('outcome', 'ignored');
  end if;

  insert into public.clients (name, contact_email, organization, key_prefix, key_hash, status)
  values (btrim(p ->> 'name'), v_email, nullif(btrim(p ->> 'organization'), ''), p ->> 'key_prefix', lower(p ->> 'key_hash'), 'pending')
  returning id into v_client;
  insert into public.client_enrollments (client_id, name, organization, contact_email, reason, consent_version, client_version, key_hash,
    ip, verify_token_hash, verify_expires_at)
  values (v_client, btrim(p ->> 'name'), nullif(btrim(p ->> 'organization'), ''), v_email, nullif(btrim(p ->> 'reason'), ''),
    p ->> 'consent_version', nullif(p ->> 'client_version', ''), lower(p ->> 'key_hash'), v_ip, lower(p ->> 'token_hash'),
    now() + interval '24 hours')
  returning id into v_id;
  return jsonb_build_object('outcome', 'created', 'id', v_id);
end;
$$;

-- The contact opened the email link and pressed Confirm. status: pending | approved | invalid
create or replace function public.enrollment_confirm(p_token_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  e public.client_enrollments;
  v_auto boolean;
begin
  select * into e from public.client_enrollments
  where verify_token_hash = lower(p_token_hash) and status = 'unverified' and verify_expires_at > now() and expires_at > now()
  for update;
  if e.id is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  -- Auto-approve: the domain is listed and fewer than 20 requests of that domain were approved this way today.
  select public.enrollment_domain(e.contact_email) = any (s.auto_approve_domains)
    and (select count(*) from public.client_enrollments x
         where x.auto_approved and x.decided_at > now() - interval '1 day'
           and public.enrollment_domain(x.contact_email) = public.enrollment_domain(e.contact_email)) < 20
  into v_auto
  from public.enrollment_settings s where s.id = 1;

  if v_auto then
    update public.clients set status = 'active' where id = e.client_id and status = 'pending';
    update public.client_enrollments set status = 'approved', auto_approved = true, verified_at = now(), decided_at = now(),
      verify_token_hash = null where id = e.id;
    insert into public.notifications (type, ref_id, title)
    values ('access_request', e.id::text, left(format('Access approved automatically for %s (%s)', e.name, e.contact_email), 300));
    insert into public.audit_log (user_id, action, target, data)
    values (null, 'approve access request (auto)', e.id::text, jsonb_build_object('name', e.name, 'contact_email', e.contact_email));
    return jsonb_build_object('status', 'approved', 'name', e.name, 'contact_email', e.contact_email);
  end if;

  update public.client_enrollments set status = 'pending', verified_at = now(), verify_token_hash = null where id = e.id;
  insert into public.notifications (type, ref_id, title)
  values ('access_request', e.id::text, left(format('New access request from %s (%s)', e.name, e.contact_email), 300));
  return jsonb_build_object('status', 'pending', 'name', e.name, 'contact_email', e.contact_email);
end;
$$;

-- The requesting installation, authenticated by its own (pending) key. null when the key is unknown.
create or replace function public.enrollment_status(p_key_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  e public.client_enrollments;
begin
  perform public.expire_enrollments();
  select * into e from public.client_enrollments where key_hash = lower(p_key_hash);
  if e.id is null then
    return null;
  end if;
  return jsonb_build_object('status', e.status, 'note', e.decision_note, 'expires_at', e.expires_at);
end;
$$;

create or replace function public.enrollment_cancel(p_key_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  e public.client_enrollments;
begin
  select * into e from public.client_enrollments
  where key_hash = lower(p_key_hash) and status in ('unverified', 'pending')
  for update;
  if e.id is null then
    return null;
  end if;
  update public.client_enrollments set status = 'cancelled', verify_token_hash = null where id = e.id;
  delete from public.clients where id = e.client_id and status = 'pending';
  return jsonb_build_object('status', 'cancelled');
end;
$$;

-- 4. Hub admins: decide, read and change the settings (console).
create or replace function public.enrollment_decide(p_id uuid, p_approve boolean, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  e public.client_enrollments;
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins decide access requests' using errcode = '42501';
  end if;
  select * into e from public.client_enrollments where id = p_id for update;
  if e.id is null then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if e.status <> 'pending' then
    raise exception 'Only a confirmed, open request can be decided (this one is %)', e.status using errcode = '22023';
  end if;
  if p_approve then
    update public.clients set status = 'active' where id = e.client_id and status = 'pending';
  else
    delete from public.clients where id = e.client_id and status = 'pending';
  end if;
  update public.client_enrollments set
    status = case when p_approve then 'approved'::public.enrollment_status else 'rejected'::public.enrollment_status end,
    decided_by = auth.uid(), decided_at = now(), decision_note = v_note
  where id = e.id;
  insert into public.audit_log (user_id, action, target, data)
  values (auth.uid(), case when p_approve then 'approve access request' else 'reject access request' end, e.id::text,
    jsonb_build_object('name', e.name, 'contact_email', e.contact_email, 'note', v_note));
  return jsonb_build_object('status', case when p_approve then 'approved' else 'rejected' end, 'name', e.name,
    'contact_email', e.contact_email, 'note', v_note);
end;
$$;

create or replace function public.get_enrollment_settings()
returns table (enabled boolean, allowed_domains text[], auto_approve_domains text[], updated_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select s.enabled, s.allowed_domains, s.auto_approve_domains, s.updated_at
  from public.enrollment_settings s
  where s.id = 1 and public.is_hub_admin();
$$;

create or replace function public.set_enrollment_settings(p_enabled boolean, p_allowed_domains text[], p_auto_approve_domains text[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_allowed text[] := array(select distinct lower(btrim(d)) from unnest(coalesce(p_allowed_domains, '{}')) d where btrim(d) <> '' order by 1);
  v_auto text[] := array(select distinct lower(btrim(d)) from unnest(coalesce(p_auto_approve_domains, '{}')) d where btrim(d) <> '' order by 1);
  v_bad text;
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins change access requests' using errcode = '42501';
  end if;
  select d into v_bad from unnest(v_allowed || v_auto) d where d !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' limit 1;
  if v_bad is not null then
    raise exception 'Not a domain name: %', v_bad using errcode = '22023';
  end if;
  update public.enrollment_settings set enabled = coalesce(p_enabled, false), allowed_domains = v_allowed,
    auto_approve_domains = v_auto, updated_at = now(), updated_by = auth.uid()
  where id = 1;
  insert into public.audit_log (user_id, action, target, data)
  values (auth.uid(), 'set access requests', 'enrollment_settings',
    jsonb_build_object('enabled', coalesce(p_enabled, false), 'allowed_domains', v_allowed, 'auto_approve_domains', v_auto));
end;
$$;

-- 5. Digest: weekly summary (new titles, access requests, reclassification requests, CPE matches) and the daily
-- known exploited CVEs. The digest function sends the weekly part on Mondays and the KEV part every day.
drop function public.build_digest();
create function public.build_digest(p_weekly boolean default false)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'weekly', p_weekly,
    'pending_total', (select count(*) from public.entries where status = 'pending'),
    'open_requests', (select count(*) from public.reclassification_requests where status = 'open'),
    'new_requests', (select count(*) from public.reclassification_requests
                     where created_at > now() - case when p_weekly then interval '7 days' else interval '24 hours' end),
    'proposals', (select count(*) from public.v_proposals),
    'cpe_candidates', (select count(*) from public.product_cpes where status = 'candidate'),
    'new_titles', coalesce((
      select jsonb_agg(jsonb_build_object('name', canonical_name, 'kind', kind, 'reports', reports_count) order by reports_count desc, canonical_name)
      from (select * from public.entries where status = 'pending'
              and first_reported_at > now() - case when p_weekly then interval '7 days' else interval '24 hours' end
            order by reports_count desc limit 50) n), '[]'),
    'access', jsonb_build_object(
      'open', (select count(*) from public.client_enrollments where status = 'pending'),
      'unconfirmed', (select count(*) from public.client_enrollments where status = 'unverified'),
      'approved', (select count(*) from public.client_enrollments where status = 'approved' and not auto_approved and decided_at > now() - interval '7 days'),
      'auto_approved', (select count(*) from public.client_enrollments where status = 'approved' and auto_approved and decided_at > now() - interval '7 days'),
      'rejected', (select count(*) from public.client_enrollments where status = 'rejected' and decided_at > now() - interval '7 days'),
      'waiting', coalesce((
        select jsonb_agg(jsonb_build_object('name', name, 'organization', organization, 'email', contact_email, 'since', verified_at) order by verified_at)
        from (select * from public.client_enrollments where status = 'pending' order by verified_at limit 20) w), '[]')),
    'new_kev', coalesce((
      select jsonb_agg(jsonb_build_object('vuln_id', k.vuln_id, 'cvss_score', k.cvss_score, 'kev_due', k.kev_due, 'products', k.products)
        order by k.cvss_score desc nulls last, k.vuln_id)
      from (
        select v.vuln_id, v.cvss_score, v.kev_due,
          (select jsonb_agg(distinct p.display_name) from public.vulnerability_ranges r join public.products p on p.id = r.product_id where r.vuln_id = v.vuln_id) as products
        from public.vulnerabilities v
        where v.kev_flagged_at > now() - interval '24 hours'
          and exists (select 1 from public.vulnerability_ranges r where r.vuln_id = v.vuln_id)
        limit 50
      ) k), '[]'));
$$;

-- 6. Grants.
do $$
declare
  f text;
begin
  foreach f in array array[
    'enrollment_create(jsonb)', 'enrollment_confirm(text)', 'enrollment_status(text)', 'enrollment_cancel(text)',
    'expire_enrollments()', 'build_digest(boolean)', 'enrollment_domain(text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['enrollment_decide(uuid, boolean, text)', 'get_enrollment_settings()', 'set_enrollment_settings(boolean, text[], text[])'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end;
$$;
