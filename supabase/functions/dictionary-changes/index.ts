// GET dictionary-changes?since=<seq>&limit=1000 → { entries, categories, next_seq, has_more }
// Published fields only; deprecated entries included so clients drop them (public.dictionary_changes).

import { authenticate, json, serviceClient } from "../_shared/client-api.ts";

Deno.serve(async (req) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const db = serviceClient();
  const caller = await authenticate(req, db);
  if (caller instanceof Response) return caller;

  const url = new URL(req.url);
  const since = Number(url.searchParams.get("since") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 1000);
  if (!Number.isInteger(since) || since < 0) return json({ error: "since must be a non-negative integer" }, 400);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return json({ error: "limit must be 1 to 1000" }, 400);

  const { data, error } = await db.rpc("dictionary_changes", { p_client_id: caller.id, p_since: since, p_limit: limit });
  if (error) return json({ error: "Could not read the dictionary changes" }, 500);
  return json(data);
});
