// Turns the Hub's pg_cron jobs (jev-auto, research-tick, daily-digest) on or off by writing (or removing) the Vault secrets they read:
// jev_url (the jev Edge Function as seen from the database container) and cron_secret (CRON_SECRET from
// supabase/functions/.env, which the function checks in x-cron-secret).
// Usage: npm run cron:configure            (on)
//        npm run cron:configure -- --off   (off)
// Remote projects: create the same two Vault secrets in the SQL editor with the project's function URL.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const DB_CONTAINER = "supabase_db_dictionary-hub";
const off = process.argv.includes("--off");

let sql = "delete from vault.secrets where name in ('jev_url', 'cron_secret');\n";
if (!off) {
  const env = readFileSync("supabase/functions/.env", "utf8");
  const secret = /^CRON_SECRET=(.*)$/m.exec(env)?.[1]?.trim() ?? "";
  if (secret.length < 16) {
    console.error("Set CRON_SECRET (16+ characters) in supabase/functions/.env first, and restart the stack.");
    process.exit(1);
  }
  const quote = (s) => `'${s.replace(/'/g, "''")}'`;
  sql += `select vault.create_secret(${quote("http://kong:8000/functions/v1/jev")}, 'jev_url');\n`;
  sql += `select vault.create_secret(${quote(secret)}, 'cron_secret');\n`;
}
const result = spawnSync("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });
if (result.status !== 0) {
  console.error(result.stderr || "psql failed");
  process.exit(1);
}
console.log(off ? "Hub cron jobs are off." : "Hub cron jobs are on: jev-auto (hourly, runs when due), research-tick (hourly, works the research queue) and daily-digest.");
