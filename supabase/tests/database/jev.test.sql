-- Phase H3: Jev gateway (modes, pause, limits, cost), the auto-publish gate, proposals and decisions.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
truncate public.clients, public.classification_runs, public.audit_log, public.hub_members, public.access_rules, public.notifications, public.ai_calls cascade;
delete from public.entries;
update public.engine_settings set mode = 'automatic', paused = false, paused_reason = null, monthly_budget_usd = 3, daily_titles = 200,
  auto_publish_daily = 100, alert_pct = 80 where engine = 'jev';

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
create function pg_temp.cat(slug text) returns uuid language sql as $$ select id from public.categories where categories.slug = $1 $$;
create function pg_temp.entry(key text) returns uuid language sql as $$ select id from public.entries where match_key = $1 $$;

-- Gateway -----------------------------------------------------------------------------------------
select is(public.jev_gate(10, false) ->> 'allowed', 'true', 'automatic mode lets the automatic run start');
update public.engine_settings set mode = 'manual' where engine = 'jev';
select results_eq($$select public.jev_gate(10, false) ->> 'allowed', public.jev_gate(10, true) ->> 'allowed'$$, $$values ('false', 'true')$$,
  'manual mode: only manual runs');
update public.engine_settings set mode = 'automatic', paused = true, paused_reason = 'test' where engine = 'jev';
select is(public.jev_gate(1, true) ->> 'reason', 'Jev is paused: test', 'nothing runs while paused');
update public.engine_settings set paused = false, daily_titles = 5 where engine = 'jev';
select is(public.jev_gate(6, true) ->> 'allowed', 'false', 'the daily title limit applies to manual runs too');
update public.engine_settings set daily_titles = 200 where engine = 'jev';

select is((public.record_ai_call('jev', 'claude-haiku-5-5', 'classify', null, 1, 1000000, 0, 0, 0, 100, 'ok') ->> 'cost_usd')::numeric, 0.10,
  'cost = tokens × price in force');
update public.ai_prices set input_per_mtok = 9 where model = 'claude-haiku-5-5';
select is((select sum(cost_usd) from public.ai_calls), 0.10::numeric, 'a later price change never recomputes past calls');
update public.ai_prices set input_per_mtok = 0.10 where model = 'claude-haiku-5-5';

select is((public.record_ai_call('jev', 'claude-haiku-5-5', 'classify', null, 1, 10, 1, 0, 0, 100, 'error', 402, 'credit balance too low') ->> 'paused')::boolean, true,
  'a billing error pauses Jev');
select is((select count(*)::int from public.notifications where type = 'system' and ref_id = 'jev'), 1, 'a pause notifies the inbox');

update public.engine_settings set paused = false where engine = 'jev';
delete from public.ai_calls;
select public.record_ai_call('jev', 'mock', 'classify', null, 1, 10, 1, 0, 0, 50, 'ok') from generate_series(1, 4);
select public.record_ai_call('jev', 'mock', 'classify', null, 1, 10, 1, 0, 0, 50, 'error', 529, 'overloaded') from generate_series(1, 2);
select results_eq($$select paused, paused_reason like '2 of 6 calls failed%' from public.engine_settings where engine = 'jev'$$,
  $$values (true, true)$$, 'more than 20% failed calls in an hour pauses Jev');

update public.engine_settings set paused = false, monthly_budget_usd = 1 where engine = 'jev';
delete from public.ai_calls;
delete from public.notifications;
select public.record_ai_call('jev', 'claude-haiku-5-5', 'classify', null, 1, 8500000, 0, 0, 0, 100, 'ok');
select public.record_ai_call('jev', 'claude-haiku-5-5', 'classify', null, 1, 100, 0, 0, 0, 100, 'ok');
select is((select count(*)::int from public.notifications where type = 'budget'), 1, '80% of the budget alerts once a month');
select public.record_ai_call('jev', 'claude-haiku-5-5', 'classify', null, 1, 2000000, 0, 0, 0, 100, 'ok');
select ok((select paused and paused_reason like 'monthly budget%' from public.engine_settings where engine = 'jev'), '100% of the budget pauses Jev');
update public.engine_settings set paused = false, paused_reason = null, monthly_budget_usd = 3 where engine = 'jev';
delete from public.ai_calls;
delete from public.notifications;

-- Auto-publish gate -------------------------------------------------------------------------------
insert into public.entries (kind, source, match_key, canonical_name, status) values
  ('program', 'programs', '7-zip|igor pavlov', '7-Zip', 'pending'),
  ('program', 'programs', 'anydesk|anydesk', 'AnyDesk', 'pending'),
  ('program', 'programs', 'git|git', 'Git', 'pending'),
  ('program', 'programs', 'putty|simon tatham', 'PuTTY', 'pending'),
  ('program', 'programs', 'notepad++|don ho', 'Notepad++', 'pending'),
  ('program', 'programs', 'winrar|win.rar', 'WinRAR', 'pending'),
  ('program', 'programs', 'rustdesk|purslane', 'RustDesk', 'pending'),
  ('program', 'programs', 'curl|curl', 'curl', 'pending');
-- Git has a manual revision; PuTTY has an open request; curl was published by a rule.
select public.publish_entry(pg_temp.entry('git|git'), pg_temp.cat('developer-tools/clis-and-version-control'), 'manual', null, null, '00000000-0000-0000-0000-00000000000a', 'Set by hand');
select public.publish_entry(pg_temp.entry('curl|curl'), pg_temp.cat('developer-tools/clis-and-version-control'), 'rule', null, null, null, 'Rule');
insert into public.clients (id, name, contact_email, key_prefix, key_hash) values ('c0000000-0000-0000-0000-000000000001', 'Acme', 'it@acme.example', 'hubk_aaaaaa', repeat('b', 64));
insert into public.reclassification_requests (client_id, entry_id, reason) values ('c0000000-0000-0000-0000-000000000001', pg_temp.entry('putty|simon tatham'), 'Open');

create temp table run as select public.jev_start_run(array(select id from public.entries), null, false, 'mock') as id;
grant select on run to authenticated;
select is(public.jev_store_result((select id from run), pg_temp.entry('7-zip|igor pavlov'), 'general-business/compression-and-file-utilities', 0.97),
  'auto_published', 'p ≥ 0.95, info on both sides, no manual revision, no open request: published');
select results_eq($$select e.status::text, e.method::text, e.seq = (select max(seq) from public.dictionary_events), (select count(*)::int from public.entry_revisions v where v.entry_id = e.id)
  from public.entries e where match_key = '7-zip|igor pavlov'$$, $$values ('published', 'jev_auto', true, 1)$$,
  'publishing writes a revision and takes the newest seq');
select is((select jsonb_array_length(public.dictionary_changes(gen_random_uuid(), (select seq - 1 from public.entries where match_key = '7-zip|igor pavlov'), 1000) -> 'entries')), 1,
  'clients receive the auto-published entry');
select is(public.jev_store_result((select id from run), pg_temp.entry('anydesk|anydesk'), 'remote-access/remote-desktop-and-support', 0.99), 'proposal',
  'a review category is never auto-published');
select is((select status::text from public.entries where match_key = 'anydesk|anydesk'), 'proposed', 'a pending entry becomes proposed');
select is(public.jev_store_result((select id from run), pg_temp.entry('git|git'), 'developer-tools/ides-and-editors', 0.99), 'proposal',
  'an entry with a manual revision is never auto-published');
select is(public.jev_store_result((select id from run), pg_temp.entry('putty|simon tatham'), 'developer-tools/clis-and-version-control', 0.99), 'proposal',
  'an entry with an open request is never auto-published');
select is(public.jev_store_result((select id from run), pg_temp.entry('notepad++|don ho'), 'general-business/compression-and-file-utilities', 0.90), 'proposal',
  'below 0.95 is a proposal');
update public.engine_settings set auto_publish_daily = 1 where engine = 'jev';
select is(public.jev_store_result((select id from run), pg_temp.entry('winrar|win.rar'), 'general-business/compression-and-file-utilities', 0.99), 'proposal',
  'the daily auto-publish cap holds');
update public.engine_settings set auto_publish_daily = 100 where engine = 'jev';
create temp table rerun as select public.jev_start_run(array[pg_temp.entry('winrar|win.rar')], null, true, 'mock') as id;
select is(public.jev_store_result((select id from rerun), pg_temp.entry('winrar|win.rar'), 'general-business/compression-and-file-utilities', 0.99), 'proposal',
  'a re-run never auto-publishes');
select is(public.jev_store_result((select id from run), pg_temp.entry('rustdesk|purslane'), 'remote-access/remote-desktop-and-support', 0.99), 'proposal', 'RustDesk: a sensitive proposal');
select is(public.jev_store_result((select id from run), pg_temp.entry('curl|curl'), 'general-business/compression-and-file-utilities', 0.99), 'auto_published',
  'a rule-published entry can be reclassified automatically');

-- Decisions ---------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select throws_ok($$select public.decide_proposal((select id from run), pg_temp.entry('anydesk|anydesk'), true)$$, '42501', null, 'only hub admins decide');
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select is(public.decide_proposal((select id from run), pg_temp.entry('anydesk|anydesk'), true), 'accepted', 'accept a proposal');
select is(public.decide_proposal((select id from run), pg_temp.entry('notepad++|don ho'), true, pg_temp.cat('developer-tools/ides-and-editors')), 'changed',
  'change the proposed category');
select is(public.decide_proposal((select id from run), pg_temp.entry('putty|simon tatham'), false), 'rejected', 'reject a proposal');
select is(public.accept_all_above(0.85), 2, 'accept all above 0.85 takes the info proposals (Git, WinRAR)');
select is((select string_agg(canonical_name, ',') from public.v_proposals), 'RustDesk', '...and leaves the sensitive one');
select is(public.revert_auto_publish(pg_temp.entry('7-zip|igor pavlov')), 'deprecated', 'reverting a first publish deprecates it for clients');
select is(public.revert_auto_publish(pg_temp.entry('curl|curl')), 'restored', 'reverting a reclassification restores the previous category');
reset role;
select results_eq($$select e.canonical_name, e.status::text, e.method::text, c.slug from public.entries e join public.categories c on c.id = e.category_id
  where e.match_key in ('anydesk|anydesk', 'notepad++|don ho', 'putty|simon tatham', '7-zip|igor pavlov', 'curl|curl') order by 1$$,
  $$values ('7-Zip', 'deprecated', 'manual', 'general-business/compression-and-file-utilities'),
           ('AnyDesk', 'published', 'jev', 'remote-access/remote-desktop-and-support'),
           ('curl', 'published', 'rule', 'developer-tools/clis-and-version-control'),
           ('Notepad++', 'published', 'manual', 'developer-tools/ides-and-editors')$$,
  'decisions and reverts leave the expected state (PuTTY is back to pending, without a category)');
select is((select count(*)::int from public.classification_results where accepted = false), 4,
  'changed, rejected and reverted all count against Jev');

-- Acceptance pause --------------------------------------------------------------------------------
insert into public.entries (kind, source, match_key, canonical_name) select 'package', 'npm', 'pkg' || g, 'pkg' || g from generate_series(1, 20) g;
insert into public.classification_results (run_id, entry_id, category_id, probability, accepted, accepted_at)
select (select id from run), id, pg_temp.cat('other/other'), 0.5, false, now() from public.entries where source = 'npm';
select public.check_jev_acceptance();
select ok((select paused and paused_reason like 'only%accepted' from public.engine_settings where engine = 'jev'), 'acceptance below 70% pauses Jev');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select public.resume_engine('jev');
select results_eq('select paused, titles_today >= 0 from public.engine_status(''jev'')', $$values (false, true)$$, 'an admin resumes Jev and sees its status');
reset role;

select * from finish();
rollback;
