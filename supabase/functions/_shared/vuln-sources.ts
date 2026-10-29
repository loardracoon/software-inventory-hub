// Open vulnerability sources (phase H7): NVD (CPE dictionary and CVEs by CPE), OSV.dev (packages), CISA KEV
// and FIRST EPSS. Runtime-neutral: fetch is injected, so Vitest drives the parsers with recorded answers.
// Everything here is public data; the only secret is the optional NVD API key (header apiKey).

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const NVD_CVES = "https://services.nvd.nist.gov/rest/json/cves/2.0";
export const NVD_CPES = "https://services.nvd.nist.gov/rest/json/cpes/2.0";
export const OSV_QUERY = "https://api.osv.dev/v1/query";
export const KEV_FEED = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
export const EPSS_API = "https://api.first.org/data/v1/epss";

// Package sources OSV covers without the operating system release (deb/rpm need it; Chocolatey and
// Homebrew are not OSV ecosystems).
export const OSV_ECOSYSTEM: Record<string, string> = { npm: "npm", pip: "PyPI" };

export type Range = {
  version_start: string | null;
  start_inclusive: boolean;
  version_end: string | null;
  end_inclusive: boolean;
  exact_version: string | null;
};

export type Vulnerability = {
  vuln_id: string; // CVE id, or the OSV id when there is no CVE
  aliases: string[];
  source: "nvd" | "osv";
  published: string | null;
  modified: string | null;
  summary: string | null;
  cvss_version: string | null;
  cvss_score: number | null;
  severity: string | null; // CRITICAL, HIGH, MEDIUM, LOW, NONE
  cvss_vector: string | null;
  cwe: string[];
  references: string[];
  kev_added: string | null;
  kev_due: string | null;
  ranges: Range[];
};

export type CpeCandidate = { cpe_vendor: string; cpe_product: string; title: string; exact: boolean };

export class SourceError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "SourceError";
  }
}

async function getJson(fetchFn: FetchLike, url: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new SourceError(`HTTP ${res.status} from ${new URL(url).host}: ${text.replace(/\s+/g, " ").slice(0, 200)}`, res.status);
    return JSON.parse(text);
  } catch (e) {
    if (e instanceof SourceError) throw e;
    throw new SourceError((e as Error).name === "AbortError" ? `No answer from ${new URL(url).host}` : (e as Error).message, null);
  } finally {
    clearTimeout(timer);
  }
}

// Clients inventory computers (Windows, macOS, Linux): a CPE match only for a mobile platform, such as
// OneDrive for Android, does not apply to them.
export const MOBILE_TARGETS = new Set(["android", "iphone_os", "ios", "ipados", "windows_phone", "windows_mobile", "blackberry"]);

// cpe:2.3:part:vendor:product:version:update:edition:language:sw_edition:target_sw:... (escaped
// characters keep their backslash).
export function parseCpe(cpe: string): { part: string; vendor: string; product: string; version: string; targetSw: string } | null {
  const parts = cpe.split(/(?<!\\):/);
  if (parts.length < 6 || parts[0] !== "cpe" || parts[1] !== "2.3") return null;
  return { part: parts[2], vendor: parts[3], product: parts[4], version: parts[5], targetSw: parts[10] ?? "*" };
}

// Lower case, CPE escapes removed, every separator the same: "7-Zip" and "7_zip" compare equal.
export function cpeToken(value: string): string {
  return value
    .replace(/\\(.)/g, "$1")
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, " ")
    .trim();
}

// Exact when the CPE product is the product name and the CPE vendor is the vendor key or the product itself
// (NVD often names the vendor after the product: cpe:2.3:a:7-zip:7-zip).
export function isExactCpe(cpeVendor: string, cpeProduct: string, productName: string, vendorKey: string): boolean {
  const product = cpeToken(cpeProduct);
  const vendor = cpeToken(cpeVendor);
  if (!product || product !== cpeToken(productName)) return false;
  return vendor === product || (vendorKey !== "" && (vendor === cpeToken(vendorKey) || vendor === cpeToken(vendorKey).split(" ")[0]));
}

export type NvdOptions = { apiKey?: string | null; timeoutMs?: number };
const nvdHeaders = (o: NvdOptions): Record<string, string> => (o.apiKey ? { apiKey: o.apiKey } : {});

// CPE dictionary search for a product: one candidate per (vendor, product), applications only.
export async function searchCpes(fetchFn: FetchLike, productName: string, vendorKey: string, o: NvdOptions = {}): Promise<CpeCandidate[]> {
  const keywords = [productName, vendorKey.split(" ")[0]].filter(Boolean).join(" ").slice(0, 100);
  const url = `${NVD_CPES}?${new URLSearchParams({ keywordSearch: keywords, resultsPerPage: "200" })}`;
  const body = (await getJson(fetchFn, url, { headers: nvdHeaders(o) }, o.timeoutMs)) as {
    products?: { cpe?: { cpeName?: string; deprecated?: boolean; titles?: { title?: string; lang?: string }[] } }[];
  };
  const seen = new Map<string, CpeCandidate>();
  for (const p of body.products ?? []) {
    const cpe = p.cpe;
    const parsed = cpe?.cpeName ? parseCpe(cpe.cpeName) : null;
    if (!parsed || parsed.part !== "a" || cpe?.deprecated) continue;
    const key = `${parsed.vendor}:${parsed.product}`;
    if (seen.has(key)) continue;
    const title = cpe?.titles?.find((t) => t.lang === "en")?.title ?? key;
    seen.set(key, { cpe_vendor: parsed.vendor, cpe_product: parsed.product, title: title.slice(0, 300), exact: isExactCpe(parsed.vendor, parsed.product, productName, vendorKey) });
  }
  return [...seen.values()];
}

type NvdCve = {
  id?: string;
  published?: string;
  lastModified?: string;
  vulnStatus?: string;
  cisaExploitAdd?: string;
  cisaActionDue?: string;
  descriptions?: { lang?: string; value?: string }[];
  metrics?: Record<string, { type?: string; cvssData?: { version?: string; baseScore?: number; baseSeverity?: string; vectorString?: string } ; baseSeverity?: string }[]>;
  weaknesses?: { description?: { lang?: string; value?: string }[] }[];
  configurations?: { nodes?: { cpeMatch?: CpeMatch[] }[] }[];
  references?: { url?: string }[];
};
type CpeMatch = {
  vulnerable?: boolean;
  criteria?: string;
  versionStartIncluding?: string;
  versionStartExcluding?: string;
  versionEndIncluding?: string;
  versionEndExcluding?: string;
};

// Ranges of the configurations that name this CPE (vendor:product) as vulnerable.
export function nvdRanges(cve: NvdCve, cpeVendor: string, cpeProduct: string): Range[] {
  const out: Range[] = [];
  for (const conf of cve.configurations ?? []) {
    for (const node of conf.nodes ?? []) {
      for (const m of node.cpeMatch ?? []) {
        const c = m.criteria ? parseCpe(m.criteria) : null;
        if (!m.vulnerable || !c || c.vendor !== cpeVendor || c.product !== cpeProduct || MOBILE_TARGETS.has(c.targetSw)) continue;
        const exact = c.version !== "*" && c.version !== "-" ? c.version.replace(/\\(.)/g, "$1") : null;
        out.push({
          version_start: m.versionStartIncluding ?? m.versionStartExcluding ?? null,
          start_inclusive: m.versionStartExcluding === undefined,
          version_end: m.versionEndIncluding ?? m.versionEndExcluding ?? null,
          end_inclusive: m.versionEndExcluding === undefined,
          exact_version: exact,
        });
      }
    }
  }
  return out;
}

// CVSS: v3.1, then v4.0, v3.0, v2 (Primary first).
function nvdCvss(cve: NvdCve): Pick<Vulnerability, "cvss_version" | "cvss_score" | "severity" | "cvss_vector"> {
  for (const key of ["cvssMetricV31", "cvssMetricV40", "cvssMetricV30", "cvssMetricV2"]) {
    const list = cve.metrics?.[key] ?? [];
    const m = list.find((x) => x.type === "Primary") ?? list[0];
    if (m?.cvssData?.baseScore !== undefined) {
      return {
        cvss_version: m.cvssData.version ?? null,
        cvss_score: m.cvssData.baseScore,
        severity: (m.cvssData.baseSeverity ?? m.baseSeverity ?? null)?.toUpperCase() ?? null,
        cvss_vector: m.cvssData.vectorString ?? null,
      };
    }
  }
  return { cvss_version: null, cvss_score: null, severity: null, cvss_vector: null };
}

export function parseNvdCve(cve: NvdCve, cpeVendor: string, cpeProduct: string): Vulnerability | null {
  if (!cve.id || cve.vulnStatus === "Rejected") return null;
  return {
    vuln_id: cve.id,
    aliases: [],
    source: "nvd",
    published: cve.published ?? null,
    modified: cve.lastModified ?? null,
    summary: cve.descriptions?.find((d) => d.lang === "en")?.value?.slice(0, 2000) ?? null,
    ...nvdCvss(cve),
    cwe: [...new Set((cve.weaknesses ?? []).flatMap((w) => (w.description ?? []).map((d) => d.value ?? "")).filter((v) => /^CWE-\d+$/.test(v)))],
    references: (cve.references ?? []).map((r) => r.url ?? "").filter((u) => /^https?:\/\//.test(u)).slice(0, 10),
    kev_added: cve.cisaExploitAdd ?? null,
    kev_due: cve.cisaActionDue ?? null,
    ranges: nvdRanges(cve, cpeVendor, cpeProduct),
  };
}

// CVEs of one CPE (vendor:product), all pages. With lastModStart, only CVEs modified since then (NVD
// accepts at most 120 days per window, so older starts fetch everything).
export async function fetchNvdCves(
  fetchFn: FetchLike,
  cpeVendor: string,
  cpeProduct: string,
  o: NvdOptions & { lastModStart?: Date | null; now?: Date; pause?: () => Promise<void> } = {},
): Promise<{ vulns: Vulnerability[]; calls: number }> {
  const vulns: Vulnerability[] = [];
  const now = o.now ?? new Date();
  const params: Record<string, string> = { virtualMatchString: `cpe:2.3:a:${cpeVendor}:${cpeProduct}`, resultsPerPage: "2000" };
  // NVD dates carry an explicit offset (2021-08-04T13:00:00.000+00:00).
  const nvdDate = (d: Date) => d.toISOString().replace("Z", "+00:00");
  if (o.lastModStart && now.getTime() - o.lastModStart.getTime() < 119 * 86_400_000) {
    params.lastModStartDate = nvdDate(o.lastModStart);
    params.lastModEndDate = nvdDate(now);
  }
  let start = 0;
  let calls = 0;
  for (;;) {
    if (calls > 0) await o.pause?.();
    // noRejected is a flag without a value.
    const url = `${NVD_CVES}?${new URLSearchParams({ ...params, startIndex: String(start) })}&noRejected`;
    const body = (await getJson(fetchFn, url, { headers: nvdHeaders(o) }, o.timeoutMs)) as { totalResults?: number; resultsPerPage?: number; vulnerabilities?: { cve?: NvdCve }[] };
    calls++;
    for (const v of body.vulnerabilities ?? []) {
      const parsed = v.cve ? parseNvdCve(v.cve, cpeVendor, cpeProduct) : null;
      if (parsed) vulns.push(parsed);
    }
    start += body.resultsPerPage ?? (body.vulnerabilities ?? []).length;
    if (!body.vulnerabilities?.length || start >= (body.totalResults ?? 0)) break;
  }
  return { vulns, calls };
}

// CNA data (CVE JSON 5, CVE Services API, no key). NVD writes no version ("-") for many CVEs; the CNA
// record of the same CVE sometimes has real version ranges, or shows that only a mobile app is affected.
export const CVE_RECORD = "https://cveawg.mitre.org/api/cve";

export type CnaAffected = {
  vendor?: string;
  product?: string;
  platforms?: string[];
  cpes?: string[];
  versions?: { version?: string; lessThan?: string; lessThanOrEqual?: string; status?: string; versionType?: string }[];
};

// True when the range names no version at all (NVD "-" or "*" without bounds).
export const unbounded = (r: Range) => !r.version_start && !r.version_end && !r.exact_version;

const MOBILE_WORDS = /\b(android|ios|iphone|ipad|ipados|windows phone|windows mobile|blackberry)\b/i;
// A usable CNA version has a digit and is not a placeholder ("unspecified", "publication", "*").
const cnaVersion = (v: string | undefined) => (v && /\d/.test(v) && !/^(0|\*|n\/a|unspecified|publication)$/i.test(v.trim()) ? v.trim() : null);

// The CNA entries of this CPE: by its CPE list when it has one, else by the CPE product's words in the
// CNA product name ("onedrive" in "OneDrive for Windows"). mobileOnly: every such entry is a mobile app.
// ranges: the real version ranges of the entries for computers ([] when the CNA has none).
export function cnaRanges(affected: CnaAffected[], cpeVendor: string, cpeProduct: string): { mobileOnly: boolean; ranges: Range[] } {
  const product = cpeToken(cpeProduct);
  const mine = affected.filter((a) => {
    const cpes = (a.cpes ?? []).map(parseCpe).filter((c): c is NonNullable<typeof c> => !!c);
    if (cpes.length) return cpes.some((c) => c.vendor === cpeVendor && c.product === cpeProduct);
    const name = cpeToken(a.product ?? "");
    if (product !== "" && ` ${name} `.includes(` ${product} `)) return true;
    // "One Drive for Android" is still OneDrive: compare without spaces when the name is long enough.
    const compact = product.replace(/ /g, "");
    return compact.length >= 4 && name.replace(/ /g, "").includes(compact);
  });
  const mobile = (a: CnaAffected) =>
    MOBILE_WORDS.test(a.product ?? "") ||
    (a.platforms ?? []).some((p) => MOBILE_WORDS.test(p)) ||
    (a.cpes ?? []).some((c) => MOBILE_TARGETS.has(parseCpe(c)?.targetSw ?? ""));
  const computers = mine.filter((a) => !mobile(a));
  const ranges: Range[] = [];
  for (const a of computers) {
    for (const v of a.versions ?? []) {
      if (v.status && v.status !== "affected") continue;
      const start = cnaVersion(v.version);
      const end = cnaVersion(v.lessThan) ?? cnaVersion(v.lessThanOrEqual);
      if (end) ranges.push({ version_start: start, start_inclusive: true, version_end: end, end_inclusive: !cnaVersion(v.lessThan), exact_version: null });
      else if (start && !v.lessThan && !v.lessThanOrEqual) ranges.push({ version_start: null, start_inclusive: true, version_end: null, end_inclusive: true, exact_version: start });
    }
  }
  return { mobileOnly: mine.length > 0 && computers.length === 0, ranges };
}

export async function fetchCnaAffected(fetchFn: FetchLike, cveId: string, timeoutMs = 20_000): Promise<CnaAffected[]> {
  const body = (await getJson(fetchFn, `${CVE_RECORD}/${encodeURIComponent(cveId)}`, { headers: { Accept: "application/json" } }, timeoutMs)) as {
    containers?: { cna?: { affected?: CnaAffected[] } };
  };
  return body.containers?.cna?.affected ?? [];
}

type OsvVuln = {
  id?: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  published?: string;
  modified?: string;
  withdrawn?: string;
  database_specific?: { severity?: string; cwe_ids?: string[] };
  severity?: { type?: string; score?: string }[];
  affected?: { package?: { ecosystem?: string; name?: string }; ranges?: { type?: string; events?: Record<string, string>[] }[]; versions?: string[] }[];
  references?: { url?: string }[];
};

// OSV events (introduced / fixed / last_affected) → ranges; "introduced: 0" opens at the start.
export function osvRanges(v: OsvVuln, ecosystem: string, name: string): Range[] {
  const out: Range[] = [];
  for (const a of v.affected ?? []) {
    if (a.package?.ecosystem !== ecosystem || a.package?.name?.toLowerCase() !== name.toLowerCase()) continue;
    for (const r of a.ranges ?? []) {
      if (r.type !== "ECOSYSTEM" && r.type !== "SEMVER") continue;
      let start: string | null = null;
      let open = false;
      for (const e of r.events ?? []) {
        if (e.introduced !== undefined) {
          start = e.introduced === "0" ? null : e.introduced;
          open = true;
        } else if (open && (e.fixed !== undefined || e.last_affected !== undefined)) {
          out.push({ version_start: start, start_inclusive: true, version_end: e.fixed ?? e.last_affected, end_inclusive: e.fixed === undefined, exact_version: null });
          open = false;
        }
      }
      if (open) out.push({ version_start: start, start_inclusive: true, version_end: null, end_inclusive: false, exact_version: null });
    }
    if (!(a.ranges ?? []).some((r) => r.type === "ECOSYSTEM" || r.type === "SEMVER")) {
      for (const version of (a.versions ?? []).slice(0, 200)) out.push({ version_start: null, start_inclusive: true, version_end: null, end_inclusive: false, exact_version: version });
    }
  }
  return out;
}

const SEVERITY = new Set(["CRITICAL", "HIGH", "MEDIUM", "MODERATE", "LOW"]);

export function parseOsvVuln(v: OsvVuln, ecosystem: string, name: string): Vulnerability | null {
  if (!v.id || v.withdrawn) return null;
  const cve = (v.aliases ?? []).find((a) => /^CVE-\d{4}-\d+$/.test(a));
  const level = v.database_specific?.severity?.toUpperCase();
  const vector = v.severity?.find((s) => s.type?.startsWith("CVSS_"))?.score ?? null;
  return {
    vuln_id: cve ?? v.id,
    aliases: [v.id, ...(v.aliases ?? [])].filter((a) => a !== (cve ?? v.id)),
    source: "osv",
    published: v.published ?? null,
    modified: v.modified ?? null,
    summary: (v.summary ?? v.details ?? "").slice(0, 2000) || null,
    cvss_version: vector?.match(/^CVSS:(\d\.\d)/)?.[1] ?? null,
    cvss_score: null,
    severity: level && SEVERITY.has(level) ? (level === "MODERATE" ? "MEDIUM" : level) : null,
    cvss_vector: vector,
    cwe: (v.database_specific?.cwe_ids ?? []).filter((c) => /^CWE-\d+$/.test(c)),
    references: (v.references ?? []).map((r) => r.url ?? "").filter((u) => /^https?:\/\//.test(u)).slice(0, 10),
    kev_added: null,
    kev_due: null,
    ranges: osvRanges(v, ecosystem, name),
  };
}

// Every vulnerability OSV knows for a package (no version: the client compares its own versions).
export async function fetchOsvVulns(fetchFn: FetchLike, ecosystem: string, name: string, timeoutMs?: number): Promise<{ vulns: Vulnerability[]; calls: number }> {
  const vulns: Vulnerability[] = [];
  let pageToken: string | undefined;
  let calls = 0;
  do {
    const body = (await getJson(
      fetchFn,
      OSV_QUERY,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ package: { ecosystem, name }, ...(pageToken ? { page_token: pageToken } : {}) }) },
      timeoutMs,
    )) as { vulns?: OsvVuln[]; next_page_token?: string };
    calls++;
    for (const v of body.vulns ?? []) {
      const parsed = parseOsvVuln(v, ecosystem, name);
      if (parsed) vulns.push(parsed);
    }
    pageToken = body.next_page_token;
  } while (pageToken && calls < 20);
  return { vulns, calls };
}

export type KevRow = { cve_id: string; date_added: string | null; due_date: string | null; ransomware: string | null };

export async function fetchKev(fetchFn: FetchLike, timeoutMs = 60_000): Promise<{ version: string | null; rows: KevRow[] }> {
  const body = (await getJson(fetchFn, KEV_FEED, {}, timeoutMs)) as {
    catalogVersion?: string;
    vulnerabilities?: { cveID?: string; dateAdded?: string; dueDate?: string; knownRansomwareCampaignUse?: string }[];
  };
  return {
    version: body.catalogVersion ?? null,
    rows: (body.vulnerabilities ?? [])
      .filter((v) => /^CVE-\d{4}-\d+$/.test(v.cveID ?? ""))
      .map((v) => ({ cve_id: v.cveID!, date_added: v.dateAdded ?? null, due_date: v.dueDate ?? null, ransomware: v.knownRansomwareCampaignUse ?? null })),
  };
}

export type EpssRow = { cve_id: string; epss: number; percentile: number; date: string | null };

// EPSS for up to 100 CVEs per call.
export async function fetchEpss(fetchFn: FetchLike, cves: string[], timeoutMs?: number): Promise<EpssRow[]> {
  if (cves.length === 0) return [];
  if (cves.length > 100) throw new SourceError("EPSS takes at most 100 CVEs per call", null);
  const body = (await getJson(fetchFn, `${EPSS_API}?${new URLSearchParams({ cve: cves.join(","), limit: "100" })}`, {}, timeoutMs)) as {
    data?: { cve?: string; epss?: string | number; percentile?: string | number; date?: string }[];
  };
  return (body.data ?? [])
    .filter((d) => d.cve && !Number.isNaN(Number(d.epss)))
    .map((d) => ({ cve_id: d.cve!, epss: Number(d.epss), percentile: Number(d.percentile ?? 0), date: d.date ?? null }));
}
