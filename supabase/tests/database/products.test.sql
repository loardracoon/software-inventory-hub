-- Phase H6: product grouping. Name and vendor normalization (the same vectors as the client), grouping,
-- one classification per product, new aliases, conflicts, move and split, vendor aliases, the feed.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
truncate public.clients, public.classification_runs, public.audit_log, public.hub_members, public.access_rules, public.notifications,
  public.vendor_aliases cascade;
delete from public.entries;
delete from public.products;

select plan(57);

-- Normalization ------------------------------------------------------------------------------------------
select is(public.product_name(n), expected, format('product_name(%s)', n))
from (values
  ('7-Zip 23.01 (x64)', '7-Zip'),
  ('7-Zip 26.05 (x64)', '7-Zip'),
  ('Notepad++ 8.6.4 (64-bit x64)', 'Notepad++'),
  ('Notepad++ (64-bit x64)', 'Notepad++'),
  ('Python 3.12.1 (64-bit)', 'Python'),
  ('Microsoft Visual C++ 2015-2022 Redistributable (x64) - 14.38.33135', 'Microsoft Visual C++ 2015-2022 Redistributable'),
  ('Mozilla Firefox (x64 en-US)', 'Mozilla Firefox (x64 en-US)'),
  ('VLC media player v3.0.20', 'VLC media player'),
  ('Java 8 Update 401', 'Java 8 Update 401'),
  ('python3.12', 'python3.12'),
  ('7-Zip', '7-Zip'),
  ('1.2.3', '1.2.3'),
  ('WindowsAppRuntime.1.8', 'WindowsAppRuntime'),
  ('WindowsAppRuntime.2', 'WindowsAppRuntime'),
  ('Microsoft.UI.Xaml.2.8', 'Microsoft.UI.Xaml'),
  ('Microsoft.WindowsAppRuntime.CBS.1.6', 'Microsoft.WindowsAppRuntime.CBS'),
  ('WinAppRuntime.Main.1.8', 'WinAppRuntime.Main'),
  ('Microsoft .Net Native Framework Package 2.2', 'Microsoft .Net Native Framework Package'),
  ('Sophos Data Protection Agent 2.11.48.0', 'Sophos Data Protection Agent'),
  ('Node.js', 'Node.js')
) as v (n, expected);

select is(public.vendor_key(v), expected, format('vendor_key(%s)', v))
from (values
  ('Microsoft Corporation', 'microsoft'),
  ('Microsoft Corp.', 'microsoft'),
  ('Sophos Limited', 'sophos'),
  ('AnyDesk Software GmbH', 'anydesk software'),
  ('Zoom Video Communications, Inc.', 'zoom video communications'),
  ('Igor Pavlov', 'igor pavlov'),
  (null, '')
) as v (v, expected);

-- Fixtures: an admin, a viewer, a client, three 7-Zip spellings ------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@example.com'),
  ('00000000-0000-0000-0000-00000000000c', 'viewer@example.com');
delete from public.hub_members;
insert into public.hub_members (user_id, email, role) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@example.com', 'admin'),
  ('00000000-0000-0000-0000-00000000000c', 'viewer@example.com', 'viewer');
insert into public.clients (id, name, contact_email, key_prefix, key_hash) values
  ('c0000000-0000-0000-0000-000000000001', 'Acme', 'it@acme.example', 'hubk_aaaaaa', repeat('a', 64));

create function pg_temp.as_user(uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.cat(slug text) returns uuid language sql as $$ select id from public.categories where categories.slug = $1 $$;
create function pg_temp.entry(key text) returns uuid language sql as $$ select id from public.entries where match_key = $1 order by source desc limit 1 $$;
create function pg_temp.apps_entry(key text) returns uuid language sql as $$ select id from public.entries where match_key = $1 and source = 'apps' $$;

select public.submit_titles('c0000000-0000-0000-0000-000000000001', '[
  {"kind": "program", "source": "programs", "match_key": "7-zip 23.01 (x64)|igor pavlov", "name": "7-Zip 23.01 (x64)", "vendor": "Igor Pavlov", "description": null},
  {"kind": "program", "source": "programs", "match_key": "7-zip|igor pavlov", "name": "7-Zip", "vendor": "Igor Pavlov", "description": null},
  {"kind": "program", "source": "apps", "match_key": "7-zip|igor pavlov", "name": "7-Zip", "vendor": "Igor Pavlov", "description": null},
  {"kind": "program", "source": "programs", "match_key": "windowsappruntime.1.7|microsoft corporation", "name": "WindowsAppRuntime.1.7", "vendor": "Microsoft Corporation", "description": null},
  {"kind": "program", "source": "programs", "match_key": "windowsappruntime.1.8|microsoft corp.", "name": "WindowsAppRuntime.1.8", "vendor": "Microsoft Corp.", "description": null}
]');

select is((select count(distinct product_id)::int from public.entries where canonical_name like '7-Zip%'), 1, 'every 7-Zip spelling and source is one product');
select is((select display_name from public.products p join public.entries e on e.product_id = p.id where e.match_key = '7-zip|igor pavlov' limit 1), '7-Zip',
  'the product shows the name without version');
select is((select count(distinct product_id)::int from public.entries where canonical_name like 'WindowsAppRuntime%'), 1,
  'side-by-side runtimes and vendor spellings are one product');
select is((select product_key from public.products p join public.entries e on e.product_id = p.id where e.match_key = '7-zip|igor pavlov' limit 1),
  'program|igor pavlov|7-zip', 'the product key is kind, vendor key and product name');

-- One classification per product -----------------------------------------------------------------------------
select public.publish_entry(pg_temp.entry('7-zip 23.01 (x64)|igor pavlov'), pg_temp.cat('general-business/compression-and-file-utilities'),
  'manual', null, null, '00000000-0000-0000-0000-00000000000a', 'Reviewed');
select results_eq($$select count(*)::int, count(distinct category_id)::int, bool_and(status = 'published') from public.entries where canonical_name like '7-Zip%'$$,
  $$values (3, 1, true)$$, 'publishing one alias publishes the whole product with the same category');
select is((select method::text from public.entries where match_key = '7-zip|igor pavlov' and source = 'programs'), 'manual',
  'aliases keep a method older clients accept');
select ok((select change_reason from public.entry_revisions r join public.entries e on e.id = r.entry_id
  where e.match_key = '7-zip|igor pavlov' and e.source = 'programs' order by r.revision desc limit 1) like 'Same product as%', 'the revision says why');

-- A new spelling arrives: published at once, no Inbox item.
select public.submit_titles('c0000000-0000-0000-0000-000000000001',
  '[{"kind": "program", "source": "programs", "match_key": "7-zip 26.05 (x64)|igor pavlov", "name": "7-Zip 26.05 (x64)", "vendor": "Igor Pavlov", "description": null}]');
select results_eq($$select status::text, category_id from public.entries where match_key = '7-zip 26.05 (x64)|igor pavlov'$$,
  $$select 'published', pg_temp.cat('general-business/compression-and-file-utilities')$$, 'a new alias of a published product is published at once');

-- The feed carries the product.
select ok((public.dictionary_changes('c0000000-0000-0000-0000-000000000001', 0) -> 'entries') @>
  '[{"match_key": "7-zip 26.05 (x64)|igor pavlov", "product_key": "program|igor pavlov|7-zip"}]', 'dictionary-changes carries product_key');
select ok((public.dictionary_changes('c0000000-0000-0000-0000-000000000001', 0) -> 'entries' -> 0) ? 'product_id', 'and product_id');

-- Reclassifying one alias moves the whole product.
select public.publish_entry(pg_temp.entry('7-zip|igor pavlov'), pg_temp.cat('developer-tools/clis-and-version-control'),
  'manual', null, null, '00000000-0000-0000-0000-00000000000a', 'Test');
select is((select count(distinct category_id)::int from public.entries where canonical_name like '7-Zip%'), 1, 'a reclassification follows to every alias');

-- Dictionary search: one row per product, or every spelling.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select results_eq($$select count(*)::int, max(aliases)::int, max(product_name) from public.search_entries(p_query := '7-zip', p_group := true)$$,
  $$values (1, 4, '7-Zip')$$, 'grouped search: one row for the 7-Zip product with its 4 spellings');
select is((select count(*)::int from public.search_entries(p_query := '7-zip')), 4, 'ungrouped search: every spelling');
reset role;

-- Conflicts (from before grouping) ---------------------------------------------------------------------------------
select set_config('hub.propagating', 'on', true);
select public.publish_entry(pg_temp.entry('windowsappruntime.1.7|microsoft corporation'), pg_temp.cat('system-applications/os-components-and-runtimes'),
  'manual', null, null, null, 'Old decision');
select public.publish_entry(pg_temp.entry('windowsappruntime.1.8|microsoft corp.'), pg_temp.cat('developer-tools/language-runtimes-and-sdks'),
  'jev_auto', 0.96, 'mock', null, 'Old Jev answer');
select set_config('hub.propagating', 'off', true);
select is((select count(*)::int from public.v_product_conflicts where display_name = 'WindowsAppRuntime'), 1, 'disagreeing aliases show as a conflict');
select is((select aliases -> 0 ->> 'canonical_name' from public.v_product_conflicts where display_name = 'WindowsAppRuntime'), 'WindowsAppRuntime.1.7',
  'the manual decision is suggested first');

select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select is((select count(*)::int from public.v_products), 2, 'a viewer reads the products');
select throws_ok($$select public.resolve_product_conflict(pg_temp.entry('windowsappruntime.1.7|microsoft corporation'))$$, '42501', null,
  'a viewer cannot resolve a conflict');
select throws_ok($$select public.set_entry_product(pg_temp.entry('7-zip|igor pavlov'), null)$$, '42501', null, 'a viewer cannot split');
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select is(public.resolve_product_conflict(pg_temp.entry('windowsappruntime.1.7|microsoft corporation')), 1, 'resolving publishes the chosen classification');
select is((select count(*)::int from public.v_product_conflicts), 0, 'no conflict left');

-- Split and move --------------------------------------------------------------------------------------------------
select isnt(public.set_entry_product(pg_temp.apps_entry('7-zip|igor pavlov'), null), null, 'split an alias into its own product');
select isnt((select product_id from public.entries where match_key = '7-zip|igor pavlov' and source = 'apps'),
  (select product_id from public.entries where match_key = '7-zip|igor pavlov' and source = 'programs'), 'the split alias has its own product');
select ok((select product_locked from public.entries where match_key = '7-zip|igor pavlov' and source = 'apps'), 'and is locked');
select lives_ok($$select public.set_entry_product(pg_temp.apps_entry('7-zip|igor pavlov'),
  (select product_id from public.entries where match_key = '7-zip 23.01 (x64)|igor pavlov'))$$, 'move it back');
select is((select count(distinct product_id)::int from public.entries where canonical_name like '7-Zip%'), 1, 'back in one product');
select is((select count(*)::int from public.products where display_name = '7-Zip'), 1, 'the empty product is removed');

-- Vendor aliases (admins) -------------------------------------------------------------------------------------------
reset role;
select public.submit_titles('c0000000-0000-0000-0000-000000000001', '[
  {"kind": "program", "source": "programs", "match_key": "acrobat|adobe", "name": "Adobe Acrobat", "vendor": "Adobe", "description": null},
  {"kind": "program", "source": "programs", "match_key": "acrobat|adobe systems incorporated", "name": "Adobe Acrobat", "vendor": "Adobe Systems Incorporated", "description": null}
]');
select is((select count(distinct product_id)::int from public.entries where canonical_name = 'Adobe Acrobat'), 2, 'two vendor spellings the rules miss');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select ok(public.set_vendor_alias('Adobe Systems Incorporated', 'Adobe') >= 1, 'an admin adds a vendor alias');
select is((select count(distinct product_id)::int from public.entries where canonical_name = 'Adobe Acrobat'), 1, 'the alias regroups them');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select throws_ok($$select public.set_vendor_alias('x', 'y')$$, '42501', null, 'a viewer cannot add vendor aliases');
reset role;

select * from finish();
rollback;
