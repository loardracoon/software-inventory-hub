import { useState } from "react";
import { useSearchParams } from "react-router";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { confirmAccessRequest } from "@/features/clients/enrollments";

// Public page the confirmation email links to (no sign-in). The request is confirmed only when a person presses the
// button: email security scanners that open links do not confirm anything.
export function EnrollConfirmPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<"idle" | "busy" | "pending" | "approved" | "invalid" | "error">(/^[0-9a-f]{64}$/.test(token) ? "idle" : "invalid");

  async function confirm() {
    setState("busy");
    try {
      setState(await confirmAccessRequest(token));
    } catch {
      setState("error");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center px-4">
      <Card className="w-full gap-4 px-6">
        <h1 className="m-0 text-2xl">Dictionary Hub access request</h1>
        {state === "idle" || state === "busy" ? (
          <>
            <p className="m-0 text-sm">
              Confirm that you asked for a client key for your Endpoint Inventory installation. After the confirmation, a Hub admin reviews the request,
              or it is approved at once for some email domains.
            </p>
            <div>
              <Button onClick={() => void confirm()} disabled={state === "busy"}>
                {state === "busy" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                Confirm
              </Button>
            </div>
          </>
        ) : null}
        {state === "pending" ? <p className="m-0 text-sm">Confirmed. The request now waits for a Hub admin; you get an email with the decision.</p> : null}
        {state === "approved" ? (
          <p className="m-0 text-sm">Confirmed and approved. Your installation connects to the Hub by itself within 15 minutes; nothing else is needed.</p>
        ) : null}
        {state === "invalid" ? (
          <p className="m-0 text-sm">This link is not valid: it was already used, or it is older than 24 hours. Send a new request from the installation if needed.</p>
        ) : null}
        {state === "error" ? <p className="m-0 text-sm">The Hub could not confirm the request now. Try again later.</p> : null}
      </Card>
    </main>
  );
}
