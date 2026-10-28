import { createContext, useContext } from "react";
import type { Session, User } from "@supabase/supabase-js";

export type AuthStatus = "loading" | "signed_out" | "signed_in" | "unconfigured";
export type HubRole = "admin" | "operator" | "viewer";

export type AuthContextValue = {
  status: AuthStatus;
  session: Session | null;
  user: User | null;
  // The signed-in user's Hub role (hub_members); "none" = no access; null while checking or when signed out.
  role: HubRole | "none" | null;
  sendMagicLink: (email: string, redirectPath: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}

// admin: everything; operator: curates (edits, publishes, decides, runs Jev and Research); viewer: reads.
export function useHubRole(): { role: HubRole | null; isAdmin: boolean; canCurate: boolean } {
  const { role } = useAuth();
  const r = role === "none" ? null : role;
  return { role: r, isAdmin: r === "admin", canCurate: r === "admin" || r === "operator" };
}
