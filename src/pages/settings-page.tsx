import { PageHeader } from "@/components/shared/page-header";
import { AiProvidersCard, ResearchEngineCard } from "@/features/engines/settings-cards";
import { JevCard } from "@/features/jev/jev-card";
import { UsersCard } from "@/features/users/users-card";
import { DataSourcesCard } from "@/features/vulns/data-sources-card";

export function SettingsPage() {
  return (
    <>
      <PageHeader eyebrow="Administration" title="Settings" description="Users and access, AI provider keys and the engines." />
      <UsersCard />
      <AiProvidersCard />
      <DataSourcesCard />
      <JevCard />
      <ResearchEngineCard />
    </>
  );
}
