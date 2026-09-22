import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { RecipientField } from "@/components/ezra/RecipientField";

describe("RecipientField", () => {
  const requestedUrls: string[] = [];

  beforeEach(() => {
    requestedUrls.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({
        generatedAt: "2026-07-03T12:00:00.000Z",
        query: "jen",
        workspaceId: "workspace:microsoft",
        accountId: "acct-hotmail",
        items: [{
          id: "contact:acct-hotmail:jennifer.ortiz@target.test",
          accountId: "acct-hotmail",
          accountLabel: "Hotmail",
          accountProvider: "microsoft",
          name: "Jennifer Ortiz",
          email: "jennifer.ortiz@target.test",
          source: "sender",
          messageCount: 2,
          lastSeenAt: "2026-07-03T12:00:00.000Z",
          relationship: "2 received messages",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("looks up account-scoped contacts and inserts the selected recipient", async () => {
    render(<RecipientHarness />);

    fireEvent.change(screen.getByRole("textbox", { name: "To" }), { target: { value: "jen" } });

    const suggestion = await screen.findByRole("option", { name: /Jennifer Ortiz/ });
    expect(requestedUrls[0]).toContain("workspaceId=workspace%3Amicrosoft");
    expect(requestedUrls[0]).toContain("accountId=acct-hotmail");

    fireEvent.click(suggestion);

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "To" })).toHaveValue("Jennifer Ortiz <jennifer.ortiz@target.test>, ");
    });
  });
});

function RecipientHarness() {
  const [value, setValue] = useState("");
  return (
    <RecipientField
      label="To"
      value={value}
      onChange={setValue}
      workspaceId="workspace:microsoft"
      accountId="acct-hotmail"
      placeholder="person@example.com"
    />
  );
}
