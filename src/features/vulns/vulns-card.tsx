import { useState } from "react";
import { ExternalLink, Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ErrorLine } from "@/components/shared/error-line";
import { Eyebrow } from "@/components/shared/eyebrow";
import { Field } from "@/components/shared/filters";
import { useHubRole } from "@/features/auth/auth-context";
import { formatDate, formatDateTime } from "@/lib/format";
import { useLoad } from "@/lib/use-load";
import { addCpe, decideCpe, fetchProductVulns, rangeText, refreshProductVulns } from "./api";

const SEVERITY_COLOR = { CRITICAL: "critical", HIGH: "high", MEDIUM: "medium", LOW: "low", NONE: "slate" } as const;
const SEVERITY_LABEL: Record<string, string> = { CRITICAL: "Critical", HIGH: "High", MEDIUM: "Medium", LOW: "Low", NONE: "None" };

// Entry page › Known vulnerabilities of the product: its NVD names (CPE), the CVEs with severity, KEV and
// EPSS, and the affected versions. Clients compare their own installed versions with these ranges.
export function VulnsCard({ productId }: { productId: string | null }) {
  const { canCurate } = useHubRole();
  const [version, setVersion] = useState(0);
  const data = useLoad(`vulns:${productId}:${version}`, () => (productId ? fetchProductVulns(productId) : Promise.resolve(null)));
  const [busy, setBusy] = useState(false);
  const [cpe, setCpe] = useState("");
  const reload = () => setVersion((v) => v + 1);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change");
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    if (!productId) return;
    setBusy(true);
    try {
      const r = await refreshProductVulns(productId);
      if (r.ok) toast.success(`Vulnerabilities read again: ${r.vulns_changed ?? 0} changed`);
      else toast.error(r.error ?? r.errors?.[0] ?? "The sources did not answer");
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not refresh");
    } finally {
      setBusy(false);
    }
  }

  if (!productId) return null;
  const cpes = data.data?.cpes ?? [];
  const vulns = data.data?.vulns ?? [];
  const confirmed = cpes.filter((c) => c.status === "confirmed");
  const candidates = cpes.filter((c) => c.status === "candidate");
  const kev = vulns.filter((v) => v.kev_added).length;

  return (
    <Card className="gap-4 px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Eyebrow>Known vulnerabilities</Eyebrow>
          <span className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
            {vulns.length} CVE{vulns.length === 1 ? "" : "s"}
            {kev ? (
              <Badge color="critical">
                <ShieldAlert aria-hidden="true" />
                {kev} known exploited
              </Badge>
            ) : null}
          </span>
        </div>
        {canCurate ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void refresh()}>
            {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            Refresh
          </Button>
        ) : null}
      </div>
      {data.error ? <ErrorLine message={data.error} /> : null}

      <div className="flex flex-col gap-2 text-sm">
        <span className="font-semibold text-text-strong">NVD product names (CPE)</span>
        {confirmed.length === 0 && candidates.length === 0 ? (
          <span className="text-text-muted">None yet. The hourly run searches the NVD CPE dictionary; packages use OSV instead.</span>
        ) : null}
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {[...confirmed, ...candidates].map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2">
              <code className="font-mono text-xs">
                {c.cpe_vendor}:{c.cpe_product}
              </code>
              <Badge color={c.status === "confirmed" ? "safe" : "info"} soft>
                {c.status === "confirmed" ? (c.source === "exact" ? "confirmed · exact match" : "confirmed") : "candidate"}
              </Badge>
              {c.synced_at ? <span className="text-xs text-text-muted">read {formatDateTime(c.synced_at)}</span> : null}
              {c.last_error ? <span className="text-xs text-text-critical">{c.last_error}</span> : null}
              {canCurate ? (
                <span className="flex gap-1">
                  {c.status === "candidate" ? (
                    <Button size="xs" variant="secondary" disabled={busy} onClick={() => void run(() => decideCpe(c.id, true), "CPE confirmed")}>
                      Confirm
                    </Button>
                  ) : null}
                  <Button size="xs" variant="ghost" className="text-text-critical" disabled={busy} onClick={() => void run(() => decideCpe(c.id, false), "CPE rejected")}>
                    Reject
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {canCurate ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (cpe.trim()) void run(() => addCpe(productId, cpe.trim()).then(() => setCpe("")), "CPE added; the next run reads its CVEs");
            }}
          >
            <Field label="Add a CPE by hand" htmlFor="add-cpe" className="min-w-64 flex-1">
              <Input id="add-cpe" placeholder="vendor:product, e.g. 7-zip:7-zip" value={cpe} onChange={(e) => setCpe(e.target.value)} spellCheck={false} />
            </Field>
            <Button type="submit" size="sm" variant="secondary" disabled={busy}>
              Add
            </Button>
          </form>
        ) : null}
      </div>

      {vulns.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Vulnerabilities">
          {vulns.slice(0, 100).map((v) => (
            <li key={v.vuln_id ?? ""} className="flex flex-col gap-1 border-t border-border-subtle pt-3 text-sm">
              <span className="flex flex-wrap items-center gap-2">
                <a href={`https://nvd.nist.gov/vuln/detail/${v.vuln_id}`} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-mono font-semibold">
                  {v.vuln_id}
                  <ExternalLink className="size-3" aria-hidden="true" />
                </a>
                {v.severity ? (
                  <Badge color={SEVERITY_COLOR[v.severity as keyof typeof SEVERITY_COLOR] ?? "slate"} soft>
                    {SEVERITY_LABEL[v.severity] ?? v.severity}
                    {v.cvss_score !== null ? ` ${Number(v.cvss_score).toFixed(1)}` : ""}
                  </Badge>
                ) : null}
                {v.kev_added ? (
                  <Badge color="critical">
                    <ShieldAlert aria-hidden="true" />
                    Known exploited since {formatDate(`${v.kev_added}T12:00:00Z`)}
                  </Badge>
                ) : null}
                {v.epss !== null ? <span className="text-xs text-text-muted">EPSS {(Number(v.epss) * 100).toFixed(1)}%</span> : null}
              </span>
              {v.summary ? <span className="text-text-body">{v.summary}</span> : null}
              <span className="text-xs text-text-muted">Affected versions: {v.ranges.map(rangeText).join(" · ")}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
