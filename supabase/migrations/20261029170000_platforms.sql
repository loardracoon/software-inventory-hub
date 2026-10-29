-- Operating systems (windows, macos, linux) for vulnerabilities and titles.
--  A. Each affected version range carries the OS it applies to (NVD target_sw or "running on" configuration,
--     CNA platforms; null = every OS). The client feed sends it, and clients match a CVE only on computers
--     with that OS.
--  B. Clients may send, with each shared title, the OS families where it is installed (optional field
--     "platforms" of titles-submit; never versions, hosts or counts). Entries keep the union.

-- Normalized list: known values only, sorted, null when empty.
create or replace function public.platform_list(p jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case when count(*) = 0 then null else array_agg(x order by x) end
  from (
    select distinct x from jsonb_array_elements_text(case when jsonb_typeof(p) = 'array' then p else '[]' end) x
    where x in ('windows', 'macos', 'linux')
  ) l;
$$;

create or replace function public.platform_union(a text[], b text[])
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case when count(*) = 0 then null else array_agg(x order by x) end
  from (select distinct unnest(coalesce(a, '{}') || coalesce(b, '{}')) x) u;
$$;

-- A. Ranges ---------------------------------------------------------------------------------------------------

alter table public.vulnerability_ranges add column platforms text[]
  check (platforms is null or (cardinality(platforms) > 0 and platforms <@ array['windows', 'macos', 'linux']));

do $$
declare
  v_def text;
  v_parts text[][] := array[
    -- stored ranges, compared with the new ones
    array['''ei'', end_inclusive, ''x'', exact_version)', '''ei'', end_inclusive, ''x'', exact_version, ''p'', platforms)'],
    -- new ranges
    array['''x'', r ->> ''exact_version'') order by', '''x'', r ->> ''exact_version'', ''p'', public.platform_list(r -> ''platforms'')) order by'],
    -- insert
    array['version_start, start_inclusive, version_end, end_inclusive, exact_version)', 'version_start, start_inclusive, version_end, end_inclusive, exact_version, platforms)'],
    array['false), r ->> ''exact_version''', 'false), r ->> ''exact_version'', public.platform_list(r -> ''platforms'')']
  ];
  i integer;
begin
  select pg_get_functiondef('public.vuln_store'::regproc) into v_def;
  for i in 1 .. array_length(v_parts, 1) loop
    if (length(v_def) - length(replace(v_def, v_parts[i][1], ''))) / length(v_parts[i][1]) <> 1 then
      raise exception 'vuln_store has changed (part %): update this migration', i;
    end if;
    v_def := replace(v_def, v_parts[i][1], v_parts[i][2]);
  end loop;
  execute v_def;

  select pg_get_functiondef('public.vulnerability_changes'::regproc) into v_def;
  if position('''exact_version'', r.exact_version, ''source'', r.source)' in v_def) = 0 then
    raise exception 'vulnerability_changes has changed: update this migration';
  end if;
  execute replace(v_def, '''exact_version'', r.exact_version, ''source'', r.source)',
    '''exact_version'', r.exact_version, ''source'', r.source, ''platforms'', r.platforms)');
end;
$$;

create or replace view public.v_product_vulns
with (security_invoker = true)
as
select r.product_id, v.vuln_id, v.aliases, v.summary, v.cvss_score, v.severity, v.cvss_version, v.kev_added, v.kev_due, v.kev_ransomware,
  v.epss, v.epss_percentile, v.published, v.refs,
  jsonb_agg(jsonb_build_object('version_start', r.version_start, 'start_inclusive', r.start_inclusive, 'version_end', r.version_end,
    'end_inclusive', r.end_inclusive, 'exact_version', r.exact_version, 'source', r.source, 'platforms', r.platforms) order by r.id) as ranges
from public.vulnerability_ranges r
join public.vulnerabilities v on v.vuln_id = r.vuln_id
group by r.product_id, v.vuln_id;

-- Read every confirmed CPE again in full, so the stored ranges get their OS.
update public.product_cpes set synced_at = null where status = 'confirmed';

-- B. Titles -----------------------------------------------------------------------------------------------------

alter table public.entries add column platforms text[]
  check (platforms is null or (cardinality(platforms) > 0 and platforms <@ array['windows', 'macos', 'linux']));
alter table public.submissions add column platforms text[];

do $$
declare
  v_def text;
  v_parts text[][] := array[
    array['(client_id, kind, source, match_key, name, vendor, description)', '(client_id, kind, source, match_key, name, vendor, description, platforms)'],
    array['t ->> ''vendor'', left(t ->> ''description'', 1000));', 't ->> ''vendor'', left(t ->> ''description'', 1000), public.platform_list(t -> ''platforms''));'],
    array['canonical_name, vendor, description, reports_count, first_reported_at, last_reported_at)',
      'canonical_name, vendor, description, reports_count, first_reported_at, last_reported_at, platforms)'],
    array['left(t ->> ''description'', 1000), 1, now(), now())', 'left(t ->> ''description'', 1000), 1, now(), now(), public.platform_list(t -> ''platforms''))'],
    array['      last_reported_at = now(),', '      last_reported_at = now(),
      -- Operating systems where clients found the title (a union; any status).
      platforms = public.platform_union(e.platforms, excluded.platforms),']
  ];
  i integer;
begin
  select pg_get_functiondef('public.submit_titles'::regproc) into v_def;
  for i in 1 .. array_length(v_parts, 1) loop
    if (length(v_def) - length(replace(v_def, v_parts[i][1], ''))) / length(v_parts[i][1]) <> 1 then
      raise exception 'submit_titles has changed (part %): update this migration', i;
    end if;
    v_def := replace(v_def, v_parts[i][1], v_parts[i][2]);
  end loop;
  execute v_def;
end;
$$;

revoke all on function public.platform_list(jsonb), public.platform_union(text[], text[]) from public, anon;
grant execute on function public.platform_list(jsonb), public.platform_union(text[], text[]) to authenticated, service_role;
