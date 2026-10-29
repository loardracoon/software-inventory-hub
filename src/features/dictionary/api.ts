// Console I/O for the dictionary: search, entry page, drafts and publishing, request groups, taxonomy.

import type { ServerPage, ServerPageRequest } from "@/components/shared/server-data-table";
import type { Database } from "@/integrations/supabase/types";
import { db, orThrow } from "@/lib/supabase-query";

type Fn = Database["public"]["Functions"];
export type EntryRow = Fn["search_entries"]["Returns"][number];
export type EntryStatus = Database["public"]["Enums"]["entry_status"];
export type EntryKind = Database["public"]["Enums"]["entry_kind"];
export type Attention = Database["public"]["Enums"]["attention_level"];
// group: one row per product (its most reported spelling) instead of one row per spelling.
export type DictionaryFilters = { query: string; status: EntryStatus | ""; kind: EntryKind | ""; categoryId: string; group: boolean };

export async function searchEntries(r: ServerPageRequest<DictionaryFilters>): Promise<ServerPage<EntryRow>> {
  const sort = r.sorting[0]?.id === "canonical_name" ? "name" : r.sorting[0]?.id === "updated" ? "updated" : "reports";
  const rows = orThrow(
    await db()
      .rpc("search_entries", {
        ...(r.filters.query.trim() ? { p_query: r.filters.query.trim() } : {}),
        ...(r.filters.status ? { p_status: r.filters.status } : {}),
        ...(r.filters.kind ? { p_kind: r.filters.kind } : {}),
        ...(r.filters.categoryId ? { p_category_id: r.filters.categoryId } : {}),
        p_sort: sort,
        p_limit: r.pageSize,
        p_offset: r.pageIndex * r.pageSize,
        p_group: r.filters.group,
      })
      .abortSignal(r.signal),
  ) ?? [];
  return { rows, rowCount: rows[0]?.total_count ?? 0 };
}

export type EntryDetail = Database["public"]["Tables"]["entries"]["Row"] & { category: { name: string; attention_level: Attention | null; parent: { name: string } | null } | null };
export type Revision = { revision: number; snapshot: Record<string, unknown>; change_reason: string | null; created_at: string; changed_by: string | null };
export type JevResult = { run_id: string; probability: number | null; accepted: boolean | null; accepted_at: string | null; category: { name: string } | null; run: { started_at: string; model: string } | null };
export type EntryRequest = {
  public_id: string;
  status: string;
  reason: string;
  evidence_url: string | null;
  admin_note: string | null;
  created_at: string;
  client: { name: string } | null;
  suggested: { name: string } | null;
};
export type Draft = Database["public"]["Tables"]["entry_drafts"]["Row"];

export async function fetchEntry(id: string) {
  const [entry, revisions, results, requests, draft] = await Promise.all([
    db().from("entries").select("*, category:category_id(name, attention_level, parent:parent_id(name))").eq("id", id).maybeSingle(),
    db().from("entry_revisions").select("revision, snapshot, change_reason, created_at, changed_by").eq("entry_id", id).order("revision", { ascending: false }),
    db().from("classification_results").select("run_id, probability, accepted, accepted_at, category:category_id(name), run:run_id(started_at, model)").eq("entry_id", id),
    db()
      .from("reclassification_requests")
      .select("public_id, status, reason, evidence_url, admin_note, created_at, client_id, suggested:suggested_category_id(name)")
      .eq("entry_id", id)
      .order("created_at", { ascending: false }),
    db().from("entry_drafts").select("*").eq("entry_id", id).maybeSingle(),
  ]);
  // Client names come from client_names (every member reads them; the clients table is admin-only).
  const requestRows = (orThrow(requests) ?? []) as unknown as (Omit<EntryRequest, "client"> & { client_id: string })[];
  const clientIds = [...new Set(requestRows.map((r) => r.client_id))];
  const names = clientIds.length ? ((orThrow(await db().from("client_names").select("id, name").in("id", clientIds)) ?? []) as { id: string; name: string }[]) : [];
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  return {
    entry: orThrow(entry) as unknown as EntryDetail | null,
    revisions: (orThrow(revisions) ?? []) as Revision[],
    results: ((orThrow(results) ?? []) as unknown as JevResult[]).sort((a, b) => (b.run?.started_at ?? "").localeCompare(a.run?.started_at ?? "")),
    requests: requestRows.map(({ client_id, ...r }) => ({ ...r, client: nameOf.has(client_id) ? { name: nameOf.get(client_id)! } : null })),
    draft: orThrow(draft) as Draft | null,
  };
}

export type DraftInput = { name: string; vendor: string; description: string; categoryId: string; attention: Attention | ""; clearAttention: boolean; reason: string };

export async function saveDraft(entryId: string, d: DraftInput): Promise<void> {
  orThrow(
    await db().rpc("save_entry_draft", {
      p_entry_id: entryId,
      p_name: d.name,
      p_vendor: d.vendor,
      p_description: d.description,
      // null keeps the current value (the generated types do not mark these parameters nullable).
      p_category_id: d.categoryId || (null as unknown as string),
      p_attention: d.attention || (null as unknown as Attention),
      p_clear_attention: d.clearAttention,
      p_reason: d.reason,
    }),
  );
}

export async function discardDraft(entryId: string): Promise<void> {
  orThrow(await db().rpc("discard_entry_draft", { p_entry_id: entryId }));
}

export async function publishEntry(entryId: string, reason?: string): Promise<number> {
  return orThrow(await db().rpc("publish_entry_edit", { p_entry_id: entryId, ...(reason ? { p_reason: reason } : {}) })) as number;
}

// Requests -------------------------------------------------------------------------------------------

export type RequestGroup = {
  entry_id: string;
  canonical_name: string;
  vendor: string | null;
  kind: string;
  source: string;
  entry_status: string;
  current_category: string | null;
  requests: number;
  clients: number;
  oldest: string;
  items: { public_id: string; client: string; suggested_category_id: string | null; suggested: string; reason: string; evidence_url: string | null; created_at: string }[];
};

export async function fetchRequestGroups(): Promise<RequestGroup[]> {
  return (orThrow(await db().from("v_request_groups").select("*").order("oldest")) ?? []) as unknown as RequestGroup[];
}

export async function decideRequests(entryId: string, accept: boolean, note: string, categoryId?: string): Promise<number> {
  return orThrow(
    await db().rpc("decide_entry_requests", { p_entry_id: entryId, p_accept: accept, p_note: note, ...(categoryId ? { p_category_id: categoryId } : {}) }),
  ) as number;
}

// Taxonomy -------------------------------------------------------------------------------------------

export type CategoryRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  attention_level: Attention | null;
  parent_id: string | null;
  sophos_firewall_category: string | null;
  revision: number;
  deprecated: boolean;
};

export async function fetchCategories(): Promise<CategoryRow[]> {
  return (orThrow(
    await db().from("categories").select("id, slug, name, description, attention_level, parent_id, sophos_firewall_category, revision, deprecated").order("seq"),
  ) ?? []) as CategoryRow[];
}

export async function updateCategory(id: string, name: string, description: string, reason: string): Promise<void> {
  orThrow(await db().rpc("update_category", { p_category_id: id, p_name: name, p_description: description, p_reason: reason }));
}

export async function deprecateCategory(id: string, replacementId: string, reason: string): Promise<number> {
  return orThrow(await db().rpc("deprecate_category", { p_category_id: id, p_replacement_id: replacementId, p_reason: reason })) as number;
}

// Level-2 options as "Level 1 / Level 2", active only.
export function level2Options(rows: CategoryRow[]): { value: string; label: string }[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return rows
    .filter((r) => r.parent_id && !r.deprecated)
    .map((r) => ({ value: r.id, label: `${byId.get(r.parent_id!)?.name ?? ""} / ${r.name}` }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// Products (phase H6) ----------------------------------------------------------------------------------

export type ProductAlias = { id: string; canonical_name: string; source: string; match_key: string; status: EntryStatus; product_locked: boolean; category: { name: string } | null };
export type ProductInfo = Database["public"]["Views"]["v_products"]["Row"];
export type ProductConflict = {
  product_id: string;
  display_name: string;
  vendor: string | null;
  aliases: {
    entry_id: string;
    canonical_name: string;
    category_id: string | null;
    category: string | null;
    method: string | null;
    reviewed_at: string | null;
    attention_override: Attention | null;
  }[];
};

// The product of an entry and every spelling in it.
export async function fetchProduct(productId: string): Promise<{ product: ProductInfo | null; aliases: ProductAlias[] }> {
  const [product, aliases] = await Promise.all([
    db().from("v_products").select("*").eq("id", productId).maybeSingle(),
    db().from("entries").select("id, canonical_name, source, match_key, status, product_locked, category:category_id(name)").eq("product_id", productId).order("canonical_name"),
  ]);
  return { product: orThrow(product) as ProductInfo | null, aliases: (orThrow(aliases) ?? []) as unknown as ProductAlias[] };
}

export async function searchProducts(query: string, kind: EntryKind): Promise<ProductInfo[]> {
  const q = query.replace(/[%_,()*\\]/g, " ").trim();
  if (!q) return [];
  return (orThrow(await db().from("v_products").select("*").eq("kind", kind).ilike("display_name", `%${q}%`).order("display_name").limit(20)) ?? []) as ProductInfo[];
}

// Move an entry to another product, or split it into a product of its own (null).
export async function setEntryProduct(entryId: string, productId: string | null): Promise<void> {
  orThrow(await db().rpc("set_entry_product", { p_entry_id: entryId, p_product_id: productId as string }));
}

export async function fetchProductConflicts(): Promise<ProductConflict[]> {
  return (orThrow(await db().from("v_product_conflicts").select("*").order("display_name")) ?? []) as unknown as ProductConflict[];
}

// Publish this spelling's classification to every spelling of its product.
export async function resolveProductConflict(entryId: string): Promise<number> {
  return orThrow(await db().rpc("resolve_product_conflict", { p_entry_id: entryId })) as number;
}
