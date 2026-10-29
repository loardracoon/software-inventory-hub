-- vuln-sync now computes the CVSS v3 base score of OSV advisories (OSV gives only the vector). NVD's score still
-- wins: an OSV read writes the score only for a CVE that OSV stored first or that has no score yet.
do $$
declare
  v_def text;
  v_may text := '(excluded.cvss_score is not null and (p_source = ''nvd'' or t.source = ''osv'' or t.cvss_score is null))';
  v_parts text[][] := array[
    array['cvss_version = case when excluded.cvss_score is not null or t.cvss_score is null',
          'cvss_version = case when ' || v_may || ' or t.cvss_score is null'],
    array['cvss_score = coalesce(excluded.cvss_score, t.cvss_score),',
          'cvss_score = case when ' || v_may || ' then excluded.cvss_score else t.cvss_score end,'],
    array['severity = coalesce(case when excluded.cvss_score is not null or t.severity is null then excluded.severity end, t.severity),',
          'severity = coalesce(case when ' || v_may || ' or t.severity is null then excluded.severity end, t.severity),'],
    array['cvss_vector = case when excluded.cvss_score is not null or t.cvss_vector is null',
          'cvss_vector = case when ' || v_may || ' or t.cvss_vector is null']
  ];
  i integer;
begin
  select pg_get_functiondef('public.vuln_store'::regproc) into v_def;
  for i in 1 .. array_length(v_parts, 1) loop
    if (length(v_def) - length(replace(v_def, v_parts[i][1], ''))) / length(v_parts[i][1]) <> 1 then
      raise exception 'vuln_store has changed (part %): update this migration', i;
    end if;
    v_def := replace(v_def, v_parts[i][1], v_parts[i][2]);
  end loop;
  execute v_def;
end;
$$;

-- OSV packages are read again in full at the next run, so stored advisories get their score.
update public.product_vuln_state set osv_synced_at = null where osv_synced_at is not null;
