-- vuln-sync now leaves out CPE matches for mobile platforms (target_sw android, iphone_os, ...), such as
-- OneDrive for Android. A full read removes the ranges stored before, so every confirmed CPE is read
-- again in full by the next runs (synced_at null = full read; vuln_cpes_due takes them first).
update public.product_cpes set synced_at = null where status = 'confirmed';
