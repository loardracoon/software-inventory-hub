import { PageHeader } from "@/components/shared/page-header";
import { AiProvidersCard, ResearchEngineCard } from "@/features/engines/settings-cards";
import { JevCard } from "@/features/jev/jev-card";

export function SettingsPage() {
  return (
    <>
      <PageHeader eyebrow="Administration" title="Settings" description="AI provider keys and the engines." />
      <AiProvidersCard />
      <JevCard />
      <ResearchEngineCard />
    </>
  );
}
