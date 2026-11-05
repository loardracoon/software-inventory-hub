import { useState } from "react";
import { Check, X } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorLine } from "@/components/shared/error-line";
import { useHubRole } from "@/features/auth/auth-context";
import { formatDateTime } from "@/lib/format";
import { decideAccessRequest, type AccessRequest } from "./enrollments";

const STATUS: Record<AccessRequest["status"], { label: string; color: "safe" | "slate" | "critical" | "info" }> = {
  unverified: { label: "Email not confirmed", color: "slate" },
  pending: { label: "Waiting for a decision", color: "info" },
  approved: { label: "Approved", color: "safe" },
  rejected: { label: "Rejected", color: "critical" },
  expired: { label: "Expired", color: "slate" },
  cancelled: { label: "Cancelled", color: "slate" },
};

// Inbox › Access requests: installations that asked for a client key from their Settings. Only requests whose
// email was confirmed can be decided; the key is the installation's own (the Hub holds its hash only).
export function AccessRequests({ requests, error, onDecided }: { requests: AccessRequest[]; error: string | null; onDecided: () => void }) {
  const { isAdmin } = useHubRole();
  if (error) return <ErrorLine message={error} />;
  if (!requests.length) {
    return <EmptyState title="No access requests" description="Installations ask for a key from their Settings › Dictionary hub. Open requests in Settings › Access requests." />;
  }
  return (
    <Card className="px-6">
      <Table aria-label="Access requests">
        <TableHeader>
          <TableRow>
            <TableHead>Installation</TableHead>
            <TableHead>Contact</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {requests.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <div className="flex flex-col gap-0.5">
                  <span className="font-semibold text-text-strong">{r.name}</span>
                  <span className="text-xs text-text-muted">
                    {r.organization ?? "No organization"} · asked {formatDateTime(r.created_at)}
                  </span>
                </div>
              </TableCell>
              <TableCell>{r.contact_email}</TableCell>
              <TableCell className="max-w-72 whitespace-normal text-sm">{r.reason ?? <span className="text-text-muted">None</span>}</TableCell>
              <TableCell>
                <div className="flex flex-col items-start gap-1">
                  <Badge color={STATUS[r.status].color} soft>
                    {r.auto_approved ? "Approved automatically" : STATUS[r.status].label}
                  </Badge>
                  {r.decision_note ? <span className="max-w-60 text-xs text-text-muted">{r.decision_note}</span> : null}
                </div>
              </TableCell>
              <TableCell className="text-right whitespace-nowrap">
                {isAdmin && r.status === "pending" ? (
                  <>
                    <Decide request={r} approve onDone={onDecided} />
                    <Decide request={r} approve={false} onDone={onDecided} />
                  </>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function Decide({ request, approve, onDone }: { request: AccessRequest; approve: boolean; onDone: () => void }) {
  const [note, setNote] = useState("");
  async function decide() {
    try {
      await decideAccessRequest(request.id, approve, note);
      toast.success(approve ? `${request.name} can now use this Hub` : `Request of ${request.name} rejected`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the decision");
    } finally {
      onDone();
    }
  }
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" className={approve ? undefined : "text-text-critical"}>
          {approve ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
          {approve ? "Approve" : "Reject"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{approve ? `Approve ${request.name}?` : `Reject ${request.name}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {approve
              ? "Its key starts to work at once: the installation pulls the dictionary and shares its unknown titles. The contact gets an email."
              : "Its key is deleted and never works. The contact gets an email with your note."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input aria-label="Note to the requester" placeholder="Note to the requester (optional)" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={approve ? "default" : "destructive"} onClick={() => void decide()}>
            {approve ? "Approve" : "Reject"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
