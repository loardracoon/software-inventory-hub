import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router";
import { BookOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/shared/empty-state";
import { Field, NativeSelect } from "@/components/shared/filters";
import { PageHeader } from "@/components/shared/page-header";
import { ServerDataTable, type ServerColumnDef, type ServerPageRequest } from "@/components/shared/server-data-table";
import { fetchCategories, level2Options, searchEntries, type DictionaryFilters, type EntryRow } from "@/features/dictionary/api";
import { AttentionBadge } from "@/features/jev/jev-bits";
import { formatNumber } from "@/lib/format";
import { useLoad } from "@/lib/use-load";

export const KIND_LABEL: Record<string, string> = { program: "Program", extension: "Browser extension", ide_extension: "IDE extension", package: "Package" };
export const METHOD_LABEL: Record<string, string> = { rule: "Rule", jev: "Jev", jev_auto: "Jev auto", manual: "Manual" };
const STATUS_COLOR = { published: "safe", proposed: "info", pending: "slate", deprecated: "high" } as const;

const COLUMNS: ServerColumnDef<EntryRow>[] = [
  {
    accessorKey: "canonical_name",
    header: "Title",
    cell: ({ row }) => (
      <div className="flex flex-col gap-0.5">
        <Link to={`/dictionary/${row.original.id}`} className="font-semibold">
          {row.original.canonical_name}
        </Link>
        <span className="font-mono text-xs text-text-muted">{row.original.match_key}</span>
      </div>
    ),
  },
  { id: "kind", header: "Kind · source", enableSorting: false, cell: ({ row }) => `${KIND_LABEL[row.original.kind] ?? row.original.kind} · ${row.original.source}` },
  {
    id: "category",
    header: "Category",
    enableSorting: false,
    cell: ({ row }) =>
      row.original.category_name ? (
        <div className="flex flex-col items-start gap-1">
          <span className="text-xs text-text-muted">{row.original.level1_name}</span>
          <span className="flex items-center gap-2">
            {row.original.category_name}
            {row.original.attention_level && row.original.attention_level !== "info" ? <AttentionBadge level={row.original.attention_level} /> : null}
          </span>
        </div>
      ) : (
        <span className="text-text-muted">—</span>
      ),
  },
  {
    id: "method",
    header: "Method",
    enableSorting: false,
    cell: ({ row }) =>
      row.original.method ? `${METHOD_LABEL[row.original.method]}${row.original.confidence !== null ? ` ${Number(row.original.confidence).toFixed(2)}` : ""}` : "—",
  },
  {
    id: "status",
    header: "Status",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="flex flex-wrap gap-1">
        <Badge color={STATUS_COLOR[row.original.status]} soft>
          {row.original.status}
        </Badge>
        {row.original.has_draft ? (
          <Badge color="medium" soft>
            draft
          </Badge>
        ) : null}
        {row.original.open_requests > 0 ? (
          <Badge color="info" soft>
            {row.original.open_requests} request(s)
          </Badge>
        ) : null}
      </div>
    ),
  },
  { accessorKey: "revision", header: "Rev.", enableSorting: false },
  { accessorKey: "reports_count", header: "Clients", cell: ({ getValue }) => formatNumber(getValue() as number) },
];

export function DictionaryPage() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<DictionaryFilters["status"]>("");
  const [kind, setKind] = useState<DictionaryFilters["kind"]>("");
  const [categoryId, setCategoryId] = useState("");
  const categories = useLoad("categories", fetchCategories);
  const filters = useMemo<DictionaryFilters>(() => ({ query, status, kind, categoryId }), [query, status, kind, categoryId]);
  const fetchPage = useCallback((r: ServerPageRequest<DictionaryFilters>) => searchEntries(r), []);

  return (
    <>
      <PageHeader eyebrow="Dictionary" title="Dictionary" description="Every software title with its category, how it was decided and its revision." />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Search" htmlFor="dict-search" className="sm:col-span-2">
          <Input id="dict-search" type="search" placeholder="Name, vendor or match key" value={query} onChange={(e) => setQuery(e.target.value)} />
        </Field>
        <Field label="Status" htmlFor="dict-status">
          <NativeSelect
            id="dict-status"
            value={status}
            onChange={(v) => setStatus(v as DictionaryFilters["status"])}
            options={[
              { value: "", label: "Any status" },
              { value: "published", label: "Published" },
              { value: "proposed", label: "Proposed" },
              { value: "pending", label: "Pending" },
              { value: "deprecated", label: "Deprecated" },
            ]}
          />
        </Field>
        <Field label="Kind" htmlFor="dict-kind">
          <NativeSelect
            id="dict-kind"
            value={kind}
            onChange={(v) => setKind(v as DictionaryFilters["kind"])}
            options={[{ value: "", label: "Any kind" }, ...Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))]}
          />
        </Field>
        <Field label="Category" htmlFor="dict-category" className="sm:col-span-2">
          <NativeSelect id="dict-category" value={categoryId} onChange={setCategoryId} options={[{ value: "", label: "Any category" }, ...level2Options(categories.data ?? [])]} />
        </Field>
      </div>
      <ServerDataTable
        label="Dictionary entries"
        columns={COLUMNS}
        fetchPage={fetchPage}
        filters={filters}
        getRowId={(r) => r.id}
        initialSorting={[{ id: "reports_count", desc: true }]}
        empty={<EmptyState icon={BookOpen} title="No entries match" description="Titles arrive when clients report them." />}
      />
    </>
  );
}
