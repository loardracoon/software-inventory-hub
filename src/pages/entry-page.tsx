import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { Globe, Loader2, Send, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorLine } from "@/components/shared/error-line";
import { Eyebrow } from "@/components/shared/eyebrow";
import { Field, NativeSelect } from "@/components/shared/filters";
import { PageHeader } from "@/components/shared/page-header";
import {
  discardDraft,
  fetchCategories,
  fetchEntry,
  level2Options,
  publishEntry,
  saveDraft,
  type Attention,
  type DraftInput,
  type EntryDetail,
  type Draft,
} from "@/features/dictionary/api";
import { useHubRole } from "@/features/auth/auth-context";
import { runResearch } from "@/features/engines/api";
import { DossierCard } from "@/features/engines/dossier-card";
import { ProductCard } from "@/features/dictionary/product-card";
import { VulnsCard } from "@/features/vulns/vulns-card";
import { runJev } from "@/features/jev/api";
import { AttentionBadge, ProbabilityBar } from "@/features/jev/jev-bits";
import { formatDateTime } from "@/lib/format";
import { useLoad } from "@/lib/use-load";
import { KIND_LABEL, METHOD_LABEL } from "./dictionary-page";

const TEXTAREA =
  "w-full min-w-0 rounded-sm border-[1.5px] border-input bg-surface-raised px-3 py-2 text-[15px] text-text-body focus-visible:border-action focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:outline-none";

export function EntryPage() {
  const { canCurate } = useHubRole();
  const { id = "" } = useParams();
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);
  const data = useLoad(`entry:${id}:${version}`, () => fetchEntry(id));
  const categories = useLoad("categories", fetchCategories);
  const [jevBusy, setJevBusy] = useState(false);
  const [researchBusy, setResearchBusy] = useState(false);
  const e = data.data?.entry;

  if (data.error) return <ErrorLine message={data.error} />;
  if (!data.loading && !e) {
    return (
      <>
        <PageHeader eyebrow="Dictionary" title="Entry not found" />
        <EmptyState title="This entry does not exist" />
      </>
    );
  }

  async function jev() {
    setJevBusy(true);
    try {
      const r = await runJev({ action: e?.status === "published" ? "rerun" : "run_selected", entry_ids: [id] });
      if (!r.ok) toast.error(r.error ?? "Jev did not run");
      else toast.success(r.auto_published ? "Jev published it automatically" : "Jev's answer is in the proposals");
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not run Jev");
    } finally {
      setJevBusy(false);
    }
  }

  async function research() {
    setResearchBusy(true);
    try {
      const r = await runResearch(id);
      if (!r.ok) toast.error(r.error ?? "Research did not run");
      else toast.success(r.unknown ? "Research found no reliable source" : `Dossier ready: ${r.sources} source(s)`);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not run the research");
    } finally {
      setResearchBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={e ? `${KIND_LABEL[e.kind] ?? e.kind} · ${e.source}` : "Dictionary"}
        title={e?.canonical_name ?? "…"}
        description={e ? <span className="font-mono">{e.match_key}</span> : undefined}
        actions={
          canCurate ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => void research()} disabled={researchBusy || !e}>
              {researchBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Globe aria-hidden="true" />}
              Research
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void jev()} disabled={jevBusy || !e || e.status === "deprecated"}>
              {jevBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
              Run Jev
            </Button>
          </div>
          ) : undefined
        }
      />
      {!e ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          <Summary e={e} />
          <ProductCard entryId={e.id} productId={e.product_id} kind={e.kind} onChanged={reload} />
          <VulnsCard productId={e.product_id} />
          {canCurate ? <EditCard key={`${e.revision}:${data.data?.draft?.saved_at ?? ""}`} e={e} draft={data.data?.draft ?? null} options={level2Options(categories.data ?? [])} onChanged={reload} /> : null}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card className="gap-3 px-6">
              <Eyebrow>Jev results</Eyebrow>
              {(data.data?.results ?? []).length === 0 ? <p className="m-0 text-sm text-text-muted">Jev has not classified this title yet.</p> : null}
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {(data.data?.results ?? []).map((r) => (
                  <li key={r.run_id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span>
                      {r.category?.name ?? "—"} <span className="text-xs text-text-muted">· {r.run ? formatDateTime(r.run.started_at) : ""} · {r.run?.model}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      {r.probability !== null ? <ProbabilityBar value={Number(r.probability)} /> : null}
                      <Badge color={r.accepted === null ? "info" : r.accepted ? "safe" : "slate"} soft>
                        {r.accepted === null ? "open" : r.accepted ? "accepted" : "not accepted"}
                      </Badge>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
            <Card className="gap-3 px-6">
              <Eyebrow>Requests from clients</Eyebrow>
              {(data.data?.requests ?? []).length === 0 ? <p className="m-0 text-sm text-text-muted">No reclassification requests.</p> : null}
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {(data.data?.requests ?? []).map((r) => (
                  <li key={r.public_id} className="flex flex-col gap-1 text-sm">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono">{r.public_id}</span>
                      <Badge color={r.status === "open" ? "info" : r.status === "accepted" ? "safe" : "slate"} soft>
                        {r.status}
                      </Badge>
                      <span className="text-text-muted">
                        {r.client?.name} · suggests {r.suggested?.name ?? "Other"} · {formatDateTime(r.created_at)}
                      </span>
                    </span>
                    <span>{r.reason}</span>
                    {r.evidence_url ? (
                      <a href={r.evidence_url} target="_blank" rel="noreferrer noopener" className="text-xs break-all">
                        {r.evidence_url}
                      </a>
                    ) : null}
                    {r.admin_note ? <span className="text-xs text-text-muted">Note: {r.admin_note}</span> : null}
                  </li>
                ))}
              </ul>
            </Card>
          </div>
          <DossierCard entryId={id} version={version} />
          <Card className="gap-3 px-6">
            <Eyebrow>Revision history</Eyebrow>
            {(data.data?.revisions ?? []).length === 0 ? <p className="m-0 text-sm text-text-muted">Never published.</p> : null}
            <ol className="m-0 flex list-none flex-col gap-3 p-0">
              {(data.data?.revisions ?? []).map((r) => (
                <li key={r.revision} className="text-sm">
                  <span className="font-semibold text-text-strong">Revision {r.revision}</span>{" "}
                  <span className="text-text-muted">
                    · {formatDateTime(r.created_at)} · {String(r.snapshot.status)} · {METHOD_LABEL[String(r.snapshot.method)] ?? "—"}
                  </span>
                  {r.change_reason ? <div className="text-text-body">{r.change_reason}</div> : null}
                </li>
              ))}
            </ol>
          </Card>
          <Link to="/dictionary" className="text-sm">
            ← Back to the dictionary
          </Link>
        </>
      )}
    </>
  );
}

function Summary({ e }: { e: EntryDetail }) {
  return (
    <Card className="gap-3 px-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge color={e.status === "published" ? "safe" : e.status === "deprecated" ? "high" : "info"} soft>
          {e.status}
        </Badge>
        <span className="text-sm text-text-muted">
          Revision {e.revision} · {e.method ? METHOD_LABEL[e.method] : "not decided"}
          {e.confidence !== null ? ` ${Number(e.confidence).toFixed(2)}` : ""} · reported by {e.reports_count} client(s)
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {e.category ? (
          <>
            <span className="text-text-muted">{e.category.parent?.name} /</span>
            <span className="font-semibold text-text-strong">{e.category.name}</span>
            <AttentionBadge level={(e.attention_override ?? e.category.attention_level) as Attention} />
            {e.attention_override ? <span className="text-xs text-text-muted">(attention overridden)</span> : null}
          </>
        ) : (
          <span className="text-text-muted">No category published</span>
        )}
      </div>
      {e.vendor || e.description ? <p className="m-0 text-sm">{[e.vendor, e.description].filter(Boolean).join(" — ")}</p> : null}
    </Card>
  );
}

function EditCard({ e, draft, options, onChanged }: { e: EntryDetail; draft: Draft | null; options: { value: string; label: string }[]; onChanged: () => void }) {
  const [form, setForm] = useState<DraftInput>({
    name: draft?.canonical_name ?? e.canonical_name,
    vendor: draft?.vendor ?? e.vendor ?? "",
    description: draft?.description ?? e.description ?? "",
    categoryId: draft?.category_id ?? e.category_id ?? "",
    attention: (draft?.attention_override ?? e.attention_override ?? "") as Attention | "",
    clearAttention: false,
    reason: draft?.reason ?? "",
  });
  const [busy, setBusy] = useState<"save" | "publish" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof DraftInput>(k: K, v: DraftInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function run(kind: "save" | "publish" | "discard", fn: () => Promise<unknown>, done: string) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      toast.success(done);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(null);
    }
  }

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!form.reason.trim()) return setError("Enter a change reason");
    void run("save", () => saveDraft(e.id, { ...form, clearAttention: !form.attention && Boolean(e.attention_override) }), "Draft saved; publish it to send it to clients");
  };

  return (
    <Card className="gap-4 px-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Eyebrow>Edit</Eyebrow>
        {draft ? (
          <Badge color="medium" soft>
            Draft saved {formatDateTime(draft.saved_at)}: not published yet
          </Badge>
        ) : null}
      </div>
      <form onSubmit={save} className="flex flex-col gap-4" noValidate>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Canonical name" htmlFor="edit-name">
            <Input id="edit-name" value={form.name} maxLength={300} onChange={(ev) => set("name", ev.target.value)} />
          </Field>
          <Field label="Vendor" htmlFor="edit-vendor">
            <Input id="edit-vendor" value={form.vendor} maxLength={300} onChange={(ev) => set("vendor", ev.target.value)} />
          </Field>
          <Field label="Category" htmlFor="edit-category">
            <NativeSelect id="edit-category" value={form.categoryId} onChange={(v) => set("categoryId", v)} options={[{ value: "", label: "Choose a category" }, ...options]} />
          </Field>
          <Field label="Attention" htmlFor="edit-attention">
            <NativeSelect
              id="edit-attention"
              value={form.attention}
              onChange={(v) => set("attention", v as Attention | "")}
              options={[
                { value: "", label: "Category default" },
                { value: "info", label: "Info" },
                { value: "review", label: "Review" },
                { value: "not_allowed", label: "Not allowed" },
              ]}
            />
          </Field>
        </div>
        <Field label="Description" htmlFor="edit-description">
          <textarea id="edit-description" rows={3} maxLength={1000} className={TEXTAREA} value={form.description} onChange={(ev) => set("description", ev.target.value)} />
        </Field>
        <Field label="Change reason (required)" htmlFor="edit-reason">
          <Input id="edit-reason" value={form.reason} maxLength={1000} onChange={(ev) => set("reason", ev.target.value)} />
        </Field>
        {error ? (
          <p role="alert" className="m-0 text-sm text-text-critical">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" size="sm" variant="secondary" disabled={busy !== null}>
            {busy === "save" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            Save draft
          </Button>
          <Button type="button" size="sm" disabled={busy !== null || !draft} onClick={() => void run("publish", () => publishEntry(e.id), "Published: clients get it on their next sync")}>
            {busy === "publish" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
            Publish
          </Button>
          {draft ? (
            <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => void run("discard", () => discardDraft(e.id), "Draft discarded")}>
              Discard draft
            </Button>
          ) : null}
        </div>
        <p className="m-0 text-xs text-text-muted">Saving keeps the change private. Publishing creates a new revision with this reason and sends it to every client.</p>
      </form>
    </Card>
  );
}
