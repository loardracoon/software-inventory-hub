import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ChevronLeft, ChevronRight, Loader2, Pencil, Plus, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorLine } from "@/components/shared/error-line";
import { Field, NativeSelect } from "@/components/shared/filters";
import { ProbabilityBar } from "@/features/jev/jev-bits";
import { fetchAutoPublished, revertAutoPublish } from "@/features/jev/api";
import { formatDate, formatDateTime, formatNumber } from "@/lib/format";
import { useLoad } from "@/lib/use-load";
import { EVENTS_PAGE, fetchEvents, fetchMissingPrices, fetchPrices, PROVIDERS, setPrice, type MissingPrice, type PriceInput } from "./api";

// Auto-published: what Jev published alone; Revert restores the previous category (or withdraws the entry).
export function AutoPublishedTab() {
  const [version, setVersion] = useState(0);
  const auto = useLoad(`auto:${version}`, fetchAutoPublished);

  async function revert(id: string, name: string) {
    try {
      const outcome = await revertAutoPublish(id);
      toast.success(outcome === "restored" ? `${name}: previous category restored` : `${name}: withdrawn from clients (deprecated)`);
      setVersion((v) => v + 1);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not revert");
    }
  }

  if (auto.error) return <ErrorLine message={auto.error} />;
  if ((auto.data ?? []).length === 0) {
    return <EmptyState title="Nothing published automatically" description="Jev publishes alone only at 0.95 or more, in Info categories, without a manual revision or an open request." />;
  }
  return (
    <Card className="px-0 py-0">
      <Table aria-label="Auto-published entries">
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Probability</TableHead>
            <TableHead>Published</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(auto.data ?? []).map((e) => (
            <TableRow key={e.id}>
              <TableCell className="font-semibold text-text-strong">
                <Link to={`/dictionary/${e.id}`}>{e.canonical_name}</Link>
              </TableCell>
              <TableCell>{e.category?.name ?? "—"}</TableCell>
              <TableCell>{e.confidence !== null ? <ProbabilityBar value={Number(e.confidence)} /> : "—"}</TableCell>
              <TableCell>{formatDateTime(e.updated_at)}</TableCell>
              <TableCell className="text-right">
                <Button size="sm" variant="ghost" onClick={() => void revert(e.id, e.canonical_name)}>
                  <RotateCcw aria-hidden="true" />
                  Revert
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

const EMPTY_PRICE: PriceInput = { engine: "research", provider: "claude", model: "", input_per_mtok: 0, output_per_mtok: 0, cache_read_per_mtok: 0, cache_write_per_mtok: 0, per_search_usd: 0 };

// Price table: the current price per engine and model (older rows are history; past calls keep their cost).
export function PricesTab() {
  const [version, setVersion] = useState(0);
  const prices = useLoad(`prices:${version}`, fetchPrices);
  const missing = useLoad(`missing-prices:${version}`, fetchMissingPrices);
  const [editing, setEditing] = useState<PriceInput | null>(null);
  const [history, setHistory] = useState(false);
  const seen = new Set<string>();
  const rows = (prices.data ?? []).map((p) => {
    const key = `${p.engine}:${p.model}`;
    const current = !seen.has(key) && new Date(p.effective_from) <= new Date();
    if (current) seen.add(key);
    return { ...p, current };
  });

  return (
    <div className="flex flex-col gap-4">
      {(missing.data ?? []).map((m: MissingPrice) => (
        <div key={`${m.engine}:${m.model}`} role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-status-high/40 bg-alert-orange/10 px-4 py-3 text-sm">
          <span>
            <strong>
              No price for {m.engine} · {m.model}.
            </strong>{" "}
            Its calls count as USD 0, so the budget cannot stop it.
          </span>
          <Button size="sm" onClick={() => setEditing({ ...EMPTY_PRICE, engine: m.engine, provider: m.provider, model: m.model })}>
            <Plus aria-hidden="true" />
            Add price
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-action" checked={history} onChange={(e) => setHistory(e.target.checked)} />
          Show earlier prices
        </label>
        <Button size="sm" variant="secondary" onClick={() => setEditing(EMPTY_PRICE)}>
          <Plus aria-hidden="true" />
          New price
        </Button>
      </div>
      {prices.error ? <ErrorLine message={prices.error} /> : null}
      <Card className="px-0 py-0">
        <Table aria-label="AI prices in USD">
          <TableHeader>
            <TableRow>
              <TableHead>Engine</TableHead>
              <TableHead>Provider · model</TableHead>
              <TableHead>Input / output</TableHead>
              <TableHead>Cache read / write</TableHead>
              <TableHead>Per search</TableHead>
              <TableHead>From</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows
              .filter((p) => history || p.current)
              .map((p) => (
                <TableRow key={`${p.engine}:${p.model}:${p.effective_from}`}>
                  <TableCell>{p.engine}</TableCell>
                  <TableCell>
                    {p.provider} · <span className="font-mono text-xs">{p.model}</span>
                  </TableCell>
                  <TableCell>
                    {Number(p.input_per_mtok)} / {Number(p.output_per_mtok)}
                  </TableCell>
                  <TableCell>
                    {Number(p.cache_read_per_mtok)} / {Number(p.cache_write_per_mtok)}
                  </TableCell>
                  <TableCell>{Number(p.per_search_usd)}</TableCell>
                  <TableCell>
                    {formatDate(p.effective_from)}{" "}
                    {p.current ? null : (
                      <Badge color="slate" soft>
                        earlier
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {p.current ? (
                      <Button size="sm" variant="ghost" aria-label={`Edit the price of ${p.engine} ${p.model}`} title="Edit" onClick={() => setEditing(p)}>
                        <Pencil aria-hidden="true" />
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </Card>
      <p className="m-0 text-xs text-text-muted">Prices in USD per million tokens and per web search. A change applies from now on; calls already made keep the cost they had.</p>
      <PriceDialog
        price={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          setVersion((v) => v + 1);
        }}
      />
    </div>
  );
}

function PriceDialog({ price, onClose, onSaved }: { price: PriceInput | null; onClose: () => void; onSaved: () => void }) {
  return (
    <Dialog open={price !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>{price ? <PriceForm key={`${price.engine}:${price.model}`} initial={price} onClose={onClose} onSaved={onSaved} /> : null}</DialogContent>
    </Dialog>
  );
}

function PriceForm({ initial, onClose, onSaved }: { initial: PriceInput; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isNew = !initial.model;
  const num = (k: keyof PriceInput, label: string) => (
    <Field label={label} htmlFor={`price-${k}`}>
      <Input id={`price-${k}`} type="number" min={0} step="0.0001" value={String(form[k])} onChange={(e) => setForm((f) => ({ ...f, [k]: Number(e.target.value) }))} />
    </Field>
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.model.trim()) return setError("Enter the model name");
    setSaving(true);
    setError(null);
    try {
      await setPrice(form);
      toast.success("Price saved; it applies from now on");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the price");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>{isNew ? "New price" : `Price for ${initial.model}`}</DialogTitle>
        <DialogDescription>USD per million tokens and per web search. Earlier calls keep their cost.</DialogDescription>
      </DialogHeader>
      {isNew ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Engine" htmlFor="price-engine">
            <NativeSelect
              id="price-engine"
              value={form.engine}
              onChange={(v) => setForm((f) => ({ ...f, engine: v }))}
              options={[
                { value: "research", label: "Research" },
                { value: "jev", label: "Jev" },
              ]}
            />
          </Field>
          <Field label="Provider" htmlFor="price-provider">
            <NativeSelect id="price-provider" value={form.provider} onChange={(v) => setForm((f) => ({ ...f, provider: v }))} options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))} />
          </Field>
          <Field label="Model" htmlFor="price-model">
            <Input id="price-model" value={form.model} maxLength={80} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} />
          </Field>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {num("input_per_mtok", "Input per MTok")}
        {num("output_per_mtok", "Output per MTok")}
        {num("cache_read_per_mtok", "Cache read per MTok")}
        {num("cache_write_per_mtok", "Cache write per MTok")}
        {num("per_search_usd", "Per web search")}
      </div>
      {error ? <ErrorLine message={error} /> : null}
      <DialogFooter>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Save price
        </Button>
      </DialogFooter>
    </form>
  );
}

const EVENT_LABEL: Record<string, string> = {
  published: "Published",
  reclassified: "Reclassified",
  description_changed: "Description changed",
  deprecated: "Deprecated",
  category_changed: "Category changed",
};

// Events: the dictionary change feed the clients pull (newest first).
export function EventsTab() {
  const [page, setPage] = useState(0);
  const events = useLoad(`events:${page}`, () => fetchEvents(page));
  const total = events.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / EVENTS_PAGE));

  if (events.error) return <ErrorLine message={events.error} />;
  return (
    <div className="flex flex-col gap-3">
      <Card className="px-0 py-0">
        <Table aria-label="Dictionary events">
          <TableHeader>
            <TableRow>
              <TableHead>Seq</TableHead>
              <TableHead>When</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Entry or category</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(events.data?.rows ?? []).map((ev) => (
              <TableRow key={ev.seq}>
                <TableCell className="font-mono text-xs">{ev.seq}</TableCell>
                <TableCell>{formatDateTime(ev.created_at)}</TableCell>
                <TableCell>{EVENT_LABEL[ev.type] ?? ev.type}</TableCell>
                <TableCell>{ev.entry ? <Link to={`/dictionary/${ev.entry.id}`}>{ev.entry.canonical_name}</Link> : (ev.category?.name ?? "—")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <div className="flex items-center justify-end gap-3 text-sm">
        <span className="text-text-muted">
          Page {page + 1} of {pages} · {formatNumber(total)} events
        </span>
        <Button size="sm" variant="ghost" aria-label="Previous page" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          <ChevronLeft aria-hidden="true" />
        </Button>
        <Button size="sm" variant="ghost" aria-label="Next page" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
