-- Phase H5: provider keys, the generic gateway for research, prices with searches, research triggers and
-- the 30-day rule, usage detail.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
truncate public.clients, public.classification_runs, public.audit_log, public.hub_admins, public.notifications, public.ai_calls,
  public.research_queue, public.research_dossiers, public.provider_keys cascade;
delete from public.entries;
delete from vault.secrets where name like 'provider_key_%';
update public.engine_settings set mode = 'automatic', paused = false, paused_reason = null, daily_titles = 20, monthly_budget_usd = 10,
  triggers = '{"request": true, "sensitive_proposal": true, "jev_below_085": false, "rule_jev_disagree": false}' where engine = 'research';

select plan(23);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'someone@example.com');
insert into public.hub_admins (user_id) values ('00000000-0000-0000-0000-00000000000a');

create function pg_temp.as_user(uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.cat(slug text) returns uuid language sql as $$ select id from public.categories where categories.slug = $1 $$;
create function pg_temp.entry(key text) returns uuid language sql as $$ select id from public.entries where match_key = $1 $$;

-- Provider keys -----------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select throws_ok($$select public.set_provider_key('gemini', 'AIzaFakeKey0123456789abcdef')$$, '42501', null, 'non-admins cannot store keys');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select lives_ok($$select public.set_provider_key('gemini', 'AIzaFakeKey0123456789abcdef')$$, 'an admin stores a key');
select throws_ok($$select public.set_provider_key('mistral', 'AIzaFakeKey0123456789abcdef')$$, '22023', null, 'only the four providers');
select results_eq('select provider, key_hint from public.provider_keys', $$values ('gemini', '••••cdef')$$, 'the console sees only a hint');
select throws_ok('select secret_id from public.provider_keys', '42501', null, 'not even the Vault id');
reset role;
select is(public.get_provider_key('gemini'), 'AIzaFakeKey0123456789abcdef', 'Edge Functions read the key');
select ok(not has_function_privilege('authenticated', 'public.get_provider_key(text)', 'execute'), 'browsers cannot');
select is((select count(*)::int from public.audit_log where data::text like '%0123456789abcdef%'), 0, 'the key is never audited');

-- Gateway and prices ------------------------------------------------------------------------------
select is(public.engine_gate('research', 1, false) ->> 'provider', 'claude', 'research passes the gate with its provider');
update public.engine_settings set daily_titles = 1 where engine = 'research';
select public.record_ai_call('research', 'claude-opus-5-5', 'research', null, 1, 1000, 500, 0, 0, 1000, 'ok', null, null, 'claude', 3);
select is(public.engine_gate('research', 1, true) ->> 'allowed', 'false', 'the daily research limit holds');
update public.engine_settings set daily_titles = 20 where engine = 'research';
select is((select cost_usd from public.ai_calls order by id desc limit 1), (1000 * 4 + 500 * 20) / 1000000.0 + 3 * 0.01, 'cost includes the searches');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select public.set_price('research', 'claude', 'claude-opus-5-5', 8, 40, 0.4, 10, 0.02);
select set_config('role', 'postgres', true);
reset role;
select public.record_ai_call('research', 'claude-opus-5-5', 'research', null, 1, 1000, 0, 0, 0, 1000, 'ok', null, null, 'claude', 1);
select results_eq('select cost_usd from public.ai_calls order by id',
  $$values (0.044000::numeric(12,6)), (0.028000::numeric(12,6))$$, 'a new price applies to new calls only');
update public.engine_settings set model = 'gpt-5', provider = 'openai' where engine = 'research';
select results_eq('select engine, model from public.v_missing_prices', $$values ('research', 'gpt-5')$$, 'a model without a price is flagged');
update public.engine_settings set model = 'claude-opus-5-5', provider = 'claude' where engine = 'research';

-- Research triggers -------------------------------------------------------------------------------
insert into public.entries (kind, source, match_key, canonical_name) values
  ('program', 'programs', 'anydesk|anydesk', 'AnyDesk'), ('program', 'programs', 'foo|', 'Foo'), ('program', 'programs', 'bar|', 'Bar');
insert into public.clients (id, name, contact_email, key_prefix, key_hash) values ('c0000000-0000-0000-0000-000000000001', 'Acme', 'it@acme.example', 'hubk_aaaaaa', repeat('a', 64));
insert into public.reclassification_requests (client_id, entry_id, reason) values ('c0000000-0000-0000-0000-000000000001', pg_temp.entry('foo|'), 'what is it?');
select is((select trigger from public.research_queue where entry_id = pg_temp.entry('foo|')), 'request', 'a reclassification request queues a research');
create temp table run as select public.jev_start_run(array[pg_temp.entry('anydesk|anydesk'), pg_temp.entry('bar|')], null, false, 'mock') as id;
select public.jev_store_result((select id from run), pg_temp.entry('anydesk|anydesk'), 'remote-access/remote-desktop-and-support', 0.99);
select public.jev_store_result((select id from run), pg_temp.entry('bar|'), 'other/other', 0.40);
select results_eq('select q.trigger from public.research_queue q join public.entries e on e.id = q.entry_id order by e.canonical_name',
  $$values ('sensitive_proposal'), ('request')$$, 'a sensitive proposal queues one; below 0.85 does not while that trigger is off');
select is(public.enqueue_research(pg_temp.entry('anydesk|anydesk'), 'sensitive_proposal'), false, 'at most one automatic research per entry in 30 days');
update public.engine_settings set triggers = triggers || '{"jev_below_085": true}' where engine = 'research';
select is(public.enqueue_research(pg_temp.entry('bar|'), 'jev_below_085'), true, 'a trigger switched on queues');
select is((select count(*)::int from public.research_take(10)), 3, 'the tick takes the queue');

-- Usage -------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select results_eq($$select (d ->> 'month_calls')::int, (d ->> 'month_searches')::int from public.engine_usage_detail('research') d$$, $$values (2, 4)$$,
  'usage detail counts calls and searches');
reset role;

-- Jev on OpenAI (alternative to Claude) -------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select lives_ok($$select public.set_engine_config('jev', 'openai', 'gpt-5-mini', 200, 3)$$, 'Jev can run on OpenAI');
select results_eq($$select provider, model from public.engine_settings where engine = 'jev'$$, $$values ('openai', 'gpt-5-mini')$$, 'Jev provider and model saved');
select throws_ok($$select public.set_engine_config('jev', 'gemini', 'gemini-3.8-flash', 200, 3)$$, '22023', 'Jev runs on Claude or OpenAI', 'Jev refuses other providers');
reset role;
select is((select (public.record_ai_call('jev', 'gpt-5-mini', 'classify', null, 1, 1000000, 1000000, 1000000, 0, 10, 'ok', null, null, 'openai') ->> 'cost_usd')::numeric),
  2.275::numeric, 'gpt-5-mini cost: 0.25 input + 2.00 output + 0.025 cached input per million');

select * from finish();
rollback;
