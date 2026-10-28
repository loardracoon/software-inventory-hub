import { useMemo, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorLine } from "@/components/shared/error-line";
import { Field, NativeSelect } from "@/components/shared/filters";
import { PageHeader } from "@/components/shared/page-header";
import { deprecateCategory, fetchCategories, level2Options, updateCategory, type CategoryRow } from "@/features/dictionary/api";
import { AttentionBadge } from "@/features/jev/jev-bits";
import { useLoad } from "@/lib/use-load";
import { useHubRole } from "@/features/auth/auth-context";

type Editing = { kind: "edit" | "deprecate"; category: CategoryRow };

export function TaxonomyPage() {
  const { isAdmin } = useHubRole();
  const [version, setVersion] = useState(0);
  const categories = useLoad(`categories:${version}`, fetchCategories);
  const [editing, setEditing] = useState<Editing | null>(null);
  const rows = useMemo(() => categories.data ?? [], [categories.data]);
  const level1 = rows.filter((r) => !r.parent_id);

  return (
    <>
      <PageHeader
        eyebrow="Dictionary"
        title="Taxonomy"
        description="Two levels of categories. Slugs never change; edits are revisioned and published to clients. Retiring a category moves its entries to a replacement."
      />
      {categories.error ? <ErrorLine message={categories.error} /> : null}
      {categories.loading && rows.length === 0 ? <Skeleton className="h-40 w-full" /> : null}
      {level1.map((p) => (
        <Card key={p.id} className="gap-3 px-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="m-0 text-lg">{p.name}</h2>
            {isAdmin ? (
              <Button size="sm" variant="ghost" onClick={() => setEditing({ kind: "edit", category: p })}>
                Edit
              </Button>
            ) : null}
          </div>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {rows
              .filter((c) => c.parent_id === p.id)
              .map((c) => (
                <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 border-t border-border-subtle pt-3">
                  <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={c.deprecated ? "text-text-muted line-through" : "font-semibold text-text-strong"}>{c.name}</span>
                      <AttentionBadge level={c.attention_level} />
                      {c.deprecated ? (
                        <Badge color="slate" soft>
                          deprecated
                        </Badge>
                      ) : null}
                      <span className="font-mono text-xs text-text-muted">
                        {c.slug} · rev {c.revision}
                      </span>
                    </span>
                    {c.description ? <span className="text-sm text-text-muted">{c.description}</span> : null}
                  </div>
                  {!c.deprecated && isAdmin ? (
                    <span className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ kind: "edit", category: c })}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" className="text-text-critical" onClick={() => setEditing({ kind: "deprecate", category: c })}>
                        Deprecate
                      </Button>
                    </span>
                  ) : null}
                </li>
              ))}
          </ul>
        </Card>
      ))}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          {editing ? (
            <CategoryForm
              key={editing.category.id + editing.kind}
              editing={editing}
              options={level2Options(rows).filter((o) => o.value !== editing.category.id)}
              onDone={() => {
                setEditing(null);
                setVersion((v) => v + 1);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function CategoryForm({ editing, options, onDone }: { editing: Editing; options: { value: string; label: string }[]; onDone: () => void }) {
  const c = editing.category;
  const [name, setName] = useState(c.name);
  const [description, setDescription] = useState(c.description ?? "");
  const [replacement, setReplacement] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!reason.trim()) return setError("Enter a change reason");
    if (editing.kind === "deprecate" && !replacement) return setError("Choose the replacement category");
    setSaving(true);
    setError(null);
    try {
      if (editing.kind === "edit") {
        await updateCategory(c.id, name, description, reason);
        toast.success(`${name} published to clients`);
      } else {
        const moved = await deprecateCategory(c.id, replacement, reason);
        toast.success(`${c.name} deprecated; ${moved} entr${moved === 1 ? "y" : "ies"} moved`);
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>{editing.kind === "edit" ? `Edit ${c.name}` : `Deprecate ${c.name}`}</DialogTitle>
        <DialogDescription>
          {editing.kind === "edit"
            ? "The slug stays the same. The change is published to every client with a new revision."
            : "Every entry in this category moves to the replacement, and clients receive both changes. This cannot be undone from here."}
        </DialogDescription>
      </DialogHeader>
      {editing.kind === "edit" ? (
        <>
          <Field label="Name" htmlFor="cat-name">
            <Input id="cat-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description (Jev reads it)" htmlFor="cat-description">
            <textarea
              id="cat-description"
              rows={4}
              maxLength={2000}
              className="w-full rounded-sm border-[1.5px] border-input bg-surface-raised px-3 py-2 text-[15px]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </>
      ) : (
        <Field label="Replacement category" htmlFor="cat-replacement">
          <NativeSelect id="cat-replacement" value={replacement} onChange={setReplacement} options={[{ value: "", label: "Choose a category" }, ...options]} />
        </Field>
      )}
      <Field label="Change reason (required)" htmlFor="cat-reason">
        <Input id="cat-reason" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {error ? (
        <p role="alert" className="m-0 text-sm text-text-critical">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="submit" size="sm" variant={editing.kind === "deprecate" ? "destructive" : "default"} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          {editing.kind === "edit" ? "Save and publish" : "Deprecate and move entries"}
        </Button>
      </DialogFooter>
    </form>
  );
}
