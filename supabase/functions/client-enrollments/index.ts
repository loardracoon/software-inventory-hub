// Access requests from Endpoint Inventory installations (phase H8). Public (no JWT): each action checks its own
// credential. The installation makes its client key and sends only the SHA-256 hash: the key is never handed over
// (not in the request, not in an email), and an approval only switches that pending key to active.
//   POST { action: "create", name, organization, contact_email, reason, key_hash, key_prefix, consent_version,
//          client_version } → 202 with the same answer whether the address is new or known; 403 domain not allowed,
//          404 requests are closed, 429 too many from this address, 503 too many open requests
//   POST { action: "confirm", token }        the contact pressed Confirm on the console page the email links to
//   GET  Authorization: Bearer <client key>  → { status, note, expires_at } of that key's request
//   POST { action: "cancel" } with Bearer <client key>
//   POST { action: "decide", id, approve, note } with a hub admin JWT; the contact gets an email
// Hub admins learn about requests from the Inbox notification and the weekly digest, not from one email each.

import { sendEmail } from "../_shared/admin-email.ts";
import { callerIp, hubAdminCaller, json, readJson, serviceClient, userClient } from "../_shared/client-api.ts";
import { sha256Hex, validateEnrollment } from "../_shared/validate.ts";

const ACCEPTED = { status: "unverified", message: "If this address can request access, a confirmation email was sent to it." };
const consoleUrl = () => (Deno.env.get("HUB_CONSOLE_URL") ?? "http://localhost:5175").replace(/\/+$/, "");
const bearer = (req: Request) => req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const db = serviceClient();

  if (req.method === "GET") {
    const key = bearer(req);
    if (!key.startsWith("hubk_")) return json({ error: "Missing client key" }, 401);
    const { data, error } = await db.rpc("enrollment_status", { p_key_hash: await sha256Hex(key) });
    if (error) return json({ error: "Could not read the request" }, 500);
    return data ? json(data) : json({ status: "unknown" }, 404);
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = (await readJson(req)) as Record<string, unknown>;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("not an object");
  } catch {
    return json({ error: "Body must be a JSON object" }, 400);
  }

  switch (body.action) {
    case "create": {
      const input = validateEnrollment(body);
      if (!input.ok) return json({ error: input.error }, 400);
      const e = input.value;
      const token = randomHex(32);
      const { data, error } = await db.rpc("enrollment_create", { p: { ...e, ip: callerIp(req), token_hash: await sha256Hex(token) } });
      if (error) return json({ error: "Could not store the request" }, 500);
      const outcome = (data as { outcome: string }).outcome;
      if (outcome === "disabled") return json({ error: "This Hub does not take access requests" }, 404);
      if (outcome === "domain") return json({ error: "Requests from this email domain are not accepted" }, 403);
      if (outcome === "rate_ip") return json({ error: "Too many requests from this address; try again later" }, 429, { "Retry-After": "3600" });
      if (outcome === "busy") return json({ error: "Too many open requests; try again later" }, 503);
      if (outcome === "created") {
        await sendEmail([e.contact_email], "Confirm your access request", [
          `Someone asked for a Dictionary Hub client key for the Endpoint Inventory installation "${e.name}" with this email address.`,
          "",
          "To confirm the request, open this link and press Confirm (valid for 24 hours):",
          `${consoleUrl()}/enroll/confirm?token=${token}`,
          "",
          "If you did not ask for this, ignore this email: the request expires by itself.",
        ].join("\n"));
      }
      // created, ignored (known address or key, or the daily limit of this email): the same answer.
      return json(ACCEPTED, 202);
    }

    case "confirm": {
      const token = typeof body.token === "string" ? body.token : "";
      if (!/^[0-9a-f]{64}$/.test(token)) return json({ status: "invalid" }, 400);
      const { data, error } = await db.rpc("enrollment_confirm", { p_token_hash: await sha256Hex(token) });
      if (error) return json({ error: "Could not confirm the request" }, 500);
      const r = data as { status: string; name?: string; contact_email?: string };
      if (r.status === "approved" && r.contact_email) await emailDecision(r.contact_email, r.name ?? "", true, null);
      return json({ status: r.status }, r.status === "invalid" ? 404 : 200);
    }

    case "cancel": {
      const key = bearer(req);
      if (!key.startsWith("hubk_")) return json({ error: "Missing client key" }, 401);
      const { data, error } = await db.rpc("enrollment_cancel", { p_key_hash: await sha256Hex(key) });
      if (error) return json({ error: "Could not cancel the request" }, 500);
      return data ? json(data) : json({ status: "unknown" }, 404);
    }

    case "decide": {
      if (!(await hubAdminCaller(req))) return json({ error: "Forbidden" }, 403);
      const id = typeof body.id === "string" ? body.id : "";
      const note = typeof body.note === "string" ? body.note : null;
      if (!/^[0-9a-f-]{36}$/i.test(id) || typeof body.approve !== "boolean") return json({ error: "id and approve are required" }, 400);
      const { data, error } = await userClient(req).rpc("enrollment_decide", { p_id: id, p_approve: body.approve, p_note: note });
      if (error) return json({ error: error.message }, error.code === "22023" || error.code === "P0002" ? 400 : 500);
      const r = data as { status: string; name: string; contact_email: string; note: string | null };
      await emailDecision(r.contact_email, r.name, r.status === "approved", r.note);
      return json({ status: r.status });
    }

    default:
      return json({ error: "action must be create, confirm, cancel or decide" }, 400);
  }
});

// Best effort: the installation also reads the decision itself.
async function emailDecision(to: string, name: string, approved: boolean, note: string | null) {
  await sendEmail([to], approved ? "Access request approved" : "Access request rejected", [
    approved
      ? `The access request of the Endpoint Inventory installation "${name}" was approved. The installation connects to the Hub by itself within 15 minutes; nothing else is needed.`
      : `The access request of the Endpoint Inventory installation "${name}" was rejected.`,
    ...(note ? ["", `Note from the Hub admin: ${note}`] : []),
    "",
    "The client key was made by your installation and is not in this email.",
  ].join("\n"));
}
