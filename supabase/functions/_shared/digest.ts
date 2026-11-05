// Digest text (supabase/functions/digest). Weekly (Mondays): a summary of what waits for the admins: new titles of
// the week, access requests of installations (phase H8), reclassification requests, Jev proposals and CPE matches.
// Every day: the CVEs that became known exploited on mapped products (phase H7), so they are not a week late.
// Runtime-neutral, so Vitest tests it.

export type Digest = {
  weekly?: boolean;
  pending_total: number;
  open_requests: number;
  new_requests?: number;
  proposals: number;
  cpe_candidates?: number;
  new_titles: { name: string; kind: string; reports: number }[];
  access?: {
    open: number;
    unconfirmed: number;
    approved: number;
    auto_approved: number;
    rejected: number;
    waiting: { name: string; organization: string | null; email: string; since: string | null }[];
  };
  new_kev?: { vuln_id: string; cvss_score: number | null; kev_due: string | null; products: string[] | null }[];
};

const s = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The weekly digest goes out on Mondays (America/Sao_Paulo, where the daily job runs at 08:00).
export function isDigestWeek(now: Date): boolean {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "America/Sao_Paulo" }).format(now) === "Mon";
}

export function digestSubject(d: Digest): string {
  const kev = d.new_kev?.length ?? 0;
  if (!d.weekly) return `Known exploited vulnerabilities: ${s(kev, "new CVE")} on mapped products`;
  const access = d.access?.open ?? 0;
  return `Weekly digest: ${s(d.new_titles.length, "new title")}, ${s(access, "access request")} and ${s(d.open_requests, "reclassification request")} waiting` +
    (kev ? `, ${s(kev, "known exploited CVE")}` : "");
}

function kevLines(d: Digest): string[] {
  const kev = d.new_kev ?? [];
  if (!kev.length) return [];
  return [
    `Known exploited vulnerabilities (CISA KEV) new on mapped products in the last 24 hours: ${kev.length}`,
    ...kev.map(
      (k) =>
        `- ${k.vuln_id}${k.cvss_score != null ? ` (CVSS ${Number(k.cvss_score).toFixed(1)})` : ""}: ${(k.products ?? []).join(", ") || "no product"}` +
        (k.kev_due ? `; CISA remediation due ${k.kev_due}` : ""),
    ),
    "",
  ];
}

export function digestText(d: Digest, consoleUrl: string): string {
  if (!d.weekly) return [...kevLines(d), `Open the console: ${consoleUrl}`].join("\n");
  const a = d.access;
  return [
    `New titles this week: ${d.new_titles.length}`,
    ...d.new_titles.map((t) => `- ${t.name} (${t.kind}, ${s(t.reports, "client")})`),
    "",
    ...(a
      ? [
          `Access requests waiting for a decision: ${a.open} (${a.unconfirmed} not confirmed by email yet)`,
          ...a.waiting.map((w) => `- ${w.name}${w.organization ? `, ${w.organization}` : ""} <${w.email}>`),
          `This week: ${a.approved} approved, ${a.auto_approved} approved automatically, ${a.rejected} rejected.`,
          "",
        ]
      : []),
    `Reclassification requests: ${d.open_requests} open${d.new_requests != null ? ` (${d.new_requests} new this week)` : ""}.`,
    ...kevLines(d),
    `Waiting in the Inbox: ${d.pending_total} pending titles, ${d.proposals} Jev proposals${d.cpe_candidates != null ? `, ${d.cpe_candidates} CPE matches to confirm` : ""}.`,
    `Open the console: ${consoleUrl}`,
  ].join("\n");
}
