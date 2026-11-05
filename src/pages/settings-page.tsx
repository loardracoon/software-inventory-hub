import { PageHeader } from "@/components/shared/page-header";
import { AccessRequestsCard } from "@/features/clients/access-requests-card";
import { AiProvidersCard, ResearchEngineCard } from "@/features/engines/settings-cards";
import { JevCard } from "@/features/jev/jev-card";
import { UsersCard } from "@/features/users/users-card";
import { DataSourcesCard } from "@/features/vulns/data-sources-card";

export function SettingsPage() {
  return (
    <>
      <PageHeader eyebrow="Administration" title="Settings" description="Users and access, access requests of installations, AI provider keys and the engines." />
      <UsersCard />
      <AccessRequestsCard />
      <AiProvidersCard />
      <DataSourcesCard />
      <JevCard />
      <ResearchEngineCard />
    </>
  );
}
