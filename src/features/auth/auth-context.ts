import { createContext, useContext } from "react";
import type { Session, User } from "@supabase/supabase-js";

export type AuthStatus = "loading" | "signed_out" | "signed_in" | "unconfigured";

export type AuthContextValue = {
  status: AuthStatus;
  session: Session | null;
  user: User | null;
  // Whether the signed-in user is listed in hub_admins; null while checking or when signed out.
  isHubAdmin: boolean | null;
  sendMagicLink: (email: string, redirectPath: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
