import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarView } from "@/components/ezra/CalendarView";

describe("calendar draft time and reminder review", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });
  it.each([
    ["2026-10-01T23:30:00Z", "2026-10-01", "18:00", "19:00"],
    ["2026-10-02T04:30:00Z", "2026-10-02", "00:00", "01:00"],
  ])("starts a valid default draft in the selected timezone at %s", async (now, date, start, end) => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ events: [], drafts: [], accounts: [{ accountId: "a1", accountLabel: "Personal", accountEmail: "owner@hotmail.test", provider: "microsoft", status: "connected", calendarStatus: "connected", calendarAccess: "write" }], range: { from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z", timezone: "America/Chicago" } }))));
    render(<CalendarView workspaceId="workspace:all" workspace={null} onOpenSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /new event/i }));
    expect(screen.getByLabelText("Date")).toHaveValue(date);
    expect(screen.getByLabelText("Start")).toHaveValue(start);
    expect(screen.getByLabelText("End")).toHaveValue(end);
  });
  it.each([["0", "minutes", 0], ["none", "none", null], ["", "default", null]])("preserves reminder choice %s and selected timezone", async (choice, mode, minutes) => {
    const writes: Array<{ draft: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)); writes.push(body);
        return new Response(JSON.stringify({ ok: true, message: "Saved", draft: { ...body.draft, id: "d1", accountLabel: "Personal", accountProvider: "microsoft", attendees: [], status: "draft" } }));
      }
      return new Response(JSON.stringify({ events: [], drafts: [], accounts: [{ accountId: "a1", accountLabel: "Personal", accountEmail: "owner@hotmail.test", provider: "microsoft", status: "connected", calendarStatus: "connected", calendarAccess: "write" }], range: { from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z", timezone: "America/Chicago" } }));
    }));
    render(<CalendarView workspaceId="workspace:all" workspace={null} onOpenSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /new event/i }));
    for (const [label, value] of [["Title", "Reminder"], ["Date", "2026-10-09"], ["Start", "07:00"], ["End", "07:10"], ["Timezone", "America/Chicago"], ["Reminder", choice]]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Save draft for review" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].draft).toMatchObject({ startsAt: "2026-10-09T12:00:00.000Z", endsAt: "2026-10-09T12:10:00.000Z", reminderMode: mode, reminderMinutes: minutes });
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("America/Chicago");
  });
});
