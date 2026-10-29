-- The calls-per-minute limit of a client key comes from the deployment (RL_HUB_CLIENT_REQUESTS_PER_MINUTE in
-- rate-limits.env, read by the Edge Functions) instead of a fixed 60. 60 stays the default for callers that do
-- not pass it (function images from before this change).
drop function public.client_call(text);

-- Authenticates one API call. status: 200 ok, 401 unknown or revoked key, 429 over p_limit calls in this minute
-- (retry_after seconds until the next minute). Counts the call and updates last_seen_at.
create function public.client_call(p_key_hash text, p_limit integer default 60)
returns table (client_id uuid, client_name text, status integer, retry_after integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  c public.clients;
  v_calls integer;
  v_minute timestamptz := date_trunc('minute', now());
begin
  select * into c from public.clients where key_hash = lower(p_key_hash);
  if c.id is null or c.status <> 'active' then
    return query select null::uuid, null::text, 401, null::integer;
    return;
  end if;
  insert into public.client_rate as r (client_id, minute, calls) values (c.id, v_minute, 1)
  on conflict (client_id, minute) do update set calls = r.calls + 1
  returning r.calls into v_calls;
  update public.clients set last_seen_at = now() where id = c.id;
  delete from public.client_rate where minute < now() - interval '10 minutes';
  if v_calls > greatest(coalesce(p_limit, 60), 1) then
    return query select c.id, c.name, 429, greatest(1, ceil(extract(epoch from (v_minute + interval '1 minute' - now())))::integer);
    return;
  end if;
  return query select c.id, c.name, 200, null::integer;
end;
$$;

revoke all on function public.client_call(text, integer) from public, anon, authenticated;
grant execute on function public.client_call(text, integer) to service_role;
