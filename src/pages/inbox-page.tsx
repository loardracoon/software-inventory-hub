import { useMemo, useState } from "react";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorLine } from "@/components/shared/error-line";
import { PageHeader } from "@/components/shared/page-header";
import { fetchRequestGroups } from "@/features/dictionary/api";
import { RequestsPanel } from "@/features/dictionary/requests-panel";
import { AttentionBadge, ProbabilityBar } from "@/features/jev/jev-bits";
import {
  acceptAllAbove,
  decideProposal,
  fetchLevel2Categories,
  fetchPendingTitles,
  fetchProposals,
  runJev,
  type Proposal,
} from "@/features/jev/api";
import { useHubRole } from "@/features/auth/auth-context";
import { formatDate, formatNumber } from "@/lib/format";
import { useLoad } from "@/lib/use-load";
import { GroupingReview } from "@/features/dictionary/grouping-review";
import { fetchProductConflicts } from "@/features/dictionary/api";

const MAX_RUN = 50;
const KIND: Record<string, string> = { program: "Program", extension: "Browser extension", ide_extension: "IDE extension", package: "Package" };

export function InboxPage() {
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);
  const proposals = useLoad(`proposals:${version}`, fetchProposals);
  const requests = useLoad(`requests:${version}`, fetchRequestGroups);
  const conflicts = useLoad(`conflicts:${version}`, fetchProductConflicts);
  return (
    <>
      <PageHeader eyebrow="Review" title="Inbox" description="Reclassification requests from clients, new titles and the categories Jev proposes." />
      <Tabs defaultValue={requests.data?.length ? "requests" : "new"} key={requests.data?.length ? "r" : "n"}>
        <TabsList aria-label="Inbox">
          <TabsTrigger value="requests">Requests{requests.data?.length ? ` (${requests.data.length})` : ""}</TabsTrigger>
          <TabsTrigger value="new">New titles</TabsTrigger>
          <TabsTrigger value="proposals">Proposals{proposals.data?.length ? ` (${proposals.data.length})` : ""}</TabsTrigger>
          <TabsTrigger value="grouping">Grouping review{conflicts.data?.length ? ` (${conflicts.data.length})` : ""}</TabsTrigger>
        </TabsList>
        <TabsContent value="requests">
          <RequestsPanel groups={requests.data ?? []} error={requests.error} onDecided={refresh} />
        </TabsContent>
        <TabsContent value="new">
          <NewTitles version={version} onRun={refresh} />
        </TabsContent>
        <TabsContent value="proposals">
          <Proposals proposals={proposals.data ?? []} error={proposals.error} onDecided={refresh} />
        </TabsContent>
        <TabsContent value="grouping">
          <GroupingReview conflicts={conflicts.data ?? []} error={conflicts.error} onResolved={refresh} />
        </TabsContent>
      </Tabs>
    </>
  );
}

function NewTitles({ version, onRun }: { version: number; onRun: () => void }) {
  const titles = useLoad(`pending:${version}`, fetchPendingTitles);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const { canCurate } = useHubRole();
  const rows = titles.data ?? [];
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else if (next.size < MAX_RUN) next.add(id);
    return next;
  });

  async function run() {
    setRunning(true);
    try {
      const r = await runJev({ action: "run_selected", entry_ids: [...selected] });
      if (!r.ok) toast.error(r.error ?? "Jev did not run");
      else toast.success(`Jev classified ${r.titles} title(s): ${r.auto_published} published automatically, ${r.proposals} proposal(s)${r.errors ? `, ${r.errors} error(s)` : ""}`);
      if (r.paused) toast.error(`Jev paused: ${r.pause_reason}`);
      setSelected(new Set());
      onRun();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not run Jev");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card className="gap-4 px-0 py-0">
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-5">
        <p className="m-0 text-sm text-text-muted">
          Pending titles, most reported first.{canCurate ? ` Select up to ${MAX_RUN} to classify now.` : ""}
        </p>
        {canCurate ? (
          <Button size="sm" onClick={() => void run()} disabled={running || selected.size === 0}>
            {running ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
            Run Jev on selected ({selected.size})
          </Button>
        ) : null}
      </div>
      {titles.error ? <ErrorLine message={titles.error} /> : null}
      {rows.length === 0 && !titles.loading ? (
        <div className="p-6">
          <EmptyState title="No new titles" description="Titles that clients report and the dictionary does not know yet show up here." />
        </div>
      ) : (
        <Table aria-label="New titles">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  aria-label="Select the first 50"
                  className="size-4 accent-action"
                  checked={selected.size > 0 && selected.size === Math.min(rows.length, MAX_RUN)}
                  onChange={(e) => setSelected(e.target.checked ? new Set(rows.slice(0, MAX_RUN).map((r) => r.id)) : new Set())}
                />
              </TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Kind · source</TableHead>
              <TableHead>Clients</TableHead>
              <TableHead>First reported</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((t) => (
              <TableRow key={t.id}>
                <TableCell>
                  <input type="checkbox" aria-label={`Select ${t.canonical_name}`} className="size-4 accent-action" checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-semibold text-text-strong">{t.canonical_name}</span>
                    {t.vendor ? <span className="text-xs text-text-muted">{t.vendor}</span> : null}
                    {t.spellings > 1 ? <span className="text-xs text-text-muted">and {t.spellings - 1} other spelling(s) of the same product</span> : null}
                  </div>
                </TableCell>
                <TableCell>{`${KIND[t.kind] ?? t.kind} · ${t.source}`}</TableCell>
                <TableCell>{formatNumber(t.reports_count)}</TableCell>
                <TableCell>{t.first_reported_at ? formatDate(t.first_reported_at) : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function Proposals({ proposals, error, onDecided }: { proposals: Proposal[]; error: string | null; onDecided: () => void }) {
  const categories = useLoad("level2", fetchLevel2Categories);
  const { canCurate } = useHubRole();
  const groups = useMemo(() => {
    const map = new Map<string, Proposal[]>();
    for (const p of proposals) map.set(p.category_slug, [...(map.get(p.category_slug) ?? []), p]);
    return [...map.values()];
  }, [proposals]);
  const eligible = proposals.filter((p) => p.probability >= 0.85 && p.attention_level === "info").length;

  async function decide(p: Proposal, accept: boolean, categoryId?: string) {
    try {
      const outcome = await decideProposal(p, accept, categoryId);
      toast.success(`${p.canonical_name}: ${outcome}`);
      onDecided();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not decide");
    }
  }

  async function acceptAll() {
    try {
      const n = await acceptAllAbove(0.85);
      toast.success(`${n} proposal(s) accepted and published`);
      onDecided();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not accept");
    }
  }

  if (error) return <ErrorLine message={error} />;
  if (proposals.length === 0) return <EmptyState icon={Sparkles} title="No proposals" description="Jev's answers that need a decision show up here." />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 text-sm text-text-muted">Grouped by the category Jev proposes. Accepting publishes the entry to every client.</p>
        {canCurate ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" variant="secondary" disabled={eligible === 0}>
              Accept all above 0.85 ({eligible})
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Accept {eligible} proposal(s)?</AlertDialogTitle>
              <AlertDialogDescription>
                Publishes every proposal at 0.85 or above in categories with attention Info. Proposals in Review or Not allowed
                categories are skipped: decide those one by one.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void acceptAll()}>Accept and publish</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        ) : null}
      </div>
      {groups.map((group) => (
        <Card key={group[0].category_slug} className="gap-3 px-0 py-0">
          <div className="flex flex-wrap items-center gap-2 px-6 pt-5">
            <span className="text-xs text-text-muted">{group[0].level1_name}</span>
            <span className="font-semibold text-text-strong">{group[0].category_name}</span>
            <AttentionBadge level={group[0].attention_level} />
          </div>
          <Table aria-label={`Proposals for ${group[0].category_name}`}>
            <TableBody>
              {group.map((p) => (
                <ProposalRow key={`${p.run_id}:${p.entry_id}`} p={p} categories={categories.data ?? []} onDecide={canCurate ? decide : null} />
              ))}
            </TableBody>
          </Table>
        </Card>
      ))}
    </div>
  );
}

function ProposalRow({
  p,
  categories,
  onDecide,
}: {
  p: Proposal;
  categories: { id: string; name: string; parent: { name: string } | null }[];
  // null for viewers: they see the proposal, not the actions.
  onDecide: ((p: Proposal, accept: boolean, categoryId?: string) => Promise<void>) | null;
}) {
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (accept: boolean, categoryId?: string) => {
    if (!onDecide) return;
    setBusy(true);
    await onDecide(p, accept, categoryId);
    setBusy(false);
  };
  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col gap-0.5">
          <span className="font-semibold text-text-strong">{p.canonical_name}</span>
          <span className="text-xs text-text-muted">
            {[p.vendor, `${p.reports_count} client(s)`, p.entry_status === "published" ? "already published" : null, p.rerun ? "re-run" : null].filter(Boolean).join(" · ")}
          </span>
        </div>
      </TableCell>
      <TableCell className="w-48">
        <ProbabilityBar value={p.probability} />
      </TableCell>
      {onDecide ? (
      <TableCell>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button size="sm" onClick={() => void act(true)} disabled={busy}>
            <Check aria-hidden="true" />
            Accept
          </Button>
          <label className="sr-only" htmlFor={`change-${p.entry_id}`}>
            Change category of {p.canonical_name}
          </label>
          <select
            id={`change-${p.entry_id}`}
            className="h-9 max-w-56 rounded-sm border-[1.5px] border-input bg-surface-raised px-2 text-[13px]"
            value={other}
            onChange={(e) => setOther(e.target.value)}
          >
            <option value="">Change category…</option>
            {categories
              .filter((c) => c.id !== p.category_id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.parent?.name} / {c.name}
                </option>
              ))}
          </select>
          {other ? (
            <Button size="sm" variant="secondary" onClick={() => void act(true, other)} disabled={busy}>
              Publish with this
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" className="text-text-critical" onClick={() => void act(false)} disabled={busy}>
            <X aria-hidden="true" />
            Reject
          </Button>
        </div>
      </TableCell>
      ) : null}
    </TableRow>
  );
}

