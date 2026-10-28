// Adds a hub admin: an admin email rule (so Auth accepts the account), the Auth account, and the admin
// membership in hub_members. Use it for the first admin or to recover access; afterwards admins add people
// in Settings › Users and access.
// Usage: npm run admin:add -- someone@example.com
// Local stack by default (URL and service role key from `supabase status`); for a remote project set
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment. The key is never printed.
import { spawnSync } from "node:child_process";

const email = (process.argv[2] ?? "").trim().toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error("Usage: npm run admin:add -- <email>");
  process.exit(1);
}

let url = process.env.SUPABASE_URL;
let key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  const status = spawnSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8", shell: true });
  const env = Object.fromEntries(
    status.stdout.split(/\r?\n/).map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/)).filter(Boolean).map((m) => [m[1], m[2]]),
  );
  url = env.API_URL;
  key = env.SERVICE_ROLE_KEY;
}
if (!url || !key) {
  console.error("Could not find the Supabase URL and service role key. Is the stack running (npm run db:start)?");
  process.exit(1);
}

const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

async function findUser() {
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=200`, { headers });
    if (!res.ok) throw new Error(`Listing users failed: HTTP ${res.status}`);
    const { users } = await res.json();
    const user = users.find((u) => u.email?.toLowerCase() === email);
    if (user || users.length < 200) return user ?? null;
  }
  return null;
}

async function upsert(table, onConflict, row) {
  const res = await fetch(`${url}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`Writing ${table} failed: HTTP ${res.status} ${await res.text()}`);
}

await upsert("access_rules", "kind,value", { kind: "email", value: email, role: "admin" });
let user = await findUser();
if (!user) {
  const res = await fetch(`${url}/auth/v1/admin/users`, { method: "POST", headers, body: JSON.stringify({ email, email_confirm: true }) });
  if (!res.ok) throw new Error(`Creating the account failed: HTTP ${res.status} ${await res.text()}`);
  user = await res.json();
}

await upsert("hub_members", "user_id", { user_id: user.id, email, role: "admin" });
console.log(`${email} is a hub admin. Sign in at the console with a magic link.`);
