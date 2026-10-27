import { PageHeader } from "@/components/shared/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EngineCard } from "@/features/engines/engine-card";
import { AutoPublishedTab, EventsTab, PricesTab } from "@/features/engines/usage-tabs";

export function EnginesPage() {
  return (
    <>
      <PageHeader eyebrow="Administration" title="Engines & usage" description="Jev and the research engine: mode, pause, budget, cost and what they did." />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <EngineCard engine="jev" />
        <EngineCard engine="research" />
      </div>
      <Tabs defaultValue="auto">
        <TabsList aria-label="Engines and usage">
          <TabsTrigger value="auto">Auto-published</TabsTrigger>
          <TabsTrigger value="prices">Price table</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>
        <TabsContent value="auto">
          <AutoPublishedTab />
        </TabsContent>
        <TabsContent value="prices">
          <PricesTab />
        </TabsContent>
        <TabsContent value="events">
          <EventsTab />
        </TabsContent>
      </Tabs>
    </>
  );
}
