// Known vulnerabilities (phase H7, _shared/vuln-sync.ts). pg_cron calls it hourly with x-cron-secret
// ({ action: "tick" }); a hub admin or operator refreshes one product from its entry page
// ({ action: "product", product_id }). Every run is logged in vuln_sync_runs.

import { fromCron, hubCuratorCaller, json, serviceClient } from "../_shared/client-api.ts";
import { runVulnSync, type RpcClient } from "../_shared/vuln-sync.ts";

const BUDGET_MS = 140_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const startedAt = Date.now();
  const cron = fromCron(req);
  const caller = cron ? null : await hubCuratorCaller(req);
  if (!cron && !caller) return json({ error: "Only hub admins and operators refresh vulnerabilities" }, 403);

  const body = (await req.json().catch(() => ({}))) as { action?: string; product_id?: string };
  if (!cron && (body.action !== "product" || !UUID.test(body.product_id ?? ""))) return json({ error: "Choose a product" }, 400);

  const db = serviceClient();
  const { data: key } = await db.rpc("get_provider_key", { p_provider: "nvd" });
  const { data: runId } = await db.rpc("vuln_run_start", { p_trigger: cron ? "cron" : "manual" });
  try {
    const summary = await runVulnSync(db as unknown as RpcClient, {
      fetchFn: (url, init) => fetch(url, init),
      nvdKey: (key as string | null) ?? null,
      timeLeft: () => BUDGET_MS - (Date.now() - startedAt),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      productId: cron ? undefined : body.product_id,
    });
    await db.rpc("vuln_run_finish", { p_id: runId, p_summary: summary, p_errors: summary.errors });
    if (caller) {
      await db.from("audit_log").insert({ user_id: caller.userId, action: "refresh vulnerabilities", target: `products:${body.product_id}`, data: summary });
    }
    return json({ ok: summary.errors.length === 0, ...summary });
  } catch (error) {
    const message = (error as Error).message;
    await db.rpc("vuln_run_finish", { p_id: runId, p_summary: null, p_errors: [message] });
    return json({ ok: false, error: message }, 500);
  }
});
