import { useState } from "react";
import { Link } from "react-router";
import { Boxes, Loader2, Scissors } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ErrorLine } from "@/components/shared/error-line";
import { Eyebrow } from "@/components/shared/eyebrow";
import { Field } from "@/components/shared/filters";
import { useHubRole } from "@/features/auth/auth-context";
import { useLoad } from "@/lib/use-load";
import { fetchProduct, searchProducts, setEntryProduct, type EntryKind, type ProductInfo } from "./api";

const STATUS_COLOR = { published: "safe", proposed: "info", pending: "slate", deprecated: "high" } as const;

// Entry page: the product this spelling belongs to and its other spellings. Operators and admins can move
// a spelling to another product or split it into its own (it then stays where they put it).
export function ProductCard({ entryId, productId, kind, onChanged }: { entryId: string; productId: string | null; kind: EntryKind; onChanged: () => void }) {
  const { canCurate } = useHubRole();
  const [version, setVersion] = useState(0);
  const data = useLoad(`product:${productId}:${version}`, () => (productId ? fetchProduct(productId) : Promise.resolve(null)));
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<ProductInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const product = data.data?.product ?? null;
  const aliases = data.data?.aliases ?? [];
  const self = aliases.find((a) => a.id === entryId);

  async function change(target: string | null, done: string) {
    setBusy(true);
    try {
      await setEntryProduct(entryId, target);
      toast.success(done);
      setQuery("");
      setMatches([]);
      setVersion((v) => v + 1);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change the product");
    } finally {
      setBusy(false);
    }
  }

  async function find(value: string) {
    setQuery(value);
    try {
      setMatches((await searchProducts(value, kind)).filter((p) => p.id !== productId));
    } catch {
      setMatches([]);
    }
  }

  if (!productId) return null;
  return (
    <Card className="gap-4 px-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <Eyebrow>Product</Eyebrow>
          <span className="flex items-center gap-2 text-lg font-semibold text-text-strong">
            <Boxes className="size-5 text-text-muted" aria-hidden="true" />
            {product?.display_name ?? "…"}
            {product?.vendor ? <span className="text-sm font-normal text-text-muted">{product.vendor}</span> : null}
          </span>
        </div>
        {product?.conflict ? (
          <Badge color="high" soft>
            Spellings disagree: see Inbox › Grouping review
          </Badge>
        ) : null}
      </div>
      <p className="m-0 text-sm text-text-muted">
        Spellings that differ only by version, architecture or vendor form share one classification: publishing one publishes all of them.
      </p>
      {data.error ? <ErrorLine message={data.error} /> : null}
      <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Spellings of this product">
        {aliases.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
            {a.id === entryId ? <span className="font-semibold text-text-strong">{a.canonical_name} (this entry)</span> : <Link to={`/dictionary/${a.id}`}>{a.canonical_name}</Link>}
            <span className="font-mono text-xs text-text-muted">
              {a.source} · {a.match_key}
            </span>
            <Badge color={STATUS_COLOR[a.status]} soft>
              {a.status}
            </Badge>
            {a.category ? <span className="text-xs text-text-muted">{a.category.name}</span> : null}
            {a.product_locked ? (
              <Badge color="slate" soft>
                placed by hand
              </Badge>
            ) : null}
          </li>
        ))}
      </ul>
      {canCurate ? (
        <div className="flex flex-col gap-3 border-t border-border-subtle pt-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Move this entry to another product" htmlFor="product-search" className="min-w-64 flex-1">
              <Input id="product-search" type="search" placeholder="Product name" value={query} onChange={(e) => void find(e.target.value)} />
            </Field>
            {aliases.length > 1 ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void change(null, "Split into a product of its own")}>
                {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Scissors aria-hidden="true" />}
                Split
              </Button>
            ) : null}
          </div>
          {matches.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {matches.map((p) => (
                <li key={p.id ?? ""} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>
                    {p.display_name} <span className="text-text-muted">· {p.vendor ?? "no vendor"} · {p.aliases} spelling(s)</span>
                  </span>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void change(p.id, `Moved to ${p.display_name}`)}>
                    Move here
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {self?.product_locked ? <p className="m-0 text-xs text-text-muted">This entry was placed by hand; automatic grouping leaves it here.</p> : null}
        </div>
      ) : null}
    </Card>
  );
}
