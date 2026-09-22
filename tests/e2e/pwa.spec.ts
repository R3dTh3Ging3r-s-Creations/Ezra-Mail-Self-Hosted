import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // The real worker/navigation stays unmocked. No account/provider route is reached.
  await page.route("**/api/auth/session", (route) => route.fulfill({
    json: { authenticated: false, configured: true, developmentBypass: false, expiresAt: null },
  }));
});

test("PWA metadata uses same-origin Today launch and actual D4 install assets", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  const response = await request.get("/manifest.webmanifest");
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest).toMatchObject({ id: "/", start_url: "/?view=today", scope: "/", display: "standalone" });
  for (const [size, icon] of [[192, manifest.icons[0]], [512, manifest.icons[1]]] as const) {
    const iconResponse = await request.get(icon.src);
    expect(iconResponse.ok()).toBe(true);
    const bytes = await iconResponse.body();
    expect(bytes.readUInt32BE(16)).toBe(size);
    expect(bytes.readUInt32BE(20)).toBe(size);
  }
  const worker = await request.get("/ezra-sw.js");
  expect(worker.headers()["cache-control"]).toContain("no-store");
  expect(worker.headers()["content-type"]).toContain("javascript");
  await page.evaluate(() => navigator.serviceWorker.ready);
  const registrations = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((entry) => ({
    scope: entry.scope, script: entry.active?.scriptURL,
  })));
  expect(registrations).toEqual([{ scope: new URL("/", page.url()).href, script: new URL("/ezra-sw.js", page.url()).href }]);
});

for (const target of [
  "/?view=mail&message=pwa-local-7&account=pwa-account-7",
  "/?view=mail&drill=1&todaySection=reply&messageId=pwa-local-7",
]) {
  test(`PWA offline retry retains exact target ${target}`, async ({ page, context }, testInfo) => {
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.goto(target);
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toContain("/ezra-sw.js");
    const exactUrl = page.url();
    await context.setOffline(true);
    const response = await page.reload();
    expect(response?.status()).toBe(503);
    await expect(page.getByRole("heading", { name: "Ezra Mail is offline" })).toBeVisible();
    expect(page.url()).toBe(exactUrl);
    await expect(page.getByRole("link", { name: "Try again" })).toHaveJSProperty("href", exactUrl);
    expect(await page.evaluate(() => caches.keys())).toEqual([]);
    expect(await page.locator("body").innerText()).not.toContain("pwa-local-7");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("pwa-offline.png"), fullPage: true });
    await context.setOffline(false);
    await page.getByRole("link", { name: "Try again" }).click();
    await expect(page).toHaveTitle("Ezra Mail");
    expect(page.url()).toBe(exactUrl);
    expect(await page.evaluate(() => caches.keys())).toEqual([]);
  });
}
