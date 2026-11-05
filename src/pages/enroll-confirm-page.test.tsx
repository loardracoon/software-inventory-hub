import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { confirmAccessRequest } from "@/features/clients/enrollments";
import { EnrollConfirmPage } from "./enroll-confirm-page";

vi.mock("@/features/clients/enrollments", () => ({ confirmAccessRequest: vi.fn(async () => "pending") }));

const token = "ab".repeat(32);
const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/enroll/confirm" element={<EnrollConfirmPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe("Access request confirmation page", () => {
  it("confirms nothing when the link is only opened (email scanners open links)", () => {
    renderAt(`/enroll/confirm?token=${token}`);
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    expect(confirmAccessRequest).not.toHaveBeenCalled();
  });

  it("confirms when a person presses the button", async () => {
    renderAt(`/enroll/confirm?token=${token}`);
    await userEvent.setup().click(screen.getByRole("button", { name: "Confirm" }));
    expect(confirmAccessRequest).toHaveBeenCalledWith(token);
    expect(await screen.findByText(/now waits for a Hub admin/)).toBeInTheDocument();
  });

  it("says a malformed link is not valid, without a button", () => {
    renderAt("/enroll/confirm?token=nope");
    expect(screen.getByText(/This link is not valid/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
