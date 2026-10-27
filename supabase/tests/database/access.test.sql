-- Phase H0: only hub admins read hub data; anonymous users get nothing.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
truncate public.hub_admins, public.notifications;

select plan(9);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'someone@example.com');
insert into public.hub_admins (user_id) values ('00000000-0000-0000-0000-00000000000a');
insert into public.notifications (type, ref_id, title) values
  ('reclassification_request', 'REQ-0001', 'AnyDesk: Remote access requested by Acme'),
  ('new_title', null, '12 new titles reported');

create function pg_temp.as_user(uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

set local role anon;
select throws_ok('select count(*) from public.notifications', '42501', null, 'anon cannot read notifications');
select throws_ok('select count(*) from public.hub_admins', '42501', null, 'anon cannot read hub_admins');
select throws_ok('select public.is_hub_admin()', '42501', null, 'anon cannot call is_hub_admin');
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select ok(not public.is_hub_admin(), 'a signed-in non-admin is not a hub admin');
select is((select count(*)::int from public.notifications), 0, 'non-admins see no notifications');
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select ok(public.is_hub_admin(), 'a listed user is a hub admin');
select is((select count(*)::int from public.notifications where read_at is null), 2, 'admins see the unread notifications');
update public.notifications set read_at = now() where ref_id = 'REQ-0001';
select is((select count(*)::int from public.notifications where read_at is null), 1, 'admins mark a notification read');
select throws_ok($$update public.notifications set title = 'changed'$$, '42501', null, 'only read_at can change');
reset role;

select * from finish();
rollback;
