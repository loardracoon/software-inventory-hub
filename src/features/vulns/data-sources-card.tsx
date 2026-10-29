import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorLine } from "@/components/shared/error-line";
import { Eyebrow } from "@/components/shared/eyebrow";
import { fetchProviderKeys } from "@/features/engines/api";
import { ProviderKeyRow } from "@/features/engines/settings-cards";
import { formatDateTime, formatNumber } from "@/lib/format";
import { useLoad } from "@/lib/use-load";
import { fetchVulnStatus } from "./api";

// Settings › Data sources (admins): the optional NVD API key and the state of the vulnerability sources.
export function DataSourcesCard() {
  const [version, setVersion] = useState(0);
  const status = useLoad(`vuln-status:${version}`, fetchVulnStatus);
  const keys = useLoad(`provider-keys:nvd:${version}`, fetchProviderKeys);
  const s = status.data;
  const run = s?.last_run;
  return (
    <Card className="gap-5 px-6">
      <div className="flex flex-col gap-2">
        <Eyebrow>Engines</Eyebrow>
        <h2 className="m-0 text-xl">Data sources</h2>
      </div>
      <p className="m-0 text-sm text-text-muted">
        Known vulnerabilities come every hour from NVD (programs, through their CPE), OSV.dev (npm and PyPI packages), CISA KEV (known exploited) and FIRST EPSS
        (exploit probability). All are free. Without an NVD API key NVD allows 5 calls per 30 seconds; with a free key, 50.
      </p>
      {status.error ? <ErrorLine message={status.error} /> : null}
      {keys.data ? (
        <ul className="m-0 list-none p-0">
          <ProviderKeyRow provider="nvd" label="NVD API key" current={keys.data.find((k) => k.provider === "nvd") ?? null} onChanged={() => setVersion((v) => v + 1)} />
        </ul>
      ) : (
        <Skeleton className="h-16 w-full" />
      )}
      {s ? (
        <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-text-muted">Products with a confirmed CPE</dt>
          <dd className="m-0 text-text-strong">{formatNumber(s.products_with_cpe)}</dd>
          <dt className="text-text-muted">CPE matches to review</dt>
          <dd className="m-0 text-text-strong">{formatNumber(s.cpe_candidates)}</dd>
          <dt className="text-text-muted">Vulnerabilities on products</dt>
          <dd className="m-0 text-text-strong">
            {formatNumber(s.vulnerabilities)} · {formatNumber(s.kev)} known exploited
          </dd>
          <dt className="text-text-muted">KEV catalog read</dt>
          <dd className="m-0 text-text-strong">{s.kev_synced_at ? formatDateTime(s.kev_synced_at) : "Not yet"}</dd>
          <dt className="text-text-muted">Last run</dt>
          <dd className="m-0 text-text-strong">
            {run ? `${formatDateTime(run.started_at)} (${run.trigger})${run.finished_at ? "" : " · running"}` : "Not yet"}
            {run?.errors?.length ? <span className="block text-xs text-text-critical">{run.errors.slice(0, 3).join(" · ")}</span> : null}
          </dd>
        </dl>
      ) : null}
    </Card>
  );
}
