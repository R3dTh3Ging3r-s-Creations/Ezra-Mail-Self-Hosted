import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TelegramNotificationSettings } from "@/components/ezra/TelegramNotificationSettings";
const device = { id: "telegram-device", channel: "telegram", generation: 2, detailedCopy: false, permission: "granted", lastSuccessAt: "2026-09-14T12:00:00Z", lastFailureAt: null };
function fixture(configured = true, enrolled = false) {
  let active = enrolled, details = false;
  const calls: Array<{
    url: string;
    init?: RequestInit;
  }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "/api/telegram")
      return Response.json({ test: { ok: true } });
    if (init?.method === "POST")
      active = true;
    if (init?.method === "DELETE")
      active = false;
    if (init?.method === "PATCH")
      details = JSON.parse(String(init.body)).detailedCopy;
    return Response.json({ telegramConfiguration: { configured, enrolled: active, deviceId: active ? device.id : null, disclosure: "Telegram bots are not end-to-end encrypted. Generic notification copy is recommended." }, devices: active ? [{ ...device, detailedCopy: details }] : [] });
  });
  return calls;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("loads without enabling or testing and shows disclosure before explicit enrollment", async () => {
  const calls = fixture();
  render(<TelegramNotificationSettings />);
  const enable = await screen.findByRole("button", { name: "Enable Telegram notifications" });
  expect(screen.getByText(/not end-to-end encrypted/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Send generic Telegram test" })).toBeDisabled();
  expect(calls.every(c => !c.init?.method)).toBe(true);
  fireEvent.click(enable);
  await screen.findByRole("button", { name: "Disable Telegram notifications" });
  expect(calls.filter(c => c.init?.method === "POST")).toHaveLength(1);
  expect(calls.some(c => c.url === "/api/telegram")).toBe(false);
});
it("requires configured enrollment for test and updates only explicit privacy/removal", async () => {
  const calls = fixture(true, true);
  render(<TelegramNotificationSettings />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /Show sender and subject/ }));
  await waitFor(() => expect(calls.some(c => c.init?.method === "PATCH")).toBe(true));
  await waitFor(() => expect(screen.getByRole("button", { name: "Send generic Telegram test" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Send generic Telegram test" }));
  expect(await screen.findByRole("status")).toHaveTextContent(/accepted.*does not confirm/i);
  fireEvent.click(screen.getByRole("button", { name: "Disable Telegram notifications" }));
  await screen.findByRole("button", { name: "Enable Telegram notifications" });
  expect(calls.find(c => c.init?.method === "DELETE")?.init?.body).toBe('{"expectedGeneration":2}');
});
it("unconfigured setup cannot enable or test", async () => {
  fixture(false);
  render(<TelegramNotificationSettings />);
  expect(await screen.findByRole("button", { name: "Enable Telegram notifications" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Send generic Telegram test" })).toBeDisabled();
});
it("explains trusted-device requirement without leaking server errors", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ code: "trusted_device_required", message: "SENSITIVE" }, { status: 403 }));
  render(<TelegramNotificationSettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent(/trusted device/i);
  expect(screen.queryByText(/SENSITIVE/)).toBeNull();
});
