import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { AuthContext, type AuthContextValue } from "./auth-context";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [admin, setAdmin] = useState<{ userId: string; value: boolean } | null>(null);

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
    supabase.rpc("is_hub_admin").then(({ data }) => {
      if (active) setAdmin({ userId, value: data === true });
    });
    return () => {
      active = false;
    };
  }, [userId]);

  // Sign-ups are off: only accounts created by `npm run admin:add` get a link.
  const sendMagicLink = useCallback(async (email: string, redirectPath: string) => {
    if (!supabase) return { error: "Supabase is not configured." };
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: new URL(redirectPath, window.location.origin).toString() },
    });
    if (error && /signups not allowed|not found/i.test(error.message)) {
      return { error: "This email has no access to the Dictionary Hub. Ask a hub admin to add you." };
    }
    return { error: error?.message ?? null };
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
      isHubAdmin: admin && admin.userId === userId ? admin.value : null,
      sendMagicLink,
      signOut,
    };
  }, [session, admin, userId, sendMagicLink, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
