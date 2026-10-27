import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { Loader2, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { useAuth } from "./auth-context";

function Loading() {
  return (
    <div role="status" className="flex min-h-svh items-center justify-center gap-3 text-text-muted">
      <Loader2 className="size-5 animate-spin" aria-hidden="true" />
      Loading
    </div>
  );
}

// Signed in and listed in hub_admins; anyone else sees "Access denied" (RLS also denies them every row).
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, isHubAdmin, user, signOut } = useAuth();
  const location = useLocation();

  if (status === "unconfigured") {
    return (
      <div className="mx-auto max-w-xl p-6 pt-24">
        <EmptyState
          title="Supabase is not configured"
          description="Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local (see CLAUDE.md › Commands) and restart the dev server."
        />
      </div>
    );
  }
  if (status === "loading") return <Loading />;
  if (status === "signed_out") {
    const from = `${location.pathname}${location.search}`;
    return <Navigate to="/login" replace state={{ from }} />;
  }
  if (isHubAdmin === null) return <Loading />;
  if (!isHubAdmin) {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4 p-6 pt-24">
        <EmptyState
          icon={ShieldX}
          title="Access denied"
          description={`${user?.email ?? "This account"} is not a Dictionary Hub admin. Ask a hub admin to add you.`}
        />
        <Button variant="secondary" size="sm" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    );
  }
  return children;
}
