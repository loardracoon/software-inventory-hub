import { useState } from "react";
import { Link } from "react-router";
import { Check, MessageSquareWarning, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorLine } from "@/components/shared/error-line";
import { useHubRole } from "@/features/auth/auth-context";
import { runJev } from "@/features/jev/api";
import { formatDateTime } from "@/lib/format";
import { decideRequests, type RequestGroup } from "./api";

const age = (iso: string) => {
  const hours = Math.round((Date.now() - Date.parse(iso)) / 3600_000);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
};

// Inbox › Requests: open reclassification requests grouped per entry. A decision answers every client
// that asked (they read it with GET reclassification-requests on their next sync).
export function RequestsPanel({ groups, error, onDecided }: { groups: RequestGroup[]; error: string | null; onDecided: () => void }) {
  if (error) return <ErrorLine message={error} />;
  if (groups.length === 0) return <EmptyState icon={MessageSquareWarning} title="No open requests" description="Requests that clients send to reclassify a title show up here." />;
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <RequestCard key={g.entry_id} g={g} onDecided={onDecided} />
      ))}
    </div>
  );
}

function RequestCard({ g, onDecided }: { g: RequestGroup; onDecided: () => void }) {
  const suggestions = [...new Map(g.items.filter((i) => i.suggested_category_id).map((i) => [i.suggested_category_id!, i.suggested])).entries()];
  const [category, setCategory] = useState(suggestions[0]?.[0] ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const { canCurate } = useHubRole();

  async function decide(accept: boolean) {
    setBusy(true);
    try {
      const n = await decideRequests(g.entry_id, accept, note, accept ? category : undefined);
      toast.success(accept ? `Published; ${n} request(s) answered` : `${n} request(s) rejected`);
      onDecided();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not decide");
    } finally {
      setBusy(false);
    }
  }

  async function jev() {
    setBusy(true);
    try {
      const r = await runJev({ action: g.entry_status === "published" ? "rerun" : "run_selected", entry_ids: [g.entry_id] });
      if (!r.ok) toast.error(r.error ?? "Jev did not run");
      else toast.success("Jev's answer is in the entry page and the proposals");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not run Jev");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="gap-4 px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link to={`/dictionary/${g.entry_id}`} className="text-lg font-semibold">
            {g.canonical_name}
          </Link>
          <span className="text-sm text-text-muted">
            Now: {g.current_category ?? "Unclassified"} · {g.requests} request(s) from {g.clients} client(s) · oldest {age(g.oldest)}
          </span>
        </div>
        <Badge color="info" soft>
          {g.requests} open
        </Badge>
      </div>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {g.items.map((i) => (
          <li key={i.public_id} className="flex flex-col gap-1 border-t border-border-subtle pt-3 text-sm">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{i.public_id}</span>
              <span className="font-semibold text-text-strong">{i.client}</span>
              <span className="text-text-muted">suggests {i.suggested} · {formatDateTime(i.created_at)}</span>
            </span>
            <span>{i.reason}</span>
            {i.evidence_url ? (
              <a href={i.evidence_url} target="_blank" rel="noreferrer noopener" className="text-xs break-all">
                {i.evidence_url}
              </a>
            ) : null}
          </li>
        ))}
      </ul>
      {canCurate ? (
      <>
      <div className="flex flex-wrap items-end gap-3">
        {suggestions.length > 1 ? (
          <label className="flex flex-col gap-1 text-[13px] font-semibold">
            Publish as
            <select className="h-9 rounded-sm border-[1.5px] border-input bg-surface-raised px-2 text-[13px] font-normal" value={category} onChange={(e) => setCategory(e.target.value)}>
              {suggestions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex min-w-64 flex-1 flex-col gap-1 text-[13px] font-semibold">
          Note to the clients
          <Input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Why you decided this" />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void decide(true)} disabled={busy || !category} title={category ? undefined : "Every request suggests Other: use Edit and publish"}>
          <Check aria-hidden="true" />
          Accept and publish{suggestions.length === 1 ? `: ${suggestions[0][1]}` : ""}
        </Button>
        <Button size="sm" variant="secondary" asChild>
          <Link to={`/dictionary/${g.entry_id}`}>Edit and publish</Link>
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void jev()} disabled={busy}>
          <Sparkles aria-hidden="true" />
          Run Jev
        </Button>
        <Button size="sm" variant="ghost" className="text-text-critical" onClick={() => void decide(false)} disabled={busy}>
          <X aria-hidden="true" />
          Reject with note
        </Button>
      </div>
      </>
      ) : null}
    </Card>
  );
}
