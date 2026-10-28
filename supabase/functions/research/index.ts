// Research engine. A hub admin or operator runs it on one entry (console "Research"), or pg_cron's research-tick
// processes the queue filled by the triggers (requests, sensitive proposals, …) within the daily limit.
// Input is title metadata only; the answer must match the dossier schema; a dossier never publishes.

import Anthropic from "npm:@anthropic-ai/sdk@0.136.0";
import { emailAdmins, pausedEmailText } from "../_shared/admin-email.ts";
import { fromCron, hubCuratorCaller, json, serviceClient } from "../_shared/client-api.ts";
import { extractJson, researchMessage, researchSystem, validateDossier, type CategoryName, type ResearchInput } from "../_shared/research.ts";
import {
  claudeResearch,
  geminiResearch,
  grokResearch,
  mockResearch,
  openaiResearch,
  ResearchError,
  type ClaudeClient,
  type ResearchProvider,
} from "../_shared/research-providers.ts";

const PER_TICK = 5;
type Db = ReturnType<typeof serviceClient>;
type Gate = { allowed: boolean; reason?: string; model: string; provider: string; searches: number; timeout_seconds: number };

async function providerFor(db: Db, gate: Gate): Promise<ResearchProvider> {
  const limits = { maxSearches: gate.searches, timeoutSeconds: gate.timeout_seconds };
  if (Deno.env.get("RESEARCH_PROVIDER") === "mock") return mockResearch();
  const { data: key } = await db.rpc("get_provider_key", { p_provider: gate.provider });
  const apiKey = (key as string | null) ?? (gate.provider === "claude" ? Deno.env.get("ANTHROPIC_API_KEY") : undefined);
  if (!apiKey) return mockResearch(); // no key yet: the mock answers (logged as model "mock")
  switch (gate.provider) {
    case "claude":
      return claudeResearch(new Anthropic({ apiKey, maxRetries: 1 }) as unknown as ClaudeClient, gate.model, limits);
    case "gemini":
      return geminiResearch(fetch, apiKey, gate.model, limits);
    case "openai":
      return openaiResearch(fetch, apiKey, gate.model, limits);
    default:
      return grokResearch(fetch, apiKey, gate.model, limits);
  }
}

async function researchOne(db: Db, entryId: string, trigger: string, userId: string | null, manual: boolean) {
  const { data: gate } = await db.rpc("engine_gate", { p_engine: "research", p_units: 1, p_manual: manual });
  if (!gate?.allowed) return { ok: false, error: gate?.reason ?? "Research cannot run now" };

  const { data: entry } = await db.from("entries").select("id, kind, source, canonical_name, vendor, description, match_key, category:category_id(name)").eq("id", entryId).maybeSingle();
  if (!entry) return { ok: false, error: "Entry not found" };
  const { data: jev } = await db
    .from("v_proposals")
    .select("category_name, level1_name")
    .eq("entry_id", entryId)
    .maybeSingle();
  const { data: cats } = await db.from("categories").select("slug, name, parent:parent_id(name)").not("parent_id", "is", null).eq("deprecated", false).order("seq");
  const categories: CategoryName[] = ((cats ?? []) as unknown as { slug: string; name: string; parent: { name: string } | null }[]).map((c) => ({
    slug: c.slug,
    name: c.name,
    level1: c.parent?.name ?? "",
  }));
  if (categories.length === 0) return { ok: false, error: "Could not read the categories" };

  const provider = await providerFor(db, gate as Gate);
  const input = entry as unknown as ResearchInput;
  const jevCategory = jev ? `${jev.level1_name} / ${jev.category_name}` : null;
  let logged: { paused?: boolean; newly_paused?: boolean; reason?: string } | null = null;
  try {
    const answer = await provider.research(researchSystem(categories, (gate as Gate).searches), researchMessage(input, jevCategory));
    let dossier;
    let invalid: string | null = null;
    try {
      dossier = validateDossier(extractJson(answer.text), categories);
    } catch (e) {
      invalid = (e as Error).message;
    }
    ({ data: logged } = await db.rpc("record_ai_call", {
      p_engine: "research", p_model: provider.model, p_purpose: "research", p_run_id: null, p_titles: 1,
      p_input: answer.usage.input, p_output: answer.usage.output, p_cache_read: answer.usage.cacheRead, p_cache_write: answer.usage.cacheWrite,
      p_latency_ms: answer.latencyMs, p_status: invalid ? "error" : "ok", p_http_status: invalid ? 200 : null, p_error: invalid ? `Rejected dossier: ${invalid}` : null,
      p_provider: provider.provider, p_searches: answer.searches, p_entry_ids: [entryId],
    }));
    if (invalid) return { ok: false, error: `The answer did not match the dossier schema: ${invalid}` };
    await db.from("research_dossiers").insert({ entry_id: entryId, provider: provider.provider, model: provider.model, trigger, dossier, created_by: userId });
    return { ok: true, provider: provider.provider, unknown: dossier!.unknown, sources: dossier!.evidence.length, dropped_claims: dossier!.dropped_claims };
  } catch (e) {
    const err = e instanceof ResearchError ? e : new ResearchError((e as Error).message, null);
    ({ data: logged } = await db.rpc("record_ai_call", {
      p_engine: "research", p_model: provider.model, p_purpose: "research", p_run_id: null, p_titles: 0,
      p_input: err.usage.input, p_output: err.usage.output, p_cache_read: err.usage.cacheRead, p_cache_write: err.usage.cacheWrite,
      p_latency_ms: null, p_status: "error", p_http_status: err.httpStatus, p_error: err.message, p_provider: provider.provider, p_searches: err.searches, p_entry_ids: [entryId],
    }));
    return { ok: false, error: err.message };
  } finally {
    if (logged?.newly_paused) await emailAdmins(db, "Research paused", pausedEmailText("Research", logged.reason ?? null));
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const db = serviceClient();
  const cron = fromCron(req);
  const admin = cron ? null : await hubCuratorCaller(req);
  if (!cron && !admin) return json({ error: "Only hub admins and operators can run research" }, 403);
  const body = (await req.json().catch(() => ({}))) as { action?: string; entry_id?: string };

  if (body.action === "run") {
    if (!admin || !/^[0-9a-f-]{36}$/i.test(body.entry_id ?? "")) return json({ error: "Choose an entry" }, 400);
    const result = await researchOne(db, body.entry_id!, "manual", admin.userId, true);
    await db.from("audit_log").insert({ user_id: admin.userId, action: "run research", target: body.entry_id, data: result });
    return json(result, result.ok ? 200 : 409);
  }

  if (body.action === "tick") {
    const { data: usage } = await db.rpc("engine_usage", { p_engine: "research" });
    const { data: s } = await db.from("engine_settings").select("daily_titles").eq("engine", "research").single();
    const room = Math.max(0, Math.min(PER_TICK, (s?.daily_titles ?? 0) - Number(usage?.[0]?.titles_today ?? 0)));
    const { data: gate } = await db.rpc("engine_gate", { p_engine: "research", p_units: 1, p_manual: false });
    if (!gate?.allowed || room === 0) return json({ ok: true, skipped: gate?.reason ?? "Daily limit reached" });
    const { data: taken } = await db.rpc("research_take", { p_limit: room });
    const results = [];
    for (const item of (taken ?? []) as { queue_id: number; entry_id: string; trigger: string }[]) {
      const r = await researchOne(db, item.entry_id, item.trigger, null, false);
      if (!r.ok) await db.rpc("research_failed", { p_queue_id: item.queue_id, p_error: r.error ?? "failed" });
      results.push({ entry_id: item.entry_id, trigger: item.trigger, ...r });
      if (!r.ok && /paused|limit|budget|off/i.test(r.error ?? "")) break;
    }
    return json({ ok: true, processed: results.length, results });
  }
  return json({ error: "Unknown action" }, 400);
});
