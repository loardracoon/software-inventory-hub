import { BookOpen, Gauge, Inbox, KeyRound, ListTree, SlidersHorizontal, Sparkles, type LucideIcon } from "lucide-react";

export type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean };

export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Inbox", icon: Inbox, end: true },
  { to: "/dictionary", label: "Dictionary", icon: BookOpen },
  { to: "/runs", label: "Classification runs", icon: Sparkles },
  { to: "/engines", label: "Engines & usage", icon: Gauge },
  { to: "/taxonomy", label: "Taxonomy", icon: ListTree },
  { to: "/clients", label: "Clients", icon: KeyRound },
  { to: "/settings", label: "Settings", icon: SlidersHorizontal },
];
