// Deno glue shared by the client API functions: service role client, key authentication with the
// rate limit (public.client_call), JSON responses. Requests come from client Edge Functions, not
// browsers, so there is no CORS.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { sha256Hex } from "./validate.ts";

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export type CallingClient = { id: string; name: string };

// Bearer <client key> → the calling client, or the 401/429 response to return.
export async function authenticate(req: Request, db: SupabaseClient): Promise<CallingClient | Response> {
  const key = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!key) return json({ error: "Missing client key" }, 401);
  const { data, error } = await db.rpc("client_call", { p_key_hash: await sha256Hex(key) });
  if (error) return json({ error: "Could not check the client key" }, 500);
  const row = (data as { client_id: string | null; client_name: string | null; status: number; retry_after: number | null }[])[0];
  if (row.status === 429) return json({ error: "Rate limit: 60 calls per minute" }, 429, { "Retry-After": String(row.retry_after ?? 60) });
  if (row.status !== 200 || !row.client_id) return json({ error: "Invalid or revoked client key" }, 401);
  return { id: row.client_id, name: row.client_name ?? "" };
}

export type HubRole = "admin" | "operator" | "viewer";

// Console calls: the signed-in user and their Hub role (hub_members), checked with the user's own JWT.
export async function hubCaller(req: Request): Promise<{ userId: string; role: HubRole } | null> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const [{ data: user }, { data: role }] = await Promise.all([asUser.auth.getUser(token), asUser.rpc("hub_role")]);
  return user.user && typeof role === "string" ? { userId: user.user.id, role: role as HubRole } : null;
}

// Admins only (settings, users, digest).
export async function hubAdminCaller(req: Request): Promise<{ userId: string } | null> {
  const caller = await hubCaller(req);
  return caller?.role === "admin" ? { userId: caller.userId } : null;
}

// Admins and operators (curating: run Jev, run Research).
export async function hubCuratorCaller(req: Request): Promise<{ userId: string } | null> {
  const caller = await hubCaller(req);
  return caller && (caller.role === "admin" || caller.role === "operator") ? { userId: caller.userId } : null;
}

// pg_cron calls carry x-cron-secret (CRON_SECRET).
export function fromCron(req: Request): boolean {
  const secret = Deno.env.get("CRON_SECRET") ?? "";
  return secret.length >= 16 && req.headers.get("x-cron-secret") === secret;
}

const MAX_BODY_BYTES = 2_000_000;

export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("Body is too large");
  return JSON.parse(text);
}
