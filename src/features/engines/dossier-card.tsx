import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorLine } from "@/components/shared/error-line";
import { Eyebrow } from "@/components/shared/eyebrow";
import { formatDateTime } from "@/lib/format";
import { useLoad } from "@/lib/use-load";
import { fetchLatestDossier } from "./api";

const CAPABILITY_LABEL: Record<string, string> = {
  remote_control: "Remote control",
  screen_capture: "Screen capture",
  network_tunnel: "Network tunnel",
  credential_storage: "Credential storage",
  data_collection: "Data collection",
};
const TRIGGER_LABEL: Record<string, string> = {
  manual: "run by an admin",
  request: "client request",
  sensitive_proposal: "sensitive proposal",
  jev_below_085: "Jev below 0.85",
  rule_jev_disagree: "rule and Jev disagree",
};

// Only http(s) links are rendered as links; everything from the dossier is plain text (React escapes it).
function SourceLink({ url }: { url: string | null }) {
  if (!url || !/^https?:\/\//i.test(url)) return <span className="text-text-muted">—</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className="break-all">
      {url}
    </a>
  );
}

// The latest research dossier of an entry. It informs the admin; it never publishes anything.
export function DossierCard({ entryId, version }: { entryId: string; version: number }) {
  const data = useLoad(`dossier:${entryId}:${version}`, () => fetchLatestDossier(entryId));
  const row = data.data;
  const d = row?.dossier;

  return (
    <Card className="gap-3 px-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Eyebrow>Research dossier</Eyebrow>
        {row ? (
          <span className="text-xs text-text-muted">
            {formatDateTime(row.created_at)} · {row.provider} · <span className="font-mono">{row.model}</span> · {TRIGGER_LABEL[row.trigger] ?? row.trigger}
          </span>
        ) : null}
      </div>
      {data.error ? <ErrorLine message={data.error} /> : null}
      {data.loading && !row ? <Skeleton className="h-24 w-full" /> : null}
      {!data.loading && !row ? <p className="m-0 text-sm text-text-muted">No research yet. Use Research to look this title up on the web.</p> : null}
      {d ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {d.unknown ? (
              <Badge color="high" soft>
                No reliable source found
              </Badge>
            ) : null}
            <Badge color={d.confidence === "high" ? "safe" : d.confidence === "medium" ? "info" : "slate"} soft>
              Confidence {d.confidence}
            </Badge>
            {d.agrees_with_jev !== null ? (
              <Badge color={d.agrees_with_jev ? "safe" : "high"} soft>
                {d.agrees_with_jev ? "Agrees with Jev" : "Disagrees with Jev"}
              </Badge>
            ) : null}
          </div>
          <p className="m-0 text-sm">{d.summary}</p>
          <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="text-text-muted">Vendor</dt>
            <dd className="m-0">{d.vendor ?? "—"}</dd>
            <dt className="text-text-muted">Official site</dt>
            <dd className="m-0">
              <SourceLink url={d.official_url} />
            </dd>
            <dt className="text-text-muted">Store page</dt>
            <dd className="m-0">
              <SourceLink url={d.store_url} />
            </dd>
            <dt className="text-text-muted">Suggested category</dt>
            <dd className="m-0">{d.suggested_category ?? "—"}</dd>
            <dt className="text-text-muted">Capabilities</dt>
            <dd className="m-0">{d.capabilities.length ? d.capabilities.map((c) => CAPABILITY_LABEL[c] ?? c).join(", ") : "None found"}</dd>
          </dl>
          {d.risk_notes.length ? (
            <div className="flex flex-col gap-1">
              <span className="text-[13px] font-semibold text-text-strong">Risk notes</span>
              <ul className="m-0 flex flex-col gap-1 pl-5 text-sm">
                {d.risk_notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <span className="text-[13px] font-semibold text-text-strong">Sources</span>
            {d.evidence.length === 0 ? <p className="m-0 text-sm text-text-muted">None.</p> : null}
            <ul className="m-0 flex flex-col gap-1 pl-5 text-sm">
              {d.evidence.map((e, i) => (
                <li key={i}>
                  {e.claim} — <SourceLink url={e.url} />
                </li>
              ))}
            </ul>
            {d.dropped_claims ? <p className="m-0 text-xs text-text-muted">{d.dropped_claims} claim(s) without a source were dropped.</p> : null}
          </div>
        </>
      ) : null}
    </Card>
  );
}
