// Console I/O for the engines (jev, research): settings, usage, pause, prices, provider keys, dossiers, events.
// Provider keys are write-only: the browser sends a key to set_provider_key and only ever reads its hint.

import { db, invokeFunction, orThrow } from "@/lib/supabase-query";
import type { EngineStatus } from "@/features/jev/api";

export type EngineName = "jev" | "research";
export type Provider = "claude" | "gemini" | "openai" | "grok";
// Keys in Vault: the AI providers, plus the NVD API key (Settings › Data sources).
export type KeyedProvider = Provider | "nvd";
export const PROVIDERS: { value: Provider; label: string; defaultModel: string }[] = [
  { value: "claude", label: "Claude (Anthropic)", defaultModel: "claude-opus-5-5" },
  { value: "gemini", label: "Gemini (Google)", defaultModel: "gemini-2.5-flash" },
  { value: "openai", label: "OpenAI", defaultModel: "gpt-5" },
  { value: "grok", label: "Grok (xAI)", defaultModel: "grok-4" },
];
// Jev classifies one title per call: Claude or OpenAI, each with a small default model.
export const JEV_PROVIDERS: { value: Provider; label: string; defaultModel: string }[] = [
  { value: "claude", label: "Claude (Anthropic)", defaultModel: "claude-haiku-5-5" },
  { value: "openai", label: "OpenAI", defaultModel: "gpt-5-mini" },
];
export const TRIGGERS: { key: string; label: string }[] = [
  { key: "request", label: "A client opens a reclassification request" },
  { key: "sensitive_proposal", label: "Jev proposes a Review or Not allowed category" },
  { key: "jev_below_085", label: "Jev answers below 0.85" },
  { key: "rule_jev_disagree", label: "Jev disagrees with a client rule" },
];

export type EngineSettings = {
  engine: EngineName;
  provider: Provider;
  model: string;
  daily_titles: number;
  monthly_budget_usd: number;
  per_run_searches: number;
  timeout_seconds: number;
  triggers: Record<string, boolean>;
};
export type UsageDetail = {
  month_calls: number;
  month_errors: number;
  month_titles: number;
  month_searches: number;
  month_cost: number;
  day_calls: number;
  day_cost: number;
  accepted_month: number | null;
  cost_per_accepted: number | null;
  acceptance_rate: number | null;
  recent_errors: { at: string; http: number | null; error: string | null }[];
  queue: number | null;
};
export type Engine = { status: EngineStatus; settings: EngineSettings; usage: UsageDetail };
export type Price = {
  engine: string;
  provider: string;
  model: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
  per_search_usd: number;
  effective_from: string;
};
export type PriceInput = Omit<Price, "effective_from">;
export type MissingPrice = { engine: string; provider: string; model: string };
export type ProviderKey = { provider: KeyedProvider; key_hint: string; configured_at: string };
export type EventRow = { seq: number; type: string; created_at: string; entry: { id: string; canonical_name: string } | null; category: { name: string } | null };
export type DossierRow = {
  id: number;
  provider: string;
  model: string;
  trigger: string;
  created_at: string;
  dossier: {
    summary: string;
    vendor: string | null;
    official_url: string | null;
    store_url: string | null;
    capabilities: string[];
    suggested_category: string | null;
    suggested_slug: string | null;
    confidence: "high" | "medium" | "low";
    agrees_with_jev: boolean | null;
    risk_notes: string[];
    evidence: { claim: string; url: string }[];
    unknown: boolean;
    dropped_claims: number;
  };
};
export type ResearchResult = { ok: boolean; error?: string; provider?: string; unknown?: boolean; sources?: number; dropped_claims?: number };

export async function fetchEngine(engine: EngineName): Promise<Engine | null> {
  const client = db();
  const [status, settings, usage] = await Promise.all([
    client.rpc("engine_status", { p_engine: engine }),
    client.from("engine_settings").select("engine, provider, model, daily_titles, monthly_budget_usd, per_run_searches, timeout_seconds, triggers").eq("engine", engine).maybeSingle(),
    client.rpc("engine_usage_detail", { p_engine: engine }),
  ]);
  const s = (orThrow(status) ?? [])[0];
  if (!s) return null;
  return { status: s as EngineStatus, settings: orThrow(settings) as unknown as EngineSettings, usage: orThrow(usage) as unknown as UsageDetail };
}

export async function setEngineMode(engine: EngineName, mode: EngineStatus["mode"]): Promise<void> {
  orThrow(await db().rpc("set_engine_mode", { p_engine: engine, p_mode: mode }));
}

export async function pauseEngine(engine: EngineName): Promise<void> {
  orThrow(await db().rpc("admin_pause_engine", { p_engine: engine }));
}

export async function resumeEngine(engine: EngineName): Promise<void> {
  orThrow(await db().rpc("resume_engine", { p_engine: engine }));
}

export async function setEngineConfig(engine: EngineName, c: { provider: Provider; model: string; daily: number; budget: number; triggers?: Record<string, boolean> }): Promise<void> {
  orThrow(
    await db().rpc("set_engine_config", {
      p_engine: engine,
      p_provider: c.provider,
      p_model: c.model,
      p_daily: c.daily,
      p_monthly_budget: c.budget,
      ...(c.triggers ? { p_triggers: c.triggers } : {}),
    }),
  );
}

export async function fetchPrices(): Promise<Price[]> {
  return (orThrow(await db().from("ai_prices").select("*").order("engine").order("model").order("effective_from", { ascending: false })) ?? []) as unknown as Price[];
}

export async function fetchMissingPrices(): Promise<MissingPrice[]> {
  return (orThrow(await db().from("v_missing_prices").select("*")) ?? []) as MissingPrice[];
}

export async function setPrice(p: PriceInput): Promise<void> {
  orThrow(
    await db().rpc("set_price", {
      p_engine: p.engine,
      p_provider: p.provider,
      p_model: p.model,
      p_input: p.input_per_mtok,
      p_output: p.output_per_mtok,
      p_cache_read: p.cache_read_per_mtok,
      p_cache_write: p.cache_write_per_mtok,
      p_per_search: p.per_search_usd,
    }),
  );
}

export async function fetchProviderKeys(): Promise<ProviderKey[]> {
  return (orThrow(await db().from("provider_keys").select("provider, key_hint, configured_at")) ?? []) as ProviderKey[];
}

export async function setProviderKey(provider: KeyedProvider, key: string): Promise<void> {
  orThrow(await db().rpc("set_provider_key", { p_provider: provider, p_key: key }));
}

export async function clearProviderKey(provider: KeyedProvider): Promise<void> {
  orThrow(await db().rpc("clear_provider_key", { p_provider: provider }));
}

export const EVENTS_PAGE = 50;

export async function fetchEvents(page: number): Promise<{ rows: EventRow[]; total: number }> {
  const { data, error, count } = await db()
    .from("dictionary_events")
    .select("seq, type, created_at, entry:entry_id(id, canonical_name), category:category_id(name)", { count: "exact" })
    .order("seq", { ascending: false })
    .range(page * EVENTS_PAGE, page * EVENTS_PAGE + EVENTS_PAGE - 1);
  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as unknown as EventRow[], total: count ?? 0 };
}

export async function fetchLatestDossier(entryId: string): Promise<DossierRow | null> {
  return orThrow(
    await db().from("research_dossiers").select("id, provider, model, trigger, created_at, dossier").eq("entry_id", entryId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ) as unknown as DossierRow | null;
}

export function runResearch(entryId: string): Promise<ResearchResult> {
  return invokeFunction<ResearchResult>("research", { action: "run", entry_id: entryId });
}
