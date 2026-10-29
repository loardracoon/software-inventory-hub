// The vuln-sync run (phase H7): CVEs of confirmed CPEs (NVD), CPE search for products without a confirmed
// CPE, packages (OSV), KEV when due, then EPSS. Stops before the time limit; the next hourly run
// continues. NVD calls are spaced to its limit (5 per 30 s without a key, 50 with one).
// Runtime-neutral: the database is any client with rpc(), the network any fetch.

import {
  fetchEpss,
  fetchKev,
  fetchNvdCves,
  fetchOsvVulns,
  searchCpes,
  type FetchLike,
  type Vulnerability,
} from "./vuln-sources.ts";

export type RpcClient = {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export type SyncOptions = {
  fetchFn: FetchLike;
  nvdKey: string | null;
  timeLeft: () => number;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  productId?: string; // the Refresh button: one product, full read
};

export type SyncSummary = {
  kev: number | null;
  cpe_searches: number;
  cpes_confirmed: number;
  cpe_candidates: number;
  cpes_read: number;
  osv_packages: number;
  vulns_changed: number;
  epss: number;
  nvd_calls: number;
  osv_calls: number;
  complete: boolean;
  errors: string[];
};

const MIN_TIME_LEFT_MS = 15_000;

async function call<T>(db: RpcClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

// Only vulnerabilities with a range for this product reach the database (a CVE without one cannot be
// matched against installed versions).
const withRanges = (vulns: Vulnerability[]) => vulns.filter((v) => v.ranges.length > 0);

export async function runVulnSync(db: RpcClient, o: SyncOptions): Promise<SyncSummary> {
  const s: SyncSummary = { kev: null, cpe_searches: 0, cpes_confirmed: 0, cpe_candidates: 0, cpes_read: 0, osv_packages: 0, vulns_changed: 0, epss: 0, nvd_calls: 0, osv_calls: 0, complete: true, errors: [] };
  const now = o.now ?? Date.now;
  const gap = o.nvdKey ? 700 : 6500;
  let lastNvd = 0;
  const paceNvd = async () => {
    const wait = lastNvd + gap - now();
    if (wait > 0) await o.sleep(wait);
    lastNvd = now();
  };
  const enough = () => {
    if (o.timeLeft() < MIN_TIME_LEFT_MS) {
      s.complete = false;
      return false;
    }
    return true;
  };
  const nvd = { apiKey: o.nvdKey };

  const searchProduct = async (productId: string, name: string, vendorKey: string) => {
    await paceNvd();
    s.nvd_calls++;
    s.cpe_searches++;
    try {
      const candidates = await searchCpes(o.fetchFn, name, vendorKey, nvd);
      const stored = await call<{ new: number; confirmed: number }>(db, "vuln_store_cpes", { p_product_id: productId, p_candidates: candidates });
      s.cpes_confirmed += candidates.filter((c) => c.exact).length;
      s.cpe_candidates += candidates.filter((c) => !c.exact).length;
      return stored;
    } catch (e) {
      s.errors.push(`CPE search ${name}: ${(e as Error).message}`);
      await call(db, "vuln_store_cpes", { p_product_id: productId, p_candidates: [], p_error: (e as Error).message });
      return null;
    }
  };

  const readCpe = async (cpe: { id: string; product_id: string; cpe_vendor: string; cpe_product: string; synced_at: string | null }) => {
    try {
      const since = cpe.synced_at ? new Date(Date.parse(cpe.synced_at) - 86_400_000) : null;
      await paceNvd();
      const r = await fetchNvdCves(o.fetchFn, cpe.cpe_vendor, cpe.cpe_product, { ...nvd, lastModStart: since, now: new Date(now()), pause: paceNvd });
      s.nvd_calls += r.calls;
      const stored = await call<{ changed: number }>(db, "vuln_store", {
        p_product_id: cpe.product_id,
        p_source: "nvd",
        p_vulns: withRanges(r.vulns),
        p_full: since === null,
        p_cpe_id: cpe.id,
      });
      s.vulns_changed += stored.changed;
      s.cpes_read++;
    } catch (e) {
      s.errors.push(`CVEs of ${cpe.cpe_vendor}:${cpe.cpe_product}: ${(e as Error).message}`);
      await call(db, "vuln_mark_error", { p_cpe_id: cpe.id, p_product_id: null, p_error: (e as Error).message });
    }
  };

  const readPackage = async (pkg: { product_id: string; ecosystem: string; package_name: string }) => {
    try {
      const r = await fetchOsvVulns(o.fetchFn, pkg.ecosystem, pkg.package_name);
      s.osv_calls += r.calls;
      const stored = await call<{ changed: number }>(db, "vuln_store", { p_product_id: pkg.product_id, p_source: "osv", p_vulns: withRanges(r.vulns), p_full: true, p_cpe_id: null });
      s.vulns_changed += stored.changed;
      s.osv_packages++;
    } catch (e) {
      s.errors.push(`OSV ${pkg.ecosystem}/${pkg.package_name}: ${(e as Error).message}`);
      await call(db, "vuln_mark_error", { p_cpe_id: null, p_product_id: pkg.product_id, p_error: (e as Error).message });
    }
  };

  // The Refresh button: one product, everything read again.
  if (o.productId) {
    const p = await call<{ id: string; kind: string; display_name: string; vendor_key: string; package: { ecosystem: string; name: string } | null; cpes: { id: string; cpe_vendor: string; cpe_product: string }[] } | null>(
      db,
      "vuln_product_info",
      { p_product_id: o.productId },
    );
    if (!p) throw new Error("Product not found");
    if (p.kind === "package" && p.package?.ecosystem) {
      await readPackage({ product_id: p.id, ecosystem: p.package.ecosystem, package_name: p.package.name });
      return s;
    }
    let cpes = p.cpes;
    if (cpes.length === 0) {
      await searchProduct(p.id, p.display_name, p.vendor_key);
      cpes = (await call<typeof p | null>(db, "vuln_product_info", { p_product_id: o.productId }))?.cpes ?? [];
    }
    for (const c of cpes) {
      if (!enough()) break;
      await readCpe({ ...c, product_id: p.id, synced_at: null });
    }
    return s;
  }

  // 1. CVEs of confirmed CPEs, then 2. CPE search for products without one.
  for (const cpe of await call<{ id: string; product_id: string; cpe_vendor: string; cpe_product: string; synced_at: string | null }[]>(db, "vuln_cpes_due", { p_limit: 30 })) {
    if (!enough()) break;
    await readCpe(cpe);
  }
  if (enough()) {
    for (const p of await call<{ product_id: string; display_name: string; vendor_key: string }[]>(db, "vuln_products_due", { p_limit: 20 })) {
      if (!enough()) break;
      const stored = await searchProduct(p.product_id, p.display_name, p.vendor_key);
      // A product confirmed just now gets its CVEs in this run when time allows.
      if (stored && stored.confirmed > 0 && enough()) {
        const info = await call<{ cpes: { id: string; cpe_vendor: string; cpe_product: string }[] } | null>(db, "vuln_product_info", { p_product_id: p.product_id });
        for (const c of info?.cpes ?? []) {
          if (!enough()) break;
          await readCpe({ ...c, product_id: p.product_id, synced_at: null });
        }
      }
    }
  }

  // 3. Packages (OSV has no rate limit).
  if (enough()) {
    for (const pkg of await call<{ product_id: string; ecosystem: string; package_name: string }[]>(db, "vuln_packages_due", { p_limit: 50 })) {
      if (!enough()) break;
      await readPackage(pkg);
    }
  }

  // 4. KEV (daily), after the CVEs above so the new ones are flagged in this run.
  if (enough() && (await call<boolean>(db, "vuln_kev_due"))) {
    try {
      const kev = await fetchKev(o.fetchFn);
      s.kev = await call<number>(db, "vuln_set_kev", { p_rows: kev.rows });
    } catch (e) {
      s.errors.push(`KEV: ${(e as Error).message}`);
    }
  }

  // 5. EPSS (100 CVEs per call).
  if (enough()) {
    const due = await call<string[]>(db, "vuln_epss_due", { p_limit: 1000 });
    for (let i = 0; i < due.length && enough(); i += 100) {
      try {
        const rows = await fetchEpss(o.fetchFn, due.slice(i, i + 100));
        await call(db, "vuln_set_epss", { p_rows: rows });
        s.epss += rows.length;
      } catch (e) {
        s.errors.push(`EPSS: ${(e as Error).message}`);
        break;
      }
    }
  }
  return s;
}
