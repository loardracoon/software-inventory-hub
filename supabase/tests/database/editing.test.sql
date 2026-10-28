-- Phase H4: search, drafts and publishing, grouped request decisions, taxonomy edits and the digest.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
truncate public.clients, public.classification_runs, public.audit_log, public.hub_members, public.access_rules, public.notifications, public.ai_calls cascade;
delete from public.entries;

select plan(27);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'someone@example.com');
delete from public.hub_members;
insert into public.hub_members (user_id, email, role) values ('00000000-0000-0000-0000-00000000000a', 'admin@example.com', 'admin');

create function pg_temp.as_user(uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.cat(slug text) returns uuid language sql as $$ select id from public.categories where categories.slug = $1 $$;
create function pg_temp.entry(key text) returns uuid language sql as $$ select id from public.entries where match_key = $1 $$;

insert into public.entries (kind, source, match_key, canonical_name, vendor, status, reports_count, first_reported_at) values
  ('program', 'programs', 'anydesk|anydesk software gmbh', 'AnyDesk', 'AnyDesk Software GmbH', 'pending', 3, now() - interval '2 hours'),
  ('program', 'programs', 'git|git', 'Git', null, 'pending', 1, now() - interval '3 days'),
  ('program', 'programs', 'putty|simon tatham', 'PuTTY', null, 'pending', 2, now() - interval '1 hour');
select public.publish_entry(pg_temp.entry('git|git'), pg_temp.cat('developer-tools/clis-and-version-control'), 'rule', null, null, null, 'Rule');
insert into public.clients (id, name, contact_email, key_prefix, key_hash) values
  ('c0000000-0000-0000-0000-000000000001', 'Acme', 'it@acme.example', 'hubk_aaaaaa', repeat('a', 64)),
  ('c0000000-0000-0000-0000-000000000002', 'Globex', 'it@globex.example', 'hubk_bbbbbb', repeat('b', 64));
grant select on all tables in schema pg_temp to authenticated;

-- Search ------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select is((select count(*)::int from public.search_entries()), 0, 'non-admins find nothing');
select throws_ok($$select public.save_entry_draft(gen_random_uuid(), 'x', null, null, null, null, false, 'r')$$, '42501', null, 'non-admins cannot edit');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select results_eq($$select canonical_name, total_count from public.search_entries(p_query => 'desk')$$, $$values ('AnyDesk', 1::bigint)$$, 'search by name');
select results_eq($$select canonical_name from public.search_entries(p_status => 'pending')$$, $$values ('AnyDesk'), ('PuTTY')$$, 'filter by status, most reported first');

-- Drafts and publishing ---------------------------------------------------------------------------
select throws_ok($$select public.save_entry_draft(pg_temp.entry('anydesk|anydesk software gmbh'), null, null, null, null, null, false, ' ')$$, '22023', null,
  'saving needs a reason');
select throws_ok($$select public.save_entry_draft(pg_temp.entry('anydesk|anydesk software gmbh'), null, null, null, pg_temp.cat('remote-access'), null, false, 'r')$$,
  '22023', null, 'only level-2 categories');
select lives_ok($$select public.save_entry_draft(pg_temp.entry('anydesk|anydesk software gmbh'), 'AnyDesk', null, 'Remote support tool', pg_temp.cat('remote-access/remote-desktop-and-support'), null, false, 'Reviewed vendor site')$$,
  'a draft is saved');
reset role;
select is((select status::text from public.entries where match_key = 'anydesk|anydesk software gmbh'), 'pending', 'a draft changes nothing for clients');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select ok(public.publish_entry_edit(pg_temp.entry('anydesk|anydesk software gmbh')) > 0, 'publish');
reset role;
select results_eq($$select e.status::text, e.method::text, e.description, e.revision, e.seq = (select max(seq) from public.dictionary_events),
    (select change_reason from public.entry_revisions v where v.entry_id = e.id and v.revision = e.revision), exists (select 1 from public.entry_drafts d where d.entry_id = e.id)
  from public.entries e where match_key = 'anydesk|anydesk software gmbh'$$,
  $$values ('published', 'manual', 'Remote support tool', 2, true, 'Reviewed vendor site', false)$$, 'published as a manual revision with the reason and the newest seq');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select public.save_entry_draft(pg_temp.entry('git|git'), null, null, null, pg_temp.cat('developer-tools/ides-and-editors'), null, false, 'Ships an editor');
select public.publish_entry_edit(pg_temp.entry('git|git'));
reset role;
select is((select type::text from public.dictionary_events order by seq desc limit 1), 'reclassified', 'a category change on a published entry is a reclassified event');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select throws_ok($$select public.publish_entry_edit(pg_temp.entry('putty|simon tatham'), 'x')$$, '42501', null, 'publishing needs an admin');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select throws_ok($$select public.publish_entry_edit(pg_temp.entry('putty|simon tatham'), 'x')$$, '22023', null, 'an entry without a category cannot be published');
reset role;

-- Requests ----------------------------------------------------------------------------------------
insert into public.reclassification_requests (client_id, entry_id, suggested_category_id, reason) values
  ('c0000000-0000-0000-0000-000000000001', pg_temp.entry('git|git'), pg_temp.cat('developer-tools/clis-and-version-control'), 'It is a VCS'),
  ('c0000000-0000-0000-0000-000000000002', pg_temp.entry('git|git'), pg_temp.cat('developer-tools/clis-and-version-control'), 'Version control'),
  ('c0000000-0000-0000-0000-000000000002', pg_temp.entry('anydesk|anydesk software gmbh'), null, 'We allow it');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select results_eq($$select canonical_name, requests, clients from public.v_request_groups order by canonical_name$$,
  $$values ('AnyDesk', 1::bigint, 1::bigint), ('Git', 2::bigint, 2::bigint)$$, 'requests are grouped per entry with a count');
select is(public.decide_entry_requests(pg_temp.entry('git|git'), true, 'Agreed: back to version control'), 2, 'accept and publish the suggestion');
select throws_ok($$select public.decide_entry_requests(pg_temp.entry('anydesk|anydesk software gmbh'), true, null)$$, '22023', null,
  'accepting "Other" needs a category');
select is(public.decide_entry_requests(pg_temp.entry('anydesk|anydesk software gmbh'), false, 'Remote desktop stays under review'), 1, 'reject with a note');
reset role;
select results_eq($$select c.slug, e.method::text from public.entries e join public.categories c on c.id = e.category_id where match_key = 'git|git'$$,
  $$values ('developer-tools/clis-and-version-control', 'manual')$$, 'the accepted category is published');
select is(public.request_statuses('c0000000-0000-0000-0000-000000000002',
    array(select public_id from public.reclassification_requests where client_id = 'c0000000-0000-0000-0000-000000000002' order by public_id)) -> 1 ->> 'admin_note',
  'Remote desktop stays under review', 'clients get the decision and the note');
select is((select count(*)::int from public.reclassification_requests where status = 'accepted'), 2, 'both matching requests accepted');
select is((select count(*)::int from public.audit_log where action in ('accept requests', 'reject requests')), 2, 'decisions are audited');

-- Taxonomy ----------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
create temp table rev0 as select revision from public.categories where slug = 'developer-tools/ides-and-editors';
grant select on rev0 to authenticated;
select ok(public.update_category(pg_temp.cat('developer-tools/ides-and-editors'), 'IDEs and code editors', 'Editors and IDEs.', 'Clearer name') > 0, 'edit a category');
select throws_ok($$select public.deprecate_category(pg_temp.cat('developer-tools/clis-and-version-control'), null, 'merge')$$, '22023', null,
  'deprecating needs a replacement');
select is(public.deprecate_category(pg_temp.cat('developer-tools/clis-and-version-control'), pg_temp.cat('developer-tools/ides-and-editors'), 'Merged'), 1,
  'entries move to the replacement');
reset role;
select results_eq($$select (select deprecated from public.categories where slug = 'developer-tools/clis-and-version-control'),
    (select c.slug from public.entries e join public.categories c on c.id = e.category_id where match_key = 'git|git'),
    (select name || '/' || (revision - (select revision from rev0)) from public.categories where slug = 'developer-tools/ides-and-editors')$$,
  $$values (true, 'developer-tools/ides-and-editors', 'IDEs and code editors/1')$$, 'category deprecated, entry moved, edit revisioned');
select is(jsonb_array_length(public.dictionary_changes(gen_random_uuid(), (select max(seq) - 3 from public.dictionary_events), 1000) -> 'categories'), 2,
  'clients receive the edited and the deprecated category');

-- Digest ------------------------------------------------------------------------------------------
select results_eq($$select (d ->> 'pending_total')::int, jsonb_array_length(d -> 'new_titles'), d -> 'new_titles' -> 0 ->> 'name' from public.build_digest() d$$,
  $$values (1, 1, 'PuTTY')$$, 'the digest lists new pending titles of the last 24 hours');

select * from finish();
rollback;
