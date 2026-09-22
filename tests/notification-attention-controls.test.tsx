import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotificationAttentionControls } from "@/components/ezra/NotificationAttentionControls";
import type { NotificationPolicySettings } from "@/lib/email/types";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/components/ezra/api", () => mocks);
const initial: NotificationPolicySettings = { timezone: "America/Chicago", digestTimes: ["08:30", "16:30"], quietStart: "22:00", quietEnd: "07:30", categoryPolicies: [], dailyInterruptBudget: 3, burstWindowSeconds: 60, senderCooldownMinutes: 360, snoozedUntil: null, calmCheckinEnabled: false, calmCheckinTime: "12:30" };
let policy: NotificationPolicySettings, feedback: string | null;
beforeEach(() => {
  policy = { ...initial }; feedback = null; mocks.api.mockReset();
  mocks.api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("history")) return { events: [{ eventId: "event", kind: "brief", createdAt: "2026-09-14T15:00:00Z", outcome: "accepted", feedback }] };
    if (url.endsWith("feedback")) { feedback = JSON.parse(String(init?.body)).kind; return { recorded: true }; }
    if (url.endsWith("policy")) { const patch = JSON.parse(String(init?.body)); if (patch.dailyInterruptBudget === 21) throw new Error("Invalid budget"); policy = { ...policy, ...patch, ...(patch.snooze ? { snoozedUntil: patch.snooze === "clear" ? null : "2026-09-15T12:30:00Z" } : {}) }; return policy; }
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("shows reviewed defaults and saves attention controls persistently", async () => {
  const saved = vi.fn(); const view = render(<NotificationAttentionControls policy={policy} onSaved={saved} />);
  expect(screen.getByRole("checkbox", { name: "Enable calm check-in" })).not.toBeChecked();
  expect(screen.getByLabelText("Ordinary interrupts per day")).toHaveValue(3);
  fireEvent.change(screen.getByLabelText("Ordinary interrupts per day"), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable calm check-in" }));
  fireEvent.click(screen.getByRole("button", { name: "Save attention controls" }));
  await waitFor(() => expect(saved).toHaveBeenCalled()); view.unmount();
  render(<NotificationAttentionControls policy={policy} onSaved={saved} />);
  expect(screen.getByLabelText("Ordinary interrupts per day")).toHaveValue(4);
  expect(screen.getByRole("checkbox", { name: "Enable calm check-in" })).toBeChecked();
});
it("sends a server-derived snooze action and clears it", async () => {
  render(<NotificationAttentionControls policy={policy} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Snooze until tomorrow" }));
  await screen.findByText(/Snoozed until/);
  expect(mocks.api).toHaveBeenCalledWith("/api/notifications/policy", expect.objectContaining({ method: "PATCH", body: '{"snooze":"tomorrow"}' }));
  fireEvent.click(screen.getByRole("button", { name: "Clear snooze" }));
  await screen.findByText("No notification snooze is active.");
});
it("labels current-device outcomes honestly and allows changing feedback after reload", async () => {
  const view = render(<NotificationAttentionControls policy={policy} onSaved={vi.fn()} />);
  expect(await screen.findByText(/Accepted by transport/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Too noisy" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Too noisy" })).toHaveAttribute("aria-pressed", "true"));
  view.unmount(); render(<NotificationAttentionControls policy={policy} onSaved={vi.fn()} />);
  expect(await screen.findByRole("button", { name: "Too noisy", pressed: true })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Useful" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Useful" })).toHaveAttribute("aria-pressed", "true"));
});
it("retains edits and reports validation failure without claiming saved", async () => {
  const saved = vi.fn(); render(<NotificationAttentionControls policy={policy} onSaved={saved} />);
  fireEvent.change(screen.getByLabelText("Ordinary interrupts per day"), { target: { value: "21" } });
  fireEvent.submit(screen.getByRole("form", { name: "Attention controls" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/Invalid budget|could not/i);
  expect(saved).not.toHaveBeenCalled();
});
it("shows the bounded calm hold even when its event is outside recent history", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-14T15:00:00.000Z"));
  mocks.api.mockResolvedValue({ events: [], calmCheckinHoldUntil: "2026-09-21T15:00:00.000Z" });
  render(<NotificationAttentionControls policy={policy} onSaved={vi.fn()} />);
  expect(await screen.findByText("Calm check-ins paused by feedback until 2026-09-21T15:00:00.000Z.")).toBeInTheDocument();
  expect(screen.getByText(/Too noisy pauses calm check-ins for seven days/)).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "Enable calm check-in" })).not.toBeChecked();
});

it("refreshes history and clears expired holds on app and enrollment changes", async () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  mocks.api.mockResolvedValue({ events: [], calmCheckinHoldUntil: future });
  render(<NotificationAttentionControls policy={policy} onSaved={vi.fn()} />);
  await screen.findByText(`Calm check-ins paused by feedback until ${future}.`);
  mocks.api.mockResolvedValue({ events: [], calmCheckinHoldUntil: new Date(Date.now() - 1).toISOString() });
  window.dispatchEvent(new Event("ezra:refresh"));
  await waitFor(() => expect(screen.queryByText(/Calm check-ins paused by feedback until/)).not.toBeInTheDocument());
  mocks.api.mockResolvedValue({ events: [], calmCheckinHoldUntil: future });
  window.dispatchEvent(new Event("ezra-mail-browser-notification-enrollment-changed"));
  await screen.findByText(`Calm check-ins paused by feedback until ${future}.`);
});
