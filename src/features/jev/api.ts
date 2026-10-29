// Console I/O for Jev: titles to classify, proposals and decisions, runs, auto-publishes, engine status.

import { db, invokeFunction, orThrow } from "@/lib/supabase-query";

export type PendingTitle = {
  id: string;
  kind: string;
  source: string;
  canonical_name: string;
  vendor: string | null;
  status: string;
  reports_count: number;
  first_reported_at: string | null;
  product_id: string | null;
  // Pending spellings of the same product (one row per product; Jev classifies one, the others follow).
  spellings: number;
};
export type Proposal = {
  run_id: string;
  entry_id: string;
  probability: number;
  category_id: string;
  category_slug: string;
  category_name: string;
  level1_name: string;
  attention_level: "info" | "review" | "not_allowed";
  kind: string;
  source: string;
  canonical_name: string;
  vendor: string | null;
  entry_status: string;
  reports_count: number;
  rerun: boolean;
};
export type Run = {
  id: string;
  model: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  rerun: boolean;
  entry_count: number;
  results: number;
  auto_published: number;
  open_proposals: number;
  cost_usd: number;
  errors: number;
};
export type AutoPublished = { id: string; canonical_name: string; vendor: string | null; confidence: number | null; updated_at: string; category: { name: string } | null };
export type EngineStatus = {
  mode: "off" | "manual" | "automatic";
  model: string;
  paused: boolean;
  paused_reason: string | null;
  last_auto_run_at: string | null;
  daily_titles: number;
  titles_today: number;
  monthly_budget_usd: number;
  spend_month: number;
  auto_publish_daily: number;
  auto_published_today: number;
};
export type Level2 = { id: string; slug: string; name: string; parent: { name: string } | null };
export type RunResult = { ok: boolean; error?: string; skipped?: string; titles?: number; auto_published?: number; proposals?: number; errors?: number; paused?: boolean; pause_reason?: string | null };

export async function fetchPendingTitles(): Promise<PendingTitle[]> {
  return Array.from((orThrow(
    await db()
      .from("entries")
      .select("id, kind, source, canonical_name, vendor, status, reports_count, first_reported_at, product_id")
      .eq("status", "pending")
      .order("reports_count", { ascending: false })
      .order("first_reported_at")
      .limit(500),
  ) ?? []).reduce((byProduct: Map<string, PendingTitle>, row) => {
    const key = row.product_id ?? row.id;
    const seen = byProduct.get(key);
    if (seen) seen.spellings += 1;
    else byProduct.set(key, { ...(row as Omit<PendingTitle, "spellings">), spellings: 1 });
    return byProduct;
  }, new Map<string, PendingTitle>()).values());
}

export async function fetchProposals(): Promise<Proposal[]> {
  return (orThrow(await db().from("v_proposals").select("*").order("level1_name").order("category_name").order("probability", { ascending: false })) ?? []) as Proposal[];
}

export async function fetchRuns(): Promise<Run[]> {
  return (orThrow(await db().from("v_runs").select("*").order("started_at", { ascending: false }).limit(50)) ?? []) as Run[];
}

export async function fetchAutoPublished(): Promise<AutoPublished[]> {
  return (orThrow(
    await db()
      .from("entries")
      .select("id, canonical_name, vendor, confidence, updated_at, category:categories!entries_category_id_fkey(name)")
      .eq("method", "jev_auto")
      .eq("status", "published")
      .order("updated_at", { ascending: false })
      .limit(100),
  ) ?? []) as unknown as AutoPublished[];
}

export async function fetchLevel2Categories(): Promise<Level2[]> {
  return (orThrow(
    await db()
      .from("categories")
      .select("id, slug, name, parent:parent_id(name)")
      .not("parent_id", "is", null)
      .eq("deprecated", false)
      .order("slug"),
  ) ?? []) as unknown as Level2[];
}

export async function fetchEngineStatus(): Promise<EngineStatus | null> {
  return ((orThrow(await db().rpc("engine_status", { p_engine: "jev" })) ?? [])[0] ?? null) as EngineStatus | null;
}

export function runJev(payload: { action: "run_selected" | "rerun"; entry_ids?: string[]; category_slug?: string }): Promise<RunResult> {
  return invokeFunction<RunResult>("jev", payload);
}

export async function decideProposal(p: Proposal, accept: boolean, categoryId?: string): Promise<string> {
  return orThrow(
    await db().rpc("decide_proposal", { p_run_id: p.run_id, p_entry_id: p.entry_id, p_accept: accept, ...(categoryId ? { p_category_id: categoryId } : {}) }),
  ) as string;
}

export async function acceptAllAbove(min = 0.85): Promise<number> {
  return orThrow(await db().rpc("accept_all_above", { p_min: min })) as number;
}

export async function revertAutoPublish(entryId: string): Promise<string> {
  return orThrow(await db().rpc("revert_auto_publish", { p_entry_id: entryId })) as string;
}

export async function setJevMode(mode: EngineStatus["mode"]): Promise<void> {
  orThrow(await db().rpc("set_engine_mode", { p_engine: "jev", p_mode: mode }));
}

export async function resumeJev(): Promise<void> {
  orThrow(await db().rpc("resume_engine", { p_engine: "jev" }));
}
