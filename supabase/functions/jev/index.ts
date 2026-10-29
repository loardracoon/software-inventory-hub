// Jev runs. Called by a hub admin or operator (console, user JWT) or by pg_cron (x-cron-secret, action "auto").
//   run_selected { entry_ids }          manual run on chosen titles (max 50)
//   rerun { entry_ids } | { category_slug }  re-classify published entries; results are proposals only
//   auto                                 every interval_hours: pending titles reported by min_reports+ clients
// Every model call passes the gateway (jev_gate before the run, record_ai_call after each call, which
// may pause Jev); answers go through jev_store_result, which owns the auto-publish gate.

import Anthropic from "npm:@anthropic-ai/sdk@0.136.0";
import { emailAdmins, pausedEmailText } from "../_shared/admin-email.ts";
import { fromCron as isCron, hubCuratorCaller, json, serviceClient } from "../_shared/client-api.ts";
import { ClassifyError, claudeClassifier, mockClassifier, openaiClassifier, type Classifier, type MessagesClient } from "../_shared/jev-classifier.ts";
import { buildSystem, type CategoryOption, type TitleInput } from "../_shared/jev-prompt.ts";

const MAX_TITLES = 50;
const CONCURRENCY = 5;

type Body = { action?: string; entry_ids?: string[]; category_slug?: string };
type EntryRow = TitleInput & { id: string; product_id: string | null };

const ENV_KEY: Record<string, string> = { claude: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };

// The provider and model come from Settings › Jev (engine_settings). The provider's key from Settings
// (Vault) first, ANTHROPIC_API_KEY / OPENAI_API_KEY as fallback; without a key, the mock answers.
// JEV_PROVIDER=mock forces the mock even with a key (local stacks).
function classifierFor(provider: string, key: string | null, model: string, system: string, slugs: string[]): { classifier: Classifier; provider: string } {
  const chosen = Deno.env.get("JEV_PROVIDER") === "mock" || !key ? "mock" : provider;
  if (chosen === "claude") {
    return { provider: chosen, classifier: claudeClassifier(new Anthropic({ apiKey: key!, maxRetries: 2 }) as unknown as MessagesClient, model, system, slugs) };
  }
  if (chosen === "openai") return { provider: chosen, classifier: openaiClassifier((url, init) => fetch(url, init), key!, model, system, slugs) };
  return { provider: "mock", classifier: mockClassifier(slugs, { failEvery: Number(Deno.env.get("JEV_MOCK_FAIL_EVERY") ?? 0) || undefined }) };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const db = serviceClient();
  const fromCron = isCron(req);
  const admin = fromCron ? null : await hubCuratorCaller(req);
  if (!fromCron && !admin) return json({ error: "Only hub admins and operators can run Jev" }, 403);

  const body = (await req.json().catch(() => ({}))) as Body;
  const action = body.action ?? "";
  const { data: settings } = await db.from("engine_settings").select("*").eq("engine", "jev").single();

  // Pick the titles.
  let entries: EntryRow[] = [];
  const cols = "id, kind, source, canonical_name, vendor, description, product_id";
  if (action === "auto") {
    if (!fromCron && !admin) return json({ error: "Forbidden" }, 403);
    const last = settings.last_auto_run_at ? Date.parse(settings.last_auto_run_at) : 0;
    if (Date.now() - last < settings.interval_hours * 3600_000) return json({ ok: true, skipped: "Not due yet" });
    const { data } = await db
      .from("entries")
      .select(cols)
      .eq("status", "pending")
      .gte("reports_count", settings.min_reports)
      .order("reports_count", { ascending: false })
      .order("first_reported_at")
      .limit(Math.min(settings.batch_size, MAX_TITLES));
    entries = (data ?? []) as EntryRow[];
  } else if (action === "run_selected" || action === "rerun") {
    if (!admin) return json({ error: "Only hub admins and operators can run Jev" }, 403);
    let q = db.from("entries").select(cols).neq("status", "deprecated");
    if (body.category_slug && action === "rerun") {
      const { data: cat } = await db.from("categories").select("id").eq("slug", body.category_slug).maybeSingle();
      if (!cat) return json({ error: "Unknown category" }, 400);
      q = q.eq("category_id", cat.id).eq("status", "published");
    } else {
      const ids = (body.entry_ids ?? []).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
      if (ids.length === 0 || ids.length > MAX_TITLES) return json({ error: `Choose 1 to ${MAX_TITLES} titles` }, 400);
      q = q.in("id", ids);
    }
    const { data } = await q.limit(MAX_TITLES);
    entries = (data ?? []) as EntryRow[];
  } else {
    return json({ error: "Unknown action" }, 400);
  }
  // One call per product: publishing one spelling publishes the others (publish_entry). The automatic run
  // also skips products that already wait for a decision on another spelling.
  const seen = new Set<string>();
  entries = entries.filter((e) => !e.product_id || (!seen.has(e.product_id) && seen.add(e.product_id) !== null));
  if (action === "auto" && seen.size > 0) {
    const { data: waiting } = await db.from("entries").select("product_id").eq("status", "proposed").in("product_id", [...seen]);
    const busy = new Set((waiting ?? []).map((w) => w.product_id as string));
    entries = entries.filter((e) => !e.product_id || !busy.has(e.product_id));
  }
  if (entries.length === 0) return json({ ok: true, skipped: "No titles to classify" });

  const { data: gate } = await db.rpc("jev_gate", { p_titles: entries.length, p_manual: action !== "auto" });
  if (!gate?.allowed) return json({ ok: false, error: gate?.reason ?? "Jev cannot run now" }, 409);
  if (action === "auto") await db.from("engine_settings").update({ last_auto_run_at: new Date().toISOString() }).eq("engine", "jev");

  // Options: the level-2 categories in seq order, so the cached system prompt never changes between calls.
  const { data: cats, error: catsError } = await db
    .from("categories")
    .select("slug, name, description, parent:parent_id(name)")
    .not("parent_id", "is", null)
    .eq("deprecated", false)
    .order("seq");
  if (catsError || !cats?.length) return json({ ok: false, error: `Could not read the categories${catsError ? `: ${catsError.message}` : ""}` }, 500);
  const options: CategoryOption[] = ((cats ?? []) as unknown as { slug: string; name: string; description: string | null; parent: { name: string } | null }[]).map(
    (c) => ({ slug: c.slug, name: c.name, description: c.description, level1: c.parent?.name ?? "" }),
  );
  const slugs = options.map((o) => o.slug);
  let classifier: Classifier;
  let provider: string;
  try {
    const { data: vaultKey } = await db.rpc("get_provider_key", { p_provider: settings.provider });
    const key = (vaultKey as string | null) ?? Deno.env.get(ENV_KEY[settings.provider] ?? "") ?? null;
    ({ classifier, provider } = classifierFor(settings.provider, key, settings.model, buildSystem(options), slugs));
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }

  const { data: runId, error: runError } = await db.rpc("jev_start_run", {
    p_entry_ids: entries.map((e) => e.id),
    p_started_by: admin?.userId ?? null,
    p_rerun: action === "rerun",
    p_model: classifier.model,
  });
  if (runError) return json({ ok: false, error: runError.message }, 500);

  const summary = { run_id: runId as string, titles: entries.length, auto_published: 0, proposals: 0, errors: 0, paused: false, pause_reason: null as string | null, newly_paused: false };
  for (let i = 0; i < entries.length && !summary.paused; i += CONCURRENCY) {
    await Promise.all(
      entries.slice(i, i + CONCURRENCY).map(async (entry) => {
        try {
          const result = await classifier.classify(entry);
          const { data: logged } = await db.rpc("record_ai_call", {
            p_engine: "jev", p_provider: provider, p_model: classifier.model, p_purpose: action === "rerun" ? "reclassify" : "classify", p_run_id: runId, p_titles: 1,
            p_input: result.usage.input, p_output: result.usage.output, p_cache_read: result.usage.cacheRead, p_cache_write: result.usage.cacheWrite,
            p_latency_ms: result.latencyMs, p_status: "ok",
          });
          if (logged?.paused) Object.assign(summary, { paused: true, pause_reason: logged.reason, newly_paused: summary.newly_paused || logged.newly_paused });
          const { data: outcome, error } = await db.rpc("jev_store_result", {
            p_run_id: runId, p_entry_id: entry.id, p_category_slug: result.category, p_probability: result.probability,
          });
          if (error) throw new Error(error.message);
          if (outcome === "auto_published") summary.auto_published++;
          else summary.proposals++;
        } catch (e) {
          summary.errors++;
          const err = e instanceof ClassifyError ? e : new ClassifyError((e as Error).message, null);
          const { data: logged } = await db.rpc("record_ai_call", {
            p_engine: "jev", p_provider: provider, p_model: classifier.model, p_purpose: "classify", p_run_id: runId, p_titles: 0,
            p_input: err.usage.input, p_output: err.usage.output, p_cache_read: err.usage.cacheRead, p_cache_write: err.usage.cacheWrite,
            p_latency_ms: null, p_status: "error", p_http_status: err.httpStatus, p_error: err.message,
          });
          if (logged?.paused) Object.assign(summary, { paused: true, pause_reason: logged.reason, newly_paused: summary.newly_paused || logged.newly_paused });
        }
      }),
    );
  }
  if (summary.newly_paused) await emailAdmins(db, "Jev paused", pausedEmailText("Jev", summary.pause_reason));
  await db.rpc("jev_finish_run", { p_run_id: runId, p_status: summary.paused ? "cancelled" : summary.errors === entries.length ? "failed" : "finished" });
  if (admin) {
    await db.from("audit_log").insert({ user_id: admin.userId, action: `jev ${action}`, target: runId as string, data: summary });
  }
  return json({ ok: true, provider, model: classifier.model, ...summary });
});
