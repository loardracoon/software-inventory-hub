import { useState } from "react";
import { CircleAlert, CircleCheck, Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Eyebrow } from "@/components/shared/eyebrow";
import { Field, NativeSelect } from "@/components/shared/filters";
import { formatDateTime, formatNumber } from "@/lib/format";
import { useLoad } from "@/lib/use-load";
import { fetchEngineStatus, resumeJev, setJevMode, type EngineStatus } from "./api";

const MODES = [
  { value: "automatic", label: "Automatic: runs every 6 hours and on demand" },
  { value: "manual", label: "Manual: only when you run it" },
  { value: "off", label: "Off" },
];

// Settings › Engines › Jev: mode, pause and today's / this month's use.
export function JevCard() {
  const [version, setVersion] = useState(0);
  const status = useLoad(`jev-status:${version}`, fetchEngineStatus);
  const [busy, setBusy] = useState(false);
  const s = status.data;

  async function change(fn: () => Promise<void>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change Jev");
    } finally {
      setBusy(false);
      setVersion((v) => v + 1);
    }
  }

  return (
    <Card className="gap-5 px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Eyebrow>Engines</Eyebrow>
          <h2 className="m-0 text-xl">Jev</h2>
        </div>
        {s ? (
          s.paused ? (
            <Badge color="critical" soft>
              <CircleAlert aria-hidden="true" />
              Paused
            </Badge>
          ) : (
            <Badge color={s.mode === "off" ? "slate" : "safe"} soft>
              <CircleCheck aria-hidden="true" />
              {s.mode === "off" ? "Off" : s.mode === "manual" ? "Manual" : "Automatic"}
            </Badge>
          )
        ) : null}
      </div>
      <p className="m-0 text-sm text-text-muted">
        Jev proposes a category for each new title ({s?.model ?? "claude-haiku-5-5"} through the AI gateway; a local mock answers while no
        Claude key is set in AI providers). It publishes alone only at 0.95 or more in Info categories; everything else waits in the Inbox.
      </p>
      {status.loading && !s ? <Skeleton className="h-20 w-full" /> : null}
      {s ? (
        <>
          {s.paused ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-status-critical/40 bg-alert-red/10 px-4 py-3 text-sm">
              <span>
                <strong>Paused{s.paused_reason ? `: ${s.paused_reason}` : ""}.</strong> Only an admin resumes Jev.
              </span>
              <Button size="sm" onClick={() => void change(resumeJev, "Jev resumed")} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Play aria-hidden="true" />}
                Resume
              </Button>
            </div>
          ) : null}
          <Field label="Mode" htmlFor="jev-mode" className="max-w-md">
            <NativeSelect id="jev-mode" value={s.mode} onChange={(v) => void change(() => setJevMode(v as EngineStatus["mode"]), "Mode changed")} options={MODES} />
          </Field>
          <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="text-text-muted">Titles today</dt>
            <dd className="m-0 text-text-strong">
              {formatNumber(s.titles_today)} of {formatNumber(s.daily_titles)}
            </dd>
            <dt className="text-text-muted">Estimated cost this month</dt>
            <dd className="m-0 text-text-strong">
              USD {Number(s.spend_month).toFixed(4)} of {Number(s.monthly_budget_usd).toFixed(2)}
            </dd>
            <dt className="text-text-muted">Auto-published today</dt>
            <dd className="m-0 text-text-strong">
              {formatNumber(s.auto_published_today)} of {formatNumber(s.auto_publish_daily)}
            </dd>
            <dt className="text-text-muted">Last automatic run</dt>
            <dd className="m-0 text-text-strong">{s.last_auto_run_at ? formatDateTime(s.last_auto_run_at) : "Never"}</dd>
          </dl>
        </>
      ) : null}
    </Card>
  );
}
