// Access requests of Endpoint Inventory installations (phase H8): the Inbox tab, the Settings card and the public
// Confirm page. Decisions go through the client-enrollments function, which also emails the requester.

import { supabase } from "@/integrations/supabase/client";
import { db, invokeFunction, orThrow } from "@/lib/supabase-query";

export type AccessRequest = {
  id: string;
  name: string;
  organization: string | null;
  contact_email: string;
  reason: string | null;
  status: "unverified" | "pending" | "approved" | "rejected" | "expired" | "cancelled";
  auto_approved: boolean;
  consent_version: string;
  created_at: string;
  verified_at: string | null;
  decided_at: string | null;
  decision_note: string | null;
  expires_at: string;
};

export type EnrollmentSettings = { enabled: boolean; allowed_domains: string[]; auto_approve_domains: string[]; updated_at: string | null };

// Open requests and the decisions of the last 30 days.
export async function fetchAccessRequests(): Promise<AccessRequest[]> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  return (orThrow(
    await db()
      .from("client_enrollments")
      .select("id, name, organization, contact_email, reason, status, auto_approved, consent_version, created_at, verified_at, decided_at, decision_note, expires_at")
      .or(`status.in.(unverified,pending),created_at.gte.${since}`)
      .order("created_at", { ascending: false })
      .limit(200),
  ) ?? []) as AccessRequest[];
}

export async function decideAccessRequest(id: string, approve: boolean, note: string): Promise<void> {
  await invokeFunction("client-enrollments", { action: "decide", id, approve, note: note.trim() || null });
}

export async function fetchEnrollmentSettings(): Promise<EnrollmentSettings | null> {
  const rows = orThrow(await db().rpc("get_enrollment_settings")) ?? [];
  return (rows[0] as EnrollmentSettings | undefined) ?? null;
}

export async function saveEnrollmentSettings(enabled: boolean, allowed: string[], autoApprove: string[]): Promise<void> {
  orThrow(await db().rpc("set_enrollment_settings", { p_enabled: enabled, p_allowed_domains: allowed, p_auto_approve_domains: autoApprove }));
}

// "sophos.com, partner.example" → ["sophos.com", "partner.example"]
export function parseDomains(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
}

// Public page (no sign-in): the token comes from the email link; the function answers pending, approved or invalid.
export async function confirmAccessRequest(token: string): Promise<"pending" | "approved" | "invalid"> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.functions.invoke<{ status: string }>("client-enrollments", { method: "POST", body: { action: "confirm", token } });
  if (error) {
    const status = (error as { context?: Response }).context?.status;
    if (status === 400 || status === 404) return "invalid";
    throw new Error("Could not confirm the request. Try again later.");
  }
  return data?.status === "approved" ? "approved" : data?.status === "pending" ? "pending" : "invalid";
}
