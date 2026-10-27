import { Ban, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Probability as a number and a bar (the number carries the meaning; the bar repeats it).
export function ProbabilityBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <span className="flex items-center gap-2" aria-label={`Probability ${value.toFixed(2)}`}>
      <span className="relative block h-2 w-24 rounded-full bg-surface-subtle" aria-hidden="true">
        <span className={cn("block h-full rounded-full", value >= 0.95 ? "bg-alert-green" : value >= 0.85 ? "bg-action" : "bg-alert-orange")} style={{ width: `${pct}%` }} />
      </span>
      <span className="font-mono text-xs text-text-strong">{value.toFixed(2)}</span>
    </span>
  );
}

export function AttentionBadge({ level }: { level: "info" | "review" | "not_allowed" | null }) {
  if (level === "review") {
    return (
      <Badge color="high">
        <Eye aria-hidden="true" />
        Review
      </Badge>
    );
  }
  if (level === "not_allowed") {
    return (
      <Badge color="critical">
        <Ban aria-hidden="true" />
        Not allowed
      </Badge>
    );
  }
  return (
    <Badge color="slate" soft>
      Info
    </Badge>
  );
}
