// Plain-text email to every hub admin; best effort (the inbox notification is the record).
// SMTP when SMTP_HOST is set (Mailu on the VPS, Mailpit locally), otherwise Resend when RESEND_API_KEY and
// HUB_EMAIL_FROM are set, otherwise skipped. Never throws.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { connectSmtp, sendSmtp, smtpConfigFromEnv } from "./smtp.ts";

export type EmailResult = { sent: boolean; recipients: number; reason?: string };

export async function emailAdmins(db: SupabaseClient, subject: string, text: string): Promise<EmailResult> {
  const env = (name: string) => Deno.env.get(name);
  const smtp = smtpConfigFromEnv(env);
  const resendKey = env("RESEND_API_KEY");
  const resendFrom = env("HUB_EMAIL_FROM");
  if (!smtp && !(resendKey && resendFrom)) return { sent: false, recipients: 0, reason: "Email is not configured" };

  const { data } = await db.rpc("hub_admin_emails");
  const to = (data as string[] | null) ?? [];
  if (to.length === 0) return { sent: false, recipients: 0, reason: "No hub admins" };
  const fullSubject = `[Dictionary Hub] ${subject}`;

  try {
    if (smtp) {
      await sendSmtp(await connectSmtp(smtp), smtp, { to, subject: fullSubject, text });
      return { sent: true, recipients: to.length };
    }
    const res = await fetch(env("RESEND_API_URL") || "https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: resendFrom, to, subject: fullSubject, text }),
    });
    await res.body?.cancel();
    return res.ok ? { sent: true, recipients: to.length } : { sent: false, recipients: to.length, reason: `Resend HTTP ${res.status}` };
  } catch (error) {
    // The message only: never the login or the server's full reply.
    const reason = (error as Error).message.slice(0, 200);
    console.error(`Admin email failed: ${reason}`);
    return { sent: false, recipients: to.length, reason };
  }
}

export function pausedEmailText(engine: string, reason: string | null): string {
  const console = (Deno.env.get("HUB_CONSOLE_URL") ?? "http://localhost:5175").replace(/\/+$/, "");
  return `${engine} was paused: ${reason ?? "no reason given"}.\nIt stays paused until a hub admin resumes it in Engines & usage: ${console}/engines`;
}
