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
    isHubAdmin: true,
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
  it("denies access to signed-in users who are not hub admins", () => {
    renderAt("/", { isHubAdmin: false, user: { id: "u2", email: "someone@example.com" } as AuthContextValue["user"] });
    expect(screen.getByText("Access denied")).toBeInTheDocument();
    expect(screen.getByText(/someone@example.com is not a Dictionary Hub admin/)).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).not.toBeInTheDocument();
  });

  it("sends signed-out visitors to the sign-in page", () => {
    renderAt("/taxonomy", { status: "signed_out", user: null, isHubAdmin: null });
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows the console sections and the unread count to hub admins", async () => {
    renderAt("/", {});
    expect(screen.getByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
    const nav = screen.getAllByRole("navigation", { name: "Main navigation" })[0];
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Inbox", "Dictionary", "Classification runs", "Engines & usage", "Taxonomy", "Clients", "Settings"]);
    expect(await screen.findByRole("button", { name: "Notifications, 3 unread" })).toBeInTheDocument();
  });
});
