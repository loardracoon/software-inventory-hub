// Digest, run every day at 08:00 America/Sao_Paulo (pg_cron daily-digest, x-cron-secret) or on demand by an admin
// ({ "weekly": true } for the weekly one). On Mondays: the weekly summary of what waits (new titles, access requests,
// reclassification requests, proposals, CPE matches; text in _shared/digest.ts). Other days: an email only when CVEs
// became known exploited on mapped products in the last 24 hours. Every run also ends access requests older than 14
// days. Emailed to every hub admin through the admin sender (_shared/admin-email.ts: SMTP or Resend).

import { emailAdmins } from "../_shared/admin-email.ts";
import { fromCron, hubAdminCaller, json, readJson, serviceClient } from "../_shared/client-api.ts";
import { digestSubject, digestText, isDigestWeek, type Digest } from "../_shared/digest.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const cron = fromCron(req);
  if (!cron && !(await hubAdminCaller(req))) return json({ error: "Forbidden" }, 403);
  const body = (await readJson(req).catch(() => ({}))) as { weekly?: boolean };

  const db = serviceClient();
  await db.rpc("expire_enrollments");
  const weekly = body?.weekly === true || (cron && isDigestWeek(new Date()));
  const { data, error } = await db.rpc("build_digest", { p_weekly: weekly });
  if (error) return json({ ok: false, error: error.message }, 500);
  const digest = data as Digest;
  if (!weekly && !(digest.new_kev?.length)) return json({ ok: true, sent: false, reason: "Nothing for today (the summary goes weekly)", digest });
  const mail = await emailAdmins(db, digestSubject(digest), digestText(digest, Deno.env.get("HUB_CONSOLE_URL") ?? "http://localhost:5175"));
  // ok is false only when a send failed; "not configured" and "no admins" are not errors.
  return json({ ok: mail.sent || mail.recipients === 0, ...mail, digest });
});
