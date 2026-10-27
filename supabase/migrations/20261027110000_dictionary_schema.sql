-- Phase H1: the dictionary schema. Tables only, plus integrity rules; the RPCs that edit, revise and
-- publish come in H4, the client API in H2, Jev in H3. Hub admins read everything; nothing is written
-- from the browser yet, and anonymous users get nothing.

create extension if not exists pg_trgm with schema extensions;

create type public.attention_level as enum ('info', 'review', 'not_allowed');
create type public.entry_kind as enum ('program', 'extension', 'ide_extension', 'package');
create type public.entry_method as enum ('rule', 'jev', 'jev_auto', 'manual');
create type public.entry_status as enum ('pending', 'proposed', 'published', 'deprecated');
create type public.event_type as enum ('published', 'reclassified', 'description_changed', 'deprecated', 'category_changed');
create type public.client_status as enum ('active', 'revoked');
create type public.request_status as enum ('open', 'accepted', 'rejected', 'superseded');
create type public.run_status as enum ('running', 'finished', 'failed', 'cancelled');

-- Taxonomy ----------------------------------------------------------------------------------------
-- Two levels. Level 1 (parent_id null) carries no attention; level 2 always does. Slugs never change:
-- clients match categories by slug.

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9-]+(/[a-z0-9-]+)?$'),
  description text check (char_length(description) <= 2000),
  attention_level public.attention_level,
  parent_id uuid references public.categories (id) on delete restrict,
  sophos_firewall_category text,
  revision integer not null default 1 check (revision > 0),
  seq bigint not null default 0,
  deprecated boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((parent_id is null) = (attention_level is null)),
  check ((parent_id is null) = (position('/' in slug) = 0))
);

create index categories_parent_idx on public.categories (parent_id);

create or replace function public.categories_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.slug <> old.slug then
    raise exception 'Category slugs never change (% → %)', old.slug, new.slug using errcode = '23514';
  end if;
  if new.parent_id is not null and exists (select 1 from public.categories p where p.id = new.parent_id and p.parent_id is not null) then
    raise exception 'Categories have two levels: the parent of % must be a level-1 category', new.slug using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger categories_guard
  before insert or update on public.categories
  for each row execute function public.categories_guard();

-- Dictionary entries ------------------------------------------------------------------------------

create table public.entries (
  id uuid primary key default gen_random_uuid(),
  kind public.entry_kind not null,
  source text not null check (char_length(source) between 1 and 60),
  match_key text not null check (char_length(match_key) between 1 and 500),
  canonical_name text not null check (char_length(btrim(canonical_name)) between 1 and 300),
  vendor text check (char_length(vendor) <= 300),
  description text check (char_length(description) <= 1000),
  category_id uuid references public.categories (id) on delete restrict,
  attention_override public.attention_level,
  confidence numeric(4, 3) check (confidence between 0 and 1),
  method public.entry_method,
  model_version text,
  status public.entry_status not null default 'pending',
  revision integer not null default 1 check (revision > 0),
  seq bigint not null default 0,
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  reports_count integer not null default 0 check (reports_count >= 0),
  first_reported_at timestamptz,
  last_reported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, source, match_key),
  -- Anything past pending has a category and a method.
  check (status = 'pending' or (category_id is not null and method is not null))
);

create index entries_category_idx on public.entries (category_id);
create index entries_status_idx on public.entries (status, reports_count desc);
create index entries_name_trgm_idx on public.entries using gin (canonical_name extensions.gin_trgm_ops);
create index entries_vendor_trgm_idx on public.entries using gin (vendor extensions.gin_trgm_ops);
create index entries_match_key_trgm_idx on public.entries using gin (match_key extensions.gin_trgm_ops);

-- An entry's category is always a level-2 category.
create or replace function public.entries_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.category_id is not null and exists (select 1 from public.categories c where c.id = new.category_id and c.parent_id is null) then
    raise exception 'Entries point to a level-2 category' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger entries_guard
  before insert or update of category_id on public.entries
  for each row execute function public.entries_guard();

create table public.entry_revisions (
  entry_id uuid not null references public.entries (id) on delete cascade,
  revision integer not null check (revision > 0),
  snapshot jsonb not null,
  changed_by uuid references auth.users (id) on delete set null,
  change_reason text check (char_length(change_reason) <= 1000),
  created_at timestamptz not null default now(),
  primary key (entry_id, revision)
);

-- Global publication order: what clients ask for with dictionary-changes?since=<seq>.
create table public.dictionary_events (
  seq bigserial primary key,
  entry_id uuid references public.entries (id) on delete cascade,
  category_id uuid references public.categories (id) on delete cascade,
  type public.event_type not null,
  created_at timestamptz not null default now(),
  check (entry_id is not null or category_id is not null)
);

create index dictionary_events_entry_idx on public.dictionary_events (entry_id);
create index dictionary_events_category_idx on public.dictionary_events (category_id);

-- Clients -----------------------------------------------------------------------------------------
-- Keys are shown once and stored as sha256 hex; key_prefix identifies a key in the console.

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  contact_email text not null check (contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  key_prefix text not null check (char_length(key_prefix) between 4 and 16),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  status public.client_status not null default 'active',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  last_seq bigint not null default 0
);

create table public.submissions (
  id bigint generated always as identity primary key,
  client_id uuid not null references public.clients (id) on delete cascade,
  kind public.entry_kind not null,
  source text not null check (char_length(source) between 1 and 60),
  match_key text not null check (char_length(match_key) between 1 and 500),
  name text not null check (char_length(name) between 1 and 300),
  vendor text check (char_length(vendor) <= 300),
  description text check (char_length(description) <= 1000),
  received_at timestamptz not null default now()
);

create index submissions_key_idx on public.submissions (kind, source, match_key);
create index submissions_client_idx on public.submissions (client_id, received_at desc);

-- Reclassification requests -----------------------------------------------------------------------

create sequence public.reclassification_request_number;

create table public.reclassification_requests (
  id uuid primary key default gen_random_uuid(),
  public_id text not null unique default ('REQ-' || lpad(nextval('public.reclassification_request_number')::text, 4, '0')),
  client_id uuid not null references public.clients (id) on delete cascade,
  entry_id uuid not null references public.entries (id) on delete cascade,
  current_category_id uuid references public.categories (id) on delete set null,
  -- null = "Other": the reason explains it.
  suggested_category_id uuid references public.categories (id) on delete set null,
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  evidence_url text check (evidence_url ~ '^https?://' and char_length(evidence_url) <= 500),
  status public.request_status not null default 'open',
  admin_note text check (char_length(admin_note) <= 1000),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users (id) on delete set null
);

alter sequence public.reclassification_request_number owned by public.reclassification_requests.public_id;

-- One open request per client and entry; a repeat returns the open one (H2).
create unique index reclassification_requests_one_open_idx on public.reclassification_requests (client_id, entry_id) where status = 'open';
create index reclassification_requests_entry_idx on public.reclassification_requests (entry_id, status);

-- Jev ---------------------------------------------------------------------------------------------

create table public.classification_runs (
  id uuid primary key default gen_random_uuid(),
  model text not null,
  started_by uuid references auth.users (id) on delete set null, -- null = automatic run
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  entry_count integer not null default 0 check (entry_count >= 0),
  status public.run_status not null default 'running'
);

create table public.classification_results (
  run_id uuid not null references public.classification_runs (id) on delete cascade,
  entry_id uuid not null references public.entries (id) on delete cascade,
  category_id uuid references public.categories (id) on delete set null,
  probability numeric(4, 3) check (probability between 0 and 1),
  accepted boolean,
  accepted_by uuid references auth.users (id) on delete set null,
  accepted_at timestamptz,
  primary key (run_id, entry_id)
);

create index classification_results_entry_idx on public.classification_results (entry_id);

-- Audit -------------------------------------------------------------------------------------------

create table public.audit_log (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete set null,
  action text not null,
  target text,
  data jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_created_idx on public.audit_log (created_at desc);

-- Access ------------------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'categories', 'entries', 'entry_revisions', 'dictionary_events', 'clients', 'submissions',
    'reclassification_requests', 'classification_runs', 'classification_results', 'audit_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('create policy "Hub admins read %s" on public.%I for select to authenticated using ((select public.is_hub_admin()))', t, t);
    if t <> 'clients' then
      execute format('grant select on table public.%I to authenticated', t);
    end if;
  end loop;
end;
$$;

-- The key hash never reaches the browser.
grant select (id, name, contact_email, key_prefix, status, created_at, last_seen_at, last_seq) on table public.clients to authenticated;

revoke all on sequence public.reclassification_request_number from anon, authenticated;
revoke all on function public.categories_guard() from public, anon, authenticated;
revoke all on function public.entries_guard() from public, anon, authenticated;
