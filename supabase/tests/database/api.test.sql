-- Phase H2: client keys and rate limit, dictionary changes, title submissions, reclassification
-- requests and the console's client management.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
truncate public.clients, public.classification_runs, public.audit_log, public.hub_admins, public.notifications cascade;
delete from public.entries;

select plan(31);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'someone@example.com');
insert into public.hub_admins (user_id) values ('00000000-0000-0000-0000-00000000000a');

create function pg_temp.as_user(uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.hash(k text) returns text language sql as $$ select encode(sha256(convert_to(k, 'UTF8')), 'hex') $$;

-- Client management (console) -------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select throws_ok($$select public.create_client('Acme', 'it@acme.example')$$, '42501', null, 'non-admins cannot create clients');
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
create temp table k1 as select * from public.create_client('Acme', 'IT@acme.example');
create temp table k2 as select * from public.create_client('Globex', 'ops@globex.example');
reset role;
select matches((select client_key from k1), '^hubk_[0-9a-f]{48}$', 'the key is returned once');
select is((select key_hash from public.clients where id = (select client_id from k1)), pg_temp.hash((select client_key from k1)), 'only its sha256 is stored');
select is((select key_prefix || '|' || contact_email from public.clients where id = (select client_id from k1)), left((select client_key from k1), 11) || '|it@acme.example',
  'the prefix identifies the key; the email is normalised');
select is((select count(*)::int from public.clients where key_hash like '%' || (select client_key from k1) || '%'), 0, 'the plain key is not stored');

-- Authentication and rate limit ------------------------------------------------------------------
select results_eq($$select status, client_name from public.client_call(pg_temp.hash((select client_key from k1)))$$, $$values (200, 'Acme')$$, 'a valid key passes');
select is((select status from public.client_call(pg_temp.hash('hubk_wrong'))), 401, 'an unknown key is refused');
select ok((select last_seen_at is not null from public.clients where id = (select client_id from k1)), 'last_seen_at is updated');
select public.client_call(pg_temp.hash((select client_key from k1))) from generate_series(1, 59);
select results_eq($$select status, retry_after between 1 and 60 from public.client_call(pg_temp.hash((select client_key from k1)))$$,
  $$values (429, true)$$, 'the 61st call in a minute gets 429 with Retry-After');
select is((select status from public.client_call(pg_temp.hash((select client_key from k2)))), 200, 'the limit is per client');

-- Dictionary changes ------------------------------------------------------------------------------
insert into public.entries (kind, source, match_key, canonical_name, category_id, method, status, seq, confidence)
values ('program', 'programs', 'anydesk|anydesk software gmbh', 'AnyDesk', (select id from public.categories where slug = 'remote-access/remote-desktop-and-support'), 'manual', 'published', 0, 1);
insert into public.dictionary_events (entry_id, type) select id, 'published' from public.entries where canonical_name = 'AnyDesk';
update public.entries set seq = (select max(seq) from public.dictionary_events) where canonical_name = 'AnyDesk';
insert into public.entries (kind, source, match_key, canonical_name, category_id, method, status, seq)
values ('program', 'programs', 'secret|', 'Proposed only', (select id from public.categories where slug = 'remote-access/remote-desktop-and-support'), 'jev', 'proposed', 9999);

create temp table p1 as select public.dictionary_changes((select client_id from k1), 0, 60) as r;
select results_eq($$select jsonb_array_length(r -> 'categories'), jsonb_array_length(r -> 'entries'), (r ->> 'next_seq')::int, (r ->> 'has_more')::boolean from p1$$,
  $$values (60, 0, 60, true)$$, 'a first page of 60 categories, more to come');
select is((select r -> 'categories' -> 0 ->> 'slug' from p1), 'remote-access', 'in seq order: level 1 first');
create temp table p2 as select public.dictionary_changes((select client_id from k1), 60, 1000) as r;
select results_eq($$select jsonb_array_length(r -> 'categories'), jsonb_array_length(r -> 'entries'), (r ->> 'has_more')::boolean from p2$$,
  $$values (40, 1, false)$$, 'the rest: 40 categories and the published entry, nothing proposed');
select results_eq($$select e ->> 'canonical_name', e ->> 'attention_level', e ->> 'status', e ? 'reports_count', e ? 'id' from p2, jsonb_array_elements(r -> 'entries') e$$,
  $$values ('AnyDesk', 'review', 'published', false, false)$$, 'entries carry published fields and the effective attention only');
select is((select last_seq from public.clients where id = (select client_id from k1)), (select (r ->> 'next_seq')::bigint from p2), 'last_seq is stored');
select results_eq($$select jsonb_array_length(r -> 'categories') + jsonb_array_length(r -> 'entries'), (r ->> 'next_seq')::bigint from
  (select public.dictionary_changes((select client_id from k1), (select (r ->> 'next_seq')::bigint from p2), 1000) as r) x$$,
  $$values (0, (select (r ->> 'next_seq')::bigint from p2))$$, 'nothing new: empty page, same next_seq');

-- Titles ------------------------------------------------------------------------------------------
select is(public.submit_titles((select client_id from k1), '[{"kind": "program", "source": "programs", "match_key": "rustdesk|purslane", "name": "RustDesk", "vendor": "Purslane", "description": null},
  {"kind": "program", "source": "programs", "match_key": "anydesk|anydesk software gmbh", "name": "AnyDesk", "vendor": null, "description": null}]'),
  '{"accepted": 2, "new": 1, "known": 1}'::jsonb, 'one new title, one known');
select results_eq($$select status::text, reports_count, canonical_name from public.entries where match_key = 'rustdesk|purslane'$$,
  $$values ('pending', 1, 'RustDesk')$$, 'an unknown title becomes a pending entry');
select public.submit_titles((select client_id from k1), '[{"kind": "program", "source": "programs", "match_key": "rustdesk|purslane", "name": "RustDesk", "vendor": "Purslane", "description": null}]');
select public.submit_titles((select client_id from k2), '[{"kind": "program", "source": "programs", "match_key": "rustdesk|purslane", "name": "RustDesk", "vendor": "Purslane", "description": "Remote desktop"}]');
select results_eq($$select reports_count, description from public.entries where match_key = 'rustdesk|purslane'$$,
  $$values (2, 'Remote desktop')$$, 'reports_count counts distinct clients; a pending entry learns missing fields');
select is((select count(*)::int from public.submissions where match_key = 'rustdesk|purslane'), 3, 'every submission is kept');
select is((select count(*)::int from public.notifications where type = 'new_title'), 1, 'new titles notify the inbox once per call with something new');
select throws_ok($$select public.submit_titles((select client_id from k1), (select jsonb_agg('{}'::jsonb) from generate_series(1, 501)))$$, '22023', null, 'at most 500 titles');

-- Reclassification requests -----------------------------------------------------------------------
create temp table q1 as select public.open_reclassification_request((select client_id from k1), 'program', 'programs', 'anydesk|anydesk software gmbh',
  (select id from public.categories where slug = 'remote-access/remote-management-agents-rmm'), 'We deploy it as RMM', 'https://example.com') as r;
select results_eq($$select r ->> 'id' ~ '^REQ-\d{4}$', r ->> 'status', (r ->> 'created')::boolean, r ->> 'current_category', r ->> 'suggested_category' from q1$$,
  $$values (true, 'open', true, 'Remote desktop and support', 'Remote management agents (RMM)')$$, 'a request is opened with both categories');
select is((select public.open_reclassification_request((select client_id from k1), 'program', 'programs', 'anydesk|anydesk software gmbh', null, 'again', null) ->> 'id'),
  (select r ->> 'id' from q1), 'a second request from the same client returns the open one');
select isnt((select public.open_reclassification_request((select client_id from k2), 'program', 'programs', 'anydesk|anydesk software gmbh', null, 'Other client', null) ->> 'id'),
  (select r ->> 'id' from q1), 'another client opens its own');
select is((select count(*)::int from public.notifications where type = 'reclassification_request'), 2, 'each new request notifies the inbox');
select throws_ok($$select public.open_reclassification_request((select client_id from k1), 'program', 'programs', 'x|', (select id from public.categories where slug = 'remote-access'), 'level 1', null)$$,
  '22023', null, 'the suggestion must be a level-2 category');
select results_eq($$select status::text, canonical_name from public.entries where match_key = 'brand-new|'$$, $$values ('pending', 'brand-new|')$$,
  'a request for an unknown title creates a pending entry') from (select public.open_reclassification_request((select client_id from k1), 'program', 'programs', 'brand-new|', null, 'What is this?', null)) x;

update public.reclassification_requests set status = 'rejected', admin_note = 'It is remote desktop' where public_id = (select r ->> 'id' from q1);
select is(public.request_statuses((select client_id from k1), array[(select r ->> 'id' from q1)]),
  jsonb_build_array(jsonb_build_object('id', (select r ->> 'id' from q1), 'status', 'rejected', 'admin_note', 'It is remote desktop')), 'status and admin note of own requests');
select is(public.request_statuses((select client_id from k2), array[(select r ->> 'id' from q1)]), '[]'::jsonb, 'never another client''s request');

-- Revoke and rotate --------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select public.revoke_client((select client_id from k1));
reset role;
select is((select status from public.client_call(pg_temp.hash((select client_key from k1)))), 401, 'a revoked key is refused');

select * from finish();
rollback;
