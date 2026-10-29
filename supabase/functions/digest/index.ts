// Daily digest at 08:00 America/Sao_Paulo (pg_cron daily-digest, x-cron-secret) or on demand by an admin:
// new pending titles of the last 24 hours with their report counts, CVEs that became known exploited on
// mapped products, plus what waits in the Inbox (text in _shared/digest.ts).
// Emailed to every hub admin through the admin sender (_shared/admin-email.ts: SMTP or Resend).

import { emailAdmins } from "../_shared/admin-email.ts";
import { fromCron, hubAdminCaller, json, serviceClient } from "../_shared/client-api.ts";
import { digestSubject, digestText, type Digest } from "../_shared/digest.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!fromCron(req) && !(await hubAdminCaller(req))) return json({ error: "Forbidden" }, 403);

  const db = serviceClient();
  const { data, error } = await db.rpc("build_digest");
  if (error) return json({ ok: false, error: error.message }, 500);
  const digest = data as Digest;
  const subject = digestSubject(digest);
  const mail = await emailAdmins(db, subject, digestText(digest, Deno.env.get("HUB_CONSOLE_URL") ?? "http://localhost:5175"));
  // ok is false only when a send failed; "not configured" and "no admins" are not errors.
  return json({ ok: mail.sent || mail.recipients === 0, ...mail, digest });
});
