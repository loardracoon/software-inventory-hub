import { BookOpen, Gauge, Inbox, KeyRound, ListTree, SlidersHorizontal, Sparkles, type LucideIcon } from "lucide-react";

// Who sees the item: everyone with a role, operators and admins ("curate"), or admins only.
export type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean; access?: "curate" | "admin" };

export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Inbox", icon: Inbox, end: true },
  { to: "/dictionary", label: "Dictionary", icon: BookOpen },
  { to: "/runs", label: "Classification runs", icon: Sparkles },
  { to: "/engines", label: "Engines & usage", icon: Gauge, access: "curate" },
  { to: "/taxonomy", label: "Taxonomy", icon: ListTree },
  { to: "/clients", label: "Clients", icon: KeyRound, access: "admin" },
  { to: "/settings", label: "Settings", icon: SlidersHorizontal, access: "admin" },
];
