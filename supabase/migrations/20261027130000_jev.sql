-- Phase H3: Jev. Engine settings and the ai_gateway rules in SQL (mode, pause, daily titles, monthly
-- budget, cost per call, pause rules), the publish core (revision + event + seq, reused by H4), the
-- auto-publish gate, proposals and the admin's decisions. The jev Edge Function only does I/O.

create table public.engine_settings (
  engine text primary key check (engine in ('jev', 'research')),
  mode text not null default 'automatic' check (mode in ('off', 'manual', 'automatic')),
  model text not null,
  batch_size integer not null default 50 check (batch_size between 1 and 50),
  interval_hours integer not null default 6 check (interval_hours between 1 and 168),
  min_reports integer not null default 2 check (min_reports >= 1),
  daily_titles integer not null default 200 check (daily_titles >= 0),
  monthly_budget_usd numeric(10, 2) not null default 3 check (monthly_budget_usd >= 0),
  auto_publish_daily integer not null default 100 check (auto_publish_daily >= 0),
  alert_pct integer not null default 80 check (alert_pct between 1 and 100),
  paused boolean not null default false,
  paused_reason text,
  paused_at timestamptz,
  last_auto_run_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

insert into public.engine_settings (engine, model) values ('jev', 'claude-haiku-5-5');

-- Prices per million tokens, kept by the admin. A call's cost uses the price in force at call time
-- and is never recomputed.
create table public.ai_prices (
  engine text not null,
  model text not null,
  input_per_mtok numeric(10, 4) not null,
  output_per_mtok numeric(10, 4) not null,
  cache_read_per_mtok numeric(10, 4) not null default 0,
  cache_write_per_mtok numeric(10, 4) not null default 0,
  effective_from timestamptz not null default now(),
  primary key (engine, model, effective_from)
);

insert into public.ai_prices (engine, model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, effective_from)
values ('jev', 'claude-haiku-5-5', 0.10, 0.50, 0.01, 0.125, '2026-01-01'),
       ('jev', 'mock', 0.10, 0.50, 0.01, 0.125, '2026-01-01');

create table public.ai_calls (
  id bigint generated always as identity primary key,
  engine text not null,
  model text not null,
  purpose text not null,
  run_id uuid references public.classification_runs (id) on delete set null,
  titles integer not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  latency_ms integer,
  status text not null check (status in ('ok', 'error')),
  http_status integer,
  error text,
  created_at timestamptz not null default now()
);

create index ai_calls_engine_created_idx on public.ai_calls (engine, created_at desc);

alter table public.classification_runs add column rerun boolean not null default false;

-- A proposed entry has a proposal (in classification_results) but no published category yet.
alter table public.entries drop constraint entries_check;
alter table public.entries add constraint entries_published_has_category
  check (status in ('pending', 'proposed') or (category_id is not null and method is not null));

-- Gateway ---------------------------------------------------------------------------------------

create or replace function public.engine_usage(p_engine text)
returns table (titles_today bigint, spend_month numeric, calls_hour bigint, errors_hour bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(sum(titles) filter (where status = 'ok' and created_at >= date_trunc('day', now(), 'UTC')), 0),
    coalesce(sum(cost_usd) filter (where created_at >= date_trunc('month', now(), 'UTC')), 0),
    count(*) filter (where created_at > now() - interval '1 hour'),
    count(*) filter (where created_at > now() - interval '1 hour' and status = 'error')
  from public.ai_calls
  where engine = p_engine;
$$;

create or replace function public.pause_engine(p_engine text, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.engine_settings set paused = true, paused_reason = left(p_reason, 300), paused_at = now()
  where engine = p_engine and not paused;
  if found then
    insert into public.notifications (type, ref_id, title)
    values ('system', p_engine, left(format('%s paused: %s. Only an admin can resume it.', initcap(p_engine), p_reason), 300));
  end if;
end;
$$;

-- May this run start? Manual runs pass in manual mode; nothing passes while paused, over the daily
-- title limit or once the monthly budget is spent.
create or replace function public.jev_gate(p_titles integer, p_manual boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.engine_settings;
  u record;
begin
  select * into s from public.engine_settings where engine = 'jev';
  select * into u from public.engine_usage('jev');
  if s.mode = 'off' then
    return jsonb_build_object('allowed', false, 'reason', 'Jev is off');
  elsif s.mode = 'manual' and not p_manual then
    return jsonb_build_object('allowed', false, 'reason', 'Jev is in manual mode');
  elsif s.paused then
    return jsonb_build_object('allowed', false, 'reason', 'Jev is paused: ' || coalesce(s.paused_reason, 'no reason given'));
  elsif u.titles_today + p_titles > s.daily_titles then
    return jsonb_build_object('allowed', false, 'reason', format('Daily limit: %s of %s titles used today', u.titles_today, s.daily_titles));
  elsif s.monthly_budget_usd > 0 and u.spend_month >= s.monthly_budget_usd then
    return jsonb_build_object('allowed', false, 'reason', format('Monthly budget of USD %s is used', s.monthly_budget_usd));
  end if;
  return jsonb_build_object('allowed', true, 'model', s.model);
end;
$$;

-- Logs one model call with its estimated cost and applies the pause rules.
create or replace function public.record_ai_call(
  p_engine text, p_model text, p_purpose text, p_run_id uuid, p_titles integer,
  p_input integer, p_output integer, p_cache_read integer, p_cache_write integer,
  p_latency_ms integer, p_status text, p_http_status integer default null, p_error text default null
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
  v_month text := to_char(now() at time zone 'UTC', 'YYYY-MM');
begin
  select * into p from public.ai_prices
  where engine = p_engine and model = p_model and effective_from <= now()
  order by effective_from desc limit 1;
  if p.engine is not null then
    v_cost := (coalesce(p_input, 0) * p.input_per_mtok + coalesce(p_output, 0) * p.output_per_mtok
             + coalesce(p_cache_read, 0) * p.cache_read_per_mtok + coalesce(p_cache_write, 0) * p.cache_write_per_mtok) / 1000000;
  end if;

  insert into public.ai_calls (engine, model, purpose, run_id, titles, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                               cost_usd, latency_ms, status, http_status, error)
  values (p_engine, p_model, p_purpose, p_run_id, coalesce(p_titles, 0), coalesce(p_input, 0), coalesce(p_output, 0),
          coalesce(p_cache_read, 0), coalesce(p_cache_write, 0), v_cost, p_latency_ms, p_status, p_http_status, left(p_error, 500));

  select * into s from public.engine_settings where engine = p_engine;
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
  return jsonb_build_object('cost_usd', v_cost, 'paused', s.paused, 'reason', s.paused_reason);
end;
$$;

-- Publish core ----------------------------------------------------------------------------------
-- Every change to an entry: next revision with a snapshot, a dictionary event and its seq. Nothing
-- reaches clients without passing here.

create or replace function public.publish_entry(
  p_entry_id uuid, p_category_id uuid, p_method public.entry_method, p_confidence numeric, p_model_version text,
  p_actor uuid, p_reason text, p_status public.entry_status default 'published'
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  e public.entries;
  v_was_published boolean;
  v_old_category uuid;
  v_seq bigint;
begin
  select status = 'published', category_id into v_was_published, v_old_category from public.entries where id = p_entry_id for update;
  if v_was_published is null then
    raise exception 'Entry not found' using errcode = 'P0002';
  end if;

  update public.entries set
    category_id = p_category_id,
    method = p_method,
    confidence = p_confidence,
    model_version = p_model_version,
    status = p_status,
    revision = revision + 1,
    reviewed_by = coalesce(p_actor, reviewed_by),
    reviewed_at = case when p_actor is not null then now() else reviewed_at end,
    updated_at = now()
  where id = p_entry_id
  returning * into e;

  insert into public.dictionary_events (entry_id, type)
  values (p_entry_id, case
      when p_status = 'deprecated' then 'deprecated'
      when v_was_published and v_old_category is distinct from p_category_id then 'reclassified'
      else 'published' end::public.event_type)
  returning seq into v_seq;
  update public.entries set seq = v_seq where id = p_entry_id returning * into e;

  insert into public.entry_revisions (entry_id, revision, snapshot, changed_by, change_reason)
  values (p_entry_id, e.revision, to_jsonb(e), p_actor, left(p_reason, 1000));
  return v_seq;
end;
$$;

-- Runs and the auto-publish gate ----------------------------------------------------------------

create or replace function public.jev_start_run(p_entry_ids uuid[], p_started_by uuid, p_rerun boolean, p_model text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if cardinality(p_entry_ids) not between 1 and 50 then
    raise exception 'A run takes 1 to 50 titles' using errcode = '22023';
  end if;
  insert into public.classification_runs (model, started_by, entry_count, rerun)
  values (p_model, p_started_by, cardinality(p_entry_ids), p_rerun)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.jev_finish_run(p_run_id uuid, p_status public.run_status)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.classification_runs set status = p_status, finished_at = now() where id = p_run_id;
$$;

-- Stores Jev's answer and publishes it only when every gate condition holds; otherwise a proposal.
create or replace function public.jev_store_result(p_run_id uuid, p_entry_id uuid, p_category_slug text, p_probability numeric)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r public.classification_runs;
  e public.entries;
  v_cat public.categories;
  v_current_attention public.attention_level;
  v_auto_today integer;
  v_cap integer;
begin
  select * into r from public.classification_runs where id = p_run_id;
  select * into v_cat from public.categories where slug = p_category_slug and parent_id is not null and not deprecated;
  if r.id is null or v_cat.id is null then
    raise exception 'Unknown run or category %', p_category_slug using errcode = '22023';
  end if;
  insert into public.classification_results (run_id, entry_id, category_id, probability)
  values (p_run_id, p_entry_id, v_cat.id, p_probability)
  on conflict (run_id, entry_id) do update set category_id = excluded.category_id, probability = excluded.probability;

  select * into e from public.entries where id = p_entry_id for update;
  select attention_level into v_current_attention from public.categories where id = e.category_id;
  select auto_publish_daily into v_cap from public.engine_settings where engine = 'jev';
  select count(*) into v_auto_today from public.entry_revisions
  where created_at >= date_trunc('day', now(), 'UTC') and snapshot ->> 'method' = 'jev_auto';

  if not r.rerun
     and p_probability >= 0.95
     and v_cat.attention_level = 'info'
     and (e.category_id is null or v_current_attention = 'info')
     and e.status <> 'deprecated'
     and not exists (select 1 from public.entry_revisions v where v.entry_id = e.id and v.snapshot ->> 'method' = 'manual')
     and not exists (select 1 from public.reclassification_requests q where q.entry_id = e.id and q.status = 'open')
     and v_auto_today < v_cap
  then
    perform public.publish_entry(e.id, v_cat.id, 'jev_auto', p_probability, r.model, null, 'Jev auto-publish');
    update public.classification_results set accepted = true, accepted_at = now() where run_id = p_run_id and entry_id = p_entry_id;
    return 'auto_published';
  end if;

  if e.status = 'pending' then
    update public.entries set status = 'proposed', updated_at = now() where id = e.id;
  end if;
  return 'proposal';
end;
$$;

-- Admin decisions -------------------------------------------------------------------------------

-- Pauses Jev when fewer than 70% of the last 50 decided proposals were accepted (from 20 decisions on,
-- so one early rejection cannot pause it). A reverted auto-publish counts as a rejection.
create or replace function public.check_jev_acceptance()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_total integer;
  v_accepted integer;
begin
  select count(*), count(*) filter (where accepted) into v_total, v_accepted
  from (select accepted from public.classification_results where accepted is not null order by accepted_at desc nulls last limit 50) d;
  if v_total >= 20 and v_accepted::numeric / v_total < 0.7 then
    perform public.pause_engine('jev', format('only %s of the last %s decided proposals were accepted', v_accepted, v_total));
  end if;
end;
$$;

create or replace function public.decide_proposal(p_run_id uuid, p_entry_id uuid, p_accept boolean, p_category_id uuid default null)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  res public.classification_results;
  v_run public.classification_runs;
  v_category uuid;
  v_jev_right boolean;
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins decide proposals' using errcode = '42501';
  end if;
  select * into res from public.classification_results where run_id = p_run_id and entry_id = p_entry_id for update;
  if res.run_id is null or res.accepted is not null then
    raise exception 'This proposal does not exist or was already decided' using errcode = '22023';
  end if;
  select * into v_run from public.classification_runs where id = p_run_id;

  if not p_accept then
    update public.classification_results set accepted = false, accepted_by = auth.uid(), accepted_at = now() where run_id = p_run_id and entry_id = p_entry_id;
    update public.entries set status = 'pending', updated_at = now() where id = p_entry_id and status = 'proposed';
    insert into public.audit_log (user_id, action, target, data) values (auth.uid(), 'reject proposal', p_entry_id::text, jsonb_build_object('run_id', p_run_id));
    perform public.check_jev_acceptance();
    return 'rejected';
  end if;

  v_category := coalesce(p_category_id, res.category_id);
  if not exists (select 1 from public.categories where id = v_category and parent_id is not null and not deprecated) then
    raise exception 'Choose a level-2 category' using errcode = '22023';
  end if;
  v_jev_right := v_category = res.category_id;
  perform public.publish_entry(p_entry_id, v_category,
    case when v_jev_right then 'jev' else 'manual' end::public.entry_method,
    case when v_jev_right then res.probability end, case when v_jev_right then v_run.model end,
    auth.uid(), case when v_jev_right then 'Accepted Jev proposal' else 'Changed the category Jev proposed' end);
  -- Jev counts as right only when its category was kept.
  update public.classification_results set accepted = v_jev_right, accepted_by = auth.uid(), accepted_at = now()
  where run_id = p_run_id and entry_id = p_entry_id;
  insert into public.audit_log (user_id, action, target, data)
  values (auth.uid(), case when v_jev_right then 'accept proposal' else 'change proposal' end, p_entry_id::text,
          jsonb_build_object('run_id', p_run_id, 'category_id', v_category));
  perform public.check_jev_acceptance();
  return case when v_jev_right then 'accepted' else 'changed' end;
end;
$$;

-- "Accept all above 0.85": never in categories with attention review or not_allowed.
create or replace function public.accept_all_above(p_min numeric default 0.85)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p record;
  v_n integer := 0;
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins decide proposals' using errcode = '42501';
  end if;
  for p in select v.run_id, v.entry_id from public.v_proposals v where v.probability >= greatest(p_min, 0.85) and v.attention_level = 'info' loop
    perform public.decide_proposal(p.run_id, p.entry_id, true);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- One-click revert of a Jev auto-publish: back to the previously published category, or deprecated
-- (clients drop it) when there was none. Counts as a rejection of Jev.
create or replace function public.revert_auto_publish(p_entry_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  e public.entries;
  prev jsonb;
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins revert auto-publishes' using errcode = '42501';
  end if;
  select * into e from public.entries where id = p_entry_id for update;
  if e.method is distinct from 'jev_auto' or e.status <> 'published' then
    raise exception 'Only a published Jev auto-publish can be reverted' using errcode = '22023';
  end if;
  select v.snapshot into prev from public.entry_revisions v
  where v.entry_id = p_entry_id and v.revision < e.revision and v.snapshot ->> 'status' = 'published'
  order by v.revision desc limit 1;

  update public.classification_results set accepted = false, accepted_by = auth.uid(), accepted_at = now()
  where entry_id = p_entry_id and accepted and accepted_by is null;

  if prev is not null then
    perform public.publish_entry(p_entry_id, (prev ->> 'category_id')::uuid, (prev ->> 'method')::public.entry_method,
      (prev ->> 'confidence')::numeric, prev ->> 'model_version', auth.uid(), 'Reverted a Jev auto-publish');
  else
    perform public.publish_entry(p_entry_id, e.category_id, 'manual', null, null, auth.uid(), 'Reverted a Jev auto-publish', 'deprecated');
  end if;
  insert into public.audit_log (user_id, action, target, data)
  values (auth.uid(), 'revert auto-publish', p_entry_id::text, jsonb_build_object('restored', prev is not null));
  perform public.check_jev_acceptance();
  return case when prev is not null then 'restored' else 'deprecated' end;
end;
$$;

create or replace function public.set_engine_mode(p_engine text, p_mode text)
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
  update public.engine_settings set mode = p_mode, updated_at = now(), updated_by = auth.uid() where engine = p_engine;
  insert into public.audit_log (user_id, action, target, data) values (auth.uid(), 'set engine mode', p_engine, jsonb_build_object('mode', p_mode));
end;
$$;

create or replace function public.resume_engine(p_engine text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_hub_admin() then
    raise exception 'Only hub admins resume engines' using errcode = '42501';
  end if;
  update public.engine_settings set paused = false, paused_reason = null, paused_at = null, updated_at = now(), updated_by = auth.uid()
  where engine = p_engine;
  insert into public.audit_log (user_id, action, target, data) values (auth.uid(), 'resume engine', p_engine, null);
end;
$$;

-- Console reads ---------------------------------------------------------------------------------

-- Each entry's latest result, when still undecided (a newer decided result supersedes older ones), for
-- entries that are not deprecated.
create view public.v_proposals
with (security_invoker = true)
as
select * from (
  select distinct on (r.entry_id)
    r.run_id, r.entry_id, r.probability, r.category_id, r.accepted,
    c.slug as category_slug, c.name as category_name, p.name as level1_name, c.attention_level,
    e.kind, e.source, e.canonical_name, e.vendor, e.status as entry_status, e.reports_count,
    e.category_id as current_category_id, run.started_at, run.rerun
  from public.classification_results r
  join public.classification_runs run on run.id = r.run_id
  join public.entries e on e.id = r.entry_id and e.status <> 'deprecated'
  join public.categories c on c.id = r.category_id
  left join public.categories p on p.id = c.parent_id
  order by r.entry_id, run.started_at desc, r.accepted nulls last
) latest
where latest.accepted is null;

create view public.v_runs
with (security_invoker = true)
as
select run.id, run.model, run.started_at, run.finished_at, run.status, run.rerun, run.entry_count, run.started_by,
  (select count(*) from public.classification_results r where r.run_id = run.id) as results,
  (select count(*) from public.classification_results r where r.run_id = run.id and r.accepted and r.accepted_by is null) as auto_published,
  (select count(*) from public.classification_results r where r.run_id = run.id and r.accepted is null) as open_proposals,
  (select coalesce(sum(a.cost_usd), 0) from public.ai_calls a where a.run_id = run.id) as cost_usd,
  (select count(*) from public.ai_calls a where a.run_id = run.id and a.status = 'error') as errors
from public.classification_runs run;

create or replace function public.engine_status(p_engine text)
returns table (
  engine text, mode text, model text, paused boolean, paused_reason text, paused_at timestamptz, last_auto_run_at timestamptz,
  daily_titles integer, titles_today bigint, monthly_budget_usd numeric, spend_month numeric,
  auto_publish_daily integer, auto_published_today bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.engine, s.mode, s.model, s.paused, s.paused_reason, s.paused_at, s.last_auto_run_at,
    s.daily_titles, u.titles_today, s.monthly_budget_usd, u.spend_month, s.auto_publish_daily,
    (select count(*) from public.entry_revisions v where v.created_at >= date_trunc('day', now(), 'UTC') and v.snapshot ->> 'method' = 'jev_auto')
  from public.engine_settings s
  cross join lateral public.engine_usage(s.engine) u
  where s.engine = p_engine and public.is_hub_admin();
$$;

-- Cron: hourly; the function itself waits for interval_hours between automatic runs.
create or replace function public.invoke_jev()
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
  return net.http_post(
    url := v_url,
    body := '{"action": "auto"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 150000
  );
end;
$$;

-- Access ----------------------------------------------------------------------------------------

do $$
declare
  t text;
  f text;
begin
  foreach t in array array['engine_settings', 'ai_prices', 'ai_calls'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('create policy "Hub admins read %s" on public.%I for select to authenticated using ((select public.is_hub_admin()))', t, t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
  revoke all on table public.v_proposals, public.v_runs from anon, authenticated;
  grant select on table public.v_proposals, public.v_runs to authenticated;

  foreach f in array array[
    'engine_usage(text)', 'pause_engine(text, text)', 'jev_gate(integer, boolean)',
    'record_ai_call(text, text, text, uuid, integer, integer, integer, integer, integer, integer, text, integer, text)',
    'publish_entry(uuid, uuid, public.entry_method, numeric, text, uuid, text, public.entry_status)',
    'jev_start_run(uuid[], uuid, boolean, text)', 'jev_finish_run(uuid, public.run_status)',
    'jev_store_result(uuid, uuid, text, numeric)', 'check_jev_acceptance()', 'invoke_jev()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array[
    'decide_proposal(uuid, uuid, boolean, uuid)', 'accept_all_above(numeric)', 'revert_auto_publish(uuid)',
    'set_engine_mode(text, text)', 'resume_engine(text)', 'engine_status(text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end;
$$;

-- pg_net and pg_cron for the automatic run.
create extension if not exists pg_net;
create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'jev-auto';
select cron.schedule('jev-auto', '7 * * * *', 'select public.invoke_jev()');
