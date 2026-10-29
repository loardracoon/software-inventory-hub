// Daily digest text (supabase/functions/digest): new pending titles, CVEs that became known exploited on
// mapped products (phase H7), and what waits in the Inbox. Runtime-neutral, so Vitest tests it.

export type Digest = {
  pending_total: number;
  open_requests: number;
  proposals: number;
  new_titles: { name: string; kind: string; reports: number }[];
  new_kev?: { vuln_id: string; cvss_score: number | null; kev_due: string | null; products: string[] | null }[];
};

export function digestSubject(d: Digest): string {
  const kev = d.new_kev?.length ?? 0;
  return `Daily digest: ${d.new_titles.length} new title(s), ${d.open_requests} open request(s)${kev ? `, ${kev} known exploited CVE(s)` : ""}`;
}

export function digestText(d: Digest, consoleUrl: string): string {
  const lines = d.new_titles.map((t) => `- ${t.name} (${t.kind}, ${t.reports} client${t.reports === 1 ? "" : "s"})`);
  const kev = d.new_kev ?? [];
  const kevLines = kev.map(
    (k) =>
      `- ${k.vuln_id}${k.cvss_score != null ? ` (CVSS ${Number(k.cvss_score).toFixed(1)})` : ""}: ${(k.products ?? []).join(", ") || "no product"}` +
      (k.kev_due ? `; CISA remediation due ${k.kev_due}` : ""),
  );
  return [
    `New titles in the last 24 hours: ${d.new_titles.length}`,
    ...lines,
    "",
    ...(kev.length ? [`Known exploited vulnerabilities (CISA KEV) new on mapped products in the last 24 hours: ${kev.length}`, ...kevLines, ""] : []),
    `Waiting in the Inbox: ${d.pending_total} pending titles, ${d.proposals} Jev proposals, ${d.open_requests} open reclassification requests.`,
    `Open the console: ${consoleUrl}`,
  ].join("\n");
}
