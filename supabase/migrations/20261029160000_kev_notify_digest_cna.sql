-- H7 completion: a CVE that becomes known exploited (CISA KEV) on a mapped product notifies the Inbox and
-- goes into the daily digest; vuln-sync now also reads the CNA record of CVEs NVD names no version for.

-- 1. When a CVE became known exploited here (insert with KEV, or KEV added later). Older ones keep the
--    catalog date, so the first digest does not list the whole catalog.
alter table public.vulnerabilities add column kev_flagged_at timestamptz;
update public.vulnerabilities set kev_flagged_at = kev_added::timestamptz where kev_added is not null;

create or replace function public.vulnerabilities_kev_flag()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kev_added is not null and (tg_op = 'INSERT' or old.kev_added is null) then
    new.kev_flagged_at := now();
  end if;
  return new;
end;
$$;

create trigger vulnerabilities_kev_flag
  before insert or update of kev_added on public.vulnerabilities
  for each row execute function public.vulnerabilities_kev_flag();

-- 2. A CVE the KEV catalog adds later (vuln_set_kev, or NVD's own KEV fields): one Inbox notification per
--    product that has it. A new CVE that arrives with KEV is notified by vuln_store (its ranges come after).
create or replace function public.vulnerabilities_kev_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.notifications (type, ref_id, title)
  select 'system', p.id::text,
    left(format('Known exploited vulnerability for %s: %s (CISA KEV since %s)', p.display_name, new.vuln_id, new.kev_added), 300)
  from public.products p
  where exists (select 1 from public.vulnerability_ranges r where r.product_id = p.id and r.vuln_id = new.vuln_id);
  return null;
end;
$$;

create trigger vulnerabilities_kev_notify
  after update of kev_added on public.vulnerabilities
  for each row when (old.kev_added is null and new.kev_added is not null)
  execute function public.vulnerabilities_kev_notify();

revoke all on function public.vulnerabilities_kev_flag(), public.vulnerabilities_kev_notify() from public, anon, authenticated;

-- 3. Daily digest: CVEs that became known exploited in the last 24 hours on mapped products.
create or replace function public.build_digest()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'pending_total', (select count(*) from public.entries where status = 'pending'),
    'open_requests', (select count(*) from public.reclassification_requests where status = 'open'),
    'proposals', (select count(*) from public.v_proposals),
    'new_titles', coalesce((
      select jsonb_agg(jsonb_build_object('name', canonical_name, 'kind', kind, 'reports', reports_count) order by reports_count desc, canonical_name)
      from (select * from public.entries where status = 'pending' and first_reported_at > now() - interval '24 hours' order by reports_count desc limit 50) n), '[]'),
    'new_kev', coalesce((
      select jsonb_agg(jsonb_build_object('vuln_id', k.vuln_id, 'cvss_score', k.cvss_score, 'kev_due', k.kev_due, 'products', k.products)
        order by k.cvss_score desc nulls last, k.vuln_id)
      from (
        select v.vuln_id, v.cvss_score, v.kev_due,
          (select jsonb_agg(distinct p.display_name) from public.vulnerability_ranges r join public.products p on p.id = r.product_id where r.vuln_id = v.vuln_id) as products
        from public.vulnerabilities v
        where v.kev_flagged_at > now() - interval '24 hours'
          and exists (select 1 from public.vulnerability_ranges r where r.vuln_id = v.vuln_id)
        limit 50
      ) k), '[]'));
$$;

-- 4. Read every confirmed CPE again in full, so the CNA data applies to the CVEs stored before.
update public.product_cpes set synced_at = null where status = 'confirmed';
