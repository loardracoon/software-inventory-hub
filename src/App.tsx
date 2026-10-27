import { Route, Routes } from "react-router";
import { AppLayout } from "@/components/layout/app-layout";
import { RequireAuth } from "@/features/auth/require-auth";
import { ClientsPage } from "@/pages/clients-page";
import { DictionaryPage } from "@/pages/dictionary-page";
import { EnginesPage } from "@/pages/engines-page";
import { EntryPage } from "@/pages/entry-page";
import { InboxPage } from "@/pages/inbox-page";
import { LoginPage } from "@/pages/login-page";
import { NotFoundPage } from "@/pages/not-found-page";
import { RunsPage } from "@/pages/runs-page";
import { SettingsPage } from "@/pages/settings-page";
import { TaxonomyPage } from "@/pages/taxonomy-page";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<InboxPage />} />
        <Route path="dictionary" element={<DictionaryPage />} />
        <Route path="dictionary/:id" element={<EntryPage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="engines" element={<EnginesPage />} />
        <Route path="taxonomy" element={<TaxonomyPage />} />
        <Route path="clients" element={<ClientsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
