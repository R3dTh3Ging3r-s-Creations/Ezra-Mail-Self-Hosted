import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarView } from "@/components/ezra/CalendarView";
import type {
  CalendarActionResult,
  CalendarDraft,
  CalendarEvent,
  CalendarPage,
  MailWorkspace,
} from "@/lib/email/types";

describe("CalendarView daily brief change signals", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("signals one confirmed non-empty sync for the workspace that initiated it", async () => {
    const response = deferred<Response>();
    const onDailyBriefChanged = vi.fn(async () => undefined);
    const dispatchEvent = vi.spyOn(window, "dispatchEvent");
    const harness = installFetchHarness(() => response.promise);
    const { rerender } = renderCalendar({
      workspaceId: "workspace:account:gmail:gmail-1",
      onDailyBriefChanged,
    });

    await screen.findByText("Gmail calendar");
    fireEvent.click(screen.getByRole("button", { name: "Sync calendars" }));
    await waitFor(() => expect(harness.actions).toHaveLength(1));
    expect(onDailyBriefChanged).not.toHaveBeenCalled();

    rerender(
      <CalendarView
        workspaceId="workspace:account:microsoft:ms-1"
        workspace={workspace("workspace:account:microsoft:ms-1", "Outlook")}
        onOpenSettings={vi.fn()}
        onDailyBriefChanged={onDailyBriefChanged}
      />,
    );
    response.resolve(jsonResponse({ ok: true, message: "Calendar sync complete.", synced: 2 }));

    await waitFor(() => {
      expect(onDailyBriefChanged).toHaveBeenCalledTimes(1);
    });
    expect(onDailyBriefChanged).toHaveBeenCalledWith("workspace:account:gmail:gmail-1");
    expect(harness.calendarReads.map((url) => new URL(url, "https://ezra.test").searchParams.get("workspaceId"))).toEqual([
      "workspace:account:gmail:gmail-1", "workspace:account:microsoft:ms-1",
    ]);
    expect(harness.urls.some((url) => url.startsWith("/api/today"))).toBe(false);
    expect(dispatchEvent.mock.calls.some(([event]) => event.type === "ezra:refresh")).toBe(false);
  });

  it("signals a partial sync when at least one initiating account completed", async () => {
    const onDailyBriefChanged = vi.fn();
    const initialPage = calendarPage();
    installFetchHarness(() => jsonResponse({
      ok: false,
      message: "Calendar sync completed with errors.",
      synced: 0,
      failures: [{ accountId: "gmail-2", error: "Calendar unavailable." }],
    }), {
      ...initialPage,
      accounts: [
        ...initialPage.accounts,
        {
          ...initialPage.accounts[0],
          accountId: "gmail-2",
          accountLabel: "Second Gmail",
          accountEmail: "second@gmail.test",
        },
      ],
    });
    renderCalendar({ onDailyBriefChanged });

    await screen.findByText("Gmail calendar");
    fireEvent.click(screen.getByRole("button", { name: "Sync calendars" }));

    await waitFor(() => expect(onDailyBriefChanged).toHaveBeenCalledTimes(1));
  });

  it("signals a successful zero-event sync because source freshness was confirmed", async () => {
    const onDailyBriefChanged = vi.fn();
    installFetchHarness(() => jsonResponse({
      ok: true,
      message: "Calendar sync complete.",
      synced: 0,
      failures: [],
    }));
    renderCalendar({ onDailyBriefChanged });

    await screen.findByText("Gmail calendar");
    fireEvent.click(screen.getByRole("button", { name: "Sync calendars" }));

    await waitFor(() => expect(onDailyBriefChanged).toHaveBeenCalledTimes(1));
  });

  it.each([
    ["an all-account failure", {
      ok: false,
      message: "Calendar sync failed.",
      synced: 0,
      failures: [{ accountId: "gmail-1", error: "Calendar unavailable." }],
    }],
    ["an encoded failure without account receipts", { ok: false, message: "Calendar sync failed.", synced: 1 }],
    ["a success without a confirmed count", { ok: true, message: "Sync response was incomplete." }],
  ] satisfies Array<[string, CalendarActionResult]>) (
    "does not signal for %s",
    async (_label, result) => {
      const onDailyBriefChanged = vi.fn();
      const harness = installFetchHarness(() => jsonResponse(result));
      renderCalendar({ onDailyBriefChanged });

      await screen.findByText("Gmail calendar");
      fireEvent.click(screen.getByRole("button", { name: "Sync calendars" }));

      await screen.findByText(result.message);
      await waitFor(() => expect(harness.calendarReads).toHaveLength(2));
      expect(onDailyBriefChanged).not.toHaveBeenCalled();
    },
  );

  it("does not signal when manual sync returns an HTTP error", async () => {
    const onDailyBriefChanged = vi.fn();
    installFetchHarness(() => jsonResponse({ error: "Provider sync failed." }, 502));
    renderCalendar({ onDailyBriefChanged });

    await screen.findByText("Gmail calendar");
    fireEvent.click(screen.getByRole("button", { name: "Sync calendars" }));

    expect(await screen.findByText("Provider sync failed.")).toBeInTheDocument();
    expect(onDailyBriefChanged).not.toHaveBeenCalled();
  });

  it("signals once after draft creation is confirmed with the created draft", async () => {
    const response = deferred<Response>();
    const onDailyBriefChanged = vi.fn();
    const dispatchEvent = vi.spyOn(window, "dispatchEvent");
    const harness = installFetchHarness(() => response.promise);
    renderCalendar({ onDailyBriefChanged });

    await submitNewDraft();
    await waitFor(() => expect(harness.actions).toHaveLength(1));
    expect(harness.actions[0]).toMatchObject({ action: "draft_create" });
    expect(onDailyBriefChanged).not.toHaveBeenCalled();

    response.resolve(jsonResponse({
      ok: true,
      message: "Calendar draft saved.",
      draft: calendarDraft(),
    }));

    expect(await screen.findByRole("heading", { name: "Planning session" })).toBeInTheDocument();
    await waitFor(() => expect(onDailyBriefChanged).toHaveBeenCalledTimes(1));
    expect(onDailyBriefChanged).toHaveBeenCalledWith("workspace:account:gmail:gmail-1");
    expect(harness.urls.some((url) => url.startsWith("/api/today"))).toBe(false);
    expect(dispatchEvent.mock.calls.some(([event]) => event.type === "ezra:refresh")).toBe(false);
  });

  it.each([
    ["an encoded failure with a draft", { ok: false, message: "Draft was rejected.", draft: calendarDraft() }],
    ["a success without a draft", { ok: true, message: "Draft response was incomplete." }],
  ] satisfies Array<[string, CalendarActionResult]>) (
    "does not signal draft creation for %s",
    async (_label, result) => {
      const onDailyBriefChanged = vi.fn();
      installFetchHarness(() => jsonResponse(result));
      renderCalendar({ onDailyBriefChanged });

      await submitNewDraft();

      await screen.findByText(result.message);
      expect(onDailyBriefChanged).not.toHaveBeenCalled();
    },
  );

  it("does not signal when draft creation returns an HTTP error", async () => {
    const onDailyBriefChanged = vi.fn();
    installFetchHarness(() => jsonResponse({ error: "Draft could not be saved." }, 500));
    renderCalendar({ onDailyBriefChanged });

    await submitNewDraft();

    expect(await screen.findByText("Draft could not be saved.")).toBeInTheDocument();
    expect(onDailyBriefChanged).not.toHaveBeenCalled();
  });

  it("signals once after event creation is confirmed with the created event", async () => {
    const response = deferred<Response>();
    const onDailyBriefChanged = vi.fn();
    const harness = installFetchHarness(
      () => response.promise,
      calendarPage({ drafts: [calendarDraft()] }),
    );
    renderCalendar({ onDailyBriefChanged });

    await openExistingDraft();
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));
    await waitFor(() => expect(harness.actions).toHaveLength(1));
    expect(harness.actions[0]).toMatchObject({ action: "create_event", draftId: "draft-1" });
    expect(onDailyBriefChanged).not.toHaveBeenCalled();

    response.resolve(jsonResponse({
      ok: true,
      message: "Calendar event created.",
      event: calendarEvent(),
    }));

    await waitFor(() => expect(onDailyBriefChanged).toHaveBeenCalledTimes(1));
    expect(onDailyBriefChanged).toHaveBeenCalledWith("workspace:account:gmail:gmail-1");
    expect(harness.calendarReads).toHaveLength(2);
    expect(harness.calendarReads[1]).toContain("sync=false");
    expect(screen.getByRole("dialog", { name: "Planning session" })).toBeInTheDocument();
  });

  it.each([
    ["an encoded failure with an event", { ok: false, message: "Creation was rejected.", event: calendarEvent() }],
    ["a success without an event", { ok: true, message: "Creation response was incomplete." }],
  ] satisfies Array<[string, CalendarActionResult]>) (
    "does not signal event creation for %s",
    async (_label, result) => {
      const onDailyBriefChanged = vi.fn();
      const harness = installFetchHarness(
        () => jsonResponse(result),
        calendarPage({ drafts: [calendarDraft()] }),
      );
      renderCalendar({ onDailyBriefChanged });

      await openExistingDraft();
      fireEvent.click(screen.getByRole("button", { name: "Create event" }));

      await screen.findByText(result.message);
      await waitFor(() => expect(harness.calendarReads).toHaveLength(2));
      expect(onDailyBriefChanged).not.toHaveBeenCalled();
    },
  );

  it("does not signal when event creation returns an HTTP error", async () => {
    const onDailyBriefChanged = vi.fn();
    installFetchHarness(
      () => jsonResponse({ error: "Event could not be created." }, 502),
      calendarPage({ drafts: [calendarDraft()] }),
    );
    renderCalendar({ onDailyBriefChanged });

    await openExistingDraft();
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));

    expect(await screen.findByText("Event could not be created.")).toBeInTheDocument();
    expect(onDailyBriefChanged).not.toHaveBeenCalled();
  });

  it("signals once after draft cancellation is confirmed", async () => {
    const response = deferred<Response>();
    const onDailyBriefChanged = vi.fn();
    const dispatchEvent = vi.spyOn(window, "dispatchEvent");
    const harness = installFetchHarness(
      () => response.promise,
      calendarPage({ drafts: [calendarDraft()] }),
    );
    renderCalendar({ onDailyBriefChanged });

    await openExistingDraft();
    fireEvent.click(screen.getByRole("button", { name: "Cancel draft" }));
    await waitFor(() => expect(harness.actions).toHaveLength(1));
    expect(harness.actions[0]).toMatchObject({ action: "draft_cancel", draftId: "draft-1" });
    expect(onDailyBriefChanged).not.toHaveBeenCalled();

    response.resolve(jsonResponse({ ok: true, message: "Calendar draft cancelled." }));

    await waitFor(() => expect(onDailyBriefChanged).toHaveBeenCalledTimes(1));
    expect(onDailyBriefChanged).toHaveBeenCalledWith("workspace:account:gmail:gmail-1");
    expect(harness.calendarReads).toHaveLength(2);
    expect(harness.calendarReads[1]).toContain("sync=false");
    expect(harness.urls.some((url) => url.startsWith("/api/today"))).toBe(false);
    expect(dispatchEvent.mock.calls.some(([event]) => event.type === "ezra:refresh")).toBe(false);
  });

  it("does not signal an encoded draft-cancellation failure", async () => {
    const onDailyBriefChanged = vi.fn();
    const harness = installFetchHarness(
      () => jsonResponse({ ok: false, message: "Draft cancellation failed." }),
      calendarPage({ drafts: [calendarDraft()] }),
    );
    renderCalendar({ onDailyBriefChanged });

    await openExistingDraft();
    fireEvent.click(screen.getByRole("button", { name: "Cancel draft" }));

    await waitFor(() => expect(harness.calendarReads).toHaveLength(2));
    expect(onDailyBriefChanged).not.toHaveBeenCalled();
  });
});

type FetchHandler = (
  body: Record<string, unknown>,
) => Response | Promise<Response>;

describe("Calendar exact Today drilldown", () => {
  afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });
  const target = { view: "calendar" as const, eventId: "event-1", date: "2026-09-01", requestKey: 1 };
  const props = { workspaceId: "workspace:account:gmail:gmail-1", workspace: workspace("workspace:account:gmail:gmail-1", "Gmail"), onOpenSettings: vi.fn() };

  it("overrides a saved unrelated month and selects only the exact returned local event", async () => {
    localStorage.setItem("ezra-calendar-mode", "month");
    localStorage.setItem("ezra-calendar-date", "2025-01-12");
    const harness = installFetchHarness(() => { throw new Error("No mutation is expected"); }, calendarPage({ events: [{ ...calendarEvent(), id: "lookalike", description: "Wrong event" }, calendarEvent()] }));
    render(<CalendarView {...props} target={target} />);
    expect(await screen.findByRole("dialog", { name: "Planning session" })).toHaveTextContent("Set the release plan.");
    expect(screen.getByRole("button", { name: "Day" })).toHaveAttribute("aria-pressed", "true");
    const query = new URL(harness.calendarReads[0], "https://ezra.test").searchParams;
    expect(query.get("from")).toBe(new Date(2026, 8, 1).toISOString());
    expect(query.get("to")).toBe(new Date(2026, 8, 2).toISOString());
    expect(query.get("workspaceId")).toBe(props.workspaceId);
    expect(query.get("sync")).toBe("false");
    expect(query.get("date")).toBe("2026-09-01");
    expect(harness.actions).toEqual([]);
  });

  it("repeats and supersedes targets while suppressing older range and workspace responses", async () => {
    const requests: Array<ReturnType<typeof deferred<Response>>> = [];
    vi.stubGlobal("fetch", vi.fn(() => { const request = deferred<Response>(); requests.push(request); return request.promise; }));
    const { rerender } = render(<CalendarView {...props} />);
    await waitFor(() => expect(requests).toHaveLength(1));
    rerender(<CalendarView {...props} target={target} />);
    await waitFor(() => expect(requests).toHaveLength(2));
    const next = { ...target, eventId: "new-event", date: "2026-09-02", requestKey: 2 };
    rerender(<CalendarView {...props} target={next} />);
    await waitFor(() => expect(requests).toHaveLength(3));
    await act(async () => requests[2].resolve(jsonResponse(calendarPage({ events: [{ ...calendarEvent(), id: "new-event", title: "New target" }] }))));
    expect(await screen.findByRole("dialog", { name: "New target" })).toBeInTheDocument();
    await act(async () => { requests[0].resolve(jsonResponse(calendarPage({ events: [calendarEvent()] }))); requests[1].resolve(jsonResponse(calendarPage({ events: [calendarEvent()] }))); });
    expect(screen.getByRole("dialog", { name: "New target" })).toBeInTheDocument();
    rerender(<CalendarView {...props} target={{ ...next, requestKey: 3 }} />);
    await waitFor(() => expect(requests).toHaveLength(4));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    rerender(<CalendarView {...props} workspaceId="workspace:account:microsoft:ms-1" target={null} />);
    await waitFor(() => expect(requests).toHaveLength(5));
    await act(async () => requests[4].resolve(jsonResponse(calendarPage())));
    await act(async () => requests[3].resolve(jsonResponse(calendarPage({ events: [{ ...calendarEvent(), id: "new-event", title: "Stale target" }] }))));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Stale target")).not.toBeInTheDocument();
  });

  it("retries the same target and keeps its day with truthful guidance if the exact ID is absent", async () => {
    const reads: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      reads.push(String(input));
      return Promise.resolve(reads.length === 1 ? jsonResponse({ error: "Calendar temporarily unavailable." }, 503) : jsonResponse(calendarPage({ events: [{ ...calendarEvent(), id: "same-title-different-local-id" }] })));
    }));
    render(<CalendarView {...props} target={target} />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("This event is no longer available in this workspace. The requested day is still shown.")).toBeInTheDocument();
    expect(reads[1]).toBe(reads[0]);
    expect(screen.getByRole("button", { name: "Day" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

function installFetchHarness(handleAction: FetchHandler, page = calendarPage()) {
  const urls: string[] = [];
  const calendarReads: string[] = [];
  const actions: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith("/api/calendar?")) {
      calendarReads.push(url);
      return jsonResponse(page);
    }
    if (url === "/api/calendar/actions" && init?.method === "POST") {
      const body = JSON.parse(String(init.body || "{}")) as Record<string, unknown>;
      actions.push(body);
      return handleAction(body);
    }
    return jsonResponse({ error: "not found" }, 404);
  }));
  return { actions, calendarReads, urls };
}

function renderCalendar(input: {
  workspaceId?: string;
  onDailyBriefChanged: (sourceWorkspaceId: string) => void | Promise<void>;
}) {
  const workspaceId = input.workspaceId || "workspace:account:gmail:gmail-1";
  return render(
    <CalendarView
      workspaceId={workspaceId}
      workspace={workspace(workspaceId, "Gmail")}
      onOpenSettings={vi.fn()}
      onDailyBriefChanged={input.onDailyBriefChanged}
    />,
  );
}

function workspace(id: string, label: string): MailWorkspace {
  return {
    id,
    label,
    purpose: "Test workspace",
    accountIds: [id.endsWith("ms-1") ? "ms-1" : "gmail-1"],
    isAllAccounts: false,
    calendarRole: "primary_future",
    provider: id.includes("microsoft") ? "microsoft" : "gmail",
  };
}

function calendarPage(input: { drafts?: CalendarDraft[]; events?: CalendarEvent[] } = {}): CalendarPage {
  return {
    events: input.events || [],
    drafts: input.drafts || [],
    accounts: [{
      accountId: "gmail-1",
      accountLabel: "Gmail",
      accountEmail: "owner@gmail.test",
      provider: "gmail",
      status: "connected",
      calendarStatus: "connected",
      calendarAccess: "write",
      lastSyncAt: "2026-08-31T14:00:00.000Z",
      lastError: null,
    }],
    range: {
      from: "2026-08-30T05:00:00.000Z",
      to: "2026-09-06T05:00:00.000Z",
      timezone: "America/Chicago",
    },
  };
}

function calendarEvent(): CalendarEvent {
  return {
    id: "event-1",
    accountId: "gmail-1",
    accountLabel: "Gmail",
    accountProvider: "gmail",
    externalEventId: "provider-event-1",
    calendarId: "primary",
    calendarName: "Primary",
    title: "Planning session",
    description: "Set the release plan.",
    location: null,
    startsAt: "2026-09-01T15:00:00.000Z",
    endsAt: "2026-09-01T16:00:00.000Z",
    isAllDay: false,
    dateRange: null,
    timezone: "America/Chicago",
    status: "confirmed",
    visibility: "default",
    isBusy: true,
    organizerName: null,
    organizerEmail: "owner@gmail.test",
    attendees: [],
    webLink: "https://calendar.google.test/event-1",
    updatedAt: "2026-08-31T15:01:00.000Z",
    syncedAt: "2026-08-31T15:01:00.000Z",
  };
}

function calendarDraft(): CalendarDraft {
  return {
    id: "draft-1",
    accountId: "gmail-1",
    accountLabel: "Gmail",
    accountProvider: "gmail",
    calendarId: "primary",
    title: "Planning session",
    description: "Set the release plan.",
    location: "",
    startsAt: "2026-09-01T15:00:00.000Z",
    endsAt: "2026-09-01T16:00:00.000Z",
    isAllDay: false,
    timezone: "America/Chicago",
    attendees: [],
    reminderMinutes: 30,
    isBusy: true,
    privacy: "default",
    sendUpdates: false,
    status: "draft",
    providerEventId: null,
    createdAt: "2026-08-31T15:00:00.000Z",
    updatedAt: "2026-08-31T15:00:00.000Z",
  };
}

async function submitNewDraft() {
  await screen.findByText("Gmail calendar");
  fireEvent.click(screen.getByRole("button", { name: "New event draft" }));
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Planning session" } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft for review" }));
}

async function openExistingDraft() {
  await screen.findByText("Drafts waiting for approval");
  fireEvent.click(screen.getByRole("button", { name: /Planning session/ }));
  await screen.findByRole("alertdialog", { name: "Planning session" });
}

function jsonResponse<T>(payload: T, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
