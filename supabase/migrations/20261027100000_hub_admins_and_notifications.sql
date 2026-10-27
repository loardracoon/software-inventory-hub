-- Phase H0: who may use the console (hub_admins) and the inbox notifications behind the top-bar bell.
-- The rest of the schema is Phase H1. Sign-ups are off (supabase/config.toml); accounts and admin rows
-- are created by `npm run admin:add -- <email>`. Anonymous users get nothing: no grants, no policies.

create table public.hub_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);

create or replace function public.is_hub_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.hub_admins where user_id = auth.uid());
$$;

alter table public.hub_admins enable row level security;

create policy "Hub admins read the admin list"
  on public.hub_admins for select
  to authenticated
  using ((select public.is_hub_admin()));

-- One shared inbox for all hub admins: read_at is set by whoever handles the item.
create table public.notifications (
  id bigint generated always as identity primary key,
  type text not null check (type in ('reclassification_request', 'new_title', 'jev_proposal', 'research', 'budget', 'system')),
  ref_id text,
  title text not null check (char_length(title) <= 300),
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_unread_idx on public.notifications (created_at desc) where read_at is null;

alter table public.notifications enable row level security;

create policy "Hub admins read notifications"
  on public.notifications for select
  to authenticated
  using ((select public.is_hub_admin()));

create policy "Hub admins mark notifications read"
  on public.notifications for update
  to authenticated
  using ((select public.is_hub_admin()))
  with check ((select public.is_hub_admin()));

revoke all on table public.hub_admins, public.notifications from anon, authenticated;
grant select on table public.hub_admins, public.notifications to authenticated;
grant update (read_at) on table public.notifications to authenticated;

revoke all on function public.is_hub_admin() from public, anon;
grant execute on function public.is_hub_admin() to authenticated;
