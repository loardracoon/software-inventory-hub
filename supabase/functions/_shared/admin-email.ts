// Plain-text email to every hub admin through Resend; best effort (the inbox notification is the record).
// Skipped when RESEND_API_KEY or HUB_EMAIL_FROM is not set.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";

export async function emailAdmins(db: SupabaseClient, subject: string, text: string): Promise<boolean> {
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("HUB_EMAIL_FROM");
  if (!key || !from) return false;
  const { data } = await db.rpc("hub_admin_emails");
  const to = (data as string[] | null) ?? [];
  if (to.length === 0) return false;
  try {
    const res = await fetch(Deno.env.get("RESEND_API_URL") || "https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject: `[Dictionary Hub] ${subject}`, text }),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

export function pausedEmailText(engine: string, reason: string | null): string {
  const console = (Deno.env.get("HUB_CONSOLE_URL") ?? "http://localhost:5175").replace(/\/+$/, "");
  return `${engine} was paused: ${reason ?? "no reason given"}.\nIt stays paused until a hub admin resumes it in Engines & usage: ${console}/engines`;
}
