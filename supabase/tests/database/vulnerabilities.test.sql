-- Phase H7: CPE matches, stored vulnerabilities with ranges per product and CPE, events, KEV and EPSS,
-- the client feed, curator actions and access.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
truncate public.clients, public.classification_runs, public.audit_log, public.hub_members, public.access_rules, public.notifications,
  public.vulnerabilities, public.vulnerability_events, public.vuln_sync_state, public.vuln_sync_runs cascade;
delete from public.entries;
delete from public.products;

select plan(38);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'ops@example.com'),
  ('00000000-0000-0000-0000-00000000000c', 'viewer@example.com');
delete from public.hub_members;
insert into public.hub_members (user_id, email, role) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@example.com', 'admin'),
  ('00000000-0000-0000-0000-00000000000b', 'ops@example.com', 'operator'),
  ('00000000-0000-0000-0000-00000000000c', 'viewer@example.com', 'viewer');
insert into public.clients (id, name, contact_email, key_prefix, key_hash) values
  ('c0000000-0000-0000-0000-000000000001', 'Acme', 'it@acme.example', 'hubk_aaaaaa', repeat('a', 64));
insert into public.entries (kind, source, match_key, canonical_name, vendor) values
  ('program', 'programs', '7-zip|igor pavlov', '7-Zip', 'Igor Pavlov'),
  ('package', 'npm', 'lodash', 'lodash', null);

create function pg_temp.product(name text) returns uuid language sql as $$ select id from public.products where display_name = $1 $$;
create function pg_temp.as_user(uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.events() returns int language sql as $$ select count(*)::int from public.vulnerability_events $$;

-- CPE matches ---------------------------------------------------------------------------------------------------
select is(public.vuln_store_cpes(pg_temp.product('7-Zip'), '[
  {"cpe_vendor": "7-zip", "cpe_product": "7-zip", "title": "7-Zip", "exact": true},
  {"cpe_vendor": "7-zip", "cpe_product": "p7zip", "title": "p7zip", "exact": false}]'), '{"new": 2, "confirmed": 1}'::jsonb,
  'an exact CPE is confirmed, the other waits as a candidate');
select is((select count(*)::int from public.v_cpe_candidates), 1, 'one candidate to review');
select is((select count(*)::int from public.vuln_products_due()), 0, 'a product with a confirmed CPE is not searched again');
select is((select cpe_product from public.vuln_cpes_due()), '7-zip', 'its CVEs are due');
select is((select ecosystem || '/' || package_name from public.vuln_packages_due()), 'npm/lodash', 'npm packages go to OSV');

-- Storing vulnerabilities ---------------------------------------------------------------------------------------
select set_config('t.cpe', (select id::text from public.product_cpes where cpe_product = '7-zip'), true);
select is(public.vuln_store(pg_temp.product('7-Zip'), 'nvd', '[
  {"vuln_id": "CVE-2025-0411", "summary": "MotW bypass", "cvss_version": "3.1", "cvss_score": 7.0, "severity": "HIGH", "cwe": ["CWE-693"],
   "references": ["https://example.org/a"], "kev_added": "2025-02-06", "kev_due": "2025-02-27",
   "ranges": [{"version_start": null, "start_inclusive": true, "version_end": "24.09", "end_inclusive": false, "exact_version": null}]},
  {"vuln_id": "CVE-2016-2334", "cvss_score": 9.3, "severity": "HIGH",
   "ranges": [{"exact_version": "9.20"}, {"version_start": "15.0", "version_end": "15.05", "end_inclusive": true}]}]', true, current_setting('t.cpe')::uuid),
  '{"changed": 2, "removed": 0, "new_kev": 1}'::jsonb, 'two CVEs stored with their ranges');
select is((select count(*)::int from public.vulnerability_ranges where product_id = pg_temp.product('7-Zip')), 3, 'three ranges');
select is(pg_temp.events(), 2, 'one event per (product, CVE)');
select ok((select synced_at is not null from public.product_cpes where id = current_setting('t.cpe')::uuid), 'the CPE is marked as read');
select ok((select title like 'Known exploited vulnerability for 7-Zip: CVE-2025-0411%' from public.notifications order by id desc limit 1),
  'a new known-exploited CVE notifies the inbox');

select is(public.vuln_store(pg_temp.product('7-Zip'), 'nvd', '[
  {"vuln_id": "CVE-2025-0411", "kev_added": "2025-02-06", "ranges": [{"version_end": "24.09"}]}]', false, current_setting('t.cpe')::uuid) ->> 'changed', '0',
  'the same ranges again: no event');
select is(public.vuln_store(pg_temp.product('7-Zip'), 'nvd', '[
  {"vuln_id": "CVE-2025-0411", "kev_added": "2025-02-06", "ranges": [{"version_end": "24.10"}]}]', false, current_setting('t.cpe')::uuid) ->> 'changed', '1',
  'a changed range: one event');
select is((select cvss_score from public.vulnerabilities where vuln_id = 'CVE-2025-0411'), 7.0::numeric(3, 1), 'a partial update keeps the known CVSS');

-- A second CPE of the same product keeps its own ranges apart.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select public.add_cpe(pg_temp.product('7-Zip'), '7-zip:7-zip_extra');
reset role;
select set_config('t.cpe2', (select id::text from public.product_cpes where cpe_product = '7-zip_extra'), true);
select public.vuln_store(pg_temp.product('7-Zip'), 'nvd', '[{"vuln_id": "CVE-2030-1", "ranges": [{"exact_version": "1.0"}]}]', true, current_setting('t.cpe2')::uuid);
select is((select count(distinct vuln_id)::int from public.vulnerability_ranges where product_id = pg_temp.product('7-Zip')), 3,
  'a full read of one CPE leaves the other CPE''s CVEs alone');

-- A full read without a CVE removes it, with an event.
select is(public.vuln_store(pg_temp.product('7-Zip'), 'nvd', '[{"vuln_id": "CVE-2025-0411", "kev_added": "2025-02-06", "ranges": [{"version_end": "24.10"}]}]',
  true, current_setting('t.cpe')::uuid) ->> 'removed', '1', 'a full read drops CVE-2016-2334');

-- OSV keeps the CVE id and adds its own id as an alias; NVD's CVSS is kept over OSV's missing score.
select public.vuln_store(pg_temp.product('lodash'), 'osv', '[{"vuln_id": "CVE-2021-23337", "aliases": ["GHSA-35jh-r3h4-6jhm"], "severity": "HIGH",
  "cvss_vector": "CVSS:3.1/AV:N", "ranges": [{"version_end": "4.17.21"}]}]', true, null);
select is((select aliases from public.vulnerabilities where vuln_id = 'CVE-2021-23337'), array['GHSA-35jh-r3h4-6jhm'], 'OSV alias kept');
select ok((select osv_synced_at is not null from public.product_vuln_state where product_id = pg_temp.product('lodash')), 'the package is marked as read');

-- KEV and EPSS --------------------------------------------------------------------------------------------------------
select set_config('t.before', pg_temp.events()::text, true);
select is(public.vuln_set_kev('[{"cve_id": "CVE-2021-23337", "date_added": "2026-10-01", "due_date": "2026-10-22", "ransomware": "Known"}]'), 1,
  'KEV flags a stored CVE');
select is(pg_temp.events() - current_setting('t.before')::int, 1, 'with an event for its product');
select ok((select title = 'Known exploited vulnerability for lodash: CVE-2021-23337 (CISA KEV since 2026-10-01)' from public.notifications order by id desc limit 1),
  'a CVE the KEV catalog adds later notifies the Inbox for its product');
select ok((select kev_flagged_at > now() - interval '1 minute' from public.vulnerabilities where vuln_id = 'CVE-2021-23337'), 'and is stamped as flagged now');
select results_eq($q$select k ->> 'vuln_id', k -> 'products' from jsonb_array_elements(public.build_digest() -> 'new_kev') k order by 1$q$,
  $q$values ('CVE-2021-23337', '["lodash"]'::jsonb), ('CVE-2025-0411', '["7-Zip"]'::jsonb)$q$, 'the daily digest lists CVEs that became known exploited in 24 hours');
select is(public.vuln_kev_due(), false, 'KEV is not due again for 20 hours');
select is((select count(*)::int from public.vuln_epss_due()), 3, 'EPSS is due for every stored CVE with a range');
select set_config('t.before', pg_temp.events()::text, true);
select public.vuln_set_epss('[{"cve_id": "CVE-2021-23337", "epss": 0.4, "percentile": 0.97}]');
select is(pg_temp.events() - current_setting('t.before')::int, 1, 'a first EPSS score is an event');
select public.vuln_set_epss('[{"cve_id": "CVE-2021-23337", "epss": 0.41, "percentile": 0.97}]');
select is(pg_temp.events() - current_setting('t.before')::int, 1, 'a small EPSS change is not');

-- The client feed ----------------------------------------------------------------------------------------------------
select ok((public.vulnerability_changes('c0000000-0000-0000-0000-000000000001', 0) -> 'items') @>
  '[{"vuln_id": "CVE-2025-0411", "product_key": "program|igor pavlov|7-zip", "removed": false, "kev_added": "2025-02-06"}]', 'the feed carries the product key, KEV and ranges');
select ok((public.vulnerability_changes('c0000000-0000-0000-0000-000000000001', 0) -> 'items') @> '[{"vuln_id": "CVE-2016-2334", "removed": true}]',
  'a dropped CVE comes as removed');
select is((select count(*)::int from jsonb_array_elements(public.vulnerability_changes('c0000000-0000-0000-0000-000000000001', 0) -> 'items') i
  where i ->> 'vuln_id' = 'CVE-2025-0411'), 1, 'one item per pair, the latest state');
select ok((public.vulnerability_changes('c0000000-0000-0000-0000-000000000001', 0, 1) ->> 'has_more')::boolean, 'paging: has_more');
select is((public.vulnerability_changes('c0000000-0000-0000-0000-000000000001', 0, 1) ->> 'next_seq')::bigint,
  (select min(seq) from public.vulnerability_events), 'paging: next_seq is the last event of the page');

-- Curator actions and access ------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select throws_ok($$select public.decide_cpe((select id from public.v_cpe_candidates limit 1), true)$$, '42501', null, 'a viewer cannot decide CPE matches');
select is(public.vuln_status(), null, 'a viewer gets no source status');
select ok((select count(*) from public.v_product_vulns) > 0, 'a viewer reads the vulnerabilities');
select throws_ok($$select public.vulnerability_changes('c0000000-0000-0000-0000-000000000001', 0)$$, '42501', null, 'the feed is for the service role');
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select lives_ok($$select public.decide_cpe((select id from public.v_cpe_candidates limit 1), false)$$, 'an operator rejects a candidate');
select lives_ok($$select public.decide_cpe((select id from public.product_cpes where cpe_product = '7-zip_extra'), false)$$, 'and a confirmed CPE');
reset role;
select is((select count(*)::int from public.vulnerability_ranges where vuln_id = 'CVE-2030-1'), 0, 'rejecting a CPE removes the CVEs it brought');

select * from finish();
rollback;
