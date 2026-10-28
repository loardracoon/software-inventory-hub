import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { AuthContext, type AuthContextValue, type HubRole } from "./auth-context";
import { signInErrorMessage } from "./sign-in-error";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [role, setRole] = useState<{ userId: string; value: HubRole | "none" } | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session);
    });
    // Keep this callback synchronous: calling Supabase from inside it can deadlock the auth lock.
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (!supabase || !userId) return;
    let active = true;
    supabase.rpc("hub_role").then(({ data }) => {
      if (active) setRole({ userId, value: typeof data === "string" ? (data as HubRole) : "none" });
    });
    return () => {
      active = false;
    };
  }, [userId]);

  // An email with an access rule (Settings › Users and access) gets an account on its first sign-in;
  // Auth refuses any other email (trigger before_auth_user_created).
  const sendMagicLink = useCallback(async (email: string, redirectPath: string) => {
    if (!supabase) return { error: "Supabase is not configured." };
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true, emailRedirectTo: new URL(redirectPath, window.location.origin).toString() },
    });
    return { error: error ? signInErrorMessage(error.message) : null };
  }, []);

  const signOut = useCallback(async () => {
    await supabase?.auth.signOut();
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const status = !supabase ? "unconfigured" : session === undefined ? "loading" : session ? "signed_in" : "signed_out";
    return {
      status,
      session: session ?? null,
      user: session?.user ?? null,
      role: role && role.userId === userId ? role.value : null,
      sendMagicLink,
      signOut,
    };
  }, [session, role, userId, sendMagicLink, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
