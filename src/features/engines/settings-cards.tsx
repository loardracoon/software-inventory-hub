import { useState, type FormEvent } from "react";
import { KeyRound, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorLine } from "@/components/shared/error-line";
import { Eyebrow } from "@/components/shared/eyebrow";
import { Field, NativeSelect } from "@/components/shared/filters";
import { formatDateTime } from "@/lib/format";
import { useLoad } from "@/lib/use-load";
import { clearProviderKey, fetchEngine, fetchProviderKeys, JEV_PROVIDERS, PROVIDERS, setEngineConfig, setProviderKey, TRIGGERS, type Engine, type Provider, type ProviderKey } from "./api";

// Settings › AI providers: one write-only key per provider, kept in Vault. The console only sees the hint.
export function AiProvidersCard() {
  const [version, setVersion] = useState(0);
  const keys = useLoad(`provider-keys:${version}`, fetchProviderKeys);
  const byProvider = new Map((keys.data ?? []).map((k) => [k.provider, k]));

  return (
    <Card className="gap-5 px-6">
      <div className="flex flex-col gap-2">
        <Eyebrow>Engines</Eyebrow>
        <h2 className="m-0 text-xl">AI providers</h2>
      </div>
      <p className="m-0 text-sm text-text-muted">
        Keys are stored in Vault and used only by the Hub's Edge Functions. Once saved, a key is never shown again: you see its last four characters. Without a key, the
        engines answer with a local mock.
      </p>
      {keys.error ? <ErrorLine message={keys.error} /> : null}
      {keys.loading && !keys.data ? <Skeleton className="h-32 w-full" /> : null}
      <ul className="m-0 flex list-none flex-col gap-4 p-0">
        {PROVIDERS.map((p) => (
          <ProviderKeyRow key={p.value} provider={p.value} label={p.label} current={byProvider.get(p.value) ?? null} onChanged={() => setVersion((v) => v + 1)} />
        ))}
      </ul>
    </Card>
  );
}

function ProviderKeyRow({ provider, label, current, onChanged }: { provider: Provider; label: string; current: ProviderKey | null; onChanged: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `key-${provider}`;

  async function run(fn: () => Promise<void>, done: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setKey("");
      toast.success(done);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the key");
    } finally {
      setBusy(false);
    }
  }

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (key.trim().length < 16) return setError("Paste the full API key");
    void run(() => setProviderKey(provider, key.trim()), `${label}: key saved`);
  };

  return (
    <li className="flex flex-col gap-2 border-t border-border-subtle pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold text-text-strong">{label}</span>
        {current ? (
          <Badge color="safe" soft>
            <KeyRound aria-hidden="true" />
            Key {current.key_hint}
          </Badge>
        ) : (
          <Badge color="slate" soft>
            No key
          </Badge>
        )}
        {current ? <span className="text-xs text-text-muted">saved {formatDateTime(current.configured_at)}</span> : null}
      </div>
      <form onSubmit={save} className="flex flex-wrap items-end gap-3" noValidate>
        <Field label={current ? "Replace the key" : "API key"} htmlFor={id} className="min-w-64 flex-1">
          <Input id={id} type="password" autoComplete="off" spellCheck={false} value={key} maxLength={500} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <Button type="submit" size="sm" disabled={busy || !key}>
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Save key
        </Button>
        {current ? (
          <Button type="button" size="sm" variant="ghost" className="text-text-critical" disabled={busy} onClick={() => void run(() => clearProviderKey(provider), `${label}: key removed`)}>
            <Trash2 aria-hidden="true" />
            Remove
          </Button>
        ) : null}
      </form>
      {error ? <ErrorLine message={error} /> : null}
    </li>
  );
}

// Settings › Research engine: provider, model, daily limit, budget and the triggers that queue a research.
export function ResearchEngineCard() {
  const [version, setVersion] = useState(0);
  const engine = useLoad(`engine:research:settings:${version}`, () => fetchEngine("research"));

  return (
    <Card className="gap-5 px-6">
      <div className="flex flex-col gap-2">
        <Eyebrow>Engines</Eyebrow>
        <h2 className="m-0 text-xl">Research engine</h2>
      </div>
      <p className="m-0 text-sm text-text-muted">
        Researches a title on the web and writes a dossier with sources next to Jev's results. It never publishes. It runs from the Research button on an entry, or
        automatically for the triggers below (at most once per title every 30 days).
      </p>
      {engine.error ? <ErrorLine message={engine.error} /> : null}
      {engine.data ? <ResearchForm key={version} engine={engine.data} onSaved={() => setVersion((v) => v + 1)} /> : <Skeleton className="h-48 w-full" />}
    </Card>
  );
}

function ResearchForm({ engine, onSaved }: { engine: Engine; onSaved: () => void }) {
  const s = engine.settings;
  const [provider, setProvider] = useState<Provider>(s.provider);
  const [model, setModel] = useState(s.model);
  const [daily, setDaily] = useState(String(s.daily_titles));
  const [budget, setBudget] = useState(String(s.monthly_budget_usd));
  const [triggers, setTriggers] = useState<Record<string, boolean>>({ ...s.triggers });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function pickProvider(value: string) {
    const next = value as Provider;
    // A model belongs to one provider: switching proposes that provider's default.
    if (next !== provider) setModel(PROVIDERS.find((p) => p.value === next)?.defaultModel ?? "");
    setProvider(next);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const d = Number(daily);
    const b = Number(budget);
    if (!Number.isInteger(d) || d < 1) return setError("Researches per day must be a whole number, 1 or more");
    if (!(b >= 0)) return setError("The monthly budget must be 0 or more");
    if (!model.trim()) return setError("Enter the model");
    setSaving(true);
    setError(null);
    try {
      await setEngineConfig("research", { provider, model: model.trim(), daily: d, budget: b, triggers });
      toast.success("Research engine saved");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Provider" htmlFor="research-provider">
          <NativeSelect id="research-provider" value={provider} onChange={pickProvider} options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))} />
        </Field>
        <Field label="Model" htmlFor="research-model">
          <Input id="research-model" value={model} maxLength={80} onChange={(e) => setModel(e.target.value)} />
        </Field>
        <Field label="Researches per day" htmlFor="research-daily">
          <Input id="research-daily" type="number" min={1} step={1} value={daily} onChange={(e) => setDaily(e.target.value)} />
        </Field>
        <Field label="Monthly budget (USD)" htmlFor="research-budget">
          <Input id="research-budget" type="number" min={0} step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </Field>
      </div>
      <p className="m-0 text-xs text-text-muted">
        Each research runs at most {s.per_run_searches} web searches and stops after {s.timeout_seconds} seconds. Gemini, OpenAI and Grok have not been tested against their
        live APIs yet.
      </p>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 text-[13px] font-semibold text-text-strong">Research automatically when</legend>
        {TRIGGERS.map((t) => (
          <label key={t.key} className="flex items-center gap-2 text-sm">
            <input type="checkbox" role="switch" className="size-4 accent-action" checked={Boolean(triggers[t.key])} onChange={(e) => setTriggers((v) => ({ ...v, [t.key]: e.target.checked }))} />
            {t.label}
          </label>
        ))}
      </fieldset>
      {error ? <ErrorLine message={error} /> : null}
      <div>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Save
        </Button>
      </div>
    </form>
  );
}

// Settings › Jev: which provider and model classify the titles. Limits and budget stay as they are.
export function JevModelForm({ onSaved }: { onSaved?: () => void }) {
  const [version, setVersion] = useState(0);
  const engine = useLoad(`engine:jev:settings:${version}`, () => fetchEngine("jev"));
  const keys = useLoad("provider-keys:jev", fetchProviderKeys);
  if (engine.error) return <ErrorLine message={engine.error} />;
  if (!engine.data) return <Skeleton className="h-20 w-full" />;
  return (
    <JevModelFields
      key={version}
      engine={engine.data}
      keys={keys.data ?? null}
      onSaved={() => {
        setVersion((v) => v + 1);
        onSaved?.();
      }}
    />
  );
}

function JevModelFields({ engine, keys, onSaved }: { engine: Engine; keys: ProviderKey[] | null; onSaved: () => void }) {
  const s = engine.settings;
  const [provider, setProvider] = useState<Provider>(s.provider);
  const [model, setModel] = useState(s.model);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const label = JEV_PROVIDERS.find((p) => p.value === provider)?.label ?? provider;
  const hasKey = keys?.some((k) => k.provider === provider) ?? true;
  const changed = provider !== s.provider || model.trim() !== s.model;

  function pickProvider(value: string) {
    const next = value as Provider;
    if (next !== provider) setModel(JEV_PROVIDERS.find((p) => p.value === next)?.defaultModel ?? "");
    setProvider(next);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!model.trim()) return setError("Enter the model");
    setSaving(true);
    setError(null);
    try {
      await setEngineConfig("jev", { provider, model: model.trim(), daily: s.daily_titles, budget: Number(s.monthly_budget_usd) });
      toast.success(`Jev now uses ${label} · ${model.trim()}`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Provider" htmlFor="jev-provider">
          <NativeSelect id="jev-provider" value={provider} onChange={pickProvider} options={JEV_PROVIDERS.map((p) => ({ value: p.value, label: p.label }))} />
        </Field>
        <Field label="Model" htmlFor="jev-model">
          <Input id="jev-model" value={model} maxLength={80} onChange={(e) => setModel(e.target.value)} />
        </Field>
      </div>
      {!hasKey ? (
        <p className="m-0 text-xs text-text-critical" role="status">
          No {label} key in AI providers: Jev answers with the local mock until you add one.
        </p>
      ) : null}
      {error ? <ErrorLine message={error} /> : null}
      <div>
        <Button type="submit" size="sm" disabled={saving || !changed}>
          {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Save provider and model
        </Button>
      </div>
    </form>
  );
}
