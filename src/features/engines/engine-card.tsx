import { useState } from "react";
import { CircleAlert, CircleCheck, Loader2, Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorLine } from "@/components/shared/error-line";
import { Eyebrow } from "@/components/shared/eyebrow";
import { Field, NativeSelect } from "@/components/shared/filters";
import { formatDateTime, formatNumber } from "@/lib/format";
import { useLoad } from "@/lib/use-load";
import { cn } from "@/lib/utils";
import type { EngineStatus } from "@/features/jev/api";
import { fetchEngine, pauseEngine, PROVIDERS, resumeEngine, setEngineMode, type EngineName } from "./api";
import { useHubRole } from "@/features/auth/auth-context";

const TITLE: Record<EngineName, string> = { jev: "Jev", research: "Research" };
const UNIT: Record<EngineName, string> = { jev: "titles", research: "researches" };
const MODES = [
  { value: "automatic", label: "Automatic" },
  { value: "manual", label: "Manual: only when you run it" },
  { value: "off", label: "Off" },
];
export const usd = (v: number | null | undefined, digits = 4) => `USD ${Number(v ?? 0).toFixed(digits)}`;

// Used against a limit: the numbers carry the meaning; the bar repeats them (orange from 80 %, red when full).
export function BudgetBar({ label, used, limit, text }: { label: string; used: number; limit: number; text: string }) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap justify-between gap-2 text-sm">
        <span className="text-text-muted">{label}</span>
        <span className="text-text-strong">{text}</span>
      </div>
      <span className="relative block h-2 w-full rounded-full bg-surface-subtle" aria-hidden="true">
        <span className={cn("block h-full rounded-full", ratio >= 1 ? "bg-alert-red" : ratio >= 0.8 ? "bg-alert-orange" : "bg-action")} style={{ width: `${Math.round(ratio * 100)}%` }} />
      </span>
    </div>
  );
}

// Engines & usage: one card per engine with mode, pause, provider/model, budget and this month's numbers.
export function EngineCard({ engine }: { engine: EngineName }) {
  const { isAdmin } = useHubRole();
  const [version, setVersion] = useState(0);
  const data = useLoad(`engine:${engine}:${version}`, () => fetchEngine(engine));
  const [busy, setBusy] = useState(false);
  const e = data.data;
  const s = e?.status;
  const u = e?.usage;

  async function change(fn: () => Promise<void>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not change ${TITLE[engine]}`);
    } finally {
      setBusy(false);
      setVersion((v) => v + 1);
    }
  }

  return (
    <Card className="gap-5 px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Eyebrow>Engine</Eyebrow>
          <h2 className="m-0 text-xl">{TITLE[engine]}</h2>
          {e ? (
            <span className="text-sm text-text-muted">
              {PROVIDERS.find((p) => p.value === e.settings.provider)?.label ?? e.settings.provider} · <span className="font-mono">{e.settings.model}</span>
            </span>
          ) : null}
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
      {data.error ? <ErrorLine message={data.error} /> : null}
      {data.loading && !e ? <Skeleton className="h-40 w-full" /> : null}
      {s && u && e ? (
        <>
          {s.paused ? (
            <div role="alert" className="rounded-md border border-status-critical/40 bg-alert-red/10 px-4 py-3 text-sm">
              <strong>Paused{s.paused_reason ? `: ${s.paused_reason}` : ""}.</strong> It stays paused until an admin resumes it.
            </div>
          ) : null}
          {isAdmin ? (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Mode" htmlFor={`${engine}-mode`} className="min-w-56 flex-1">
              <NativeSelect id={`${engine}-mode`} value={s.mode} onChange={(v) => void change(() => setEngineMode(engine, v as EngineStatus["mode"]), "Mode changed")} options={MODES} />
            </Field>
            {s.paused ? (
              <Button size="sm" onClick={() => void change(() => resumeEngine(engine), `${TITLE[engine]} resumed`)} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Play aria-hidden="true" />}
                Resume
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => void change(() => pauseEngine(engine), `${TITLE[engine]} paused`)} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Pause aria-hidden="true" />}
                Pause
              </Button>
            )}
          </div>
          ) : null}
          <BudgetBar
            label="Budget this month"
            used={Number(s.spend_month)}
            limit={Number(s.monthly_budget_usd)}
            text={`${usd(s.spend_month)} of ${usd(s.monthly_budget_usd, 2)}`}
          />
          <BudgetBar label={`${UNIT[engine][0].toUpperCase()}${UNIT[engine].slice(1)} today`} used={s.titles_today} limit={s.daily_titles} text={`${formatNumber(s.titles_today)} of ${formatNumber(s.daily_titles)}`} />
          <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="text-text-muted">Calls this month</dt>
            <dd className="m-0 text-text-strong">
              {formatNumber(u.month_calls)} ({formatNumber(u.month_errors)} with errors) · today {formatNumber(u.day_calls)}, {usd(u.day_cost)}
            </dd>
            <dt className="text-text-muted">{engine === "jev" ? "Titles classified this month" : "Researches this month"}</dt>
            <dd className="m-0 text-text-strong">{formatNumber(u.month_titles)}</dd>
            {engine === "research" ? (
              <>
                <dt className="text-text-muted">Web searches this month</dt>
                <dd className="m-0 text-text-strong">{formatNumber(u.month_searches)}</dd>
                <dt className="text-text-muted">Waiting in the queue</dt>
                <dd className="m-0 text-text-strong">{formatNumber(u.queue ?? 0)}</dd>
              </>
            ) : (
              <>
                <dt className="text-text-muted">Cost per accepted title</dt>
                <dd className="m-0 text-text-strong">{u.cost_per_accepted !== null ? usd(u.cost_per_accepted) : "No accepted titles this month"}</dd>
                <dt className="text-text-muted">Acceptance rate (last 50 decisions)</dt>
                <dd className="m-0 text-text-strong">{u.acceptance_rate !== null ? `${Math.round(u.acceptance_rate * 100)} %` : "No decisions yet"}</dd>
              </>
            )}
          </dl>
          <div className="flex flex-col gap-2">
            <Eyebrow>Recent errors</Eyebrow>
            {u.recent_errors.length === 0 ? (
              <p className="m-0 text-sm text-text-muted">None.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
                {u.recent_errors.slice(0, 5).map((err, i) => (
                  <li key={i} className="break-words">
                    <span className="text-text-muted">
                      {formatDateTime(err.at)}
                      {err.http ? ` · HTTP ${err.http}` : ""} ·{" "}
                    </span>
                    {err.error ?? "Unknown error"}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </Card>
  );
}
