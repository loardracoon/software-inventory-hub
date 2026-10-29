import { describe, expect, it } from "vitest";
import { digestSubject, digestText, type Digest } from "./digest.ts";

const base: Digest = { pending_total: 3, open_requests: 1, proposals: 2, new_titles: [{ name: "AnyDesk", kind: "program", reports: 2 }] };

describe("digest", () => {
  it("lists new titles and the Inbox; no KEV section when there is nothing new", () => {
    const text = digestText(base, "https://hub.example");
    expect(text).toContain("- AnyDesk (program, 2 clients)");
    expect(text).not.toContain("Known exploited");
    expect(digestSubject(base)).toBe("Daily digest: 1 new title(s), 1 open request(s)");
  });

  it("adds the CVEs that became known exploited, with products, score and due date", () => {
    const d = { ...base, new_kev: [{ vuln_id: "CVE-2025-0411", cvss_score: 7, kev_due: "2025-02-27", products: ["7-Zip"] }] };
    expect(digestText(d, "https://hub.example")).toContain(
      "Known exploited vulnerabilities (CISA KEV) new on mapped products in the last 24 hours: 1\n- CVE-2025-0411 (CVSS 7.0): 7-Zip; CISA remediation due 2025-02-27",
    );
    expect(digestSubject(d)).toBe("Daily digest: 1 new title(s), 1 open request(s), 1 known exploited CVE(s)");
  });
});
