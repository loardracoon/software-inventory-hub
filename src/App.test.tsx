import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { AuthContext, type AuthContextValue } from "@/features/auth/auth-context";
import App from "./App";

// The bell reads notifications through db(): a fake query that resolves 3 unread items.
vi.mock("@/lib/supabase-query", () => {
  const rows = [{ id: 1, type: "reclassification_request", ref_id: "REQ-0001", title: "AnyDesk: Remote access requested", created_at: "2026-10-27T12:00:00Z" }];
  const query = { select: () => query, is: () => query, order: () => query, limit: () => Promise.resolve({ data: rows, count: 3, error: null }) };
  return { db: () => ({ from: () => query }), orThrow: (r: { data: unknown }) => r.data };
});

function renderAt(path: string, auth: Partial<AuthContextValue>) {
  const value: AuthContextValue = {
    status: "signed_in",
    session: null,
    user: { id: "u1", email: "admin@example.com" } as AuthContextValue["user"],
    role: "admin",
    sendMagicLink: vi.fn(),
    signOut: vi.fn(),
    ...auth,
  };
  return render(
    <ThemeProvider>
      <AuthContext.Provider value={value}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

describe("Dictionary Hub shell", () => {
  it("denies access to signed-in users without a Hub role", () => {
    renderAt("/", { role: "none", user: { id: "u2", email: "someone@example.com" } as AuthContextValue["user"] });
    expect(screen.getByText("Access denied")).toBeInTheDocument();
    expect(screen.getByText(/someone@example.com has no access to the Dictionary Hub/)).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).not.toBeInTheDocument();
  });

  it("sends signed-out visitors to the sign-in page", () => {
    renderAt("/taxonomy", { status: "signed_out", user: null, role: null });
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows the console sections and the unread count to hub admins", async () => {
    renderAt("/", {});
    expect(screen.getByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
    const nav = screen.getAllByRole("navigation", { name: "Main navigation" })[0];
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Inbox", "Dictionary", "Classification runs", "Engines & usage", "Taxonomy", "Clients", "Settings"]);
    expect(await screen.findByRole("button", { name: "Notifications, 3 unread" })).toBeInTheDocument();
  });

  it("shows operators the curator sections, without Clients and Settings", () => {
    renderAt("/", { role: "operator" });
    const nav = screen.getAllByRole("navigation", { name: "Main navigation" })[0];
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Inbox", "Dictionary", "Classification runs", "Engines & usage", "Taxonomy"]);
  });

  it("shows viewers the reading sections only and refuses admin pages", () => {
    renderAt("/settings", { role: "viewer" });
    const nav = screen.getAllByRole("navigation", { name: "Main navigation" })[0];
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Inbox", "Dictionary", "Classification runs", "Taxonomy"]);
    expect(screen.getByText("Only hub admins can open this page.")).toBeInTheDocument();
  });
});
