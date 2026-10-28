-- Jev on OpenAI as an alternative to Claude. Settings › Jev chooses the provider and the model; the
-- Edge Function reads them from engine_settings and the key from provider_keys (Vault).
-- Prices of gpt-5-mini from https://developers.openai.com/api/docs/pricing (standard tier, read
-- 2026-10-28): input 0.25, cached input 0.025, output 2.00 USD per million tokens. OpenAI has no cache
-- write charge. Reasoning tokens are billed as output.

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
  if p_engine = 'jev' and p_provider not in ('claude', 'openai') then
    raise exception 'Jev runs on Claude or OpenAI' using errcode = '22023';
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

insert into public.ai_prices (engine, provider, model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, per_search_usd, effective_from)
values ('jev', 'openai', 'gpt-5-mini', 0.25, 2.00, 0.025, 0, 0, '2026-10-28');
