import { useState } from "react";
import { Link } from "react-router";
import { Check, ShieldQuestion, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorLine } from "@/components/shared/error-line";
import { useHubRole } from "@/features/auth/auth-context";
import { decideCpe, type CpeCandidate } from "./api";

// Inbox › CPE matches: NVD product names found for a product that are not an exact match. Confirming one
// brings its CVEs on the next run; rejecting it keeps it out.
export function CpeMatches({ candidates, error, onDecided }: { candidates: CpeCandidate[]; error: string | null; onDecided: () => void }) {
  const { canCurate } = useHubRole();
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(c: CpeCandidate, accept: boolean) {
    setBusy(c.id);
    try {
      await decideCpe(c.id ?? "", accept);
      toast.success(`${c.cpe_vendor}:${c.cpe_product} ${accept ? "confirmed for" : "rejected for"} ${c.display_name}`);
      onDecided();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not decide");
    } finally {
      setBusy(null);
    }
  }

  if (error) return <ErrorLine message={error} />;
  if (candidates.length === 0) {
    return <EmptyState icon={ShieldQuestion} title="No CPE matches to review" description="NVD product names that are not an exact match for a product show up here." />;
  }
  const groups = new Map<string, CpeCandidate[]>();
  for (const c of candidates) groups.set(c.product_id ?? "", [...(groups.get(c.product_id ?? "") ?? []), c]);
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-sm text-text-muted">
        Confirm the NVD name (CPE) that is this product; its known vulnerabilities then come with the next hourly run. A wrong match gives false vulnerabilities to every client.
      </p>
      {[...groups.values()].map((list) => (
        <Card key={list[0].product_id} className="gap-3 px-6">
          <span className="flex flex-wrap items-center gap-2">
            {list[0].entry_id ? (
              <Link to={`/dictionary/${list[0].entry_id}`} className="text-lg font-semibold">
                {list[0].display_name}
              </Link>
            ) : (
              <span className="text-lg font-semibold">{list[0].display_name}</span>
            )}
            {list[0].vendor ? <span className="text-sm text-text-muted">{list[0].vendor}</span> : null}
          </span>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {list.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-2 text-sm">
                <span className="flex flex-col">
                  <code className="font-mono text-xs">
                    cpe:2.3:a:{c.cpe_vendor}:{c.cpe_product}
                  </code>
                  <span className="text-xs text-text-muted">{c.title}</span>
                </span>
                {canCurate ? (
                  <span className="flex gap-2">
                    <Button size="sm" disabled={busy !== null} onClick={() => void decide(c, true)}>
                      <Check aria-hidden="true" />
                      Confirm
                    </Button>
                    <Button size="sm" variant="ghost" className="text-text-critical" disabled={busy !== null} onClick={() => void decide(c, false)}>
                      <X aria-hidden="true" />
                      Reject
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
