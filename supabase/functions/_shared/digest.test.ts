import { describe, expect, it } from "vitest";
import { digestSubject, digestText, isDigestWeek, type Digest } from "./digest.ts";

const base: Digest = { pending_total: 3, open_requests: 1, proposals: 2, new_titles: [{ name: "AnyDesk", kind: "program", reports: 2 }] };
const kev = [{ vuln_id: "CVE-2025-0411", cvss_score: 7, kev_due: "2025-02-27", products: ["7-Zip"] }];
const weekly: Digest = {
  ...base,
  weekly: true,
  new_requests: 1,
  cpe_candidates: 4,
  access: {
    open: 1,
    unconfirmed: 2,
    approved: 3,
    auto_approved: 5,
    rejected: 1,
    waiting: [{ name: "ACME IT", organization: "ACME", email: "it@acme.example", since: "2026-11-03T10:00:00Z" }],
  },
};

describe("digest", () => {
  it("weekly: new titles, access requests, reclassification requests and the Inbox", () => {
    const text = digestText(weekly, "https://hub.example");
    expect(text).toContain("New titles this week: 1\n- AnyDesk (program, 2 clients)");
    expect(text).toContain("Access requests waiting for a decision: 1 (2 not confirmed by email yet)\n- ACME IT, ACME <it@acme.example>");
    expect(text).toContain("This week: 3 approved, 5 approved automatically, 1 rejected.");
    expect(text).toContain("Reclassification requests: 1 open (1 new this week).");
    expect(text).toContain("Waiting in the Inbox: 3 pending titles, 2 Jev proposals, 4 CPE matches to confirm.");
    expect(text).not.toContain("Known exploited");
    expect(digestSubject(weekly)).toBe("Weekly digest: 1 new title, 1 access request and 1 reclassification request waiting");
  });

  it("weekly with new known exploited CVEs adds them", () => {
    const d = { ...weekly, new_kev: kev };
    expect(digestText(d, "https://hub.example")).toContain(
      "Known exploited vulnerabilities (CISA KEV) new on mapped products in the last 24 hours: 1\n- CVE-2025-0411 (CVSS 7.0): 7-Zip; CISA remediation due 2025-02-27",
    );
    expect(digestSubject(d)).toBe("Weekly digest: 1 new title, 1 access request and 1 reclassification request waiting, 1 known exploited CVE");
  });

  it("daily: only the known exploited CVEs", () => {
    const d = { ...base, new_kev: kev };
    const text = digestText(d, "https://hub.example");
    expect(text).toContain("- CVE-2025-0411 (CVSS 7.0): 7-Zip");
    expect(text).not.toContain("New titles");
    expect(digestSubject(d)).toBe("Known exploited vulnerabilities: 1 new CVE on mapped products");
  });

  it("the weekly digest goes on Mondays in São Paulo", () => {
    expect(isDigestWeek(new Date("2026-11-09T11:00:00Z"))).toBe(true); // Monday 08:00 local
    expect(isDigestWeek(new Date("2026-11-10T02:30:00Z"))).toBe(true); // still Monday 23:30 local
    expect(isDigestWeek(new Date("2026-11-10T11:00:00Z"))).toBe(false); // Tuesday
  });
});
