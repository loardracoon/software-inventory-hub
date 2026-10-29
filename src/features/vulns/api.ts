// Known vulnerabilities (phase H7): CPE matches, the vulnerabilities of a product, source status, and the
// Refresh button (Edge Function vuln-sync, action "product").
import type { Database } from "@/integrations/supabase/types";
import { db, invokeFunction, orThrow } from "@/lib/supabase-query";

export type CpeCandidate = Database["public"]["Views"]["v_cpe_candidates"]["Row"];
export type ProductCpe = Database["public"]["Tables"]["product_cpes"]["Row"];
export type Range = {
  version_start: string | null;
  start_inclusive: boolean;
  version_end: string | null;
  end_inclusive: boolean;
  exact_version: string | null;
  source: string;
  platforms?: string[] | null; // null = every OS
};

export const PLATFORM_LABEL: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };
export const platformsText = (p: string[] | null | undefined) => (p ?? []).map((x) => PLATFORM_LABEL[x] ?? x).join(", ");
export type ProductVuln = Omit<Database["public"]["Views"]["v_product_vulns"]["Row"], "ranges"> & { ranges: Range[] };
export type VulnStatus = {
  products_with_cpe: number;
  cpe_candidates: number;
  vulnerabilities: number;
  kev: number;
  kev_synced_at: string | null;
  nvd_key: boolean;
  last_run: { started_at: string; finished_at: string | null; trigger: string; summary: Record<string, unknown> | null; errors: string[] } | null;
};

export async function fetchCpeCandidates(): Promise<CpeCandidate[]> {
  return (orThrow(await db().from("v_cpe_candidates").select("*").order("display_name").limit(500)) ?? []) as CpeCandidate[];
}

export async function decideCpe(id: string, accept: boolean): Promise<void> {
  orThrow(await db().rpc("decide_cpe", { p_id: id, p_accept: accept }));
}

export async function addCpe(productId: string, cpe: string): Promise<void> {
  orThrow(await db().rpc("add_cpe", { p_product_id: productId, p_cpe: cpe }));
}

export async function fetchProductVulns(productId: string): Promise<{ cpes: ProductCpe[]; vulns: ProductVuln[] }> {
  const [cpes, vulns] = await Promise.all([
    db().from("product_cpes").select("*").eq("product_id", productId).order("status").order("cpe_product"),
    db().from("v_product_vulns").select("*").eq("product_id", productId).order("cvss_score", { ascending: false, nullsFirst: false }).limit(500),
  ]);
  return { cpes: (orThrow(cpes) ?? []) as ProductCpe[], vulns: (orThrow(vulns) ?? []) as unknown as ProductVuln[] };
}

export function refreshProductVulns(productId: string): Promise<{ ok: boolean; vulns_changed?: number; cpes_read?: number; errors?: string[]; error?: string }> {
  return invokeFunction("vuln-sync", { action: "product", product_id: productId });
}

export async function fetchVulnStatus(): Promise<VulnStatus | null> {
  return orThrow(await db().rpc("vuln_status")) as unknown as VulnStatus | null;
}

// "≤ 24.09", "15.0 – 15.05", "= 9.20", "all versions"; "(Windows only)" when the range names an OS.
export function rangeText(r: Range): string {
  const os = r.platforms?.length ? ` (${platformsText(r.platforms)} only)` : "";
  if (r.exact_version) return `= ${r.exact_version}${os}`;
  const start = r.version_start ? `${r.start_inclusive ? "≥" : ">"} ${r.version_start}` : "";
  const end = r.version_end ? `${r.end_inclusive ? "≤" : "<"} ${r.version_end}` : "";
  return ([start, end].filter(Boolean).join(" and ") || "all versions") + os;
}
