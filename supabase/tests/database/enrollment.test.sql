-- Phase H8: access requests of installations. The key never reaches the Hub (only its hash); a pending key reads
-- nothing; email confirmation comes first; auto-approval by domain; limits; admin decisions; expiry; the digest.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
truncate public.clients, public.client_enrollments, public.audit_log, public.hub_members, public.access_rules, public.notifications cascade;

select plan(35);

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
create function pg_temp.hash(k text) returns text language sql as $$ select encode(sha256(convert_to(k, 'UTF8')), 'hex') $$;
create function pg_temp.req(email text, key text, token text, ip text default '203.0.113.7') returns text language sql as $$
  select public.enrollment_create(jsonb_build_object('name', 'Inventory of ' || email, 'organization', 'Acme', 'contact_email', email,
    'reason', 'Classify our titles', 'key_hash', pg_temp.hash(key), 'key_prefix', left(key, 11), 'consent_version', '2026-11-04',
    'client_version', '1.0', 'ip', ip, 'token_hash', pg_temp.hash(token))) ->> 'outcome'
$$;

-- Off by default --------------------------------------------------------------------------------------------
select is(pg_temp.req('ana@sophos.com', 'hubk_aaaa01', 'tok-a'), 'disabled', 'a new Hub takes no requests');

select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select throws_ok($$select public.set_enrollment_settings(true, '{}', '{}')$$, '42501', null, 'only hub admins open requests');
select is((select count(*)::int from public.client_enrollments), 0, 'other users read no requests');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select throws_ok($$select public.set_enrollment_settings(true, '{"bad domain"}', '{}')$$, '22023', null, 'domains are checked');
select public.set_enrollment_settings(true, '{" Sophos.com", "partner.example"}', '{sophos.com}');
reset role;
select is((select allowed_domains from public.enrollment_settings), '{partner.example,sophos.com}'::text[], 'domains are trimmed, lower case and sorted');

-- Create --------------------------------------------------------------------------------------------------
select is(pg_temp.req('bob@other.example', 'hubk_bbbb01', 'tok-b'), 'domain', 'a domain outside the allowed list is refused');
select is(pg_temp.req('Ana@Sophos.com', 'hubk_aaaa01', 'tok-a'), 'created', 'an allowed domain is stored');
select results_eq($$select c.status::text, c.key_hash = pg_temp.hash('hubk_aaaa01'), e.status::text, e.contact_email from public.client_enrollments e join public.clients c on c.id = e.client_id$$,
  $$values ('pending', true, 'unverified', 'ana@sophos.com')$$, 'a pending client with the key hash; the request waits for the email');
select is((select count(*)::int from public.clients where key_hash like '%hubk_aaaa01%' or key_prefix <> 'hubk_aaaa01'), 0, 'only the hash and the prefix are stored');
select results_eq($$select status from public.client_call(pg_temp.hash('hubk_aaaa01'))$$, $$values (401)$$, 'a pending key reads nothing');
select is(public.enrollment_status(pg_temp.hash('hubk_aaaa01')) ->> 'status', 'unverified', 'the installation reads its status with its key');
select is(public.enrollment_status(pg_temp.hash('hubk_unknown')), null, 'an unknown key reads nothing');
select is(pg_temp.req('ana@sophos.com', 'hubk_aaaa01', 'tok-a2'), 'ignored', 'the same key again: accepted silently, nothing stored');
select is((select count(*)::int from public.client_enrollments), 1, 'still one request');

-- Limits -----------------------------------------------------------------------------------------------------
select is(pg_temp.req('x1@partner.example', 'hubk_cccc01', 'tok-c1', '198.51.100.9'), 'created', 'request 1 of an address');
select is(pg_temp.req('x2@partner.example', 'hubk_cccc02', 'tok-c2', '198.51.100.9'), 'created', 'request 2 of an address');
select is(pg_temp.req('x3@partner.example', 'hubk_cccc03', 'tok-c3', '198.51.100.9'), 'created', 'request 3 of an address');
select is(pg_temp.req('x4@partner.example', 'hubk_cccc04', 'tok-c4', '198.51.100.9'), 'rate_ip', 'the 4th in an hour from one address is refused');

-- Confirm -----------------------------------------------------------------------------------------------------
select is(public.enrollment_confirm(pg_temp.hash('tok-wrong')) ->> 'status', 'invalid', 'a wrong token confirms nothing');
select is(public.enrollment_confirm(pg_temp.hash('tok-a')) ->> 'status', 'approved', 'sophos.com is on the auto-approve list');
select results_eq($$select status from public.client_call(pg_temp.hash('hubk_aaaa01'))$$, $$values (200)$$, 'the approved key works');
select is(public.enrollment_confirm(pg_temp.hash('tok-a')) ->> 'status', 'invalid', 'a token works once');
select is(public.enrollment_confirm(pg_temp.hash('tok-c1')) ->> 'status', 'pending', 'another domain waits for an admin');
select is((select count(*)::int from public.notifications where type = 'access_request'), 2, 'both confirmations notify the Inbox');

-- Decide -------------------------------------------------------------------------------------------------------
create temp table ids as select id, contact_email from public.client_enrollments;
grant select on ids to authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select throws_ok($$select public.enrollment_decide((select id from ids where contact_email = 'x1@partner.example'), true)$$, '42501', null, 'only hub admins decide');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select throws_ok($$select public.enrollment_decide((select id from ids where contact_email = 'x2@partner.example'), true)$$, '22023', null,
  'an unconfirmed request cannot be approved');
select is(public.enrollment_decide((select id from ids where contact_email = 'x1@partner.example'), false, 'Unknown organization') ->> 'status', 'rejected', 'an admin rejects');
reset role;
select is((select count(*)::int from public.clients where key_hash = pg_temp.hash('hubk_cccc01')), 0, 'a rejected request leaves no client');
select is(public.enrollment_status(pg_temp.hash('hubk_cccc01')) ->> 'note', 'Unknown organization', 'the installation still reads the decision and the note');

-- Cancel and expiry -------------------------------------------------------------------------------------------
select is(public.enrollment_cancel(pg_temp.hash('hubk_cccc02')) ->> 'status', 'cancelled', 'the installation cancels its request');
update public.client_enrollments set expires_at = now() - interval '1 minute' where contact_email = 'x3@partner.example';
select is(public.expire_enrollments(), 1, 'requests past 14 days end');
select is(public.enrollment_status(pg_temp.hash('hubk_cccc03')) ->> 'status', 'expired', 'and say so');
select is((select count(*)::int from public.clients where status = 'pending'), 0, 'no pending client is left');

-- Digest ------------------------------------------------------------------------------------------------------
select is((public.build_digest(true) -> 'access' ->> 'auto_approved')::int, 1, 'the weekly digest counts automatic approvals');
select is((public.build_digest(true) -> 'access' ->> 'rejected')::int, 1, 'and rejections');

select * from finish();
rollback;
