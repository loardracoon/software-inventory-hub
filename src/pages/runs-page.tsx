import { useState } from "react";
import { Link } from "react-router";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { Eyebrow } from "@/components/shared/eyebrow";
import { Field, NativeSelect } from "@/components/shared/filters";
import { PageHeader } from "@/components/shared/page-header";
import { fetchLevel2Categories, fetchRuns, runJev } from "@/features/jev/api";
import { formatDateTime, formatNumber } from "@/lib/format";
import { useLoad } from "@/lib/use-load";
import { useHubRole } from "@/features/auth/auth-context";

const usd = (v: number) => `USD ${Number(v).toFixed(4)}`;

export function RunsPage() {
  const { canCurate } = useHubRole();
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);
  const runs = useLoad(`runs:${version}`, fetchRuns);
  const categories = useLoad("level2", fetchLevel2Categories);
  const [category, setCategory] = useState("");
  const [running, setRunning] = useState(false);

  async function rerun() {
    setRunning(true);
    try {
      const r = await runJev({ action: "rerun", category_slug: category });
      if (!r.ok) toast.error(r.error ?? "Jev did not run");
      else if (r.skipped) toast.info(r.skipped);
      else toast.success(`Re-run on ${r.titles} title(s): ${r.proposals} proposal(s) in the Inbox`);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not run Jev");
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <PageHeader eyebrow="Jev" title="Classification runs" description="Every Jev run, what it published on its own and what it left for you." />
      <p className="m-0 text-sm text-text-muted">
        What Jev published on its own, with Revert, is in <Link to="/engines">Engines &amp; usage</Link>.
      </p>
      {canCurate ? (
      <Card className="gap-4 px-6">
        <Eyebrow>Re-run Jev</Eyebrow>
        <p className="m-0 text-sm text-text-muted">After a taxonomy change, re-classify the published titles of a category. Results arrive as proposals; nothing is published automatically.</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Category" htmlFor="rerun-category" className="min-w-72">
            <NativeSelect
              id="rerun-category"
              value={category}
              onChange={setCategory}
              options={[{ value: "", label: "Choose a category" }, ...(categories.data ?? []).map((c) => ({ value: c.slug, label: `${c.parent?.name} / ${c.name}` }))]}
            />
          </Field>
          <Button size="sm" onClick={() => void rerun()} disabled={!category || running}>
            {running ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
            Re-run Jev
          </Button>
        </div>
      </Card>
      ) : null}

      <h2 className="m-0 text-xl">Runs</h2>
      <Card className="px-0 py-0">
        {(runs.data ?? []).length === 0 ? (
          <div className="p-6">
            <EmptyState icon={Sparkles} title="No runs yet" description="Run Jev from the Inbox, or let the automatic run pick the titles reported by two or more clients." />
          </div>
        ) : (
          <Table aria-label="Classification runs">
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Titles</TableHead>
                <TableHead>Auto-published</TableHead>
                <TableHead>Open proposals</TableHead>
                <TableHead>Errors</TableHead>
                <TableHead>Estimated cost</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(runs.data ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{formatDateTime(r.started_at)}</TableCell>
                  <TableCell>{r.rerun ? "Re-run" : "Classify"}</TableCell>
                  <TableCell className="font-mono text-xs">{r.model}</TableCell>
                  <TableCell>{formatNumber(r.entry_count)}</TableCell>
                  <TableCell>{formatNumber(r.auto_published)}</TableCell>
                  <TableCell>{formatNumber(r.open_proposals)}</TableCell>
                  <TableCell>{formatNumber(r.errors)}</TableCell>
                  <TableCell>{usd(r.cost_usd)}</TableCell>
                  <TableCell>
                    <Badge color={r.status === "finished" ? "safe" : r.status === "running" ? "info" : "high"} soft>
                      {r.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </>
  );
}
