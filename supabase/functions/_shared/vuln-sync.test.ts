import { describe, expect, it, vi } from "vitest";
import { runVulnSync, type RpcClient } from "./vuln-sync.ts";
import type { FetchLike } from "./vuln-sources.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const cve = (id: string, end: string | null) => ({
  cve: {
    id,
    descriptions: [{ lang: "en", value: id }],
    configurations: end ? [{ nodes: [{ cpeMatch: [{ vulnerable: true, criteria: "cpe:2.3:a:7-zip:7-zip:*:*:*:*:*:*:*:*", versionEndExcluding: end }] }] }] : [],
  },
});

// Answers by host and path, like the real services.
function fakeNet(overrides: Partial<Record<"kev" | "cpes" | "cves" | "osv" | "epss", unknown>> = {}) {
  return vi.fn<FetchLike>(async (url) => {
    const u = new URL(url);
    if (u.host === "www.cisa.gov") return json(overrides.kev ?? { vulnerabilities: [{ cveID: "CVE-2025-0411", dateAdded: "2025-02-06" }] });
    if (u.pathname.endsWith("/cpes/2.0")) return json(overrides.cpes ?? { products: [{ cpe: { cpeName: "cpe:2.3:a:7-zip:7-zip:24.09:*:*:*:*:*:*:*" } }] });
    if (u.pathname.endsWith("/cves/2.0")) return json(overrides.cves ?? { totalResults: 2, resultsPerPage: 2, vulnerabilities: [cve("CVE-2025-0411", "24.09"), cve("CVE-2000-0001", null)] });
    if (u.host === "api.osv.dev") return json(overrides.osv ?? { vulns: [{ id: "GHSA-1", aliases: ["CVE-2021-23337"], affected: [{ package: { ecosystem: "npm", name: "lodash" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] }] }] });
    if (u.host === "api.first.org") return json(overrides.epss ?? { data: (u.searchParams.get("cve") ?? "").split(",").map((c) => ({ cve: c, epss: "0.1", percentile: "0.9" })) });
    return json({}, 404);
  });
}

function fakeDb(state: { kevDue?: boolean; cpesDue?: unknown[]; productsDue?: unknown[]; packagesDue?: unknown[]; epssDue?: string[]; info?: unknown } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db: RpcClient = {
    async rpc(fn, args = {}) {
      calls.push({ fn, args });
      const data: Record<string, unknown> = {
        vuln_kev_due: state.kevDue ?? true,
        vuln_set_kev: 1,
        vuln_cpes_due: state.cpesDue ?? [],
        vuln_products_due: state.productsDue ?? [],
        vuln_store_cpes: { new: 1, confirmed: 1 },
        vuln_product_info: state.info ?? { id: "p7", kind: "program", display_name: "7-Zip", vendor_key: "igor pavlov", package: null, cpes: [{ id: "c1", cpe_vendor: "7-zip", cpe_product: "7-zip" }] },
        vuln_store: { changed: 1, removed: 0, new_kev: 0 },
        vuln_packages_due: state.packagesDue ?? [],
        vuln_epss_due: state.epssDue ?? [],
        vuln_set_epss: 1,
        vuln_mark_error: null,
      };
      return { data: data[fn] ?? null, error: null };
    },
  };
  return { db, calls };
}

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: vi.fn(async (ms: number) => void (t += ms)) };
};

describe("runVulnSync (cron)", () => {
  it("reads KEV, the CVEs of due CPEs (only those with ranges), searches new products, packages and EPSS", async () => {
    const { db, calls } = fakeDb({
      cpesDue: [{ id: "c1", product_id: "p7", cpe_vendor: "7-zip", cpe_product: "7-zip", synced_at: null }],
      productsDue: [{ product_id: "p9", display_name: "Notepad++", vendor_key: "notepad++ team" }],
      packagesDue: [{ product_id: "pl", ecosystem: "npm", package_name: "lodash" }],
      epssDue: ["CVE-2025-0411"],
    });
    const c = clock();
    const s = await runVulnSync(db, { fetchFn: fakeNet(), nvdKey: null, timeLeft: () => 100_000, ...c });
    expect(calls.map((x) => x.fn)).toEqual([
      "vuln_cpes_due", "vuln_store",
      "vuln_products_due", "vuln_store_cpes", "vuln_product_info", "vuln_store",
      "vuln_packages_due", "vuln_store",
      "vuln_kev_due", "vuln_set_kev",
      "vuln_epss_due", "vuln_set_epss",
    ]);
    const nvdStore = calls[1].args;
    expect(nvdStore).toMatchObject({ p_product_id: "p7", p_source: "nvd", p_full: true, p_cpe_id: "c1" });
    expect((nvdStore.p_vulns as { vuln_id: string }[]).map((v) => v.vuln_id)).toEqual(["CVE-2025-0411"]); // the CVE without a range is left out
    expect(calls[7].args).toMatchObject({ p_source: "osv", p_full: true });
    expect(s).toMatchObject({ kev: 1, cpe_searches: 1, cpes_read: 2, osv_packages: 1, epss: 1, complete: true, errors: [] });
    // Without a key NVD calls are 6.5 s apart.
    expect(c.sleep.mock.calls.every(([ms]) => ms <= 6500)).toBe(true);
    expect(c.sleep).toHaveBeenCalled();
  });

  it("reads only changes since the last read (one day of overlap), as an incremental update", async () => {
    const { db, calls } = fakeDb({ kevDue: false, cpesDue: [{ id: "c1", product_id: "p7", cpe_vendor: "7-zip", cpe_product: "7-zip", synced_at: "2026-10-27T12:00:00Z" }] });
    const net = fakeNet();
    await runVulnSync(db, { fetchFn: net, nvdKey: "k", timeLeft: () => 100_000, ...clock(), now: () => Date.parse("2026-10-28T12:00:00Z") });
    const url = net.mock.calls.map((x) => x[0]).find((u) => u.includes("/cves/2.0"))!;
    expect(url).toContain("lastModStartDate=2026-10-26T12");
    expect(calls.find((x) => x.fn === "vuln_store")!.args.p_full).toBe(false);
  });

  it("marks a failing source and continues", async () => {
    const { db, calls } = fakeDb({ kevDue: false, cpesDue: [{ id: "c1", product_id: "p7", cpe_vendor: "7-zip", cpe_product: "7-zip", synced_at: null }] });
    const net = vi.fn<FetchLike>(async () => new Response("forbidden", { status: 403 }));
    const s = await runVulnSync(db, { fetchFn: net, nvdKey: null, timeLeft: () => 100_000, ...clock() });
    expect(calls.find((x) => x.fn === "vuln_mark_error")!.args).toMatchObject({ p_cpe_id: "c1" });
    expect(s.errors[0]).toMatch(/CVEs of 7-zip:7-zip: HTTP 403/);
  });

  it("stops before the time limit and says so", async () => {
    const { db, calls } = fakeDb({ kevDue: false, cpesDue: [{ id: "c1", product_id: "p7", cpe_vendor: "a", cpe_product: "b", synced_at: null }] });
    const s = await runVulnSync(db, { fetchFn: fakeNet(), nvdKey: null, timeLeft: () => 5_000, ...clock() });
    expect(s.complete).toBe(false);
    expect(calls.some((x) => x.fn === "vuln_store")).toBe(false);
  });
});

describe("runVulnSync (Refresh one product)", () => {
  it("reads every confirmed CPE in full", async () => {
    const { db, calls } = fakeDb();
    const s = await runVulnSync(db, { fetchFn: fakeNet(), nvdKey: "k", timeLeft: () => 100_000, ...clock(), productId: "p7" });
    expect(calls.map((x) => x.fn)).toEqual(["vuln_product_info", "vuln_store"]);
    expect(calls[1].args).toMatchObject({ p_full: true, p_cpe_id: "c1" });
    expect(s.cpes_read).toBe(1);
  });

  it("searches the CPE dictionary first when the product has no confirmed CPE", async () => {
    let first = true;
    const { db, calls } = fakeDb();
    const info = { id: "p7", kind: "program", display_name: "7-Zip", vendor_key: "igor pavlov", package: null, cpes: [] as unknown[] };
    const wrapped: RpcClient = {
      async rpc(fn, args) {
        if (fn === "vuln_product_info") {
          calls.push({ fn, args: args ?? {} });
          const data = first ? info : { ...info, cpes: [{ id: "c1", cpe_vendor: "7-zip", cpe_product: "7-zip" }] };
          first = false;
          return { data, error: null };
        }
        return db.rpc(fn, args);
      },
    };
    await runVulnSync(wrapped, { fetchFn: fakeNet(), nvdKey: "k", timeLeft: () => 100_000, ...clock(), productId: "p7" });
    expect(calls.map((x) => x.fn)).toEqual(["vuln_product_info", "vuln_store_cpes", "vuln_product_info", "vuln_store"]);
  });

  it("reads OSV for a package product", async () => {
    const { db, calls } = fakeDb({ info: { id: "pl", kind: "package", display_name: "lodash", vendor_key: "", package: { ecosystem: "npm", name: "lodash" }, cpes: [] } });
    const s = await runVulnSync(db, { fetchFn: fakeNet(), nvdKey: null, timeLeft: () => 100_000, ...clock(), productId: "pl" });
    expect(calls.find((x) => x.fn === "vuln_store")!.args).toMatchObject({ p_source: "osv", p_product_id: "pl" });
    expect(s.osv_packages).toBe(1);
  });
});
