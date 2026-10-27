import { useState, type FormEvent } from "react";
import { Copy, KeyRound, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorLine } from "@/components/shared/error-line";
import { Field } from "@/components/shared/filters";
import { PageHeader } from "@/components/shared/page-header";
import { createClient, fetchClients, revokeClient, rotateClientKey, type ClientRow } from "@/features/clients/api";
import { formatDateTime, formatNumber } from "@/lib/format";
import { useLoad } from "@/lib/use-load";

// Endpoint Inventory installations allowed to read the dictionary. A key is shown once, here.
export function ClientsPage() {
  const clients = useLoad("clients", fetchClients);
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ name: string; key: string } | null>(null);

  async function rotate(c: ClientRow) {
    try {
      setRevealed({ name: c.name, key: await rotateClientKey(c.id) });
      clients.reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not rotate the key");
    }
  }

  async function revoke(c: ClientRow) {
    try {
      await revokeClient(c.id);
      toast.success(`${c.name} revoked: its key no longer works`);
      clients.reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not revoke the client");
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Access"
        title="Clients"
        description="Endpoint Inventory installations that read the dictionary and send suggestions. Each one authenticates with its own key."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" />
            New client
          </Button>
        }
      />
      {clients.error ? <ErrorLine message={clients.error} /> : null}
      <Card className="px-0 py-0">
        {clients.data && clients.data.length === 0 ? (
          <div className="p-6">
            <EmptyState icon={KeyRound} title="No clients yet" description="Create one and paste its key in the client's Settings › Dictionary hub." />
          </div>
        ) : (
          <Table aria-label="Clients">
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>Synced to seq</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(clients.data ?? []).map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-semibold text-text-strong">{c.name}</span>
                      <span className="text-xs text-text-muted">{c.contact_email}</span>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{c.key_prefix}…</TableCell>
                  <TableCell>
                    <Badge color={c.status === "active" ? "safe" : "slate"} soft>
                      {c.status === "active" ? "Active" : "Revoked"}
                    </Badge>
                  </TableCell>
                  <TableCell>{c.last_seen_at ? formatDateTime(c.last_seen_at) : "Never"}</TableCell>
                  <TableCell>{formatNumber(c.last_seq)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Confirm
                        trigger={c.status === "active" ? "Rotate key" : "Reactivate with a new key"}
                        title={`New key for ${c.name}?`}
                        description="The current key stops working at once. Paste the new key in the client's Settings › Dictionary hub."
                        confirm="Create new key"
                        onConfirm={() => void rotate(c)}
                      />
                      {c.status === "active" ? (
                        <Confirm
                          trigger="Revoke"
                          title={`Revoke ${c.name}?`}
                          description="Its key stops working at once. Its requests and submissions are kept."
                          confirm="Revoke"
                          destructive
                          onConfirm={() => void revoke(c)}
                        />
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      <NewClientDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(name, key) => {
          setCreating(false);
          setRevealed({ name, key });
          clients.reload();
        }}
      />
      <KeyDialog revealed={revealed} onClose={() => setRevealed(null)} />
    </>
  );
}

function Confirm({ trigger, title, description, confirm, destructive, onConfirm }: { trigger: string; title: string; description: string; confirm: string; destructive?: boolean; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className={destructive ? "text-text-critical" : undefined}>
          {trigger}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={destructive ? "destructive" : "default"} onClick={onConfirm}>
            {confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function NewClientDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (name: string, key: string) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !email.trim()) return setError("Enter a name and a contact email");
    setSaving(true);
    setError(null);
    try {
      const key = await createClient(name, email);
      onCreated(name.trim(), key);
      setName("");
      setEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the client");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>New client</DialogTitle>
            <DialogDescription>An Endpoint Inventory installation. Its key is shown once, right after this.</DialogDescription>
          </DialogHeader>
          <Field label="Name" htmlFor="client-name">
            <Input id="client-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Contact email" htmlFor="client-email">
            <Input id="client-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {error ? (
            <p role="alert" className="m-0 text-sm text-text-critical">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              Create client
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function KeyDialog({ revealed, onClose }: { revealed: { name: string; key: string } | null; onClose: () => void }) {
  return (
    <Dialog open={revealed !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Key for {revealed?.name}</DialogTitle>
          <DialogDescription>Copy it now: it is not shown again. Paste it with the Hub URL in the client's Settings › Dictionary hub.</DialogDescription>
        </DialogHeader>
        <Field label="Client key" htmlFor="client-key">
          <Input id="client-key" readOnly value={revealed?.key ?? ""} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        </Field>
        <DialogFooter>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void navigator.clipboard
                .writeText(revealed?.key ?? "")
                .then(() => toast.success("Key copied"))
                .catch(() => toast.error("Copy failed: select the key and copy it"))
            }
          >
            <Copy aria-hidden="true" />
            Copy key
          </Button>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
