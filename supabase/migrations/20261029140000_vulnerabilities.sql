-- Phase H7: known vulnerabilities per product, from open sources: NVD (programs, through CPE), OSV.dev
-- (npm and PyPI packages), CISA KEV (known exploited) and FIRST EPSS (exploit probability).
-- The Hub stores CVEs with their affected version ranges per product and sends them to clients through
-- GET vulnerability-changes; clients compare their own installed versions (versions never leave them).
-- The Edge Function vuln-sync does the I/O (_shared/vuln-sources.ts); these functions store the results.

-- 1. NVD API key (optional; raises NVD's limit from 5 to 50 calls per 30 s) beside the AI keys ------------
alter table public.provider_keys drop constraint provider_keys_provider_check;
alter table public.provider_keys add constraint provider_keys_provider_check check (provider in ('claude', 'gemini', 'openai', 'grok', 'nvd'));

do $$
declare
  f text;
  v_def text;
begin
  foreach f in array array['set_provider_key', 'clear_provider_key'] loop
    select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = f;
    if position('(''claude'', ''gemini'', ''openai'', ''grok'')' in v_def) > 0 then
      execute replace(v_def, '(''claude'', ''gemini'', ''openai'', ''grok'')', '(''claude'', ''gemini'', ''openai'', ''grok'', ''nvd'')');
    end if;
  end loop;
end;
$$;

-- 2. Tables -----------------------------------------------------------------------------------------------
create type public.cpe_status as enum ('candidate', 'confirmed', 'rejected');

-- NVD product names (CPE vendor:product) of a Hub product. Exact matches are confirmed automatically;
-- other candidates wait for an operator (Inbox › CPE matches).
create table public.product_cpes (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  cpe_vendor text not null check (char_length(cpe_vendor) between 1 and 200),
  cpe_product text not null check (char_length(cpe_product) between 1 and 200),
  title text check (char_length(title) <= 300),
  status public.cpe_status not null default 'candidate',
  source text not null check (source in ('exact', 'search', 'manual')),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (product_id, cpe_vendor, cpe_product)
);

create index product_cpes_status_idx on public.product_cpes (status, synced_at);

-- Per product: when the CPE dictionary was searched and when OSV was read.
create table public.product_vuln_state (
  product_id uuid primary key references public.products (id) on delete cascade,
  cpe_searched_at timestamptz,
  osv_synced_at timestamptz,
  last_error text
);

create table public.vulnerabilities (
  vuln_id text primary key check (char_length(vuln_id) between 3 and 100),
  aliases text[] not null default '{}',
  source text not null check (source in ('nvd', 'osv')),
  published timestamptz,
  modified timestamptz,
  summary text check (char_length(summary) <= 2000),
  cvss_version text,
  cvss_score numeric(3, 1) check (cvss_score between 0 and 10),
  severity text check (severity in ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE')),
  cvss_vector text,
  cwe text[] not null default '{}',
  refs text[] not null default '{}',
  kev_added date,
  kev_due date,
  kev_ransomware text,
  epss numeric(6, 5),
  epss_percentile numeric(6, 5),
  epss_date date,
  updated_at timestamptz not null default now()
);

create table public.vulnerability_ranges (
  id bigint generated always as identity primary key,
  product_id uuid not null references public.products (id) on delete cascade,
  vuln_id text not null references public.vulnerabilities (vuln_id) on delete cascade,
  source text not null check (source in ('nvd', 'osv')),
  -- The CPE whose CVE configurations gave this range (NVD); null for OSV.
  cpe_id uuid references public.product_cpes (id) on delete cascade,
  version_start text,
  start_inclusive boolean not null default true,
  version_end text,
  end_inclusive boolean not null default false,
  exact_version text
);

create index vulnerability_ranges_product_idx on public.vulnerability_ranges (product_id, vuln_id);
create index vulnerability_ranges_vuln_idx on public.vulnerability_ranges (vuln_id);

-- One row per change of a (product, vulnerability) pair; clients page by seq.
create table public.vulnerability_events (
  seq bigint generated always as identity primary key,
  product_id uuid not null,
  vuln_id text not null,
  created_at timestamptz not null default now()
);

create index vulnerability_events_pair_idx on public.vulnerability_events (product_id, vuln_id, seq desc);

create table public.vuln_sync_state (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

create table public.vuln_sync_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  trigger text not null check (trigger in ('cron', 'manual')),
  summary jsonb,
  errors text[] not null default '{}'
);

-- 3. Storage (service role, called by vuln-sync) ----------------------------------------------------------

-- Programs whose CPE dictionary search is due: never searched, or searched more than 30 days ago without
-- a confirmed CPE. Published products first, most reported first.
create or replace function public.vuln_products_due(p_limit integer default 20)
returns table (product_id uuid, display_name text, vendor_key text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.display_name, split_part(p.product_key, '|', 2)
  from public.products p
  left join public.product_vuln_state s on s.product_id = p.id
  where p.kind = 'program'
    and not exists (select 1 from public.product_cpes c where c.product_id = p.id and c.status = 'confirmed')
    and (s.cpe_searched_at is null or s.cpe_searched_at < now() - interval '30 days')
    and exists (select 1 from public.entries e where e.product_id = p.id and e.status = 'published')
  order by s.cpe_searched_at nulls first,
    (select coalesce(sum(e.reports_count), 0) from public.entries e where e.product_id = p.id) desc
  limit least(greatest(p_limit, 1), 200);
$$;

-- p_candidates: [{ cpe_vendor, cpe_product, title, exact }]. Exact ones are confirmed at once.
create or replace function public.vuln_store_cpes(p_product_id uuid, p_candidates jsonb, p_error text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_new integer;
  v_confirmed integer;
begin
  insert into public.product_vuln_state (product_id, cpe_searched_at, last_error) values (p_product_id, now(), left(p_error, 500))
  on conflict (product_id) do update set cpe_searched_at = now(), last_error = left(p_error, 500);
  insert into public.product_cpes (product_id, cpe_vendor, cpe_product, title, status, source, decided_at)
  select p_product_id, c ->> 'cpe_vendor', c ->> 'cpe_product', left(c ->> 'title', 300),
    case when (c ->> 'exact')::boolean then 'confirmed' else 'candidate' end::public.cpe_status,
    case when (c ->> 'exact')::boolean then 'exact' else 'search' end,
    case when (c ->> 'exact')::boolean then now() end
  from jsonb_array_elements(coalesce(p_candidates, '[]')) c
  on conflict (product_id, cpe_vendor, cpe_product) do nothing;
  get diagnostics v_new = row_count;
  select count(*) into v_confirmed from public.product_cpes where product_id = p_product_id and status = 'confirmed';
  return jsonb_build_object('new', v_new, 'confirmed', v_confirmed);
end;
$$;

-- Confirmed CPEs whose CVEs are due (never read, or last read more than a day ago).
create or replace function public.vuln_cpes_due(p_limit integer default 20)
returns table (id uuid, product_id uuid, cpe_vendor text, cpe_product text, synced_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.product_id, c.cpe_vendor, c.cpe_product, c.synced_at
  from public.product_cpes c
  where c.status = 'confirmed' and (c.synced_at is null or c.synced_at < now() - interval '1 day')
  order by c.synced_at nulls first
  limit least(greatest(p_limit, 1), 200);
$$;

-- npm and PyPI packages whose OSV data is due (daily). The package name is the entry's match key.
create or replace function public.vuln_packages_due(p_limit integer default 50)
returns table (product_id uuid, ecosystem text, package_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct on (e.product_id) e.product_id,
    case e.source when 'npm' then 'npm' when 'pip' then 'PyPI' end, e.match_key
  from public.entries e
  left join public.product_vuln_state s on s.product_id = e.product_id
  where e.kind = 'package' and e.source in ('npm', 'pip') and e.product_id is not null and e.status <> 'deprecated'
    and (s.osv_synced_at is null or s.osv_synced_at < now() - interval '1 day')
  order by e.product_id, e.reports_count desc
  limit least(greatest(p_limit, 1), 500);
$$;

-- Stores the vulnerabilities of one product from one source. p_vulns: [{ vuln_id, aliases, source,
-- published, modified, summary, cvss_*, severity, cwe, references, kev_added, kev_due, ranges: [...] }].
-- p_full: the answer is complete, so vulnerabilities of this product and source missing from it are
-- removed (with an event, so clients drop them). p_cpe_id: the CPE read (its ranges are kept apart from
-- the product's other CPEs; its synced_at is set).
create or replace function public.vuln_store(p_product_id uuid, p_source text, p_vulns jsonb, p_full boolean, p_cpe_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v jsonb;
  v_old_ranges jsonb;
  v_new_ranges jsonb;
  v_was_kev boolean;
  v_changed integer := 0;
  v_removed integer := 0;
  v_new_kev text[] := '{}';
  v_ids text[] := '{}';
  v_name text;
begin
  for v in select x from jsonb_array_elements(coalesce(p_vulns, '[]')) x loop
    v_ids := v_ids || (v ->> 'vuln_id');
    select kev_added is not null into v_was_kev from public.vulnerabilities where vuln_id = v ->> 'vuln_id';
    insert into public.vulnerabilities as t (vuln_id, aliases, source, published, modified, summary, cvss_version, cvss_score, severity,
                                             cvss_vector, cwe, refs, kev_added, kev_due, updated_at)
    values (v ->> 'vuln_id', array(select jsonb_array_elements_text(coalesce(v -> 'aliases', '[]'))), p_source,
      (v ->> 'published')::timestamptz, (v ->> 'modified')::timestamptz, left(v ->> 'summary', 2000), v ->> 'cvss_version',
      (v ->> 'cvss_score')::numeric, v ->> 'severity', v ->> 'cvss_vector',
      array(select jsonb_array_elements_text(coalesce(v -> 'cwe', '[]'))), array(select jsonb_array_elements_text(coalesce(v -> 'references', '[]'))),
      (v ->> 'kev_added')::date, (v ->> 'kev_due')::date, now())
    on conflict (vuln_id) do update set
      aliases = (select array(select distinct unnest(t.aliases || excluded.aliases))),
      published = coalesce(excluded.published, t.published),
      modified = coalesce(excluded.modified, t.modified),
      summary = coalesce(excluded.summary, t.summary),
      -- NVD's CVSS wins over OSV's (OSV gives a vector without a score).
      cvss_version = case when excluded.cvss_score is not null or t.cvss_score is null then coalesce(excluded.cvss_version, t.cvss_version) else t.cvss_version end,
      cvss_score = coalesce(excluded.cvss_score, t.cvss_score),
      severity = coalesce(case when excluded.cvss_score is not null or t.severity is null then excluded.severity end, t.severity),
      cvss_vector = case when excluded.cvss_score is not null or t.cvss_vector is null then coalesce(excluded.cvss_vector, t.cvss_vector) else t.cvss_vector end,
      cwe = (select array(select distinct unnest(t.cwe || excluded.cwe))),
      refs = case when cardinality(excluded.refs) > 0 then excluded.refs else t.refs end,
      kev_added = coalesce(t.kev_added, excluded.kev_added),
      kev_due = coalesce(t.kev_due, excluded.kev_due),
      updated_at = now();

    select coalesce(jsonb_agg(jsonb_build_object('s', version_start, 'si', start_inclusive, 'e', version_end, 'ei', end_inclusive, 'x', exact_version)
             order by version_start, version_end, exact_version), '[]')
    into v_old_ranges
    from public.vulnerability_ranges
    where product_id = p_product_id and vuln_id = v ->> 'vuln_id' and source = p_source and cpe_id is not distinct from p_cpe_id;
    select coalesce(jsonb_agg(jsonb_build_object('s', r ->> 'version_start', 'si', coalesce((r ->> 'start_inclusive')::boolean, true), 'e', r ->> 'version_end',
             'ei', coalesce((r ->> 'end_inclusive')::boolean, false), 'x', r ->> 'exact_version') order by r ->> 'version_start', r ->> 'version_end', r ->> 'exact_version'), '[]')
    into v_new_ranges
    from jsonb_array_elements(coalesce(v -> 'ranges', '[]')) r;

    if v_old_ranges is distinct from v_new_ranges or (v_was_kev is distinct from true and v ->> 'kev_added' is not null) or v_was_kev is null then
      delete from public.vulnerability_ranges
      where product_id = p_product_id and vuln_id = v ->> 'vuln_id' and source = p_source and cpe_id is not distinct from p_cpe_id;
      insert into public.vulnerability_ranges (product_id, vuln_id, source, cpe_id, version_start, start_inclusive, version_end, end_inclusive, exact_version)
      select p_product_id, v ->> 'vuln_id', p_source, p_cpe_id, r ->> 'version_start', coalesce((r ->> 'start_inclusive')::boolean, true), r ->> 'version_end',
        coalesce((r ->> 'end_inclusive')::boolean, false), r ->> 'exact_version'
      from jsonb_array_elements(coalesce(v -> 'ranges', '[]')) r;
      insert into public.vulnerability_events (product_id, vuln_id) values (p_product_id, v ->> 'vuln_id');
      v_changed := v_changed + 1;
      if v ->> 'kev_added' is not null and v_old_ranges = '[]'::jsonb then
        v_new_kev := v_new_kev || (v ->> 'vuln_id');
      end if;
    end if;
  end loop;

  if p_full then
    with gone as (
      delete from public.vulnerability_ranges r
      where r.product_id = p_product_id and r.source = p_source and r.cpe_id is not distinct from p_cpe_id and not (r.vuln_id = any (v_ids))
      returning r.vuln_id
    )
    insert into public.vulnerability_events (product_id, vuln_id) select distinct p_product_id, vuln_id from gone;
    get diagnostics v_removed = row_count;
  end if;

  if p_cpe_id is not null then
    update public.product_cpes set synced_at = now(), last_error = null where id = p_cpe_id;
  end if;
  if p_source = 'osv' then
    insert into public.product_vuln_state (product_id, osv_synced_at) values (p_product_id, now())
    on conflict (product_id) do update set osv_synced_at = now(), last_error = null;
  end if;

  if cardinality(v_new_kev) > 0 then
    select display_name into v_name from public.products where id = p_product_id;
    insert into public.notifications (type, ref_id, title)
    values ('system', p_product_id::text, left(format('Known exploited vulnerability for %s: %s', v_name, array_to_string(v_new_kev, ', ')), 300));
  end if;
  return jsonb_build_object('changed', v_changed, 'removed', v_removed, 'new_kev', cardinality(v_new_kev));
end;
$$;

-- The CISA KEV catalog: flags the CVEs it lists (with an event for each product that has them).
create or replace function public.vuln_set_kev(p_rows jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with rows as (
    select r ->> 'cve_id' as cve_id, (r ->> 'date_added')::date as date_added, (r ->> 'due_date')::date as due_date, r ->> 'ransomware' as ransomware
    from jsonb_array_elements(coalesce(p_rows, '[]')) r
  ),
  changed as (
    update public.vulnerabilities v set kev_added = r.date_added, kev_due = r.due_date, kev_ransomware = r.ransomware, updated_at = now()
    from rows r
    where v.vuln_id = r.cve_id
      and (v.kev_added is distinct from r.date_added or v.kev_due is distinct from r.due_date or v.kev_ransomware is distinct from r.ransomware)
    returning v.vuln_id, v.kev_added
  ),
  events as (
    insert into public.vulnerability_events (product_id, vuln_id)
    select distinct x.product_id, x.vuln_id from public.vulnerability_ranges x join changed c on c.vuln_id = x.vuln_id
    returning product_id, vuln_id
  )
  select count(*) into v_count from changed;
  insert into public.vuln_sync_state (key, value, updated_at) values ('kev', now()::text, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return v_count;
end;
$$;

-- CVEs whose EPSS is missing or older than today.
create or replace function public.vuln_epss_due(p_limit integer default 1000)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select v.vuln_id from public.vulnerabilities v
  where v.vuln_id like 'CVE-%' and (v.epss_date is null or v.epss_date < current_date - 1)
    and exists (select 1 from public.vulnerability_ranges r where r.vuln_id = v.vuln_id)
  order by v.epss_date nulls first
  limit least(greatest(p_limit, 1), 5000);
$$;

-- EPSS scores. Clients get an event only when the score moves by 0.05 or more (EPSS changes daily).
create or replace function public.vuln_set_epss(p_rows jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with rows as (
    select r ->> 'cve_id' as cve_id, (r ->> 'epss')::numeric as epss, (r ->> 'percentile')::numeric as percentile, coalesce((r ->> 'date')::date, current_date) as day
    from jsonb_array_elements(coalesce(p_rows, '[]')) r
  ),
  old as (
    select v.vuln_id, v.epss as old_epss from public.vulnerabilities v join rows r on r.cve_id = v.vuln_id
  ),
  updated as (
    update public.vulnerabilities v set epss = round(r.epss, 5), epss_percentile = round(r.percentile, 5), epss_date = r.day
    from rows r where v.vuln_id = r.cve_id
    returning v.vuln_id, v.epss
  )
  insert into public.vulnerability_events (product_id, vuln_id)
  select distinct x.product_id, x.vuln_id
  from updated u
  join old o on o.vuln_id = u.vuln_id
  join public.vulnerability_ranges x on x.vuln_id = u.vuln_id
  where o.old_epss is null or abs(u.epss - o.old_epss) >= 0.05;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- The KEV catalog is read again after 20 hours.
create or replace function public.vuln_kev_due()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select updated_at < now() - interval '20 hours' from public.vuln_sync_state where key = 'kev'), true);
$$;

-- A failed source call: on the CPE (CVE read) or on the product (CPE search, OSV).
create or replace function public.vuln_mark_error(p_cpe_id uuid, p_product_id uuid, p_error text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_cpe_id is not null then
    -- Retry tomorrow, not on every run.
    update public.product_cpes set last_error = left(p_error, 500), synced_at = now() where id = p_cpe_id;
  elsif p_product_id is not null then
    insert into public.product_vuln_state (product_id, last_error, osv_synced_at) values (p_product_id, left(p_error, 500), now())
    on conflict (product_id) do update set last_error = left(p_error, 500), osv_synced_at = now();
  end if;
end;
$$;

-- One product, for the Refresh button: kind, name, vendor key, package source, confirmed CPEs.
create or replace function public.vuln_product_info(p_product_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id, 'kind', p.kind, 'display_name', p.display_name, 'vendor_key', split_part(p.product_key, '|', 2),
    'package', (select jsonb_build_object('ecosystem', case e.source when 'npm' then 'npm' when 'pip' then 'PyPI' end, 'name', e.match_key)
                from public.entries e where e.product_id = p.id and e.kind = 'package' and e.source in ('npm', 'pip') order by e.reports_count desc limit 1),
    'cpes', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'cpe_vendor', c.cpe_vendor, 'cpe_product', c.cpe_product))
                      from public.product_cpes c where c.product_id = p.id and c.status = 'confirmed'), '[]'))
  from public.products p where p.id = p_product_id;
$$;

create or replace function public.vuln_run_start(p_trigger text)
returns bigint
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.vuln_sync_runs (trigger) values (p_trigger) returning id;
$$;

create or replace function public.vuln_run_finish(p_id bigint, p_summary jsonb, p_errors text[])
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.vuln_sync_runs set finished_at = now(), summary = p_summary, errors = coalesce(p_errors[1:20], '{}') where id = p_id;
$$;

-- 4. Client API: GET vulnerability-changes?since=<seq> --------------------------------------------------------
-- Each item is the current state of one (product, vulnerability) pair: the vulnerability with its ranges
-- for that product, or removed = true when the product no longer has it.
create or replace function public.vulnerability_changes(p_client_id uuid, p_since bigint, p_limit integer default 500)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 1000);
  v_items jsonb;
  v_next bigint;
  v_more boolean;
begin
  with page as (
    select e.seq, e.product_id, e.vuln_id from public.vulnerability_events e
    where e.seq > p_since order by e.seq limit v_limit + 1
  ),
  latest as (
    select distinct on (product_id, vuln_id) seq, product_id, vuln_id from page
    where seq <= coalesce((select seq from page order by seq offset v_limit limit 1) - 1, 9223372036854775807)
    order by product_id, vuln_id, seq desc
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'product_id', l.product_id, 'product_key', p.product_key, 'vuln_id', l.vuln_id,
      'removed', not exists (select 1 from public.vulnerability_ranges r where r.product_id = l.product_id and r.vuln_id = l.vuln_id),
      'aliases', v.aliases, 'published', v.published, 'modified', v.modified, 'summary', v.summary,
      'cvss_version', v.cvss_version, 'cvss_score', v.cvss_score, 'severity', v.severity, 'cvss_vector', v.cvss_vector,
      'cwe', v.cwe, 'references', v.refs, 'kev_added', v.kev_added, 'kev_due', v.kev_due, 'kev_ransomware', v.kev_ransomware,
      'epss', v.epss, 'epss_percentile', v.epss_percentile,
      'ranges', coalesce((select jsonb_agg(jsonb_build_object('version_start', r.version_start, 'start_inclusive', r.start_inclusive,
          'version_end', r.version_end, 'end_inclusive', r.end_inclusive, 'exact_version', r.exact_version, 'source', r.source) order by r.id)
        from public.vulnerability_ranges r where r.product_id = l.product_id and r.vuln_id = l.vuln_id), '[]'),
      'seq', l.seq) order by l.seq), '[]'),
    max(l.seq)
  into v_items, v_next
  from latest l
  left join public.products p on p.id = l.product_id
  left join public.vulnerabilities v on v.vuln_id = l.vuln_id;

  select count(*) > v_limit into v_more from (select 1 from public.vulnerability_events e where e.seq > p_since limit v_limit + 1) x;
  if v_more then
    select seq into v_next from public.vulnerability_events e where e.seq > p_since order by e.seq offset v_limit - 1 limit 1;
  end if;
  return jsonb_build_object('items', v_items, 'next_seq', coalesce(v_next, p_since), 'has_more', v_more);
end;
$$;

-- 5. Console reads and curator actions --------------------------------------------------------------------------

create view public.v_cpe_candidates
with (security_invoker = true)
as
select c.id, c.product_id, p.display_name, p.vendor, c.cpe_vendor, c.cpe_product, c.title, c.created_at,
  (select e.id from public.entries e where e.product_id = p.id order by e.reports_count desc limit 1) as entry_id
from public.product_cpes c
join public.products p on p.id = c.product_id
where c.status = 'candidate';

create view public.v_product_vulns
with (security_invoker = true)
as
select r.product_id, v.vuln_id, v.aliases, v.summary, v.cvss_score, v.severity, v.cvss_version, v.kev_added, v.kev_due, v.kev_ransomware,
  v.epss, v.epss_percentile, v.published, v.refs,
  jsonb_agg(jsonb_build_object('version_start', r.version_start, 'start_inclusive', r.start_inclusive, 'version_end', r.version_end,
    'end_inclusive', r.end_inclusive, 'exact_version', r.exact_version, 'source', r.source) order by r.id) as ranges
from public.vulnerability_ranges r
join public.vulnerabilities v on v.vuln_id = r.vuln_id
group by r.product_id, v.vuln_id;

-- Accept (confirm) or reject a candidate CPE.
create or replace function public.decide_cpe(p_id uuid, p_accept boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.product_cpes;
begin
  if not public.can_curate() then
    raise exception 'Only hub admins and operators decide CPE matches' using errcode = '42501';
  end if;
  update public.product_cpes set status = case when p_accept then 'confirmed' else 'rejected' end::public.cpe_status,
    decided_by = auth.uid(), decided_at = now(), synced_at = null
  where id = p_id
  returning * into c;
  if c.id is null then
    raise exception 'CPE match not found' using errcode = 'P0002';
  end if;
  -- A rejected CPE takes away the CVEs it brought (when it was confirmed before).
  if not p_accept then
    perform public.vuln_store(c.product_id, 'nvd', '[]', true, c.id);
  end if;
  insert into public.audit_log (user_id, action, target, data)
  values (auth.uid(), case when p_accept then 'confirm cpe' else 'reject cpe' end, 'product_cpes:' || p_id,
    jsonb_build_object('product_id', c.product_id, 'cpe', c.cpe_vendor || ':' || c.cpe_product));
end;
$$;

-- Add a CPE by hand: "vendor:product" or a full cpe:2.3 name. Confirmed at once.
create or replace function public.add_cpe(p_product_id uuid, p_cpe text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_parts text[];
  v_vendor text;
  v_product text;
  v_id uuid;
begin
  if not public.can_curate() then
    raise exception 'Only hub admins and operators decide CPE matches' using errcode = '42501';
  end if;
  v_parts := regexp_split_to_array(btrim(coalesce(p_cpe, '')), '(?<!\\):');
  if v_parts[1] = 'cpe' and v_parts[2] = '2.3' and cardinality(v_parts) >= 5 then
    v_vendor := v_parts[4];
    v_product := v_parts[5];
  elsif cardinality(v_parts) = 2 then
    v_vendor := lower(v_parts[1]);
    v_product := lower(v_parts[2]);
  end if;
  if coalesce(v_vendor, '') !~ '^[a-z0-9_.\-\\+!~]+$' or coalesce(v_product, '') !~ '^[a-z0-9_.\-\\+!~]+$' then
    raise exception 'Enter vendor:product as NVD writes it, e.g. 7-zip:7-zip' using errcode = '22023';
  end if;
  insert into public.product_cpes (product_id, cpe_vendor, cpe_product, title, status, source, decided_by, decided_at)
  values (p_product_id, v_vendor, v_product, v_vendor || ':' || v_product, 'confirmed', 'manual', auth.uid(), now())
  on conflict (product_id, cpe_vendor, cpe_product) do update set status = 'confirmed', decided_by = auth.uid(), decided_at = now(), synced_at = null
  returning id into v_id;
  insert into public.audit_log (user_id, action, target, data)
  values (auth.uid(), 'add cpe', 'product_cpes:' || v_id, jsonb_build_object('product_id', p_product_id, 'cpe', v_vendor || ':' || v_product));
  return v_id;
end;
$$;

-- Status for Settings › Data sources.
create or replace function public.vuln_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when not public.can_curate() then null else jsonb_build_object(
    'products_with_cpe', (select count(distinct product_id) from public.product_cpes where status = 'confirmed'),
    'cpe_candidates', (select count(*) from public.product_cpes where status = 'candidate'),
    'vulnerabilities', (select count(distinct vuln_id) from public.vulnerability_ranges),
    'kev', (select count(distinct r.vuln_id) from public.vulnerability_ranges r join public.vulnerabilities v on v.vuln_id = r.vuln_id where v.kev_added is not null),
    'kev_synced_at', (select updated_at from public.vuln_sync_state where key = 'kev'),
    'nvd_key', exists (select 1 from public.provider_keys where provider = 'nvd'),
    'last_run', (select to_jsonb(r) from public.vuln_sync_runs r order by r.id desc limit 1)
  ) end;
$$;

-- 6. Schedule: vuln-sync hourly (reuses the Jev cron secrets, like research-tick) -------------------------------
create or replace function public.invoke_vuln_sync()
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
  return net.http_post(url := regexp_replace(v_url, '/jev/?$', '/vuln-sync'), body := '{"action": "tick"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret), timeout_milliseconds := 150000);
end;
$$;

select cron.unschedule(jobid) from cron.job where jobname = 'vuln-sync';
select cron.schedule('vuln-sync', '17 * * * *', 'select public.invoke_vuln_sync()');

-- 7. Access -------------------------------------------------------------------------------------------------------
alter table public.product_cpes enable row level security;
alter table public.product_vuln_state enable row level security;
alter table public.vulnerabilities enable row level security;
alter table public.vulnerability_ranges enable row level security;
alter table public.vulnerability_events enable row level security;
alter table public.vuln_sync_state enable row level security;
alter table public.vuln_sync_runs enable row level security;

create policy "Members read product cpes" on public.product_cpes for select to authenticated using ((select public.is_hub_member()));
create policy "Members read vulnerabilities" on public.vulnerabilities for select to authenticated using ((select public.is_hub_member()));
create policy "Members read vulnerability ranges" on public.vulnerability_ranges for select to authenticated using ((select public.is_hub_member()));
create policy "Curators read sync runs" on public.vuln_sync_runs for select to authenticated using ((select public.can_curate()));

revoke all on table public.product_cpes, public.product_vuln_state, public.vulnerabilities, public.vulnerability_ranges, public.vulnerability_events,
  public.vuln_sync_state, public.vuln_sync_runs, public.v_cpe_candidates, public.v_product_vulns from anon, authenticated;
grant select on table public.product_cpes, public.vulnerabilities, public.vulnerability_ranges, public.vuln_sync_runs,
  public.v_cpe_candidates, public.v_product_vulns to authenticated;

do $$
declare
  f text;
begin
  foreach f in array array['decide_cpe(uuid, boolean)', 'add_cpe(uuid, text)', 'vuln_status()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['vuln_products_due(integer)', 'vuln_store_cpes(uuid, jsonb, text)', 'vuln_cpes_due(integer)', 'vuln_packages_due(integer)',
                           'vuln_store(uuid, text, jsonb, boolean, uuid)', 'vuln_set_kev(jsonb)', 'vuln_epss_due(integer)', 'vuln_set_epss(jsonb)',
                           'vulnerability_changes(uuid, bigint, integer)', 'invoke_vuln_sync()', 'vuln_kev_due()',
                           'vuln_mark_error(uuid, uuid, text)', 'vuln_product_info(uuid)', 'vuln_run_start(text)', 'vuln_run_finish(bigint, jsonb, text[])'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
