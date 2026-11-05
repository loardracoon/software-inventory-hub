import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorLine } from "@/components/shared/error-line";
import { Eyebrow } from "@/components/shared/eyebrow";
import { Field } from "@/components/shared/filters";
import { useHubRole } from "@/features/auth/auth-context";
import { useLoad } from "@/lib/use-load";
import { fetchEnrollmentSettings, parseDomains, saveEnrollmentSettings, type EnrollmentSettings } from "./enrollments";

// Settings › Access requests (hub admins): whether installations may ask for a key from their own Settings, which
// email domains may ask, and which are approved without a review once their email is confirmed.
export function AccessRequestsCard() {
  const { isAdmin } = useHubRole();
  return isAdmin ? <AccessRequestsAdmin /> : null;
}

function AccessRequestsAdmin() {
  const [version, setVersion] = useState(0);
  const settings = useLoad(`enrollment-settings:${version}`, fetchEnrollmentSettings);
  return (
    <Card className="gap-6 px-6">
      <div className="flex flex-col gap-2">
        <Eyebrow>Administration</Eyebrow>
        <h2 className="m-0 text-xl">Access requests</h2>
        <p className="m-0 text-sm text-text-muted">
          Endpoint Inventory installations can ask for a client key from their Settings › Dictionary hub. The installation makes the key and sends only
          its hash; the requester must confirm the email address first, then the request waits in Inbox › Access requests (or is approved at once for the
          domains below). Open requests end after 14 days. Each address may send 3 requests an hour; at most 50 requests are open at a time.
        </p>
      </div>
      {settings.error ? <ErrorLine message={settings.error} /> : null}
      {settings.loading && !settings.data ? <Skeleton className="h-24 w-full" /> : null}
      {settings.data ? <SettingsForm key={settings.data.updated_at ?? "new"} initial={settings.data} onSaved={() => setVersion((v) => v + 1)} /> : null}
    </Card>
  );
}

function SettingsForm({ initial, onSaved }: { initial: EnrollmentSettings; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [allowed, setAllowed] = useState(initial.allowed_domains.join(", "));
  const [auto, setAuto] = useState(initial.auto_approve_domains.join(", "));
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await saveEnrollmentSettings(enabled, parseDomains(allowed), parseDomains(auto));
      toast.success(enabled ? "Access requests are open" : "Access requests are closed");
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void save(e)}>
      <label className="flex items-center gap-2 text-sm font-semibold text-text-strong">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Take access requests from installations
      </label>
      <Field label="Allowed email domains (empty: any domain, after email confirmation)" htmlFor="enroll-allowed">
        <Input id="enroll-allowed" placeholder="sophos.com, partner.example" value={allowed} onChange={(e) => setAllowed(e.target.value)} />
      </Field>
      <Field label="Approve automatically once the email is confirmed (at most 20 a day for each domain)" htmlFor="enroll-auto">
        <Input id="enroll-auto" placeholder="sophos.com" value={auto} onChange={(e) => setAuto(e.target.value)} />
      </Field>
      <div>
        <Button type="submit" disabled={saving}>
          {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Save
        </Button>
      </div>
    </form>
  );
}
