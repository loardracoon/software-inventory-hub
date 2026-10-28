// Daily digest at 08:00 America/Sao_Paulo (pg_cron daily-digest, x-cron-secret) or on demand by an admin:
// new pending titles of the last 24 hours with their report counts, plus what waits in the Inbox.
// Emailed to every hub admin through the admin sender (_shared/admin-email.ts: SMTP or Resend).

import { emailAdmins } from "../_shared/admin-email.ts";
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
  const subject = `Daily digest: ${digest.new_titles.length} new title(s), ${digest.open_requests} open request(s)`;
  const mail = await emailAdmins(db, subject, digestText(digest, Deno.env.get("HUB_CONSOLE_URL") ?? "http://localhost:5175"));
  // ok is false only when a send failed; "not configured" and "no admins" are not errors.
  return json({ ok: mail.sent || mail.recipients === 0, ...mail, digest });
});
