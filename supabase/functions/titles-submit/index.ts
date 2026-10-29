// POST titles-submit { titles: [{ kind, source, match_key, name, vendor, description, platforms? }] } (max 500).
// platforms: the OS families (windows, macos, linux) where the client found the title. Any other field
// is rejected. Unknown titles become pending entries; known ones count one more client.

import { authenticate, json, readJson, serviceClient } from "../_shared/client-api.ts";
import { validateTitles } from "../_shared/validate.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const db = serviceClient();
  const caller = await authenticate(req, db);
  if (caller instanceof Response) return caller;

  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    return json({ error: "Body must be JSON (at most 2 MB)" }, 400);
  }
  const titles = validateTitles(body);
  if (!titles.ok) return json({ error: titles.error }, 400);

  const { data, error } = await db.rpc("submit_titles", { p_client_id: caller.id, p_titles: titles.value });
  if (error) return json({ error: "Could not store the titles" }, 500);
  return json(data);
});
