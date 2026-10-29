import { describe, expect, it, vi } from "vitest";
import {
  cpeToken,
  fetchEpss,
  fetchKev,
  fetchNvdCves,
  fetchOsvVulns,
  isExactCpe,
  osvRanges,
  parseCpe,
  parseNvdCve,
  searchCpes,
  SourceError,
  type FetchLike,
} from "./vuln-sources.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fakeFetch = (...bodies: unknown[]) => {
  let i = 0;
  return vi.fn<FetchLike>(async () => json(bodies[Math.min(i++, bodies.length - 1)]));
};

// Shaped like an NVD CVE API 2.0 answer for cpe:2.3:a:7-zip:7-zip (CVE-2025-0411 style).
const NVD_7ZIP = {
  resultsPerPage: 2,
  startIndex: 0,
  totalResults: 2,
  vulnerabilities: [
    {
      cve: {
        id: "CVE-2025-0411",
        published: "2025-01-25T05:15:09.090",
        lastModified: "2025-02-07T14:00:00.000",
        vulnStatus: "Analyzed",
        cisaExploitAdd: "2025-02-06",
        cisaActionDue: "2025-02-27",
        descriptions: [
          { lang: "es", value: "x" },
          { lang: "en", value: "7-Zip Mark-of-the-Web bypass." },
        ],
        metrics: {
          cvssMetricV31: [
            { type: "Secondary", cvssData: { version: "3.1", baseScore: 7.0, baseSeverity: "HIGH", vectorString: "CVSS:3.1/AV:L/AC:H" } },
            { type: "Primary", cvssData: { version: "3.1", baseScore: 7.5, baseSeverity: "HIGH", vectorString: "CVSS:3.1/AV:N" } },
          ],
        },
        weaknesses: [{ description: [{ lang: "en", value: "CWE-693" }, { lang: "en", value: "NVD-CWE-noinfo" }] }],
        configurations: [
          {
            nodes: [
              {
                cpeMatch: [
                  { vulnerable: true, criteria: "cpe:2.3:a:7-zip:7-zip:*:*:*:*:*:*:*:*", versionEndExcluding: "24.09" },
                  { vulnerable: false, criteria: "cpe:2.3:o:microsoft:windows:-:*:*:*:*:*:*:*" },
                  { vulnerable: true, criteria: "cpe:2.3:a:other:thing:*:*:*:*:*:*:*:*", versionEndExcluding: "2" },
                ],
              },
            ],
          },
        ],
        references: [{ url: "https://www.zerodayinitiative.com/advisories/ZDI-25-045/" }, { url: "ftp://bad" }],
      },
    },
    {
      cve: {
        id: "CVE-2016-2334",
        published: "2016-12-13T20:59:00.000",
        vulnStatus: "Modified",
        descriptions: [{ lang: "en", value: "Heap overflow in 7-Zip 9.20 and 15.05." }],
        metrics: { cvssMetricV2: [{ type: "Primary", baseSeverity: "HIGH", cvssData: { version: "2.0", baseScore: 9.3, vectorString: "AV:N/AC:M" } }] },
        configurations: [
          {
            nodes: [
              {
                cpeMatch: [
                  { vulnerable: true, criteria: "cpe:2.3:a:7-zip:7-zip:9.20:*:*:*:*:*:*:*" },
                  { vulnerable: true, criteria: "cpe:2.3:a:7-zip:7-zip:*:*:*:*:*:*:*:*", versionStartIncluding: "15.0", versionEndIncluding: "15.05" },
                ],
              },
            ],
          },
        ],
      },
    },
  ],
};

describe("CPE names", () => {
  it("parse with escapes and compare by tokens", () => {
    expect(parseCpe("cpe:2.3:a:notepad-plus-plus:notepad\\+\\+:8.6:*:*:*:*:*:*:*")).toMatchObject({ vendor: "notepad-plus-plus", product: "notepad\\+\\+", version: "8.6" });
    expect(parseCpe("not a cpe")).toBeNull();
    expect(cpeToken("7-Zip")).toBe("7 zip");
    expect(cpeToken("notepad\\+\\+")).toBe("notepad++");
  });

  it("are exact only when the product matches and the vendor is the vendor or the product", () => {
    expect(isExactCpe("7-zip", "7-zip", "7-Zip", "igor pavlov")).toBe(true);
    expect(isExactCpe("anydesk", "anydesk", "AnyDesk", "anydesk software")).toBe(true);
    expect(isExactCpe("microsoft", "visual_studio_code", "Visual Studio Code", "microsoft")).toBe(true);
    expect(isExactCpe("microsoft", "edge", "Visual Studio Code", "microsoft")).toBe(false);
    expect(isExactCpe("someone", "7-zip", "7-Zip", "igor pavlov")).toBe(false);
  });
});

describe("NVD", () => {
  it("searches the CPE dictionary: applications only, one candidate per vendor and product, API key in the header", async () => {
    const f = fakeFetch({
      products: [
        { cpe: { cpeName: "cpe:2.3:a:7-zip:7-zip:23.01:*:*:*:*:*:*:*", titles: [{ title: "7-Zip 23.01", lang: "en" }] } },
        { cpe: { cpeName: "cpe:2.3:a:7-zip:7-zip:24.09:*:*:*:*:*:*:*" } },
        { cpe: { cpeName: "cpe:2.3:a:7-zip:p7zip:16.02:*:*:*:*:*:*:*" } },
        { cpe: { cpeName: "cpe:2.3:o:7-zip:firmware:1:*:*:*:*:*:*:*" } },
        { cpe: { cpeName: "cpe:2.3:a:old:7-zip:1:*:*:*:*:*:*:*", deprecated: true } },
      ],
    });
    const c = await searchCpes(f, "7-Zip", "igor pavlov", { apiKey: "nvd-key" });
    expect(c).toEqual([
      { cpe_vendor: "7-zip", cpe_product: "7-zip", title: "7-Zip 23.01", exact: true },
      { cpe_vendor: "7-zip", cpe_product: "p7zip", title: "7-zip:p7zip", exact: false },
    ]);
    const [url, init] = f.mock.calls[0];
    expect(url).toContain("keywordSearch=7-Zip+igor");
    expect((init?.headers as Record<string, string>).apiKey).toBe("nvd-key");
  });

  it("parses a CVE: English summary, primary CVSS 3.1, CWE, KEV dates and the ranges of this CPE only", () => {
    const v = parseNvdCve(NVD_7ZIP.vulnerabilities[0].cve, "7-zip", "7-zip")!;
    expect(v).toMatchObject({
      vuln_id: "CVE-2025-0411",
      summary: "7-Zip Mark-of-the-Web bypass.",
      cvss_version: "3.1",
      cvss_score: 7.5,
      severity: "HIGH",
      cwe: ["CWE-693"],
      references: ["https://www.zerodayinitiative.com/advisories/ZDI-25-045/"],
      kev_added: "2025-02-06",
      kev_due: "2025-02-27",
      ranges: [{ version_start: null, start_inclusive: true, version_end: "24.09", end_inclusive: false, exact_version: null }],
    });
  });

  it("falls back to CVSS v2 and reads exact versions and inclusive bounds", () => {
    const v = parseNvdCve(NVD_7ZIP.vulnerabilities[1].cve, "7-zip", "7-zip")!;
    expect(v).toMatchObject({ cvss_version: "2.0", cvss_score: 9.3, severity: "HIGH" });
    expect(v.ranges).toEqual([
      { version_start: null, start_inclusive: true, version_end: null, end_inclusive: true, exact_version: "9.20" },
      { version_start: "15.0", start_inclusive: true, version_end: "15.05", end_inclusive: true, exact_version: null },
    ]);
    expect(parseNvdCve({ id: "CVE-1", vulnStatus: "Rejected" }, "a", "b")).toBeNull();
  });

  it("pages through CVEs and asks for changes only within NVD's 120-day window", async () => {
    const page = (start: number, ids: string[]) => ({ resultsPerPage: ids.length, startIndex: start, totalResults: 3, vulnerabilities: ids.map((id) => ({ cve: { id } })) });
    const f = fakeFetch(page(0, ["CVE-1", "CVE-2"]), page(2, ["CVE-3"]));
    const pause = vi.fn(async () => {});
    const now = new Date("2026-10-28T12:00:00Z");
    const r = await fetchNvdCves(f, "7-zip", "7-zip", { now, lastModStart: new Date("2026-10-01T00:00:00Z"), pause });
    expect(r.vulns.map((v) => v.vuln_id)).toEqual(["CVE-1", "CVE-2", "CVE-3"]);
    expect(r.calls).toBe(2);
    expect(pause).toHaveBeenCalledTimes(1);
    const first = f.mock.calls[0][0];
    expect(first).toContain("virtualMatchString=cpe%3A2.3%3Aa%3A7-zip%3A7-zip");
    expect(first).toContain("lastModStartDate=2026-10-01T00%3A00%3A00.000%2B00%3A00");
    expect(first).toMatch(/&noRejected$/);
    expect(f.mock.calls[1][0]).toContain("startIndex=2");
    const full = fakeFetch(page(0, []));
    await fetchNvdCves(full, "a", "b", { now, lastModStart: new Date("2026-01-01T00:00:00Z") });
    expect(full.mock.calls[0][0]).not.toContain("lastModStartDate");
  });

  it("reports HTTP errors with the status", async () => {
    const f = vi.fn<FetchLike>(async () => new Response("Too many requests", { status: 403 }));
    await expect(searchCpes(f, "x", "y")).rejects.toMatchObject({ status: 403 });
    await expect(searchCpes(f, "x", "y")).rejects.toBeInstanceOf(SourceError);
  });
});

describe("OSV", () => {
  const LODASH = {
    vulns: [
      {
        id: "GHSA-35jh-r3h4-6jhm",
        aliases: ["CVE-2021-23337"],
        summary: "Command Injection in lodash",
        modified: "2024-01-01T00:00:00Z",
        database_specific: { severity: "HIGH", cwe_ids: ["CWE-77", "CWE-94"] },
        severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H" }],
        affected: [
          { package: { ecosystem: "npm", name: "lodash" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] },
          { package: { ecosystem: "npm", name: "lodash-es" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] },
        ],
        references: [{ url: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm" }],
      },
      { id: "GHSA-old", withdrawn: "2024-01-01T00:00:00Z" },
    ],
  };

  it("uses the CVE id when there is one, keeps the OSV id as alias, maps MODERATE to MEDIUM", async () => {
    const f = fakeFetch(LODASH);
    const { vulns, calls } = await fetchOsvVulns(f, "npm", "lodash");
    expect(calls).toBe(1);
    expect(vulns).toHaveLength(1);
    expect(vulns[0]).toMatchObject({
      vuln_id: "CVE-2021-23337",
      aliases: ["GHSA-35jh-r3h4-6jhm"],
      source: "osv",
      severity: "HIGH",
      cvss_version: "3.1",
      cwe: ["CWE-77", "CWE-94"],
      ranges: [{ version_start: null, start_inclusive: true, version_end: "4.17.21", end_inclusive: false, exact_version: null }],
    });
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ package: { ecosystem: "npm", name: "lodash" } });
  });

  it("turns events into ranges: several introduced/fixed pairs, last_affected, open end, explicit versions", () => {
    const v = {
      affected: [
        {
          package: { ecosystem: "PyPI", name: "Django" },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "3.2" }, { fixed: "3.2.5" }, { introduced: "4.0" }, { last_affected: "4.0.2" }, { introduced: "5.0" }] }],
        },
        { package: { ecosystem: "PyPI", name: "django" }, versions: ["1.0", "1.1"] },
      ],
    };
    expect(osvRanges(v, "PyPI", "django")).toEqual([
      { version_start: "3.2", start_inclusive: true, version_end: "3.2.5", end_inclusive: false, exact_version: null },
      { version_start: "4.0", start_inclusive: true, version_end: "4.0.2", end_inclusive: true, exact_version: null },
      { version_start: "5.0", start_inclusive: true, version_end: null, end_inclusive: false, exact_version: null },
      { version_start: null, start_inclusive: true, version_end: null, end_inclusive: false, exact_version: "1.0" },
      { version_start: null, start_inclusive: true, version_end: null, end_inclusive: false, exact_version: "1.1" },
    ]);
  });

  it("follows next_page_token", async () => {
    const f = fakeFetch({ vulns: [{ id: "OSV-1" }], next_page_token: "t1" }, { vulns: [{ id: "OSV-2" }] });
    const { vulns, calls } = await fetchOsvVulns(f, "npm", "x");
    expect(vulns.map((v) => v.vuln_id)).toEqual(["OSV-1", "OSV-2"]);
    expect(calls).toBe(2);
    expect(JSON.parse(String(f.mock.calls[1][1]?.body)).page_token).toBe("t1");
  });
});

describe("KEV and EPSS", () => {
  it("reads the KEV catalog", async () => {
    const f = fakeFetch({
      catalogVersion: "2026.10.28",
      vulnerabilities: [
        { cveID: "CVE-2025-0411", dateAdded: "2025-02-06", dueDate: "2025-02-27", knownRansomwareCampaignUse: "Unknown" },
        { cveID: "bad" },
      ],
    });
    expect(await fetchKev(f)).toEqual({ version: "2026.10.28", rows: [{ cve_id: "CVE-2025-0411", date_added: "2025-02-06", due_date: "2025-02-27", ransomware: "Unknown" }] });
  });

  it("reads EPSS for up to 100 CVEs, numbers from strings", async () => {
    const f = fakeFetch({ data: [{ cve: "CVE-2025-0411", epss: "0.024370000", percentile: "0.84", date: "2026-10-28" }] });
    expect(await fetchEpss(f, ["CVE-2025-0411"])).toEqual([{ cve_id: "CVE-2025-0411", epss: 0.02437, percentile: 0.84, date: "2026-10-28" }]);
    expect(f.mock.calls[0][0]).toContain("cve=CVE-2025-0411");
    expect(await fetchEpss(f, [])).toEqual([]);
    await expect(fetchEpss(f, Array.from({ length: 101 }, (_, i) => `CVE-1-${i}`))).rejects.toThrow(/100/);
  });
});
