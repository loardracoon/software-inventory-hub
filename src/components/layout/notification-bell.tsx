import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Bell } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { formatDateTime } from "@/lib/format";
import { db, orThrow } from "@/lib/supabase-query";

type Notification = { id: number; type: string; ref_id: string | null; title: string; created_at: string };

const REFRESH_MS = 60_000;

export async function fetchUnread(): Promise<{ count: number; latest: Notification[] }> {
  const { data, count, error } = await db()
    .from("notifications")
    .select("id, type, ref_id, title, created_at", { count: "exact" })
    .is("read_at", null)
    .order("created_at", { ascending: false })
    .limit(8);
  if (error) throw new Error(error.message);
  return { count: count ?? 0, latest: data ?? [] };
}

async function markAllRead(ids: number[]) {
  orThrow(await db().from("notifications").update({ read_at: new Date().toISOString() }).in("id", ids));
}

// Top-bar bell: unread notifications (shared by all hub admins), refreshed every minute.
export function NotificationBell() {
  const [state, setState] = useState<{ count: number; latest: Notification[] }>({ count: 0, latest: [] });
  const load = useCallback(() => {
    fetchUnread()
      .then(setState)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const label = state.count === 0 ? "Notifications, none unread" : `Notifications, ${state.count} unread`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-full text-text-strong hover:bg-surface-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        <Bell className="size-5" aria-hidden="true" />
        {state.count > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-status-critical px-1 text-[11px] leading-5 font-semibold text-on-status-critical"
          >
            {state.count > 99 ? "99+" : state.count}
          </span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>{state.count === 0 ? "No unread notifications" : `${state.count} unread`}</DropdownMenuLabel>
        {state.latest.map((n) => (
          <DropdownMenuItem key={n.id} asChild>
            <Link to="/" className="flex flex-col items-start gap-0.5">
              <span className="text-sm text-text-strong">{n.title}</span>
              <span className="text-xs text-text-muted">{formatDateTime(n.created_at)}</span>
            </Link>
          </DropdownMenuItem>
        ))}
        {state.count > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                void markAllRead(state.latest.map((n) => n.id))
                  .then(load)
                  .catch(() => undefined)
              }
            >
              Mark these as read
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
