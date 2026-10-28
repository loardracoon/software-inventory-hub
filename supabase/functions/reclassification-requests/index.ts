// POST reclassification-requests { kind, source, match_key, suggested_category_id, reason, evidence_url }
//   → { id: "REQ-0042", status: "open" }; the client's open request for the entry is returned instead of
//   a second one. A new request notifies the inbox and emails every hub admin (SMTP or Resend, when configured).
// GET reclassification-requests?ids=REQ-0042,REQ-0043 → [{ id, status, admin_note }], own requests only.

import { emailAdmins } from "../_shared/admin-email.ts";
import { authenticate, json, readJson, serviceClient } from "../_shared/client-api.ts";
import { parseRequestIds, validateRequest } from "../_shared/validate.ts";

type Opened = { id: string; status: string; created: boolean; title?: string; current_category?: string; suggested_category?: string; client?: string; reason?: string };

Deno.serve(async (req) => {
  const db = serviceClient();
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const caller = await authenticate(req, db);
  if (caller instanceof Response) return caller;

  if (req.method === "GET") {
    const ids = parseRequestIds(new URL(req.url).searchParams.get("ids"));
    if (!ids.ok) return json({ error: ids.error }, 400);
    const { data, error } = await db.rpc("request_statuses", { p_client_id: caller.id, p_ids: ids.value });
    if (error) return json({ error: "Could not read the requests" }, 500);
    return json(data);
  }

  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }
  const input = validateRequest(body);
  if (!input.ok) return json({ error: input.error }, 400);
  const r = input.value;
  const { data, error } = await db.rpc("open_reclassification_request", {
    p_client_id: caller.id,
    p_kind: r.kind,
    p_source: r.source,
    p_match_key: r.match_key,
    p_suggested_category_id: r.suggested_category_id,
    p_reason: r.reason,
    p_evidence_url: r.evidence_url,
  });
  if (error) return json({ error: error.code === "22023" ? error.message : "Could not open the request" }, error.code === "22023" ? 400 : 500);
  const opened = data as Opened;
  if (opened.created) await emailRequest(db, opened);
  return json({ id: opened.id, status: opened.status }, opened.created ? 201 : 200);
});

// Best effort: the request is stored and in the inbox even when email fails or is not configured.
async function emailRequest(db: ReturnType<typeof serviceClient>, r: Opened) {
  const link = `${(Deno.env.get("HUB_CONSOLE_URL") ?? "http://localhost:5175").replace(/\/+$/, "")}/?request=${encodeURIComponent(r.id)}`;
  // Client text is untrusted: plain text email only.
  const text = [
    `${r.client} asks to reclassify ${r.title}.`,
    "",
    `Current category: ${r.current_category}`,
    `Suggested category: ${r.suggested_category}`,
    `Reason: ${r.reason}`,
    "",
    `Open the request: ${link}`,
  ].join("\n");
  await emailAdmins(db, `${r.id}: reclassify ${r.title}`, text);
}
