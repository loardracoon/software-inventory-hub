-- Users and access: roles (admin, operator, viewer), access rules, the sign-up gate and the admin RPCs.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
truncate public.clients, public.classification_runs, public.audit_log, public.hub_members, public.access_rules, public.notifications cascade;
delete from public.entries;

select plan(40);

-- Rules first, then accounts: the first account of an empty Hub is admin; the others take their rule's role.
insert into public.access_rules (kind, value, role) values
  ('email', 'ops@example.com', 'operator'),
  ('domain', 'sophos.com', 'viewer');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'ops@example.com'),
  ('00000000-0000-0000-0000-00000000000c', 'ana@sophos.com'),
  ('00000000-0000-0000-0000-00000000000d', 'script@other.org');

insert into public.entries (kind, source, match_key, canonical_name, vendor, status, reports_count, first_reported_at) values
  ('program', 'programs', 'anydesk|anydesk software gmbh', 'AnyDesk', 'AnyDesk Software GmbH', 'pending', 3, now());
insert into public.notifications (type, title) values ('system', 'Hello');

select is((select role::text from public.hub_members where email = 'admin@example.com'), 'admin', 'the first account is admin');
select is((select role::text from public.hub_members where email = 'ops@example.com'), 'operator', 'an email rule sets the role');
select is((select role::text from public.hub_members where email = 'ana@sophos.com'), 'viewer', 'a domain rule sets the role');
select is((select count(*)::int from public.hub_members where email = 'script@other.org'), 0, 'an account made by a database role without a rule gets no membership');

select is(public.access_role_for('OPS@Example.com'), 'operator'::public.hub_role, 'email rules win and ignore case');
select is(public.access_role_for('joe@sophos.com'), 'viewer'::public.hub_role, 'domain rules match the email domain');
select is(public.access_role_for('joe@eu.sophos.com'), null::public.hub_role, 'a subdomain needs its own rule');
select throws_ok($$insert into public.access_rules (kind, value, role) values ('domain', 'evil.com', 'admin')$$, '23514', null, 'a domain never grants admin');
select throws_ok($$insert into public.access_rules (kind, value, role) values ('domain', 'Sophos.COM', 'viewer')$$, '23514', null, 'rule values are stored lower case');

create function pg_temp.login(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create function pg_temp.entry() returns uuid language sql as $$ select id from public.entries where match_key = 'anydesk|anydesk software gmbh' $$;

-- Viewer: reads and searches, changes nothing.
select pg_temp.login('00000000-0000-0000-0000-00000000000c');
select is(public.hub_role(), 'viewer'::public.hub_role, 'hub_role tells the caller its role');
select is((select count(*)::int from public.entries), 1, 'a viewer reads the dictionary');
select is((select count(*)::int from public.notifications), 1, 'a viewer reads the inbox');
select is((select count(*)::int from public.search_entries(p_query := 'anydesk')), 1, 'a viewer searches');
select is((select count(*)::int from public.engine_settings), 0, 'a viewer does not read engine settings');
select is((select count(*)::int from public.clients), 0, 'a viewer does not read clients');
select throws_ok($$select public.save_entry_draft(pg_temp.entry(), 'x', null, null, null, null, false, 'r')$$, '42501', null, 'a viewer cannot edit entries');
select throws_ok($$select * from public.list_users()$$, '42501', null, 'a viewer cannot list users');
reset role;

-- Operator: curates, cannot change settings.
select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select is(public.can_curate(), true, 'an operator curates');
select is(public.is_hub_admin(), false, 'an operator is not an admin');
select lives_ok($$select public.save_entry_draft(pg_temp.entry(), 'AnyDesk', 'AnyDesk Software GmbH', 'Remote desktop.', null, null, false, 'Better description')$$,
  'an operator edits an entry');
select is((select count(*)::int from public.engine_settings), 2, 'an operator reads the engine settings');
select ok((select count(*) from public.engine_status('jev')) = 1, 'an operator reads the engine status');
select throws_ok($$select public.set_engine_mode('jev', 'off')$$, '42501', null, 'an operator cannot change engine modes');
select throws_ok($$select public.set_provider_key('openai', 'sk-0123456789abcdef0123')$$, '42501', null, 'an operator cannot manage provider keys');
select throws_ok($$select public.create_client('Acme', 'it@acme.example')$$, '42501', null, 'an operator cannot manage clients');
select throws_ok($$select public.set_user_role('00000000-0000-0000-0000-00000000000c', 'admin')$$, '42501', null, 'an operator cannot change roles');
select lives_ok($$update public.notifications set read_at = now()$$, 'an operator marks inbox items read');
reset role;

-- Admin: manages users and access.
select pg_temp.login('00000000-0000-0000-0000-00000000000a');
select is((select count(*)::int from public.list_users()), 3, 'the admin lists every member');
select lives_ok($$select public.add_access_rule('domain', '@Partner.COM', 'operator')$$, 'the admin adds a domain (normalized)');
select lives_ok($$select public.set_user_role('00000000-0000-0000-0000-00000000000b', 'viewer')$$, 'the admin changes a role');
select is((select role::text from public.access_rules where value = 'ops@example.com'), 'viewer', 'the email rule follows the role');
select throws_ok($$select public.set_user_role('00000000-0000-0000-0000-00000000000a', 'viewer')$$, '22023', null, 'the last admin keeps the role');
select throws_ok($$select public.remove_user('00000000-0000-0000-0000-00000000000a')$$, '22023', null, 'the admin cannot remove themselves');
select lives_ok($$select public.remove_user('00000000-0000-0000-0000-00000000000b')$$, 'the admin removes a user');
reset role;

select is(public.access_role_for('bob@partner.com'), 'operator'::public.hub_role, 'the new domain rule applies');
select is((select count(*)::int from auth.users where email = 'ops@example.com'), 0, 'a removed user loses the account and its email rule');
-- manage-users helper: an account made by a script joins with its new email rule.
select is(public.ensure_hub_member('nobody@nowhere.org'), false, 'no rule, no membership');
insert into public.access_rules (kind, value, role) values ('email', 'script@other.org', 'operator');
select is(public.ensure_hub_member('Script@Other.org'), true, 'an existing account takes its rule');
select is((select role::text from public.hub_members where email = 'script@other.org'), 'operator', 'with the rule''s role');
select bag_eq(
  $$select action from public.audit_log where user_id = '00000000-0000-0000-0000-00000000000a' and action in ('add access rule', 'set user role', 'remove user')$$,
  $$values ('add access rule'), ('set user role'), ('remove user')$$,
  'rule, role and removal changes are audited');

select * from finish();
rollback;
