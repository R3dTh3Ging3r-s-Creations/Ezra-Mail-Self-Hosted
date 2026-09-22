// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { isCurrentNotificationOrigin } from "@/lib/email/notification-origin";
const origin = "https://ezra.example.test";
afterEach(() => vi.unstubAllEnvs());
it.each(["", "https://user:pass@ezra.example.test", "https://ezra.example.test/path"])("fails closed for missing or invalid current configuration %s", base => {
  vi.stubEnv("APP_BASE_URL", base); vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", origin);
  expect(isCurrentNotificationOrigin(origin)).toBe(false);
});
it("retains exact explicitly allowed origins and normalizes only configuration", () => {
  vi.stubEnv("APP_BASE_URL", "https://new.example.test"); vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", "https://EZRA.example.test:443/");
  expect(isCurrentNotificationOrigin(origin)).toBe(true);
  expect(isCurrentNotificationOrigin(origin + "/")).toBe(false);
  expect(isCurrentNotificationOrigin(origin + ":8443")).toBe(false);
  expect(isCurrentNotificationOrigin("https://old.example.test")).toBe(false);
});
it("invalid additional origin configuration disables all stored origins", () => {
  vi.stubEnv("APP_BASE_URL", origin); vi.stubEnv("EZRA_NOTIFICATION_ORIGINS", "https://bad.example.test/path");
  expect(isCurrentNotificationOrigin(origin)).toBe(false);
});
