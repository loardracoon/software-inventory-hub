import { useState } from "react";
import { Link } from "react-router";
import { Boxes, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorLine } from "@/components/shared/error-line";
import { useHubRole } from "@/features/auth/auth-context";
import { formatDateTime } from "@/lib/format";
import { resolveProductConflict, type ProductConflict } from "./api";

// Inbox › Grouping review: products whose spellings were published with different categories before they
// were grouped. Choosing one spelling publishes its classification to all of them.
export function GroupingReview({ conflicts, error, onResolved }: { conflicts: ProductConflict[]; error: string | null; onResolved: () => void }) {
  const { canCurate } = useHubRole();
  const [busy, setBusy] = useState<string | null>(null);

  async function choose(entryId: string, name: string) {
    setBusy(entryId);
    try {
      const n = await resolveProductConflict(entryId);
      toast.success(`${name}: ${n} other spelling(s) now use this classification`);
      onResolved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not resolve");
    } finally {
      setBusy(null);
    }
  }

  if (error) return <ErrorLine message={error} />;
  if (conflicts.length === 0) {
    return <EmptyState icon={Boxes} title="Nothing to review" description="Products whose spellings disagree on the category show up here." />;
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-sm text-text-muted">
        These spellings belong to one product but were published with different categories. The first one is the suggestion (manual decisions first, then the most recent).
      </p>
      {conflicts.map((c) => (
        <Card key={c.product_id} className="gap-3 px-6">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-semibold text-text-strong">{c.display_name}</span>
            {c.vendor ? <span className="text-sm text-text-muted">{c.vendor}</span> : null}
          </span>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {c.aliases.map((a, i) => (
              <li key={a.entry_id} className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-2 text-sm">
                <span className="flex flex-col">
                  <Link to={`/dictionary/${a.entry_id}`}>{a.canonical_name}</Link>
                  <span className="text-xs text-text-muted">
                    {a.category ?? "No category"} · {a.method ?? "—"}
                    {a.reviewed_at ? ` · reviewed ${formatDateTime(a.reviewed_at)}` : ""}
                    {i === 0 ? " · suggested" : ""}
                  </span>
                </span>
                {canCurate ? (
                  <Button size="sm" variant={i === 0 ? "default" : "secondary"} disabled={busy !== null} onClick={() => void choose(a.entry_id, c.display_name)}>
                    <Check aria-hidden="true" />
                    Use for all spellings
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
