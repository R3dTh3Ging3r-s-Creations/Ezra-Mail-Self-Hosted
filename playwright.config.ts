import { defineConfig, devices } from "@playwright/test";
import { e2eAuthSecret, e2eOwnerPasswordHashBase64 } from "./tests/e2e/owner-auth-fixture";

export default defineConfig({
  testDir: "./tests/e2e",
  webServer: {
    command: "node node_modules/next/dist/bin/next start",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    env: {
      EZRA_AUTH_ALLOW_UNCONFIGURED: "true",
      EZRA_AUTH_PASSWORD_HASH_B64: e2eOwnerPasswordHashBase64(),
      EZRA_AUTH_SECRET: e2eAuthSecret(),
      EZRA_AUTH_SECURE_COOKIE: "false",
      EZRA_EMAIL_DATABASE_URL: "file:./data/e2e-owner-trust.sqlite",
    },
  },
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 5"], viewport: { width: 390, height: 844 } } },
    { name: "notifications-firefox", testMatch: "notifications.spec.ts", use: { ...devices["Desktop Firefox"] } }
  ],
});
