// Settings › Users and access › "Add user" (hub admins only): writes the email rule with the chosen role
// and sends a one-click sign-in email. A new person gets an Auth invitation (the account is created now
// and takes the rule's role); an existing member gets the new role and a magic link.

import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { hubAdminCaller, json, serviceClient } from "../_shared/client-api.ts";
import { INVITE_ACTIONS, invitesPerHour, parseInvite } from "../_shared/users.ts";

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const caller = await hubAdminCaller(req);
  if (!caller) return json({ error: "Only hub admins manage users" }, 403);

  let invite;
  try {
    invite = parseInvite(await req.json().catch(() => null));
  } catch (error) {
    return json({ error: (error as Error).message }, 400);
  }

  const db = serviceClient();

  // At most RL_INVITES_PER_HOUR emails per admin per hour.
  const perHour = invitesPerHour(Deno.env.get("RL_INVITES_PER_HOUR"));
  const { count: sentLastHour } = await db
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .eq("user_id", caller.userId)
    .in("action", INVITE_ACTIONS)
    .gte("created_at", new Date(Date.now() - 3_600_000).toISOString());
  if ((sentLastHour ?? 0) >= perHour) {
    return json({ error: `Limit reached: ${perHour} invitations or sign-in links per hour. Try again later.` }, 429);
  }

  try {
    const { data: member } = await db.from("hub_members").select("user_id, role").eq("email", invite.email).maybeSingle();
    if (member && member.role === "admin" && invite.role !== "admin") {
      const { count } = await db.from("hub_members").select("user_id", { count: "exact", head: true }).eq("role", "admin");
      if ((count ?? 0) <= 1) return json({ error: "Keep at least one admin" }, 409);
    }

    // The rule first: Auth refuses to create an account without one.
    const { error: ruleError } = await db
      .from("access_rules")
      .upsert({ kind: "email", value: invite.email, role: invite.role, created_by: caller.userId }, { onConflict: "kind,value" });
    if (ruleError) throw new Error(`Could not save the access rule: ${ruleError.message}`);

    // An existing account (a member, or one made by a script) takes the rule's role now.
    const { data: existed, error: memberError } = await db.rpc("ensure_hub_member", { p_email: invite.email });
    if (memberError) throw new Error(`Could not set the role: ${memberError.message}`);

    let status: "invited" | "existing";
    if (existed === true) {
      // A magic link through the public endpoint, as if the person asked for it on the sign-in page.
      const anon = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error: otpError } = await anon.auth.signInWithOtp({
        email: invite.email,
        options: { shouldCreateUser: false, ...(invite.redirectTo ? { emailRedirectTo: invite.redirectTo } : {}) },
      });
      if (otpError) throw new HttpError(otpError.status ?? 502, `Role saved, but the sign-in email failed: ${otpError.message}`);
      status = "existing";
    } else {
      // A new account: the trigger gives it the rule's role.
      const { error } = await db.auth.admin.inviteUserByEmail(invite.email, invite.redirectTo ? { redirectTo: invite.redirectTo } : {});
      if (error) throw new HttpError(error.status ?? 502, `Could not send the invitation: ${error.message}`);
      status = "invited";
    }

    await db.from("audit_log").insert({
      user_id: caller.userId,
      action: status === "invited" ? "invite user" : "send sign-in link",
      target: `access_rules:email:${invite.email}`,
      data: { email: invite.email, role: invite.role },
    });
    return json({ ok: true, status, email: invite.email, role: invite.role });
  } catch (error) {
    return json({ error: (error as Error).message }, error instanceof HttpError ? error.status : 500);
  }
});
