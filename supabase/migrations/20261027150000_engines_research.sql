-- Phase H5: two engines behind one gateway (jev, research), provider keys in Vault, editable prices,
-- usage detail, and the research engine (dossiers with sources; never publishes).

-- Provider keys ---------------------------------------------------------------------------------
-- Entered in Settings, write-only from the browser, kept in Vault, read only by Edge Functions.

create table public.provider_keys (
  provider text primary key check (provider in ('claude', 'gemini', 'openai', 'grok')),
  secret_id uuid not null,
  key_hint text not null,
  configured_at timestamptz not null default now(),
  configured_by uuid references auth.users (id) on delete set null
);

alter table public.provider_keys enable row level security;
revoke all on table public.provider_keys from anon, authenticated;
create policy "Hub admins read provider_keys" on public.provider_keys for select to authenticated using ((select public.is_hub_admin()));
grant select (provider, key_hint, configured_at) on table public.provider_keys to authenticated;

create or replace function public.set_provider_key(p_provider text, p_key text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := btrim(coalesce(p_key, ''));
  v_secret uuid;
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins manage provider keys' using errcode = '42501';
  end if;
  if p_provider not in ('claude', 'gemini', 'openai', 'grok') then
    raise exception 'Unknown provider' using errcode = '22023';
  end if;
  if char_length(v_key) not between 16 and 500 or v_key ~ '\s' then
    raise exception 'The key is not valid' using errcode = '22023';
  end if;
  select secret_id into v_secret from public.provider_keys where provider = p_provider for update;
  if v_secret is null then
    v_secret := vault.create_secret(v_key, 'provider_key_' || p_provider, 'AI provider key: ' || p_provider);
  else
    perform vault.update_secret(v_secret, v_key);
  end if;
  insert into public.provider_keys (provider, secret_id, key_hint, configured_at, configured_by)
  values (p_provider, v_secret, '••••' || right(v_key, 4), now(), auth.uid())
  on conflict (provider) do update set key_hint = excluded.key_hint, configured_at = now(), configured_by = auth.uid();
  insert into public.audit_log (user_id, action, target, data)
  values (auth.uid(), 'set provider key', p_provider, jsonb_build_object('key_hint', '••••' || right(v_key, 4)));
end;
$$;

create or replace function public.clear_provider_key(p_provider text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins manage provider keys' using errcode = '42501';
  end if;
  delete from public.provider_keys where provider = p_provider returning secret_id into v_secret;
  if v_secret is not null then
    delete from vault.secrets where id = v_secret;
    insert into public.audit_log (user_id, action, target, data) values (auth.uid(), 'remove provider key', p_provider, null);
  end if;
end;
$$;

create or replace function public.get_provider_key(p_provider text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret from public.provider_keys k join vault.decrypted_secrets s on s.id = k.secret_id where k.provider = p_provider;
$$;

-- Engine settings -------------------------------------------------------------------------------

alter table public.engine_settings
  add column provider text not null default 'claude' check (provider in ('claude', 'gemini', 'openai', 'grok')),
  add column per_run_searches integer not null default 5 check (per_run_searches between 1 and 5),
  add column timeout_seconds integer not null default 60 check (timeout_seconds between 10 and 60),
  add column triggers jsonb not null default '{}';

insert into public.engine_settings (engine, mode, model, provider, daily_titles, monthly_budget_usd, batch_size, triggers)
values ('research', 'automatic', 'claude-opus-5-5', 'claude', 20, 10, 5,
  '{"request": true, "sensitive_proposal": true, "jev_below_085": false, "rule_jev_disagree": false}');

create or replace function public.set_engine_config(
  p_engine text, p_provider text, p_model text, p_daily integer, p_monthly_budget numeric, p_triggers jsonb default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins change engines' using errcode = '42501';
  end if;
  if p_engine = 'jev' and p_provider <> 'claude' then
    raise exception 'Jev runs on Claude' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_model, '')), '') is null or p_model !~ '^[A-Za-z0-9._:/-]{2,80}$' then
    raise exception 'Model name is not valid' using errcode = '22023';
  end if;
  update public.engine_settings set
    provider = p_provider, model = btrim(p_model), daily_titles = p_daily, monthly_budget_usd = p_monthly_budget,
    triggers = case when p_triggers is null then triggers else
      jsonb_build_object('request', coalesce((p_triggers ->> 'request')::boolean, false),
                         'sensitive_proposal', coalesce((p_triggers ->> 'sensitive_proposal')::boolean, false),
                         'jev_below_085', coalesce((p_triggers ->> 'jev_below_085')::boolean, false),
                         'rule_jev_disagree', coalesce((p_triggers ->> 'rule_jev_disagree')::boolean, false)) end,
    updated_at = now(), updated_by = auth.uid()
  where engine = p_engine;
  insert into public.audit_log (user_id, action, target, data)
  values (auth.uid(), 'configure engine', p_engine, jsonb_build_object('provider', p_provider, 'model', p_model, 'daily', p_daily, 'budget', p_monthly_budget, 'triggers', p_triggers));
end;
$$;

create or replace function public.admin_pause_engine(p_engine text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins pause engines' using errcode = '42501';
  end if;
  perform public.pause_engine(p_engine, 'paused by an admin');
  insert into public.audit_log (user_id, action, target, data) values (auth.uid(), 'pause engine', p_engine, null);
end;
$$;

-- Prices and calls ------------------------------------------------------------------------------

alter table public.ai_prices
  add column provider text not null default 'claude',
  add column per_search_usd numeric(10, 4) not null default 0;

insert into public.ai_prices (engine, provider, model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, per_search_usd, effective_from)
values ('research', 'claude', 'claude-opus-5-5', 4, 20, 0.20, 5, 0.01, '2026-01-01'),
       ('research', 'claude', 'mock', 4, 20, 0.20, 5, 0.01, '2026-01-01');

create or replace function public.set_price(
  p_engine text, p_provider text, p_model text, p_input numeric, p_output numeric, p_cache_read numeric, p_cache_write numeric, p_per_search numeric
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins edit prices' using errcode = '42501';
  end if;
  if least(p_input, p_output, p_cache_read, p_cache_write, p_per_search) < 0 then
    raise exception 'Prices cannot be negative' using errcode = '22023';
  end if;
  insert into public.ai_prices (engine, provider, model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, per_search_usd, effective_from)
  values (p_engine, p_provider, btrim(p_model), p_input, p_output, p_cache_read, p_cache_write, p_per_search, now())
  on conflict (engine, model, effective_from) do update set input_per_mtok = excluded.input_per_mtok, output_per_mtok = excluded.output_per_mtok,
    cache_read_per_mtok = excluded.cache_read_per_mtok, cache_write_per_mtok = excluded.cache_write_per_mtok, per_search_usd = excluded.per_search_usd;
  insert into public.audit_log (user_id, action, target, data)
  values (auth.uid(), 'set price', p_engine || ':' || p_model,
    jsonb_build_object('input', p_input, 'output', p_output, 'cache_read', p_cache_read, 'cache_write', p_cache_write, 'per_search', p_per_search));
end;
$$;

-- Engines whose configured model has no price: their cost shows as 0, so the console warns.
create view public.v_missing_prices
with (security_invoker = true)
as
select s.engine, s.provider, s.model
from public.engine_settings s
where not exists (select 1 from public.ai_prices p where p.engine = s.engine and p.model = s.model and p.effective_from <= now());

alter table public.ai_calls
  add column provider text,
  add column searches integer not null default 0,
  add column entry_ids uuid[];

-- Generic gateway -------------------------------------------------------------------------------

create or replace function public.engine_gate(p_engine text, p_units integer, p_manual boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.engine_settings;
  u record;
  v_name text := case when p_engine = 'jev' then 'Jev' else 'Research' end;
begin
  select * into s from public.engine_settings where engine = p_engine;
  select * into u from public.engine_usage(p_engine);
  if s.engine is null then
    return jsonb_build_object('allowed', false, 'reason', 'Unknown engine');
  elsif s.mode = 'off' then
    return jsonb_build_object('allowed', false, 'reason', v_name || ' is off');
  elsif s.mode = 'manual' and not p_manual then
    return jsonb_build_object('allowed', false, 'reason', v_name || ' is in manual mode');
  elsif s.paused then
    return jsonb_build_object('allowed', false, 'reason', v_name || ' is paused: ' || coalesce(s.paused_reason, 'no reason given'));
  elsif u.titles_today + p_units > s.daily_titles then
    return jsonb_build_object('allowed', false, 'reason', format('Daily limit: %s of %s used today', u.titles_today, s.daily_titles));
  elsif s.monthly_budget_usd > 0 and u.spend_month >= s.monthly_budget_usd then
    return jsonb_build_object('allowed', false, 'reason', format('Monthly budget of USD %s is used', s.monthly_budget_usd));
  end if;
  return jsonb_build_object('allowed', true, 'model', s.model, 'provider', s.provider,
    'searches', s.per_run_searches, 'timeout_seconds', s.timeout_seconds);
end;
$$;

create or replace function public.jev_gate(p_titles integer, p_manual boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.engine_gate('jev', p_titles, p_manual);
$$;

drop function public.record_ai_call(text, text, text, uuid, integer, integer, integer, integer, integer, integer, text, integer, text);

create or replace function public.record_ai_call(
  p_engine text, p_model text, p_purpose text, p_run_id uuid, p_titles integer,
  p_input integer, p_output integer, p_cache_read integer, p_cache_write integer,
  p_latency_ms integer, p_status text, p_http_status integer default null, p_error text default null,
  p_provider text default null, p_searches integer default 0, p_entry_ids uuid[] default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p public.ai_prices;
  s public.engine_settings;
  u record;
  v_cost numeric := 0;
  v_was_paused boolean;
  v_month text := to_char(now() at time zone 'UTC', 'YYYY-MM');
begin
  select * into p from public.ai_prices
  where engine = p_engine and model = p_model and effective_from <= now()
  order by effective_from desc limit 1;
  if p.engine is not null then
    v_cost := (coalesce(p_input, 0) * p.input_per_mtok + coalesce(p_output, 0) * p.output_per_mtok
             + coalesce(p_cache_read, 0) * p.cache_read_per_mtok + coalesce(p_cache_write, 0) * p.cache_write_per_mtok) / 1000000
             + coalesce(p_searches, 0) * p.per_search_usd;
  end if;

  insert into public.ai_calls (engine, provider, model, purpose, run_id, entry_ids, titles, input_tokens, output_tokens, cache_read_tokens,
                               cache_write_tokens, searches, cost_usd, latency_ms, status, http_status, error)
  values (p_engine, p_provider, p_model, p_purpose, p_run_id, p_entry_ids, coalesce(p_titles, 0), coalesce(p_input, 0), coalesce(p_output, 0),
          coalesce(p_cache_read, 0), coalesce(p_cache_write, 0), coalesce(p_searches, 0), v_cost, p_latency_ms, p_status, p_http_status, left(p_error, 500));

  select * into s from public.engine_settings where engine = p_engine;
  v_was_paused := s.paused;
  select * into u from public.engine_usage(p_engine);

  if p_http_status = 402 then
    perform public.pause_engine(p_engine, 'the AI provider reports no credit left (billing)');
  elsif s.monthly_budget_usd > 0 and u.spend_month >= s.monthly_budget_usd then
    perform public.pause_engine(p_engine, format('monthly budget of USD %s reached', s.monthly_budget_usd));
  elsif u.calls_hour >= 5 and u.errors_hour::numeric / u.calls_hour > 0.2 then
    perform public.pause_engine(p_engine, format('%s of %s calls failed in the last hour', u.errors_hour, u.calls_hour));
  end if;

  if s.monthly_budget_usd > 0 and u.spend_month >= s.monthly_budget_usd * s.alert_pct / 100.0
     and not exists (select 1 from public.notifications where type = 'budget' and ref_id = p_engine || ':' || v_month) then
    insert into public.notifications (type, ref_id, title)
    values ('budget', p_engine || ':' || v_month,
      format('%s has used %s%% of its USD %s budget for %s', initcap(p_engine), round(100 * u.spend_month / s.monthly_budget_usd), s.monthly_budget_usd, v_month));
  end if;

  select paused, paused_reason into s.paused, s.paused_reason from public.engine_settings where engine = p_engine;
  return jsonb_build_object('cost_usd', v_cost, 'paused', s.paused, 'reason', s.paused_reason, 'newly_paused', s.paused and not v_was_paused);
end;
$$;

-- Research --------------------------------------------------------------------------------------

create table public.research_dossiers (
  id bigint generated always as identity primary key,
  entry_id uuid not null references public.entries (id) on delete cascade,
  provider text not null,
  model text not null,
  trigger text not null check (trigger in ('manual', 'request', 'sensitive_proposal', 'jev_below_085', 'rule_jev_disagree')),
  dossier jsonb not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index research_dossiers_entry_idx on public.research_dossiers (entry_id, created_at desc);

create table public.research_queue (
  id bigint generated always as identity primary key,
  entry_id uuid not null references public.entries (id) on delete cascade,
  trigger text not null check (trigger in ('request', 'sensitive_proposal', 'jev_below_085', 'rule_jev_disagree')),
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index research_queue_pending_idx on public.research_queue (created_at) where status = 'pending';

-- Queues an automatic research when its trigger is on, the engine is not off, and the entry had no
-- automatic research (queued or done) in the last 30 days.
create or replace function public.enqueue_research(p_entry_id uuid, p_trigger text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s public.engine_settings;
begin
  select * into s from public.engine_settings where engine = 'research';
  if s.mode = 'off' or coalesce((s.triggers ->> p_trigger)::boolean, false) is not true then
    return false;
  end if;
  if exists (select 1 from public.research_queue q where q.entry_id = p_entry_id and q.created_at > now() - interval '30 days')
     or exists (select 1 from public.research_dossiers d where d.entry_id = p_entry_id and d.trigger <> 'manual' and d.created_at > now() - interval '30 days') then
    return false;
  end if;
  insert into public.research_queue (entry_id, trigger) values (p_entry_id, p_trigger);
  return true;
end;
$$;

create or replace function public.research_on_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.enqueue_research(new.entry_id, 'request');
  return new;
end;
$$;

create trigger research_on_request after insert on public.reclassification_requests
  for each row execute function public.research_on_request();

create or replace function public.research_on_result()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attention public.attention_level;
  e public.entries;
begin
  select attention_level into v_attention from public.categories where id = new.category_id;
  select * into e from public.entries where id = new.entry_id;
  if v_attention in ('review', 'not_allowed') then
    perform public.enqueue_research(new.entry_id, 'sensitive_proposal');
  elsif new.probability < 0.85 then
    perform public.enqueue_research(new.entry_id, 'jev_below_085');
  elsif e.method = 'rule' and e.category_id is distinct from new.category_id then
    perform public.enqueue_research(new.entry_id, 'rule_jev_disagree');
  end if;
  return new;
end;
$$;

create trigger research_on_result after insert on public.classification_results
  for each row execute function public.research_on_result();

-- The cron tick takes queued entries up to the daily limit.
create or replace function public.research_take(p_limit integer)
returns table (queue_id bigint, entry_id uuid, trigger text)
language sql
volatile
security definer
set search_path = ''
as $$
  update public.research_queue q set status = 'done', processed_at = now()
  where q.id in (select id from public.research_queue where status = 'pending' order by created_at limit greatest(p_limit, 0) for update skip locked)
  returning q.id, q.entry_id, q.trigger;
$$;

create or replace function public.research_failed(p_queue_id bigint, p_error text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.research_queue set status = 'failed', error = left(p_error, 500) where id = p_queue_id;
$$;

create or replace function public.invoke_research()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'jev_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  if v_url is null or v_secret is null then
    return null;
  end if;
  return net.http_post(url := regexp_replace(v_url, '/jev/?$', '/research'), body := '{"action": "tick"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret), timeout_milliseconds := 150000);
end;
$$;

select cron.unschedule(jobid) from cron.job where jobname = 'research-tick';
select cron.schedule('research-tick', '37 * * * *', 'select public.invoke_research()');

-- Usage -----------------------------------------------------------------------------------------

create or replace function public.engine_usage_detail(p_engine text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with month as (
    select * from public.ai_calls where engine = p_engine and created_at >= date_trunc('month', now(), 'UTC')
  ),
  decided as (
    select accepted from public.classification_results where accepted is not null order by accepted_at desc nulls last limit 50
  ),
  accepted_month as (
    select count(*) as n from public.classification_results where accepted and accepted_at >= date_trunc('month', now(), 'UTC')
  )
  select case when not public.is_hub_admin() then null else jsonb_build_object(
    'month_calls', (select count(*) from month),
    'month_errors', (select count(*) from month where status = 'error'),
    'month_titles', (select coalesce(sum(titles), 0) from month),
    'month_searches', (select coalesce(sum(searches), 0) from month),
    'month_cost', (select coalesce(sum(cost_usd), 0) from month),
    'day_calls', (select count(*) from month where created_at >= date_trunc('day', now(), 'UTC')),
    'day_cost', (select coalesce(sum(cost_usd), 0) from month where created_at >= date_trunc('day', now(), 'UTC')),
    'accepted_month', case when p_engine = 'jev' then (select n from accepted_month) end,
    'cost_per_accepted', case when p_engine = 'jev' and (select n from accepted_month) > 0
      then round((select coalesce(sum(cost_usd), 0) from month) / (select n from accepted_month), 6) end,
    'acceptance_rate', case when p_engine = 'jev' and (select count(*) from decided) > 0
      then round((select count(*) filter (where accepted) from decided)::numeric / (select count(*) from decided), 3) end,
    'recent_errors', coalesce((select jsonb_agg(jsonb_build_object('at', created_at, 'http', http_status, 'error', error) order by created_at desc)
      from (select * from public.ai_calls where engine = p_engine and status = 'error' order by created_at desc limit 10) x), '[]'),
    'queue', case when p_engine = 'research' then (select count(*) from public.research_queue where status = 'pending') end
  ) end;
$$;

-- Access ----------------------------------------------------------------------------------------

do $$
declare
  t text;
  f text;
begin
  foreach t in array array['research_dossiers', 'research_queue'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('create policy "Hub admins read %s" on public.%I for select to authenticated using ((select public.is_hub_admin()))', t, t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
  revoke all on table public.v_missing_prices from anon, authenticated;
  grant select on table public.v_missing_prices to authenticated;

  foreach f in array array[
    'set_provider_key(text, text)', 'clear_provider_key(text)', 'set_engine_config(text, text, text, integer, numeric, jsonb)',
    'admin_pause_engine(text)', 'set_price(text, text, text, numeric, numeric, numeric, numeric, numeric)', 'engine_usage_detail(text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array[
    'get_provider_key(text)', 'engine_gate(text, integer, boolean)', 'jev_gate(integer, boolean)',
    'record_ai_call(text, text, text, uuid, integer, integer, integer, integer, integer, integer, text, integer, text, text, integer, uuid[])',
    'enqueue_research(uuid, text)', 'research_take(integer)', 'research_failed(bigint, text)', 'invoke_research()',
    'research_on_request()', 'research_on_result()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
