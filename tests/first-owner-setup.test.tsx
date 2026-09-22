import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstOwnerSetup } from "@/components/ezra/FirstOwnerSetup";

describe("FirstOwnerSetup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("guides an owner through secure browser setup without environment-file instructions", () => {
    render(<FirstOwnerSetup challenge="a-valid-one-time-setup-challenge" />);

    expect(screen.getByRole("heading", { name: "Secure Ezra Mail" })).toBeVisible();
    expect(screen.getByLabelText("Owner password")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Confirm owner password")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Name this device")).toBeVisible();
    expect(screen.queryByText(/environment file|password hash/i)).not.toBeInTheDocument();
  });

  it("offers passkey enrollment only after it creates the owner and trusted device", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ recoveryKit: { code: "one-time-recovery-code" } }),
    }));
    render(<FirstOwnerSetup challenge="a-valid-one-time-setup-challenge" />);
    fireEvent.change(screen.getByLabelText("Owner password"), { target: { value: "a much better owner password" } });
    fireEvent.change(screen.getByLabelText("Confirm owner password"), { target: { value: "a much better owner password" } });
    fireEvent.click(screen.getByRole("button", { name: "Secure this Ezra Mail" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Add a passkey now" })).toBeVisible());
  });
});
