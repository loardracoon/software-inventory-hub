-- Phase H1: taxonomy seed, integrity rules and read access.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
-- Keep the seeded taxonomy; start every other table empty (rolled back at the end).
-- (delete, not truncate: truncating entries would cascade to the whole dictionary_events table)
truncate public.clients, public.classification_runs, public.audit_log, public.hub_admins, public.notifications cascade;
delete from public.entries;

select plan(22);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'someone@example.com');
insert into public.hub_admins (user_id) values ('00000000-0000-0000-0000-00000000000a');

create function pg_temp.as_user(uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- Seed --------------------------------------------------------------------------------------------
select is((select count(*)::int from public.categories where parent_id is null), 29, '29 level-1 categories');
select is((select count(*)::int from public.categories where parent_id is not null), 71, '71 level-2 categories');
select is((select count(distinct category_id)::int from public.dictionary_events where type = 'category_changed'), 100, 'every category has a published event');
select ok((select max(seq) from public.categories where parent_id is null) < (select min(seq) from public.categories where parent_id is not null),
  'level 1 is published before level 2');
select is((select count(*)::int from public.categories c where c.seq = 0 or not exists (select 1 from public.dictionary_events e where e.seq = c.seq and e.category_id = c.id)), 0,
  'each category carries the seq of its event');
select results_eq($$select attention_level::text, sophos_firewall_category from public.categories where slug = 'remote-access/remote-desktop-and-support'$$,
  $$values ('review', 'Remote access')$$, 'level 2 keeps its default attention and firewall category');
select ok((select description like '%Examples: AnyDesk%' from public.categories where slug = 'remote-access/remote-desktop-and-support'),
  'examples are part of the description Jev sees');
select is((select count(*)::int from public.categories where parent_id is null and attention_level is not null), 0, 'level 1 has no attention');

-- Integrity ---------------------------------------------------------------------------------------
select throws_ok($$update public.categories set slug = 'remote-access/renamed' where slug = 'remote-access/remote-desktop-and-support'$$,
  '23514', null, 'slugs never change');
select throws_ok($$insert into public.categories (name, slug, parent_id, attention_level)
  values ('Third', 'remote-access/third', (select id from public.categories where slug = 'remote-access/remote-desktop-and-support'), 'info')$$,
  '23514', null, 'no third level');
select throws_ok($$insert into public.entries (kind, source, match_key, canonical_name, category_id, method, status)
  values ('program', 'programs', 'x|y', 'X', (select id from public.categories where slug = 'remote-access'), 'manual', 'published')$$,
  '23514', null, 'entries point to level 2 only');
select lives_ok($$insert into public.entries (kind, source, match_key, canonical_name, category_id, method, status, confidence)
  values ('program', 'programs', 'anydesk|anydesk software gmbh', 'AnyDesk',
          (select id from public.categories where slug = 'remote-access/remote-desktop-and-support'), 'manual', 'published', 1)$$, 'a published entry');
select throws_ok($$insert into public.entries (kind, source, match_key, canonical_name) values ('program', 'programs', 'anydesk|anydesk software gmbh', 'AnyDesk')$$,
  '23505', null, 'one entry per (kind, source, match_key)');
select throws_ok($$insert into public.entries (kind, source, match_key, canonical_name, status) values ('program', 'programs', 'z|', 'Z', 'published')$$,
  '23514', null, 'a published entry needs a category and a method');
select throws_ok($$insert into public.entries (kind, source, match_key, canonical_name, confidence) values ('program', 'programs', 'w|', 'W', 1.5)$$,
  '23514', null, 'confidence stays within 0..1');

insert into public.clients (id, name, contact_email, key_prefix, key_hash)
values ('c0000000-0000-0000-0000-000000000001', 'Acme', 'it@acme.example', 'eik_ab12', repeat('a', 64));
insert into public.reclassification_requests (client_id, entry_id, reason)
select 'c0000000-0000-0000-0000-000000000001', id, 'It is a remote tool' from public.entries where canonical_name = 'AnyDesk';
select matches((select public_id from public.reclassification_requests), '^REQ-\d{4,}$', 'requests get a REQ-0000 public id');
select throws_ok($$insert into public.reclassification_requests (client_id, entry_id, reason)
  select 'c0000000-0000-0000-0000-000000000001', id, 'Again' from public.entries where canonical_name = 'AnyDesk'$$,
  '23505', null, 'one open request per client and entry');

-- Access ------------------------------------------------------------------------------------------
set local role anon;
select throws_ok('select count(*) from public.categories', '42501', null, 'anon cannot read the taxonomy');
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select is((select count(*)::int from public.entries) + (select count(*)::int from public.categories), 0, 'non-admins see nothing');
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select is((select count(*)::int from public.categories), 100, 'admins read the taxonomy');
select throws_ok($$insert into public.audit_log (action) values ('x')$$, '42501', null, 'admins do not write tables directly');
select throws_ok('select key_hash from public.clients', '42501', null, 'the client key hash never reaches the browser');
reset role;

select * from finish();
rollback;
