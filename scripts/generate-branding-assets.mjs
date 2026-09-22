import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brandingDir = path.join(root, "docs", "branding");
const logoPath = path.join(brandingDir, "ezra-mail-logo-d4-app-512.png");
const socialPath = path.join(brandingDir, "ezra-mail-github-social.png");
const screenshotPath = path.join(brandingDir, "ezra-mail-today-demo.png");
const port = 3011;

await mkdir(brandingDir, { recursive: true });
await generateSocialCard();
await captureProductScreenshot();

console.log(`Generated ${path.relative(root, socialPath)}`);
console.log(`Generated ${path.relative(root, screenshotPath)}`);

async function generateSocialCard() {
  const background = Buffer.from(`
    <svg width="1280" height="640" viewBox="0 0 1280 640" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#091f2c"/>
          <stop offset="0.58" stop-color="#0e5964"/>
          <stop offset="1" stop-color="#168e92"/>
        </linearGradient>
        <radialGradient id="glow" cx="0.82" cy="0.18" r="0.72">
          <stop offset="0" stop-color="#78d6d0" stop-opacity="0.32"/>
          <stop offset="1" stop-color="#78d6d0" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="1280" height="640" rx="42" fill="url(#bg)"/>
      <rect width="1280" height="640" rx="42" fill="url(#glow)"/>
      <path d="M485 98H1165" stroke="#f8f1e7" stroke-opacity="0.24" stroke-width="2"/>
      <path d="M485 538H1060" stroke="#f8f1e7" stroke-opacity="0.18" stroke-width="2"/>
      <text x="505" y="238" fill="#f8f1e7" font-family="Segoe UI, Arial, sans-serif" font-size="92" font-weight="750">Ezra Mail</text>
      <text x="510" y="320" fill="#bfecea" font-family="Segoe UI, Arial, sans-serif" font-size="42" font-weight="600">Your mail, considered.</text>
      <text x="510" y="398" fill="#f8f1e7" fill-opacity="0.88" font-family="Segoe UI, Arial, sans-serif" font-size="25">Private mail intelligence for calm triage,</text>
      <text x="510" y="434" fill="#f8f1e7" fill-opacity="0.88" font-family="Segoe UI, Arial, sans-serif" font-size="25">safe actions, and exact-review sending.</text>
      <text x="510" y="506" fill="#9fdedb" font-family="Segoe UI, Arial, sans-serif" font-size="20" font-weight="650">LOCAL-FIRST  &#8226;  HUMAN-APPROVED  &#8226;  OLLAMA-POWERED</text>
    </svg>
  `);
  const logo = await sharp(logoPath).resize(332, 332).png().toBuffer();
  await sharp(background)
    .composite([{ input: logo, left: 100, top: 154 }])
    .png({ compressionLevel: 9 })
    .toFile(socialPath);
}

async function captureProductScreenshot() {
  const server = spawn(
    process.execPath,
    [path.join(root, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(port)],
    { cwd: root, env: { ...process.env, EZRA_AUTH_ALLOW_UNCONFIGURED: "true" }, stdio: "ignore" },
  );
  let browser;
  try {
    await waitForServer(`http://127.0.0.1:${port}/`);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await page.route("**/api/auth/session", (route) => route.fulfill({ json: { authenticated: true, configured: true, developmentBypass: true, expiresAt: null } }));
    await page.route("**/api/mail/meta", (route) => route.fulfill({ json: { accounts: demoAccounts(), workspaces: demoWorkspaces(), categories: ["Account security", "Interview request", "Financial update", "Newsletter"] } }));
    await page.route("**/api/accounts", (route) => route.fulfill({ json: demoFreshness() }));
    await page.route("**/api/today?**", (route) => route.fulfill({ json: demoToday() }));
    await page.goto(`http://127.0.0.1:${port}/?view=today`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Today", exact: true }).waitFor();
    await page.screenshot({ path: screenshotPath, fullPage: false });
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
  }
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The production server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The local Ezra Mail server did not become ready for the branding capture.");
}

function demoAccounts() {
  return [
    { id: "demo-gmail", provider: "gmail", label: "Gmail", email: "general@example.test", purpose: "General / Signup / Noise Catcher" },
    { id: "demo-hotmail", provider: "microsoft", label: "Hotmail", email: "professional@example.test", purpose: "Professional / Personal / Submissions" },
  ];
}

function demoWorkspaces() {
  return [
    { id: "workspace:gmail", label: "Gmail", purpose: "General / Signup / Noise Catcher", accountIds: ["demo-gmail"], isAllAccounts: false, calendarRole: "none", provider: "gmail" },
    { id: "workspace:microsoft", label: "Hotmail", purpose: "Professional / Personal / Submissions", accountIds: ["demo-hotmail"], isAllAccounts: false, calendarRole: "primary_future", provider: "microsoft" },
    { id: "workspace:all", label: "All accounts", purpose: "Explicit blend", accountIds: ["demo-gmail", "demo-hotmail"], isAllAccounts: true, calendarRole: "none", provider: "all" },
  ];
}

function demoFreshness() {
  const now = new Date().toISOString();
  return {
    generatedAt: now,
    pollIntervalMinutes: 5,
    manualSyncCooldownSeconds: 60,
    items: demoAccounts().map((account) => ({
      accountId: account.id,
      accountLabel: account.label,
      accountEmail: account.email,
      accountProvider: account.provider,
      purposeLabel: account.purpose,
      status: "connected",
      lastSuccessfulPollAt: now,
      lastProviderActionAt: now,
      lastError: null,
      nextExpectedCheckAt: new Date(Date.now() + 300_000).toISOString(),
      manualSyncAvailableAt: null,
      canSyncNow: true,
      reconnectRecommended: false,
      recoveryMessage: null,
      issues: [
        { feature: "mail", status: "ok", message: null, reconnectRecommended: false, lastSuccessAt: now },
        { feature: "calendar", status: "ok", message: null, reconnectRecommended: false, lastSuccessAt: now },
      ],
    })),
  };
}

function demoToday() {
  const now = new Date();
  const receivedAt = (minutes) => new Date(now.getTime() - minutes * 60_000).toISOString();
  return {
    id: "demo-today",
    date: now.toISOString().slice(0, 10),
    generatedAt: now.toISOString(),
    quietReviewed: 8,
    mailActivity: {
      receivedToday: 14,
      handledToday: 11,
      unhandledToday: 3,
      attentionCounts: { interrupt: 2, digest: 4, suppress: 8, unknown: 0 },
      stillNeedsAttention: 3,
      categoryCounts: [
        { category: "Account security", count: 3 },
        { category: "Interview request", count: 2 },
        { category: "Financial update", count: 2 },
        { category: "Newsletter", count: 1 },
      ],
      lastPollAt: now.toISOString(),
      lastPollError: null,
    },
    topics: [
      topic("demo-security", "action", "New sign-in needs review", "A security notice reports a new sign-in from an unfamiliar device.", "Account Security", "Gmail", receivedAt(12), 98),
      topic("demo-interview", "action", "Interview availability requested", "A recruiter asked for two possible meeting times this week.", "Northwind Recruiting", "Hotmail", receivedAt(35), 94),
      topic("demo-deadline", "deadline", "Insurance document due Friday", "A requested document has a clear Friday deadline.", "Contoso Benefits", "Hotmail", receivedAt(75), 82, new Date(now.getTime() + 2 * 86_400_000).toISOString()),
      topic("demo-finance", "fyi", "Monthly account summary is ready", "The monthly statement is available and no action is required.", "Citywide Bank", "Gmail", receivedAt(95), 57),
    ],
    cleanup: [
      { id: "cleanup-demo", senderName: "Weekly Roundup", senderEmail: "newsletter@example.test", messageCount: 3, latestMessageId: "cleanup-message", latestSubject: "This week's product roundup", recommendation: "mark_read", reason: "This recurring sender is consistently low priority.", confidence: 0.93, learned: true, accountLabel: "Gmail" },
      { id: "cleanup-demo-2", senderName: "Event Updates", senderEmail: "events@example.test", messageCount: 1, latestMessageId: "cleanup-message-2", latestSubject: "Community events this weekend", recommendation: "acknowledge", reason: "This looks useful, but it does not require a response.", confidence: 0.84, learned: false, accountLabel: "Gmail" },
    ],
    oneMoreGlance: [],
    history: { generatedAt: now.toISOString(), sections: [] },
    counts: { action: 2, reply: 0, deadline: 1, fyi: 1 },
  };
}

function topic(id, kind, title, summary, senderName, accountLabel, receivedAt, urgency, deadline = null) {
  return { id, kind, title, summary, senderName, accountLabel, receivedAt, deadline, urgency, threadCount: 1 };
}
