// Daily digest at 08:00 America/Sao_Paulo (pg_cron daily-digest, x-cron-secret) or on demand by an admin:
// new pending titles of the last 24 hours with their report counts, plus what waits in the Inbox.
// Emailed to every hub admin through Resend when RESEND_API_KEY and HUB_EMAIL_FROM are set.

import { fromCron, hubAdminCaller, json, serviceClient } from "../_shared/client-api.ts";

type Digest = { pending_total: number; open_requests: number; proposals: number; new_titles: { name: string; kind: string; reports: number }[] };

export function digestText(d: Digest, consoleUrl: string): string {
  const lines = d.new_titles.map((t) => `- ${t.name} (${t.kind}, ${t.reports} client${t.reports === 1 ? "" : "s"})`);
  return [
    `New titles in the last 24 hours: ${d.new_titles.length}`,
    ...lines,
    "",
    `Waiting in the Inbox: ${d.pending_total} pending titles, ${d.proposals} Jev proposals, ${d.open_requests} open reclassification requests.`,
    `Open the console: ${consoleUrl}`,
  ].join("\n");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!fromCron(req) && !(await hubAdminCaller(req))) return json({ error: "Forbidden" }, 403);

  const db = serviceClient();
  const { data, error } = await db.rpc("build_digest");
  if (error) return json({ ok: false, error: error.message }, 500);
  const digest = data as Digest;
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("HUB_EMAIL_FROM");
  if (!key || !from) return json({ ok: true, sent: false, reason: "Email is not configured", digest });

  const { data: emails } = await db.rpc("hub_admin_emails");
  const to = (emails as string[] | null) ?? [];
  if (to.length === 0) return json({ ok: true, sent: false, reason: "No hub admins", digest });
  const res = await fetch(Deno.env.get("RESEND_API_URL") || "https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to,
      subject: `[Dictionary Hub] Daily digest: ${digest.new_titles.length} new title(s), ${digest.open_requests} open request(s)`,
      text: digestText(digest, Deno.env.get("HUB_CONSOLE_URL") ?? "http://localhost:5175"),
    }),
  });
  await res.body?.cancel();
  return json({ ok: res.ok, sent: res.ok, recipients: to.length, digest });
});
