import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { RuleItem, SavedView, SavedViewDefinition, TodayBrief } from "@/lib/email/types";
import { EZRA_MAIL_PRODUCT_VERSION } from "@/components/ezra/version";
import { E2E_OWNER_PASSWORD } from "./owner-auth-fixture";

test("professional workspace loads without overflow or accessibility violations", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Ezra Mail");
  await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByLabel(`Ezra Mail version ${EZRA_MAIL_PRODUCT_VERSION}`)).toContainText(`v${EZRA_MAIL_PRODUCT_VERSION}`);
  await expect(page.getByRole("button", { name: "Mail", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Calendar", exact: true }).first()).toBeVisible();
  if ((page.viewportSize()?.width || 1000) <= 500) await expect(page.getByRole("button", { name: "More", exact: true })).toBeVisible();
  else await expect(page.getByRole("button", { name: "Drafts", exact: true }).first()).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("ezra-mail.png"), fullPage: true });
});

test("first-owner wizard remains accessible without manual setup instructions", async ({ page }) => {
  await page.goto("/setup/first-owner?challenge=e2e-first-owner-challenge");
  await expect(page.getByRole("heading", { name: "Secure Ezra Mail" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Owner password", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Confirm owner password", exact: true })).toBeVisible();
  await expect(page.getByLabel("Name this device")).toBeVisible();
  await expect(page.getByText(/environment file|password hash/i)).toHaveCount(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("Calendar navigation opens the workspace calendar", async ({ page }) => {
  // Navigation must not depend on another browser test toggling owner protection.
  await mockEzraMailApi(page, []);
  await mockCalendarModesApi(page, []);
  await page.goto("/");
  await page.getByRole("button", { name: "Calendar", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /calendar$/i }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /New event draft/i })).toBeVisible();
});

test("Calendar switches Day Week and Month ranges with persistent safe navigation", async ({ page }) => {
  const requests: URLSearchParams[] = [];
  await mockEzraMailApi(page, []);
  await mockCalendarModesApi(page, requests);

  await page.goto("/?view=calendar");
  const modeGroup = page.getByRole("group", { name: "Calendar view mode" });
  await expect(modeGroup.getByRole("button", { name: "Week", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("complementary", { name: "Calendar week" })).toBeVisible();

  await modeGroup.getByRole("button", { name: "Day", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Calendar day" })).toBeVisible();
  await expect(modeGroup.getByRole("button", { name: "Day", exact: true })).toHaveAttribute("aria-pressed", "true");
  const dayRequest = requests.at(-1)!;
  const daySpan = new Date(dayRequest.get("to")!).getTime() - new Date(dayRequest.get("from")!).getTime();
  expect(daySpan).toBeGreaterThanOrEqual(23 * 60 * 60_000);
  expect(daySpan).toBeLessThanOrEqual(25 * 60 * 60_000);

  const beforeNext = dayRequest.get("from");
  await page.getByRole("button", { name: "Next day" }).click();
  await expect.poll(() => requests.at(-1)?.get("from")).not.toBe(beforeNext);

  await modeGroup.getByRole("button", { name: "Month", exact: true }).click();
  const monthGrid = page.getByRole("complementary", { name: "Calendar month" });
  await expect(monthGrid).toBeVisible();
  await expect(monthGrid.getByText("+3 more")).toBeVisible();
  await monthGrid.getByRole("button", { name: /Calendar event 1/ }).click();
  await expect(page.getByRole("dialog", { name: "Calendar event 1" })).toBeVisible();
  await page.getByRole("button", { name: "Close event" }).click();
  await monthGrid.getByRole("button", { name: /in Day view/ }).first().click();
  await expect(modeGroup.getByRole("button", { name: "Day", exact: true })).toHaveAttribute("aria-pressed", "true");
  await modeGroup.getByRole("button", { name: "Month", exact: true }).click();

  await page.reload();
  await expect(modeGroup.getByRole("button", { name: "Month", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("complementary", { name: "Calendar month" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: /All accounts Explicit blend/ }).click();
  await expect.poll(() => requests.at(-1)?.get("workspaceId")).toBe("workspace:all");
  await expect(page.getByRole("heading", { name: "All calendars" })).toBeVisible();
});

test("Today calendar target survives reload and history", async ({ page }, testInfo) => {
  const mutations: string[] = [];
  const reads: URLSearchParams[] = [];
  let includeExact = true;
  let failNext = false;
  page.on("request", (request) => { if (request.method() === "POST") mutations.push(new URL(request.url()).pathname); });
  await page.addInitScript(() => {
    localStorage.setItem("ezra-calendar-mode", "month");
    localStorage.setItem("ezra-calendar-date", "2025-01-12");
  });
  const brief: TodayBrief = { ...todayBrief(), agenda: [{
    id: "agenda-calendar", workspaceId: "workspace:gmail", sourceType: "calendar_event", sourceKey: "calendar:acct-gmail:external-calendar-1", sourceAccountId: "acct-gmail", provider: "gmail", providerThreadId: null,
    revisionAt: "2026-07-03T12:00:00.000Z", occurredAt: "2026-07-03T16:00:00.000Z", role: "agenda", title: "Exact planning review", summary: "Review the plan.", target: { view: "calendar", eventId: "calendar-event-1", date: "2026-07-03" },
    state: "open", firstSeenAt: "2026-07-03T14:00:00.000Z", lastSeenAt: "2026-07-03T14:00:00.000Z", completedAt: null, dismissedAt: null, restoredAt: null,
  }] };
  await mockEzraMailApi(page, [], [], { today: brief });
  await page.route("**/api/calendar?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    reads.push(params);
    if (failNext) { failNext = false; await route.fulfill({ status: 503, json: { error: "Calendar temporarily unavailable." } }); return; }
    const exact = { ...calendarE2eEvent(1, new Date("2026-07-03T16:00:00.000Z")), title: "Exact planning review", description: "Exact local event details." };
    await route.fulfill({ json: { events: [{ ...exact, id: "lookalike", description: "Different local event." }, ...(includeExact ? [exact] : [])], drafts: [], accounts: [{ accountId: "acct-gmail", accountLabel: "Gmail", accountEmail: "owner@gmail.test", provider: "gmail", status: "connected", calendarStatus: "connected", calendarAccess: "read", lastSyncAt: "2026-07-03T14:00:00.000Z", lastError: null }], range: { from: params.get("from"), to: params.get("to"), timezone: "America/Chicago" } } });
  });
  await page.goto("/?view=today");
  await page.getByRole("button", { name: "Open Exact planning review" }).click();
  await expect(page).toHaveURL(/view=calendar.*event=calendar-event-1.*date=2026-07-03/);
  const targetUrl = page.url();
  const drawer = page.getByRole("dialog", { name: "Exact planning review" });
  await expect(drawer).toContainText("Exact local event details.");
  await expect(page.getByRole("button", { name: "Day", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Friday, July 3, 2026", { exact: true })).toBeVisible();
  await page.reload();
  await expect(drawer).toContainText("Exact local event details.");
  await page.getByRole("button", { name: "Close event" }).click();
  await page.getByRole("navigation", { name: testInfo.project.name === "mobile" ? "Primary mobile navigation" : "Primary", exact: true }).getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.locator("h1")).toHaveText("Today");
  expect(new URL(page.url()).searchParams.has("event")).toBe(false);
  await page.goBack();
  await expect(drawer).toContainText("Exact local event details.");
  await page.getByRole("button", { name: "Close event" }).click();
  await page.getByRole("button", { name: /All accounts Explicit blend/ }).click();
  await expect.poll(() => reads.at(-1)?.get("workspaceId")).toBe("workspace:all");
  expect(new URL(page.url()).searchParams.has("event")).toBe(false);
  expect(new URL(page.url()).searchParams.has("date")).toBe(false);
  await expect(drawer).toHaveCount(0);
  includeExact = false;
  failNext = true;
  await page.goto(targetUrl);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("This event is no longer available in this workspace. The requested day is still shown.")).toBeVisible();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByText("Friday, July 3, 2026", { exact: true })).toBeVisible();
  expect(reads.at(-1)?.get("from")).toBe(reads.at(-2)?.get("from"));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(mutations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("target.png"), fullPage: true });
});

test("Calendar modes keep clear empty-state copy", async ({ page }) => {
  await mockEzraMailApi(page, []);
  await mockCalendarModesApi(page, [], true);
  await page.goto("/?view=calendar");
  await expect(page.getByRole("heading", { name: "No events in this range" })).toBeVisible();
  const modeGroup = page.getByRole("group", { name: "Calendar view mode" });
  await modeGroup.getByRole("button", { name: "Day", exact: true }).click();
  await expect(page.getByText("No scheduled events.")).toBeVisible();
});

test("Outbox navigation opens the send safety queue", async ({ page }) => {
  await page.goto("/");
  if ((page.viewportSize()?.width || 1000) <= 500) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Outbox" }).click();
  } else await page.getByRole("button", { name: "Outbox", exact: true }).first().click();
  await expect(page.locator("h1", { hasText: "Outbox" })).toBeVisible();
  await expect(page.getByText("Send Safety Queue")).toBeVisible();
});

test("Drafts can create a local new-email draft and open Outbox", async ({ page }) => {
  const posts: Array<Record<string, unknown>> = [];
  await mockDraftCompositionApi(page, posts);

  await page.goto("/?view=drafts");
  await expect(page.locator("h1", { hasText: "Drafts" })).toBeVisible();
  await page.getByRole("button", { name: "New email draft" }).click();
  await expect(page.getByRole("heading", { name: "Draft a new email" })).toBeVisible();

  await page.getByRole("textbox", { name: "To", exact: true }).fill("tay");
  await page.getByRole("option", { name: /Taylor Recruiter/ }).click();
  await page.getByRole("textbox", { name: "Cc", exact: true }).fill("copy@example.test");
  await page.getByRole("textbox", { name: "Subject", exact: true }).fill("Interview availability");
  await page.getByRole("textbox", { name: "Message body", exact: true }).fill("Hi Taylor,\n\nFriday morning works for me.");
  await page.getByRole("button", { name: /Save to Outbox/ }).click();

  await expect(page.getByText("New email draft saved to Outbox for exact review.")).toBeVisible();
  expect(posts[0]).toMatchObject({
    action: "new_email_create",
    accountId: "acct-gmail",
    to: [{ name: "Taylor Recruiter", email: "taylor@example.test" }],
    subject: "Interview availability",
  });

  await page.getByRole("button", { name: "Open Outbox" }).click();
  await expect(page.locator("h1", { hasText: "Outbox" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Interview availability" })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("safe note") });
  await expect(page.getByText("notes.txt", { exact: true })).toBeVisible();
  await expect(page.getByText(/Exact approval was reset/)).toBeVisible();
  await page.getByRole("button", { name: "Review exact draft" }).click();
  await expect(page.getByRole("heading", { name: "Approve this exact draft?" })).toBeVisible();
  await expect(page.getByRole("dialog").getByText(/notes.txt.*SHA-256/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve exact draft" })).toBeDisabled();
  await page.getByLabel(/I reviewed the exact sender/i).check();
  await page.getByRole("button", { name: "Approve exact draft" }).click();
  await expect(page.getByText("Outgoing draft approved and ready for Gmail send.")).toBeVisible();
  await expect(page.getByText("Exact draft approved", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Outgoing Gmail draft sent.")).toBeVisible();
});

test("Message detail can create a local forward draft and open Outbox", async ({ page }) => {
  const posts: Array<Record<string, unknown>> = [];
  await mockForwardCompositionApi(page, posts);

  await page.goto("/?view=mail&message=mail-forward");
  await expect(page.locator("h1", { hasText: "Mail" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Target Application Follow Up" })).toBeVisible();
  await page.getByRole("button", { name: "Forward" }).click();

  await expect(page.getByRole("heading", { name: "Target Application Follow Up" })).toHaveCount(2);
  await page.getByRole("textbox", { name: "To", exact: true }).fill("Mentor <mentor@example.test>");
  await page.getByRole("textbox", { name: "Cc", exact: true }).fill("copy@example.test");
  await expect(page.getByRole("textbox", { name: "Subject", exact: true })).toHaveValue("Fwd: Target Application Follow Up");
  await expect(page.getByRole("textbox", { name: "Forward body", exact: true })).toContainText("Please schedule your interview.");
  await page.getByRole("button", { name: /Save to Outbox/ }).click();

  await expect(page.getByText("Saved to Outbox")).toBeVisible();
  expect(posts[0]).toMatchObject({
    action: "forward_create",
    messageId: "mail-forward",
    to: [{ name: "Mentor", email: "mentor@example.test" }],
    cc: [{ email: "copy@example.test" }],
    subject: "Fwd: Target Application Follow Up",
  });

  await page.getByRole("button", { name: "Open Outbox" }).click();
  await expect(page.locator("h1", { hasText: "Outbox" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fwd: Target Application Follow Up" })).toBeVisible();
});

test("Gmail organization and attachment previews retain safe controls", async ({ page }) => {
  const posts: Array<Record<string, unknown>> = [];
  await mockForwardCompositionApi(page, posts);

  await page.goto("/?view=mail&message=mail-forward");
  await expect(page.getByRole("heading", { name: "Target Application Follow Up" })).toBeVisible();
  const conversation = page.getByLabel(/Conversation: Target/);
  const rowActions = page.getByLabel("Quick actions for Target Application Follow Up");
  const mobileReader = (page.viewportSize()?.width ?? 1440) <= 759;
  const organizationActions = mobileReader ? conversation : rowActions;
  if (mobileReader) await expect(rowActions).toBeHidden();
  else await expect(rowActions).toBeVisible();
  await expect(organizationActions.getByRole("button", { name: "Pin", exact: true })).toBeVisible();
  await organizationActions.getByRole("button", { name: "Pin", exact: true }).click();
  await expect.poll(() => posts.at(-1)?.action).toBe("pin");
  await expect(conversation.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();
  await organizationActions.getByRole("button", { name: "Flag", exact: true }).click();
  await expect.poll(() => posts.at(-1)?.action).toBe("flag");
  await expect(conversation.getByRole("button", { name: "Unflag", exact: true })).toBeVisible();

  await expect(page.getByRole("button", { name: /report\.pdf.*Download/i })).toBeVisible();
  const reportDetails = page.getByLabel("Attachment details for report.pdf");
  await expect(reportDetails).toContainText("Provider-reported type");
  await expect(reportDetails).toContainText("Ezra checks the file only after you choose Preview.");
  await expect(reportDetails).toContainText("Download remains available; preview never opens the file automatically.");
  await expect(page.getByRole("button", { name: "Preview report.pdf" })).toBeVisible();
  await expect(page.getByTitle("Attachment preview")).toHaveCount(0);
  await page.getByRole("button", { name: "Preview report.pdf" }).click();
  await expect(page.getByTitle("Attachment preview")).toHaveAttribute("sandbox", "");

  await page.getByRole("button", { name: "Preview picture.png" }).click();
  await expect(page.getByAltText("Preview of picture.png")).toBeVisible();

  const textPreview = page.getByRole("button", { name: "Preview notes.txt" });
  await textPreview.focus();
  await expect(textPreview).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Safe plain text preview.")).toBeVisible();

  await expect(page.getByRole("button", { name: /archive\.zip.*Download/i })).toBeVisible();
  await page.getByRole("button", { name: "Preview archive.zip" }).click();
  await expect(page.getByText(/Ezra can preview only PDFs, common images, and plain-text documents/i)).toBeVisible();
  await page.getByRole("button", { name: "Preview large.pdf" }).click();
  await expect(page.getByText(/too large to preview safely/i)).toBeVisible();
  await expect(conversation.getByRole("heading", { name: "Target Application Follow Up" })).toBeVisible();
});

test("Gmail Reply and Hotmail Reply all save safely to Outbox", async ({ page }) => {
  const posts: Array<Record<string, unknown>> = [];
  await mockDirectReplyApi(page, posts);

  await page.goto("/?view=mail&message=mail-reply-gmail");
  await expect(page.getByRole("heading", { name: "Gmail reply test" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clean reading" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-ezra-sanitized-content="true"] img')).not.toHaveAttribute("src", /./);
  await page.getByRole("button", { name: "Plain text" }).click();
  await expect(page.getByRole("region", { name: "Original message" })).toContainText("Earlier message");
  await page.getByRole("button", { name: "Original formatting" }).click();
  await expect(page.locator('[data-ezra-sanitized-content="true"] blockquote')).toBeVisible();
  await page.getByRole("button", { name: "Clean reading" }).click();
  await page.getByRole("button", { name: "Show 1 image once" }).click();
  await expect(page.locator('[data-ezra-sanitized-content="true"] img')).toHaveAttribute("src", "https://images.example.test/chart.png");
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  const gmailStudio = page.getByRole("region", { name: "Reply Studio" });
  await expect(gmailStudio.getByText("owner@gmail.test", { exact: true })).toBeVisible();
  await expect(gmailStudio.getByText("reply-to@example.test", { exact: true })).toBeVisible();
  await gmailStudio.getByRole("button", { name: "I'll write" }).click();
  await gmailStudio.getByRole("textbox", { name: "Reply draft" }).fill("Thanks. Friday morning works for me.");
  await gmailStudio.getByRole("combobox", { name: "Polish with Ezra" }).selectOption("warmer");
  await gmailStudio.getByRole("button", { name: "Compare polish" }).click();
  await expect(gmailStudio.getByText("Thanks so much. Friday morning works for me.", { exact: true })).toBeVisible();
  await gmailStudio.getByRole("button", { name: "Use polished version" }).click();
  await expect(gmailStudio.getByRole("textbox", { name: "Reply draft" })).toHaveValue("Thanks so much. Friday morning works for me.");
  await expect(gmailStudio.getByRole("button", { name: /^Send$/ })).toHaveCount(0);
  await gmailStudio.getByRole("button", { name: "Save to Outbox" }).click();
  await expect(page.locator("h1", { hasText: "Outbox" })).toBeVisible();
  await expect(page.getByText("Reply mode").locator("..")) .toContainText("Reply");

  await page.goto("/?view=mail&message=mail-reply-hotmail");
  await expect(page.getByRole("heading", { name: "Hotmail reply-all test" })).toBeVisible();
  await page.getByRole("button", { name: "Reply all", exact: true }).click();
  const hotmailStudio = page.getByRole("region", { name: "Reply Studio" });
  await expect(hotmailStudio.getByText("owner@hotmail.test", { exact: true })).toBeVisible();
  await expect(hotmailStudio.getByText("sender@example.test", { exact: true })).toBeVisible();
  await expect(hotmailStudio.getByText("colleague@example.test", { exact: true })).toBeVisible();
  await hotmailStudio.getByRole("button", { name: "I'll write" }).click();
  await hotmailStudio.getByRole("textbox", { name: "Reply draft" }).fill("Thanks everyone. I will follow up tomorrow.");
  await hotmailStudio.getByRole("button", { name: "Save to Outbox" }).click();
  await expect(page.locator("h1", { hasText: "Outbox" })).toBeVisible();
  await expect(page.getByText("Enable replies and keep Calendar", { exact: false })).toBeVisible();

  expect(posts).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: "create_reply_outgoing", messageId: "mail-reply-gmail", replyMode: "sender" }),
    expect.objectContaining({ action: "create_reply_outgoing", messageId: "mail-reply-hotmail", replyMode: "all" }),
  ]));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("Activity navigation opens the timeline", async ({ page }) => {
  await page.goto("/");
  if ((page.viewportSize()?.width || 1000) <= 500) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Activity" }).click();
  } else await page.getByRole("button", { name: "Activity", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ezra's receipts, in order" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Apply/i })).toBeVisible();
});

test("Settings opens the provider permissions dashboard", async ({ page }) => {
  await page.goto("/");
  if ((page.viewportSize()?.width || 1000) <= 500) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Settings" }).click();
  } else {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  }
  await page.getByRole("button", { name: "Permissions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Provider Permissions Dashboard" })).toBeVisible();
  await expect(page.getByText(/Mail read|No connected accounts in this workspace yet/i).first()).toBeVisible();
});

test("Setup checklist shows honest status and safe next-step links", async ({ page }) => {
  // Other browser projects can enable owner protection on the shared server.
  // This UI fixture must work even when every unmocked API requires authentication.
  await page.route("**/api/**", (route) => route.fulfill({
    status: 401, json: { error: "Authentication is required." },
  }));
  await mockEzraMailApi(page, []);
  await mockSetupChecklistApi(page);
  await page.goto("/?view=settings");

  await expect(page.getByRole("heading", { name: "Setup checklist" })).toBeVisible();
  const progress = page.getByRole("region", { name: "Setup progress" });
  await expect(progress).toContainText("50%");
  await expect(page.getByText("Setup needed")).toBeVisible();
  await expect(page.getByText(/daily backup and monthly restore-rehearsal timers/i)).toBeVisible();

  await page.getByRole("button", { name: /Review accounts/ }).click();
  await expect(page.getByRole("heading", { name: "Mail accounts" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("browser notifications require explicit local enrollment and keep test copy private", async ({ page }) => {
  await page.addInitScript(() => {
    const state: {
      permission: NotificationPermission;
      requestCount: number;
      notifications: Array<{ title: string; body: string | null; tag: string | null }>;
    } = {
      permission: "default",
      requestCount: 0,
      notifications: [],
    };
    Object.defineProperty(window, "__ezraNotificationTest", { configurable: true, value: state });
    class FakeNotification {
      static get permission() {
        return state.permission;
      }

      static requestPermission() {
        state.requestCount += 1;
        state.permission = "granted";
        return Promise.resolve("granted" as NotificationPermission);
      }

      constructor(title: string, options?: NotificationOptions) {
        state.notifications.push({
          title,
          body: options?.body || null,
          tag: options?.tag || null,
        });
      }
    }
    Object.defineProperty(window, "Notification", { configurable: true, value: FakeNotification });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  });
  await mockEzraMailApi(page, []);
  await mockSetupChecklistApi(page, true);
  let enrolledBrowser = false;
  let cleanupOperation: { operationId: string; pendingEpoch: number; kind: string; startedAt: string; recoveryInstructions: string } | null = null;
  await page.route("**/api/notifications/setup", route => route.fulfill({ json: {
    origin: new URL(route.request().url()).origin, setupEpoch: 0, featureEnabled: true,
    currentDevice: enrolledBrowser ? { id: "browser-test", generation: 1 } : null, pending: cleanupOperation, completion: null,
  } }));
  await page.route("**/api/notifications/setup/begin", route => {
    const body = route.request().postDataJSON();
    cleanupOperation = { operationId: body.operationId, pendingEpoch: 1, kind: body.kind, startedAt: "2026-09-14T12:00:00Z", recoveryInstructions: "Synthetic cleanup fixture." };
    enrolledBrowser = false;
    return route.fulfill({ json: { origin: new URL(route.request().url()).origin, setupEpoch: 1, featureEnabled: true, currentDevice: null, pending: cleanupOperation, completion: null } });
  });
  await page.route("**/api/notifications/setup/complete", route => {
    cleanupOperation = null;
    return route.fulfill({ json: { origin: new URL(route.request().url()).origin, setupEpoch: 2, featureEnabled: true, currentDevice: null, pending: null, completion: null } });
  });
  await page.route("**/api/notifications/devices/browser-test/subscription", route => route.fulfill({ json: { generation: 1, deliveryEnabled: false, subscription: { subscribed: false, expiresAt: null, reenrollmentRequired: false, reason: "not_subscribed" } } }));
  const browserDevice = { id: "browser-test", generation: 1, platform: "windows", channel: "browser", permission: "granted", revokedAt: null, detailedCopy: false };
  await page.route("**/api/notifications/devices", (route) => {
    if (route.request().method() === "POST") { enrolledBrowser = true; return route.fulfill({ json: { device: browserDevice } }); }
    return route.fulfill({ json: { devices: enrolledBrowser ? [browserDevice] : [], currentDeviceId: enrolledBrowser ? browserDevice.id : null } });
  });
  await page.route("**/api/notifications/devices/browser-test", (route) => { enrolledBrowser = false; return route.fulfill({ json: { removed: true } }); });
  await page.route("**/api/notifications/foreground", (route) => route.fulfill({ json: { enabled: true, deviceId: "browser-test", generation: 1, events: [], hasMore: false } }));
  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "Delivery", exact: true }).click();

  const notificationState = () => page.evaluate(() => (
    window as unknown as {
      __ezraNotificationTest: {
        requestCount: number;
        notifications: Array<{ title: string; body: string | null; tag: string | null }>;
      };
    }
  ).__ezraNotificationTest);
  expect((await notificationState()).requestCount).toBe(0);

  await page.getByRole("button", { name: "Enable notifications" }).click();
  await expect(page.getByText("Enabled on this browser")).toBeVisible();
  expect((await notificationState()).requestCount).toBe(1);

  await page.getByRole("button", { name: "Send test notification" }).click();
  expect((await notificationState()).notifications).toEqual([{
    title: "Ezra Mail",
    body: "Notifications are working on this browser.",
    tag: "ezra-mail-notification-test",
  }]);

  await page.getByRole("button", { name: "Disable this browser" }).click();
  await expect(page.getByText("Disabled in Ezra")).toBeVisible();
  await expect(page.getByText(/Browser permission remains granted until you change it in browser settings/i)).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ezra-mail-browser-notifications-enabled"))).toBeNull();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("foreground notification opens the exact account message", async ({ page }) => {
  await page.addInitScript(() => {
    if (window.location.origin !== "null") {
      localStorage.setItem("ezra-mail-workspace", "workspace:all");
      localStorage.setItem("ezra-mail-browser-notifications-enabled", JSON.stringify({
        origin: window.location.origin,
        enabled: true,
        deviceId: "foreground-test",
        generation: 1,
      }));
    }
    Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => true });
    const instances: Array<{ onclick: ((event: Event) => void) | null }> = [];
    const minuteCallbacks: Array<() => void> = [];
    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    const syntheticIntervalIds = new Set<number>();
    const state = {
      requestCount: 0,
      payloads: [] as Array<{ title: string; options: Record<string, unknown>; optionKeys: string[] }>,
      get minuteIntervalCount() { return syntheticIntervalIds.size; },
      tickMinute() { minuteCallbacks.forEach((callback) => callback()); },
      clickLatest() {
        instances.at(-1)?.onclick?.(new Event("click"));
      },
    };
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout !== 60_000) return nativeSetInterval(handler, timeout, ...args);
      const id = 900_000 + minuteCallbacks.length;
      syntheticIntervalIds.add(id);
      minuteCallbacks.push(() => {
        if (!syntheticIntervalIds.has(id)) return;
        if (typeof handler === "function") handler(...args);
      });
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id?: number) => {
      if (id !== undefined && syntheticIntervalIds.delete(id)) return;
      nativeClearInterval(id);
    }) as typeof window.clearInterval;
    Object.defineProperty(window, "__ezraForegroundNotificationTest", { configurable: true, value: state });
    class FakeNotification {
      static permission: NotificationPermission = "granted";
      static requestPermission() {
        state.requestCount += 1;
        return Promise.resolve("granted" as NotificationPermission);
      }
      onclick: ((event: Event) => void) | null = null;
      constructor(title: string, options: NotificationOptions = {}) {
        state.payloads.push({
          title,
          options: { ...options },
          optionKeys: Object.keys(options).sort(),
        });
        instances.push(this);
      }
      close() {}
    }
    Object.defineProperty(window, "Notification", { configurable: true, value: FakeNotification });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  });

  const exactMessage = {
    ...mailItem("message-local-7", "casey@example.test", "Quarterly review moved to 3 PM"),
    accountId: "gmail-7",
    accountLabel: "Gmail Two",
    accountProvider: "gmail" as const,
    senderName: "Casey",
  };
  const mailRequests: URLSearchParams[] = [];
  const posts: string[] = [];
  const pageErrors: string[] = [];
  let foregroundRequests = 0;
  let detailRequests = 0;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(new URL(request.url()).pathname);
  });

  await mockEzraMailApi(page, [], mailRequests, { mailItems: [exactMessage] });
  await page.route("**/api/mail/meta", (route) => route.fulfill({ json: {
    accounts: [
      { id: "gmail-1", provider: "gmail", label: "Gmail One", email: "one@example.test" },
      { id: "gmail-7", provider: "gmail", label: "Gmail Two", email: "two@example.test" },
      { id: "outlook-1", provider: "microsoft", label: "Outlook", email: "outlook@example.test" },
    ],
    workspaces: [
      { id: "workspace:account:gmail:gmail-1", label: "Gmail One", purpose: "Primary", accountIds: ["gmail-1"], isAllAccounts: false, calendarRole: "none", provider: "gmail" },
      { id: "workspace:account:gmail:gmail-7", label: "Gmail Two", purpose: "Second Gmail", accountIds: ["gmail-7"], isAllAccounts: false, calendarRole: "none", provider: "gmail" },
      { id: "workspace:account:microsoft:outlook-1", label: "Outlook", purpose: "Professional", accountIds: ["outlook-1"], isAllAccounts: false, calendarRole: "primary_future", provider: "microsoft" },
      { id: "workspace:all", label: "All accounts", purpose: "Explicit blend", accountIds: ["gmail-1", "gmail-7", "outlook-1"], isAllAccounts: true, calendarRole: "none", provider: "all" },
    ],
    categories: [],
  } }));
  await page.route("**/api/accounts", (route) => route.fulfill({ json: {
    generatedAt: "2026-09-03T15:08:00.000Z", pollIntervalMinutes: 5, manualSyncCooldownSeconds: 60,
    items: [{ accountId: "gmail-7", accountProvider: "gmail", status: "connected" }],
  } }));
  const sharedEvent = { deliveryId: "delivery-7", eventId: "event-7", kind: "interrupt", target: "/?view=mail&workspace=workspace%3Aaccount%3Agmail%3Agmail-7&message=message-local-7", title: "Ezra Mail", body: "Mail needs attention.", tag: "ezra-mail-event-7", createdAt: "2026-09-03T15:07:00.000Z" };
  await page.route("**/api/notifications/foreground", async (route) => {
    foregroundRequests += 1;
    await route.fulfill({ json: { enabled: true, deviceId: "foreground-test", generation: 1, hasMore: false, events: [sharedEvent] } });
  });
  await page.route("**/api/notifications/claims", (route) => route.fulfill({ json: { ...sharedEvent, attemptId: "attempt-7", generation: 1 } }));
  await page.route("**/api/notifications/receipts", (route) => route.fulfill({ json: { recorded: true } }));
  await page.route("**/api/mail/message-local-7", async (route) => {
    detailRequests += 1;
    await route.fulfill({ json: {
      detail: {
        message: exactMessage,
        bodyText: "The quarterly review now starts at 3 PM.",
        bodyIsExcerpt: false,
        content: null,
        attachments: [],
        contactMemory: { summary: "Known contact.", messageCount: 1, firstSeenAt: exactMessage.receivedAt, lastSeenAt: exactMessage.receivedAt, categories: [] },
      },
      thread: [],
      capabilities: { unsubscribeSupported: false, protectedMessage: false },
    } });
  });
  await page.route("**/api/settings/writing?**", (route) => route.fulfill({ json: { remoteImagesAllowed: false } }));

  await page.goto("/?view=today");
  const notificationState = () => page.evaluate(() => (
    window as unknown as {
      __ezraForegroundNotificationTest: {
        requestCount: number;
        payloads: Array<{ title: string; options: Record<string, unknown>; optionKeys: string[] }>;
        minuteIntervalCount: number;
      };
    }
  ).__ezraForegroundNotificationTest);

  await expect.poll(async () => ({
    pageErrors,
    payloadCount: (await notificationState()).payloads.length,
  })).toEqual({ pageErrors: [], payloadCount: 1 });
  expect(await notificationState()).toMatchObject({
    requestCount: 0,
    minuteIntervalCount: 2,
    payloads: [{
      title: "Ezra Mail",
      options: { body: "Mail needs attention.", tag: "ezra-mail-event-7" },
      optionKeys: ["body", "tag"],
    }],
  });
  expect(await page.evaluate(() => document.hidden)).toBe(true);

  const beforeMinuteTick = foregroundRequests;
  await page.evaluate(() => (
    window as unknown as { __ezraForegroundNotificationTest: { tickMinute: () => void } }
  ).__ezraForegroundNotificationTest.tickMinute());
  await expect.poll(() => foregroundRequests).toBe(beforeMinuteTick + 1);

  await page.evaluate(() => (
    window as unknown as { __ezraForegroundNotificationTest: { clickLatest: () => void } }
  ).__ezraForegroundNotificationTest.clickLatest());

  await expect(page).toHaveURL(/\?view=mail&workspace=workspace%3Aaccount%3Agmail%3Agmail-7&message=message-local-7$/);
  await expect(page.getByRole("heading", { name: "Quarterly review moved to 3 PM" })).toBeVisible();
  await expect.poll(() => detailRequests).toBeGreaterThan(0);
  expect(mailRequests.some((params) => params.get("workspaceId") === "workspace:account:gmail:gmail-7")).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("ezra-mail-workspace"))).toBe("workspace:account:gmail:gmail-7");
  expect(posts).toEqual(["/api/notifications/claims", "/api/notifications/receipts", "/api/notifications/receipts"]);
  expect(foregroundRequests).toBe(beforeMinuteTick + 1);
});

test("guided account setup preflights safely before authorization", async ({ page }) => {
  const preflightBodies: Array<Record<string, unknown>> = [];
  const authorizationBodies: Array<Record<string, unknown>> = [];
  await mockEzraMailApi(page, []);
  await mockSetupChecklistApi(page);
  await page.route("**/api/accounts", (route) => route.fulfill({
    json: { generatedAt: "2026-07-10T12:00:00.000Z", pollIntervalMinutes: 5, manualSyncCooldownSeconds: 60, items: [] },
  }));
  await page.route("**/api/accounts/discover", (route) => route.fulfill({
    json: { discovery: { provider: "gmail", label: "Gmail", authorization: "browser", capabilities: { mailRead: true, send: true } } },
  }));
  await page.route("**/api/accounts/test", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    preflightBodies.push(body);
    await route.fulfill({ json: { test: { provider: "gmail", capability: "mail_read", ready: true, authorization: "browser", message: "Gmail is ready for authorization." } } });
  });
  await page.route("**/api/email", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    authorizationBodies.push(body);
    await route.fulfill({ json: { ok: true, result: { status: "started", email: "new@gmail.test", access: "maintenance", mode: "remote", authUrl: "https://accounts.google.test/authorize", message: "Approve Google access, then paste the final redirect URL." } } });
  });

  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await page.getByRole("textbox", { name: "Gmail email address" }).fill("new@gmail.test");
  await page.getByRole("button", { name: "Continue to authorization" }).click();

  await expect(page.getByText("Gmail is ready for authorization.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Google sign-in" })).toHaveAttribute("href", "https://accounts.google.test/authorize");
  expect(preflightBodies).toEqual([{ provider: "gmail", capability: "mail_read" }]);
  expect(JSON.stringify(preflightBodies)).not.toContain("new@gmail.test");
  expect(authorizationBodies).toEqual([{ action: "connect_gmail", email: "new@gmail.test", access: "maintenance" }]);

  await page.unroute("**/api/accounts/test");
  await page.route("**/api/accounts/test", (route) => route.fulfill({
    json: { test: { provider: "gmail", capability: "mail_read", ready: false, authorization: "browser", message: "Gmail needs the local mail bridge installed before authorization." } },
  }));
  await page.reload();
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await page.getByRole("textbox", { name: "Gmail email address" }).fill("unavailable@gmail.test");
  await page.getByRole("button", { name: "Continue to authorization" }).click();
  await expect(page.getByText("Gmail needs the local mail bridge installed before authorization.")).toBeVisible();
  expect(authorizationBodies).toHaveLength(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("guided account setup recovers staged choices for Gmail and Microsoft on desktop and mobile", async ({ page }) => {
  const preflights: Array<Record<string, unknown>> = [];
  await mockEzraMailApi(page, []);
  await mockSetupChecklistApi(page);
  await page.route("**/api/accounts", (route) => route.fulfill({
    json: { generatedAt: "2026-07-10T12:00:00.000Z", pollIntervalMinutes: 5, manualSyncCooldownSeconds: 60, items: [] },
  }));
  await page.route("**/api/accounts/discover", (route) => {
    const provider = String((route.request().postDataJSON() as Record<string, unknown>).provider);
    return route.fulfill({ json: { discovery: {
      provider,
      label: provider === "microsoft" ? "Microsoft" : "Gmail",
      authorization: provider === "microsoft" ? "device_code" : "browser",
      capabilities: { mailRead: true, send: true },
    } } });
  });
  await page.route("**/api/accounts/test", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    preflights.push(body);
    const provider = String(body.provider);
    return route.fulfill({ json: { test: {
      provider,
      capability: "mail_read",
      ready: true,
      authorization: provider === "microsoft" ? "device_code" : "browser",
      message: `${provider === "microsoft" ? "Microsoft" : "Gmail"} is ready for authorization.`,
    } } });
  });
  await page.route("**/api/email", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.action === "complete_microsoft_auth") {
      return route.fulfill({ json: { ok: false, error: "You signed in with a different Microsoft account. No account was changed. Start again." } });
    }
    if (body.action === "connect_microsoft") {
      return route.fulfill({ json: { ok: true, result: {
        connectionId: "e2e-microsoft-connection", userCode: "ABCD-EFGH",
        verificationUri: "https://microsoft.example.test/device", verificationUriComplete: null,
        expiresAt: "2026-08-12T22:30:00.000Z", message: "Open Microsoft sign-in and enter the code.", interval: 5,
      } } });
    }
    return route.fulfill({ json: { ok: true, result: {
      status: "started", email: "recover@gmail.test", access: "maintenance", mode: "remote",
      authUrl: "https://accounts.google.test/authorize", message: "Approve Google access, then paste the final browser URL.",
    } } });
  });

  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await page.getByRole("textbox", { name: "Gmail email address" }).fill("recover@gmail.test");
  await page.getByRole("textbox", { name: "Purpose for this account" }).fill("Career mail");
  await page.getByRole("combobox", { name: "Initial sync range" }).selectOption("14");
  await page.getByRole("button", { name: "Continue to authorization" }).click();
  await expect(page.getByText("Google authorization")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Google sign-in" })).toBeVisible();
  await page.getByRole("button", { name: "Back to setup" }).click();
  await expect(page.getByRole("textbox", { name: "Gmail email address" })).toHaveValue("recover@gmail.test");
  await expect(page.getByRole("textbox", { name: "Purpose for this account" })).toHaveValue("Career mail");
  await expect(page.getByRole("combobox", { name: "Initial sync range" })).toHaveValue("14");

  await page.reload();
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Gmail email address" })).toHaveValue("recover@gmail.test");
  await page.getByRole("button", { name: "Microsoft", exact: true }).click();
  await page.getByRole("textbox", { name: "Microsoft email address" }).fill("recover@outlook.test");
  await page.getByRole("textbox", { name: "Purpose for this account" }).fill("Consulting");
  await page.getByRole("combobox", { name: "Initial sync range" }).selectOption("7");
  await page.getByRole("button", { name: "Continue to authorization" }).click();
  await expect(page.getByText("Microsoft code")).toBeVisible();
  await expect(page.getByText("Connecting recover@outlook.test")).toBeVisible();
  await expect(page.getByText(/private or InPrivate window/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Microsoft email address" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Initial sync range" })).toBeDisabled();
  await page.getByRole("button", { name: "Check connection" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "different Microsoft account" })).toBeVisible();
  await page.getByRole("button", { name: "Back to setup" }).click();
  await expect(page.getByRole("textbox", { name: "Microsoft email address" })).toHaveValue("recover@outlook.test");
  await expect(page.getByRole("textbox", { name: "Purpose for this account" })).toHaveValue("Consulting");
  await expect(page.getByRole("combobox", { name: "Initial sync range" })).toHaveValue("7");
  expect(preflights).toEqual([
    { provider: "gmail", capability: "mail_read" },
    { provider: "microsoft", capability: "mail_read" },
  ]);
  expect(JSON.stringify(preflights)).not.toContain("recover@");
});

test("Settings edits account purpose and exposes rate-safe freshness", async ({ page }) => {
  const todayRequests: URLSearchParams[] = [];
  await mockEzraMailApi(page, [], [], { todayRequests });
  await mockSetupChecklistApi(page);
  const accountPosts: Array<Record<string, unknown>> = [];
  await mockAccountFreshnessApi(page, accountPosts);

  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Account purpose and freshness" })).toBeVisible();
  await expect(page.getByText("Last successful poll")).toBeVisible();
  await expect(page.getByText("Next background check")).toBeVisible();

  const purpose = page.getByRole("textbox", { name: "Purpose label" });
  await purpose.fill("Career and applications");
  await page.getByRole("button", { name: "Save purpose" }).click();
  await expect(page.getByText("Account purpose updated without changing account routing.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Gmail Career and applications/ })).toBeVisible();
  expect(accountPosts[0]).toMatchObject({ action: "update_purpose", accountId: "acct-gmail", purposeLabel: "Career and applications" });

  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByRole("button", { name: /Available in/ })).toBeDisabled();
  await expect.poll(() => todayRequests.length).toBe(2);
  expect(accountPosts[1]).toMatchObject({ action: "sync_now", accountId: "acct-gmail" });
  expect(todayRequests.map((params) => params.get("workspaceId"))).toEqual(["workspace:gmail", "workspace:gmail"]);
});

test("Owner trust setup is clear and usable without daily security friction", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
  await mockEzraMailApi(page, []);
  await mockSetupChecklistApi(page);
  await mockAccountFreshnessApi(page, []);
  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "System", exact: true }).click();
  await page.waitForTimeout(250);
  expect(pageErrors).toEqual([]);

  await expect(page.getByRole("heading", { name: "Trusted devices" })).toBeVisible();
  await expect(page.getByText("Bypass still active")).toBeVisible();
  await expect(page.getByLabel("Device name")).toBeVisible();
  await expect(page.getByLabel("Owner password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Trust this device" })).toBeVisible();
  await expect(page.getByText(/without repeated prompts/i)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("a real browser authenticator completes owner trust, step-up, and revocation", async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "The virtual authenticator acceptance runs once in desktop Chromium.");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });

  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "System", exact: true }).click();
  const deviceName = `E2E owner browser ${Date.now()}`;
  await page.getByLabel("Device name").fill(deviceName);
  await page.getByLabel("Owner password").fill(E2E_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Trust this device" }).click();
  await expect(page.getByText("This browser is now trusted until you revoke it or clear its site data.")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Forget this device" })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "System", exact: true }).click();
  await expect(page.getByRole("region", { name: "Owner trust and passkeys" }).getByText(deviceName, { exact: false })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept("E2E Windows Hello"));
  await page.getByRole("button", { name: "Add passkey" }).click();
  await expect(page.getByText("Owner passkey added. Ezra will use it only for rare security changes.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Owner trust and passkeys" }).getByText("E2E Windows Hello", { exact: false })).toBeVisible();

  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();
  const secondName = `E2E second browser ${Date.now()}`;
  await secondPage.goto("/?view=settings");
  await secondPage.getByRole("button", { name: "System", exact: true }).click();
  await secondPage.getByLabel("Device name").fill(secondName);
  await secondPage.getByLabel("Owner password").fill(E2E_OWNER_PASSWORD);
  await secondPage.getByRole("button", { name: "Trust this device" }).click();
  await expect(secondPage.getByText("This browser is now trusted until you revoke it or clear its site data.")).toBeVisible();
  await secondPage.reload();
  await expect(secondPage.getByRole("button", { name: "Forget this device" })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "System", exact: true }).click();
  const secondDevice = page.getByRole("article").filter({ hasText: secondName });
  page.once("dialog", (dialog) => dialog.accept());
  await secondDevice.getByRole("button", { name: "Revoke" }).click();
  await secondPage.reload();
  await expect(secondPage.getByRole("button", { name: "Sign out" })).toBeVisible();
  await secondContext.close();

  await page.evaluate(() => {
    Object.defineProperty(navigator.credentials, "get", {
      configurable: true,
      value: async () => null,
    });
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Finish migration" }).click();
  await expect(page.getByText("Passkey confirmation was cancelled.", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "System", exact: true }).click();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Finish migration" }).click();
  await expect(page.getByText("Trusted-device protection is active. Normal mail use will not prompt again.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Forget this device" })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "System", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Enable emergency bypass" }).click();
  await expect(page.getByText("Private-installation bypass enabled.")).toBeVisible();

  const currentDevice = page.getByRole("article").filter({ hasText: deviceName });
  page.once("dialog", (dialog) => dialog.accept());
  await currentDevice.getByRole("button", { name: "Revoke" }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("mobile owner enrollment remains trusted after a return visit", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile owner enrollment runs once in the Pixel 5 project.");
  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "System", exact: true }).click();
  const deviceName = `E2E Pixel 5 ${Date.now()}`;
  await page.getByLabel("Device name").fill(deviceName);
  await page.getByLabel("Owner password").fill(E2E_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Trust this device" }).click();
  await expect(page.getByText("This browser is now trusted until you revoke it or clear its site data.")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "System", exact: true }).click();
  await expect(page.getByRole("region", { name: "Owner trust and passkeys" }).getByText(deviceName, { exact: false })).toBeVisible();
});

test("learned sender rules change care behavior without changing identity", async ({ page }) => {
  await mockEzraMailApi(page, []);
  await mockSetupChecklistApi(page);
  const updates: Array<Record<string, unknown>> = [];
  let rules: RuleItem[] = [{
    id: "priority-rule-e2e",
    source: "priority",
    kind: "sender",
    accountId: "acct-gmail",
    accountLabel: "Gmail",
    accountEmail: "owner@gmail.test",
    accountProvider: "gmail",
    target: "newsletters@example.test",
    senderEmail: "newsletters@example.test",
    action: "digest",
    enabled: true,
    evidenceCount: 3,
    createdAt: "2026-07-01T12:00:00.000Z",
    updatedAt: "2026-07-12T12:00:00.000Z",
  }];
  await page.route("**/api/rules**", async (route) => {
    if (route.request().method() === "PATCH") {
      const update = route.request().postDataJSON() as Record<string, unknown>;
      updates.push(update);
      rules = rules.map((rule) => rule.id === update.id ? { ...rule, action: String(update.action), updatedAt: "2026-07-13T12:00:00.000Z" } : rule);
    }
    await route.fulfill({ json: rules });
  });

  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "Rules", exact: true }).click();
  const action = page.getByLabel("Action for newsletters@example.test");
  await expect(action).toHaveValue("digest");
  await action.selectOption("interrupt");
  await expect(page.getByText("newsletters@example.test now uses Care more.")).toBeVisible();
  expect(updates).toContainEqual(expect.objectContaining({ id: "priority-rule-e2e", action: "interrupt", workspaceId: "workspace:gmail" }));
  await expect(page.getByText("owner@gmail.test")).toBeVisible();
});

test("partial provider actions retain per-target receipts in Activity", async ({ page }) => {
  await mockEzraMailApi(page, []);
  await page.route("**/api/activity?**", (route) => route.fulfill({ json: {
    generatedAt: "2026-07-13T12:00:00.000Z",
    filters: { workspaceId: "workspace:gmail", q: "", kind: "all", accountId: "", provider: "all", from: null, to: null, limit: 120 },
    counts: { total: 1, shown: 1, errors: 0, warnings: 1, byKind: [{ kind: "mail_action", count: 1 }] },
    accounts: [{ id: "acct-gmail", label: "Gmail", email: "owner@gmail.test", provider: "gmail" }],
    items: [{ id: "activity-action-e2e", kind: "mail_action", severity: "warning", accountId: "acct-gmail", accountLabel: "Gmail", accountEmail: "owner@gmail.test", accountProvider: "gmail", messageId: null, actionId: "action-partial-e2e", title: "Trash partially completed", subtitle: "1 changed, 1 failed", detail: "One provider target needs repair.", occurredAt: "2026-07-13T12:00:00.000Z", status: "partial" }],
  } }));
  await page.route("**/api/activity/actions/action-partial-e2e", (route) => route.fulfill({ json: {
    actionId: "action-partial-e2e", action: "delete", status: "partial", occurredAt: "2026-07-13T12:00:00.000Z", reversible: true, undoStatus: "partial", changedCount: 1, unchangedCount: 0, failedCount: 1,
    outcomes: [
      { id: "sale-1", subject: "Sale one", senderName: "Sale", accountLabel: "Gmail", provider: "gmail", status: "changed", error: null, code: null, retryable: false },
      { id: "sale-2", subject: "Sale two", senderName: "Sale", accountLabel: "Gmail", provider: "gmail", status: "failed", error: "Reconnect Gmail before retrying this action.", code: "auth", retryable: true },
    ],
  } }));

  await page.goto("/?view=activity");
  await page.getByRole("button", { name: /Trash partially completed/ }).click();
  await expect(page.getByRole("heading", { name: "1 changed, 0 unchanged, 1 failed" })).toBeVisible();
  await expect(page.getByText(/Reconnect Gmail before retrying/)).toBeVisible();
});

test("320px layout has no unintended page overflow", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One explicit narrow-width pass is sufficient.");
  await page.setViewportSize({ width: 320, height: 700 });
  await mockEzraMailApi(page, []);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "More", exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("mobile navigation opens Mail as a dedicated workspace", async ({ page }) => {
  test.skip((page.viewportSize()?.width || 1000) > 500, "Mobile project only");
  await mockEzraMailApi(page, []);
  await page.goto("/");
  await page.getByRole("button", { name: "Mail", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Mail", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary mobile navigation" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary mobile navigation" }).getByRole("button")).toHaveCount(5);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
  await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("keyboard help, search, and go navigation stay discoverable and safe", async ({ page }) => {
  test.skip((page.viewportSize()?.width || 1000) <= 500, "Hardware keyboard closeout is a desktop regression.");
  await mockEzraMailApi(page, []);
  await page.goto("/?view=mail");
  await expect(page.locator("h1", { hasText: "Mail" })).toBeVisible();
  await page.keyboard.press("Shift+/");
  await expect(page.getByRole("dialog", { name: "Ezra Mail shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Ezra Mail shortcuts" })).toHaveCount(0);
  await page.keyboard.press("/");
  await expect(page.getByRole("textbox", { name: "Search mail" })).toBeFocused();
  await page.getByRole("textbox", { name: "Search mail" }).blur();
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
});

test("Today presents each item once with compact activity and expandable history", async ({ page }, testInfo) => {
  const brief: TodayBrief = { ...todayBrief(), date: "2026-09-21", timezone: "America/Chicago", generatedAt: "2026-09-21T14:00:00.000Z" };
  const item = (id: string, title: string): TodayBrief["needsAttention"][number] => ({
    id, workspaceId: brief.workspaceId, sourceType: "mail_thread", sourceKey: "mail:acct-gmail:" + id,
    sourceAccountId: "acct-gmail", provider: "gmail", providerThreadId: id, revisionAt: brief.generatedAt,
    occurredAt: brief.generatedAt, role: "attention", title, summary: "Review the details in the original conversation.",
    target: { view: "mail", messageId: id }, state: "open", firstSeenAt: brief.generatedAt,
    lastSeenAt: brief.generatedAt, completedAt: null, dismissedAt: null, restoredAt: null,
  });
  brief.needsAttention = [item("reply-1", "Confirm the meeting time"), item("fyi-1", "Your weekly reading list")];
  brief.carryovers = [{ ...item("older-1", "Review the updated proposal"), topicKind: "action", firstSeenAt: "2026-09-18T14:00:00Z" }];
  brief.agenda = [{ ...item("event-1", "Planning review at 2 PM"), sourceType: "calendar_event", role: "agenda", target: { view: "calendar", eventId: "event-1", date: brief.date } }];
  brief.completedSinceLastBrief = [{ ...item("done-1", "Travel details confirmed"), state: "completed", completedAt: brief.generatedAt }];
  brief.topics = brief.needsAttention.map((entry, index) => ({ id: entry.id, title: entry.title, summary: entry.summary,
    kind: index ? "fyi" : "reply", senderName: index ? "Reading Club" : "Casey Morgan", accountLabel: "Personal",
    receivedAt: brief.generatedAt, deadline: null, urgency: index ? 20 : 80, threadCount: 2 }));
  brief.sourceStatus = [{ source: "mail", status: "current", accountId: null, checkedAt: brief.generatedAt, detail: null }];
  brief.morningBrief = {
    day:brief.date,timezone:"America/Chicago",status:"available",scheduledLocalTime:"08:30",preparedAt:brief.generatedAt,checkedAt:brief.generatedAt,
    narrative:{version:1,mode:"deterministic",overview:{text:"Your afternoon includes a planning review. Confirm the meeting time when you have a moment.",sourceKeys:[brief.agenda[0].sourceKey]},priorities:[{text:"Review the meeting details before the afternoon commitment.",sourceKeys:[brief.needsAttention[0].sourceKey]}]},
    changes:[],changeNarrative:null,coverage:brief.sourceStatus,truncated:false,
    sources:[brief.agenda[0],brief.needsAttention[0]].map(item=>({sourceKey:item.sourceKey,target:item.target,currentState:"open",changed:false})),
  };
  await mockEzraMailApi(page, [], [], { today: brief });
  await page.goto("/?view=today");
  const attention = page.getByRole("region", { name: "Needs your attention" });
  const fyi = page.getByRole("region", { name: "Worth knowing" });
  await expect(attention.getByText("Confirm the meeting time", { exact: true })).toHaveCount(1);
  await expect(attention.getByText("Your weekly reading list", { exact: true })).toHaveCount(0);
  await expect(fyi.getByText("Your weekly reading list", { exact: true })).toHaveCount(1);
  const earlier = page.getByText("Earlier, still open (1)", {exact:true});
  await earlier.focus(); await page.keyboard.press("Enter");
  await expect(attention.getByText("Carried over", { exact: true })).toBeVisible();
  await expect(page.getByText("Sources up to date")).toBeVisible();
  const complete = await attention.getByRole("button", { name: "Mark handled Confirm the meeting time" }).boundingBox();
  const dismiss = await attention.getByRole("button", { name: "Dismiss Confirm the meeting time" }).boundingBox();
  expect(complete).not.toBeNull();
  expect(dismiss).not.toBeNull();
  expect(Math.abs(complete!.y - dismiss!.y)).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: "Bring back Travel details confirmed" })).toBeHidden();
  const headings = await page.getByRole("heading", { level: 2 }).allTextContents();
  expect(headings.indexOf("Today's agenda")).toBeLessThan(headings.indexOf("Daily brief"));
  expect(headings.indexOf("Daily brief")).toBeLessThan(headings.indexOf("Needs your attention"));
  const agendaBox = await page.getByRole("heading", {name:"Today's agenda"}).boundingBox();
  const briefBox = await page.getByRole("heading", {name:"Daily brief"}).boundingBox();
  expect(agendaBox!.y).toBeLessThan(briefBox!.y);
  expect(headings.indexOf("Today's agenda")).toBeLessThan(headings.indexOf("Worth knowing"));
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const frozenText = brief.morningBrief.narrative!.overview.text;
  brief.generatedAt="2026-09-21T16:00:00.000Z";
  brief.morningBrief={...brief.morningBrief,checkedAt:brief.generatedAt,changes:[{id:"moved-meeting",kind:"changed",sourceKey:brief.agenda[0].sourceKey,text:"Planning review moved to 3 PM."}],sources:brief.morningBrief.sources.map(source=>({...source,changed:source.sourceKey===brief.agenda[0].sourceKey}))};
  await page.getByRole("button",{name:"Refresh",exact:true}).click();
  await expect(page.getByText(frozenText,{exact:true})).toBeVisible();
  await expect(page.getByText("Planning review moved to 3 PM.",{exact:true})).toBeVisible();
  await expect(earlier.locator("..")).toHaveAttribute("open", "");
  await page.screenshot({ path: testInfo.outputPath("today-refinement.png"), fullPage: true });
  await page.getByText("Completed and history", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Bring back Travel details confirmed" })).toBeVisible();
  await page.getByText("Sources up to date").click();
  await expect(page.getByText("Current evidence is available.")).toBeVisible();
  if (testInfo.project.name === "mobile") {
    await page.setViewportSize({ width: 320, height: 740 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("today-refinement-320.png"), fullPage: true });
  }
});

test("Today statistics drill into exact handled-state Mail filters", async ({ page }) => {
  const mailRequests: URLSearchParams[] = [];
  await mockEzraMailApi(page, [], mailRequests);
  await page.goto("/");
  await page.getByRole("button", { name: /Received today/i }).click();
  await expect.poll(() => mailRequests.at(-1)?.get("handled")).toBe("any");
  expect(mailRequests.at(-1)?.get("date")).toBe("today");
  expect(mailRequests.at(-1)?.get("folder")).toBe("all");
  await expect(page.getByRole("button", { name: /Any handled state/ })).toBeVisible();

  await page.getByRole("button", { name: "Today", exact: true }).first().click();
  await page.getByRole("button", { name: /^Handled/i }).click();
  await expect.poll(() => mailRequests.at(-1)?.get("handled")).toBe("handled");
  await expect(page.getByRole("button", { name: /^Handled/ })).toBeVisible();
});

test("Today section drilldowns keep exact identities through races, reload, and Back", async ({ page }) => {
  const actions: Array<{ action: string; messageIds: string[] }> = [];
  const mailRequests: URLSearchParams[] = [];
  let slowNextMail = false;
  const actionItems = [
    mailItem("action-1", "one@example.test", "Action one"),
    mailItem("action-2", "two@example.test", "Action two"),
    mailItem("action-3", "three@example.test", "Action three"),
    mailItem("broad-extra", "extra@example.test", "Broad extra"),
  ].map((item) => ({ ...item, attention: "interrupt", isUnread: true }));
  const topics = actionItems.slice(0, 3).map((item, index) => ({
    id: item.id,
    kind: "action" as const,
    title: item.subject,
    summary: item.summary,
    senderName: item.senderName,
    accountLabel: item.accountLabel,
    receivedAt: item.receivedAt,
    deadline: null,
    urgency: 95 - index,
    threadCount: 1,
  }));
  const brief: TodayBrief = { ...todayBrief(), topics, counts: { action: 3, reply: 0, deadline: 0, fyi: 0 } };
  await mockEzraMailApi(page, actions, mailRequests, {
    today: brief,
    mailItems: actionItems,
    mailDelay: (params, requestIndex) => {
      if (slowNextMail) {
        slowNextMail = false;
        return 250;
      }
      return requestIndex === 0 && !params.getAll("messageId").length ? 250 : 15;
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem("ezra-mail-view-id", "builtin:job-search");
    localStorage.setItem("ezra-mail-filters", JSON.stringify({ folder: "all", date: "month", priority: "suppress" }));
  });

  await page.goto("/?view=today");
  await page.getByRole("button", { name: "View 3", exact: true }).click();
  await expect(page.getByRole("button", { name: /Action one/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Action two/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Action three/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Broad extra/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Today: Action now (3)" })).toBeVisible();
  expect(new URL(page.url()).searchParams.getAll("messageId")).toEqual(["action-1", "action-2", "action-3"]);
  expect(mailRequests.every((params) => params.get("viewId") === null)).toBe(true);

  await page.reload();
  await expect(page.getByRole("button", { name: /Action one/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Broad extra/ })).toHaveCount(0);
  slowNextMail = true;
  await page.evaluate(() => window.dispatchEvent(new Event("ezra:refresh")));
  await page.waitForTimeout(25);
  await page.getByRole("button", { name: /Action one/ }).first().click();
  await expect(page.getByRole("button", { name: /Action one/ })).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(page.getByRole("button", { name: /Action one/ })).toHaveCount(0);
  await page.goBack();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
});

test("delayed automatic refresh keeps Today stationary and focused", async ({ page }) => {
  let todayRequestIndex = 0;
  await mockEzraMailApi(page, [], [], {
    todayDelay: () => todayRequestIndex++ === 0 ? 0 : 250,
  });
  await page.goto("/?view=today");
  const activity = page.getByRole("group", { name: "Today's mail activity" });
  await expect(activity).toBeVisible();
  const before = await activity.boundingBox();
  const refresh = page.getByTitle("Refresh");
  await refresh.focus();
  await refresh.click();
  await page.waitForTimeout(80);
  const during = await activity.boundingBox();
  expect(before).not.toBeNull();
  expect(during).not.toBeNull();
  expect(Math.abs((during?.y || 0) - (before?.y || 0))).toBeLessThanOrEqual(1);
  await expect(refresh).toBeFocused();
  await expect(activity).toBeVisible();
  await page.waitForTimeout(220);
  const after = await activity.boundingBox();
  expect(Math.abs((after?.y || 0) - (before?.y || 0))).toBeLessThanOrEqual(1);
  expect(todayRequestIndex).toBe(2);
});

test("sweep selection shows exact scope and clears after filters and actions", async ({ page }) => {
  test.skip((page.viewportSize()?.width || 1000) <= 500, "Desktop regression; mobile keeps selection in a tighter layout.");
  const actions: Array<{ action: string; messageIds: string[] }> = [];
  await mockEzraMailApi(page, actions);

  await page.goto("/?view=mail");
  await expect(page.getByRole("heading", { name: "Mail", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Sale one/ }).first()).toBeVisible();

  await page.getByLabel("Select Sale one").check();
  await page.getByLabel("Sweep matching senders").check();
  const toolbar = page.locator('[class*="bulkToolbar"]');
  await expect(toolbar).toContainText("1 checked");
  await expect(toolbar).toContainText("2 sender matches");

  await toolbar.getByRole("button", { name: "Trash & teach" }).click();
  await expect(page.getByRole("heading", { name: /Approve trash and teach Ezra/i })).toBeVisible();
  await expect(page.getByText(/1 explicitly selected and 1 additional sender match/i)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(toolbar).toContainText("2 sender matches");

  await page.getByLabel("Date").selectOption("today");
  await expect(page.getByText(/sender matches/i)).toHaveCount(0);

  await page.getByLabel("Select Sale one").check();
  await page.getByLabel("Sweep matching senders").check();
  await toolbar.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("2 moved to Trash.")).toBeVisible();
  await expect(page.getByText(/sender matches/i)).toHaveCount(0);
  expect(actions).toEqual([{ action: "delete", messageIds: ["sale-1", "sale-2"] }]);
});

test("Smart Lanes apply saved views to Mail results", async ({ page }) => {
  test.skip((page.viewportSize()?.width || 1000) <= 500, "Desktop smart-lane regression.");
  const actions: Array<{ action: string; messageIds: string[] }> = [];
  const mailRequests: URLSearchParams[] = [];
  await mockEzraMailApi(page, actions, mailRequests);

  await page.goto("/?view=mail");
  await expect(page.getByRole("heading", { name: "Mail", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Job search/i })).toBeVisible();
  await page.getByRole("button", { name: /Job search/i }).click();

  await expect(page.getByRole("heading", { name: "Job search" })).toBeVisible();
  await expect(page.getByText(/Recruiters, applications/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /Interview request/ }).first()).toBeVisible();
  expect(mailRequests.some((params) => params.get("viewId") === "builtin:job-search")).toBe(true);
});

test("Smart Lanes can save, edit, and delete a custom lane", async ({ page }) => {
  test.skip((page.viewportSize()?.width || 1000) <= 500, "Desktop smart-lane management regression.");
  const actions: Array<{ action: string; messageIds: string[] }> = [];
  const mailRequests: URLSearchParams[] = [];
  await mockEzraMailApi(page, actions, mailRequests);

  await page.goto("/?view=mail");
  await expect(page.getByRole("heading", { name: "Mail", exact: true })).toBeVisible();
  await page.getByLabel("Category").selectOption("job application");
  await page.getByRole("button", { name: "Save lane" }).click();

  const saveDialog = page.locator('form[aria-label="Save Smart Lane"]');
  await expect(saveDialog).toBeVisible();
  await saveDialog.getByRole("textbox", { name: "Lane name" }).fill("Recruiter follow-ups");
  await saveDialog.getByRole("textbox", { name: "Description" }).fill("Jobs I want Ezra to keep within easy reach.");
  await saveDialog.getByRole("button", { name: "Create lane" }).click();

  await expect(page.getByRole("button", { name: /Recruiter follow-ups/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recruiter follow-ups" })).toBeVisible();
  await expect.poll(() => mailRequests.some((params) => params.get("viewId") === "custom:e2e-lane")).toBe(true);

  await page.getByRole("button", { name: "Edit lane" }).click();
  const editDialog = page.locator('form[aria-label="Edit Smart Lane"]');
  await expect(editDialog).toBeVisible();
  await editDialog.getByRole("textbox", { name: "Lane name" }).fill("Recruiter lane");
  await editDialog.getByRole("button", { name: "Save lane" }).click();

  await expect(page.getByRole("button", { name: /Recruiter lane/ })).toBeVisible();
  await page.getByRole("button", { name: "Edit lane" }).click();
  await expect(editDialog).toBeVisible();
  await editDialog.getByRole("button", { name: "Delete lane" }).click();

  await expect(page.getByRole("button", { name: /Recruiter lane/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Recruiter lane" })).toHaveCount(0);
});

test("natural-language Mail search reviews interpretation before opening results", async ({ page }) => {
  const actions: Array<{ action: string; messageIds: string[] }> = [];
  const resultRequests: URLSearchParams[] = [];
  await mockEzraMailApi(page, actions);
  const interpretation = naturalSearchInterpretation();
  const recruiterMessage = mailItem("natural-search-result", "recruiter@example.test", "Interview request");

  await page.route("**/api/search/actions", async (route) => {
    const body = route.request().postDataJSON() as { action?: string; query?: string };
    expect(body.action).toBe("interpret");
    const nextInterpretation = body.query?.includes("Hotmail") ? {
      ...interpretation,
      query: body.query,
      workspaceId: "workspace:microsoft",
      workspaceLabel: "Hotmail",
      applied: interpretation.applied.map((item) => item.field === "workspaceId" ? { ...item, value: "Hotmail", reason: "You mentioned Hotmail, Outlook, or Microsoft." } : item),
    } : interpretation;
    await route.fulfill({ json: { generatedAt: "2026-07-10T12:00:00.000Z", action: "interpret", interpretation: nextInterpretation } });
  });
  await page.route("**/api/search?**", async (route) => {
    resultRequests.push(new URL(route.request().url()).searchParams);
    await route.fulfill({
      json: {
        generatedAt: "2026-07-10T12:00:00.000Z",
        query: interpretation.query,
        interpretation,
        results: { items: [recruiterMessage], nextCursor: null, total: 1 },
      },
    });
  });

  await page.goto("/?view=mail");
  await page.getByRole("button", { name: "Natural language", exact: true }).click();
  await page.getByRole("textbox", { name: "Search mail", exact: true }).fill(interpretation.query);
  await page.getByRole("button", { name: "Interpret", exact: true }).click();

  const review = page.getByRole("region", { name: "Ezra interpreted your search" });
  await expect(review).toBeVisible();
  await expect(review).toContainText("Still active");
  await expect(review).toContainText("Last 7 days");
  await expect(review).toContainText("job and recruiter mail");
  await expect(review).toContainText("Local and read-only");
  await expect(page.getByRole("heading", { name: "Interpreted search results" })).toHaveCount(0);
  expect(resultRequests).toHaveLength(0);

  await review.getByRole("button", { name: "Open results", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Interpreted search results" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Interview request/ })).toBeVisible();
  expect(resultRequests).toHaveLength(1);
  expect(resultRequests[0].get("workspaceId")).toBe("workspace:gmail");
  expect(resultRequests[0].get("q")).toBe(interpretation.query);

  await page.getByRole("button", { name: "Local", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Interpreted search results" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Ezra interpreted your search" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Natural language", exact: true }).click();
  await page.getByRole("textbox", { name: "Search mail", exact: true }).fill("find Hotmail calendar emails from last week");
  await page.getByRole("button", { name: "Interpret", exact: true }).click();
  const unavailableReview = page.getByRole("region", { name: "Ezra interpreted your search" });
  await expect(unavailableReview.getByText("Connect Hotmail before opening results from that workspace.")).toBeVisible();
  await expect(unavailableReview.getByRole("button", { name: "Hotmail not connected" })).toBeDisabled();
  expect(resultRequests).toHaveLength(1);
});

async function mockEzraMailApi(
  page: Page,
  actions: Array<{ action: string; messageIds: string[] }>,
  mailRequests: URLSearchParams[] = [],
  options: {
    today?: TodayBrief;
    mailItems?: ReturnType<typeof mailItem>[];
    mailDelay?: (params: URLSearchParams, requestIndex: number) => number;
    todayDelay?: (requestIndex: number) => number;
    todayRequests?: URLSearchParams[];
  } = {},
) {
  const workspaces = [
    {
      id: "workspace:gmail",
      label: "Gmail",
      purpose: "General / Signup / Noise Catcher",
      accountIds: ["acct-gmail"],
      isAllAccounts: false,
      calendarRole: "none",
      provider: "gmail",
    },
    {
      id: "workspace:microsoft",
      label: "Hotmail",
      purpose: "Professional / Personal / Submissions",
      accountIds: [],
      isAllAccounts: false,
      calendarRole: "primary_future",
      provider: "microsoft",
    },
    {
      id: "workspace:all",
      label: "All accounts",
      purpose: "Explicit blend",
      accountIds: ["acct-gmail"],
      isAllAccounts: true,
      calendarRole: "none",
      provider: "all",
    },
  ];
  const mailItems = options.mailItems || [
    mailItem("sale-1", "sale@example.test", "Sale one"),
    mailItem("sale-2", "sale@example.test", "Sale two"),
    mailItem("job-1", "recruiter@example.test", "Interview request"),
  ];
  const handledIds = new Set<string>();
  let mailRequestIndex = 0;
  let todayRequestIndex = 0;
  let savedViews: SavedView[] = savedViewsPage("workspace:gmail").items;

  await page.route("**/api/auth/session", (route) => route.fulfill({
    json: { authenticated: true, configured: true, developmentBypass: true, expiresAt: null },
  }));
  await page.route("**/api/today?**", async (route) => {
    options.todayRequests?.push(new URL(route.request().url()).searchParams);
    const delay = options.todayDelay?.(todayRequestIndex++) || 0;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    await route.fulfill({ json: options.today || todayBrief() });
  });
  await page.route("**/api/mail/meta", (route) => route.fulfill({
    json: {
      accounts: [{ id: "acct-gmail", provider: "gmail", label: "Gmail", email: "owner@gmail.test", purpose: "General / Signup / Noise Catcher" }],
      workspaces,
      categories: ["marketing/promotional", "job application"],
    },
  }));
  await page.route("**/api/views**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/api/views/actions")) {
      const body = route.request().postDataJSON() as {
        action: string;
        id?: string;
        workspaceId?: string;
        label?: string;
        description?: string;
        definition?: SavedViewDefinition;
      };
      const now = "2026-07-03T14:00:00.000Z";
      if (body.action === "create") {
        const created: SavedView = {
          id: "custom:e2e-lane",
          workspaceId: body.workspaceId || "workspace:gmail",
          label: body.label || "Custom lane",
          description: body.description || "",
          definition: body.definition || defaultE2eLaneDefinition(),
          isBuiltin: false,
          isEnabled: true,
          isAllAccounts: body.workspaceId === "workspace:all",
          accountScopeLabel: body.workspaceId === "workspace:all" ? "All accounts · explicit blend" : "Gmail workspace",
          sortOrder: 1000,
          createdAt: now,
          updatedAt: now,
        };
        savedViews = [...savedViews.filter((view) => view.id !== created.id), created];
        return route.fulfill({ json: created });
      }
      if (body.action === "update" && body.id) {
        const current = savedViews.find((view) => view.id === body.id);
        const updated: SavedView = {
          ...(current || fallbackE2eSavedView(body.id)),
          id: body.id,
          label: body.label || current?.label || "Custom lane",
          description: body.description ?? current?.description ?? "",
          definition: body.definition || current?.definition || defaultE2eLaneDefinition(),
          isBuiltin: false,
          updatedAt: now,
        };
        savedViews = savedViews.map((view) => (view.id === body.id ? updated : view));
        return route.fulfill({ json: updated });
      }
      if (body.action === "delete" && body.id) {
        savedViews = savedViews.filter((view) => view.id !== body.id);
        return route.fulfill({ json: { ok: true, id: body.id } });
      }
      return route.fulfill({ status: 400, json: { error: "Unsupported saved-view action." } });
    }
    const workspaceId = url.searchParams.get("workspaceId") || "workspace:gmail";
    return route.fulfill({
      json: {
        ...savedViewsPage(workspaceId),
        items: savedViews.filter((view) => view.workspaceId === workspaceId),
      },
    });
  });
  await page.route("**/api/mail?**", async (route) => {
    const url = new URL(route.request().url());
    mailRequests.push(url.searchParams);
    const requestIndex = mailRequestIndex++;
    const delay = options.mailDelay?.(url.searchParams, requestIndex) || 0;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const exactIds = url.searchParams.getAll("messageId");
    let items = url.searchParams.get("viewId") === "builtin:job-search"
      ? mailItems.filter((item) => item.category === "job application")
      : mailItems;
    if (exactIds.length) items = items.filter((item) => exactIds.includes(item.id));
    if (url.searchParams.get("handled") === "active") items = items.filter((item) => !handledIds.has(item.id));
    return route.fulfill({
      json: { items, nextCursor: null, total: items.length },
    });
  });
  await page.route("**/api/mail/actions", async (route) => {
    const body = route.request().postDataJSON() as { action: string; messageIds?: string[]; actionId?: string };
    if (body.action !== "mark_read" && body.action !== "undo") {
      actions.push({ action: body.action, messageIds: body.messageIds || [] });
    }
    if (["mark_read", "done", "delete", "delete_and_teach", "spam", "quiet"].includes(body.action)) {
      for (const id of body.messageIds || []) handledIds.add(id);
    }
    return route.fulfill({
      json: {
        actionId: "action-test",
        action: body.action,
        successCount: body.messageIds?.length || 0,
        failureCount: 0,
        reversible: body.action === "delete",
        failures: [],
        changedIds: body.messageIds || [],
        unchangedIds: [],
      },
    });
  });
}

function naturalSearchInterpretation() {
  const query = "show unhandled recruiter mail from last week";
  return {
    query,
    workspaceId: "workspace:gmail",
    workspaceLabel: "Gmail",
    mode: "local" as const,
    confidence: "high" as const,
    filters: {
      folder: "inbox",
      date: "last7",
      handled: "active",
      categories: ["job application", "job alert", "career", "interview request"],
      search: "job recruiter interview application hiring career",
    },
    filterParams: {
      workspaceId: "workspace:gmail",
      folder: "inbox",
      date: "last7",
      handled: "active",
      categories: "job application,job alert,career,interview request",
      search: "job recruiter interview application hiring career",
    },
    applied: [
      { field: "workspaceId", label: "Workspace", value: "Gmail", reason: "Using the selected Gmail workspace." },
      { field: "folder", label: "Folder", value: "Inbox", reason: "Natural-language search starts in Inbox unless you ask for another folder." },
      { field: "date", label: "Date", value: "Last 7 days", reason: "You mentioned a week or last week." },
      { field: "handled", label: "Handled state", value: "Still active", reason: "You asked for mail that is not handled yet." },
      { field: "categories", label: "Subject matter", value: "job and recruiter mail", reason: "Your words matched Ezra's local topic hints." },
    ],
    ignoredTerms: [],
    warnings: [],
    explanation: "Ezra will search Gmail, inbox mail, that is still active, from the last 7 days, matching job and recruiter mail.",
    providerSearch: {
      readOnly: true as const,
      available: true,
      requested: false,
      reason: "Ezra will search the local SQLite index first. Provider search is only used when explicitly requested.",
    },
  };
}

async function mockCalendarModesApi(page: Page, requests: URLSearchParams[], empty = false) {
  await page.route("**/api/calendar?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    requests.push(params);
    const from = new Date(params.get("from") || Date.now());
    const to = new Date(params.get("to") || from.getTime() + 86_400_000);
    const eventStart = new Date(from);
    eventStart.setHours(9, 0, 0, 0);
    const events = empty ? [] : Array.from({ length: 6 }, (_, index) => calendarE2eEvent(index + 1, new Date(eventStart.getTime() + index * 30 * 60_000)));
    await route.fulfill({
      json: {
        events,
        drafts: [],
        accounts: [{
          accountId: "acct-gmail",
          accountLabel: "Gmail",
          accountEmail: "owner@gmail.test",
          provider: "gmail",
          status: "connected",
          calendarStatus: "connected",
          calendarAccess: "write",
          lastSyncAt: "2026-07-10T12:00:00.000Z",
          lastError: null,
        }],
        range: { from: from.toISOString(), to: to.toISOString(), timezone: "America/Chicago" },
      },
    });
  });
}

async function mockSetupChecklistApi(page: Page, browserNotificationsAvailable = false) {
  await page.route("**/api/accounts", (route) => route.fulfill({ json: {
    generatedAt: "2026-07-10T12:00:00.000Z",
    pollIntervalMinutes: 5, manualSyncCooldownSeconds: 60, items: [],
  } }));
  await page.route("**/api/auth/devices", (route) => route.fulfill({ json: {
    devices: [],
    passkeys: [],
    currentDeviceId: null,
    bypassActive: true,
    configured: true,
  } }));
  await page.route("**/api/settings", (route) => route.fulfill({ json: {
    accounts: [],
    health: { worker: "running", lastPollAt: "2026-07-10T12:00:00.000Z", lastPollError: null, ollama: true, telegramConfigured: false, telegramRunning: false, gogInstalled: true, gmailModifyAuthorized: true },
    updates: { app: { currentVersion: "0.7.3", commit: "test-revision" } },
    backlog: { status: "idle", discovered: 0 },
  } }));
  await page.route("**/api/system/recovery", (route) => route.fulfill({ json: {
    generatedAt: "2026-07-10T12:00:00.000Z",
    database: { kind: "file", sizeBytes: 1024, schemaVersion: 1 },
    backup: { latest: null, verified: false, verifiedAt: null, sha256: null, detail: "No backup found." },
    runtime: { webRevision: null, workerRevision: null, revisionsMatch: null, workerHeartbeatAt: null, workerHealthy: false },
    polling: { paused: false, pausedAt: null, reason: null },
  } }));
  await page.route("**/api/rules?**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/permissions?**", (route) => route.fulfill({
    json: {
      generatedAt: "2026-07-10T12:00:00.000Z",
      workspaceId: "workspace:gmail",
      summary: { accounts: 0, connectedAccounts: 0, needsSetup: 0, errors: 0, readOnly: 0, disabled: 0 },
      accounts: [],
    },
  }));
  await page.route("**/api/notifications/history", route => route.fulfill({ json: { events: [] } }));
  await page.route("**/api/notifications/policy", (route) => route.fulfill({
    json: {
      generatedAt: "2026-07-10T12:00:00.000Z",
      timezone: "America/Chicago",
      digestTimes: ["08:30", "16:30"],
      quietStart: "22:00",
      quietEnd: "07:00",
      dailyInterruptBudget: 3, burstWindowSeconds: 60, senderCooldownMinutes: 360, snoozedUntil: null, calmCheckinEnabled: false, calmCheckinTime: "12:30",
      channels: browserNotificationsAvailable ? [{
        id: "browser",
        label: "Browser/app notifications",
        status: "available",
        detail: "Available for explicit enrollment on this browser.",
        lastError: null,
      }] : [],
      categoryPolicies: [],
      guardrails: [],
      stats: { windowDays: 7, interruptsSent: 0, interruptsSkipped: 0, interruptsFailed: 0, interruptsAccepted: 0, interruptsDisplayed: 0, digestsSent: 0, digestsSkipped: 0, digestsFailed: 0, digestsAccepted: 0, digestsDisplayed: 0, lastNotificationAt: null, lastDigestAt: null },
    },
  }));
  await page.route("**/api/onboarding?**", (route) => route.fulfill({
    json: {
      generatedAt: "2026-07-10T12:00:00.000Z",
      workspaceId: "workspace:gmail",
      summary: { total: 2, complete: 1, needsAttention: 1, planned: 0, percentComplete: 50 },
      items: [
        {
          id: "workspace_purposes",
          label: "Workspace purposes",
          description: "Review what Gmail and Hotmail are for.",
          whyItMatters: "Purpose labels keep account routing predictable.",
          status: "complete",
          statusLabel: "Reviewed",
          detail: "Reviewed today.",
          actionLabel: "Review accounts",
          target: { type: "settings", tab: "accounts" },
        },
        {
          id: "backup_restore",
          label: "Backup and restore readiness",
          description: "Verify a current local backup and restore point.",
          whyItMatters: "Local learning and approvals must be recoverable.",
          status: "needs_attention",
          statusLabel: "Setup needed",
          detail: "Install the daily backup and monthly restore-rehearsal timers, then confirm both evidence records in System.",
          actionLabel: "Open System",
          target: { type: "settings", tab: "system" },
        },
      ],
    },
  }));
  await page.route("**/api/calendar?**", (route) => route.fulfill({
    json: { events: [], drafts: [], accounts: [], range: { from: "2026-07-05T00:00:00.000Z", to: "2026-07-12T00:00:00.000Z", timezone: "America/Chicago" } },
  }));
}

async function mockAccountFreshnessApi(page: Page, posts: Array<Record<string, unknown>>) {
  let purposeLabel = "General / Signup / Noise Catcher";
  let cooldown = false;
  const freshness = () => ({
    generatedAt: "2026-07-10T12:00:00.000Z",
    pollIntervalMinutes: 5,
    manualSyncCooldownSeconds: 60,
    items: [{
      accountId: "acct-gmail",
      accountLabel: "Gmail",
      accountEmail: "owner@gmail.test",
      accountProvider: "gmail",
      purposeLabel,
      status: "connected",
      lastSuccessfulPollAt: "2026-07-10T11:59:00.000Z",
      lastProviderActionAt: "2026-07-10T11:58:00.000Z",
      lastError: null,
      nextExpectedCheckAt: "2026-07-10T12:04:00.000Z",
      manualSyncAvailableAt: cooldown ? new Date(Date.now() + 60_000).toISOString() : null,
      canSyncNow: !cooldown,
    }],
  });
  await page.route("**/api/settings", (route) => route.fulfill({
    json: {
      accounts: [{ id: "acct-gmail", provider: "gmail", email: "owner@gmail.test", label: "Gmail", purpose: purposeLabel, status: "connected", lastSyncAt: "2026-07-10T11:59:00.000Z", counts: { inbox: 1, unread: 1, interrupt: 0, digest: 1, maintenance: 0 } }],
      health: { worker: "running", lastPollAt: "2026-07-10T12:00:00.000Z", lastPollError: null, ollama: true, telegramConfigured: false, telegramRunning: false, gogInstalled: true, gmailModifyAuthorized: true },
      updates: { app: { currentVersion: "0.7.3", commit: "test-revision" } },
      backlog: { status: "idle", discovered: 0 },
    },
  }));
  await page.route("**/api/accounts", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      posts.push(body);
      if (body.action === "update_purpose") purposeLabel = String(body.purposeLabel);
      if (body.action === "sync_now") cooldown = true;
      if (body.action === "sync_now") return route.fulfill({ json: { result: { accountId: "acct-gmail", ingested: 0 }, freshness: freshness() } });
    }
    return route.fulfill({ json: freshness() });
  });
  await page.route("**/api/mail/meta", (route) => route.fulfill({
    json: {
      accounts: [{ id: "acct-gmail", provider: "gmail", label: "Gmail", email: "owner@gmail.test", purpose: purposeLabel }],
      workspaces: [
        { id: "workspace:gmail", label: "Gmail", purpose: purposeLabel, accountIds: ["acct-gmail"], isAllAccounts: false, calendarRole: "none", provider: "gmail" },
        { id: "workspace:microsoft", label: "Hotmail", purpose: "Professional / Personal / Submissions", accountIds: [], isAllAccounts: false, calendarRole: "primary_future", provider: "microsoft" },
        { id: "workspace:all", label: "All accounts", purpose: "Explicit combined view", accountIds: ["acct-gmail"], isAllAccounts: true, calendarRole: "none", provider: "all" },
      ],
      categories: [],
    },
  }));
}

function calendarE2eEvent(index: number, startsAt: Date) {
  return {
    id: `calendar-event-${index}`,
    accountId: "acct-gmail",
    accountLabel: "Gmail",
    accountProvider: "gmail",
    externalEventId: `external-calendar-${index}`,
    calendarId: "primary",
    calendarName: "Primary",
    title: `Calendar event ${index}`,
    description: "Calendar mode test event.",
    location: index === 1 ? "Remote" : null,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
    isAllDay: false,
    timezone: "America/Chicago",
    status: "confirmed",
    visibility: "default",
    isBusy: true,
    organizerName: "Owner",
    organizerEmail: "owner@gmail.test",
    attendees: [],
    webLink: null,
    updatedAt: startsAt.toISOString(),
    syncedAt: startsAt.toISOString(),
  };
}

async function mockDraftCompositionApi(page: Page, posts: Array<Record<string, unknown>>) {
  const workspaces = [
    {
      id: "workspace:gmail",
      label: "Gmail",
      purpose: "General / Signup / Noise Catcher",
      accountIds: ["acct-gmail"],
      isAllAccounts: false,
      calendarRole: "none",
      provider: "gmail",
    },
    {
      id: "workspace:microsoft",
      label: "Hotmail",
      purpose: "Professional / Personal / Submissions",
      accountIds: [],
      isAllAccounts: false,
      calendarRole: "primary_future",
      provider: "microsoft",
    },
    {
      id: "workspace:all",
      label: "All accounts",
      purpose: "Explicit blend",
      accountIds: ["acct-gmail"],
      isAllAccounts: true,
      calendarRole: "none",
      provider: "all",
    },
  ];
  let createdDraft: Record<string, unknown> | null = null;

  await page.route("**/api/auth/session", (route) => route.fulfill({
    json: { authenticated: true, configured: true, developmentBypass: true, expiresAt: null },
  }));
  await page.route("**/api/today?**", (route) => route.fulfill({ json: todayBrief() }));
  await page.route("**/api/mail/meta", (route) => route.fulfill({
    json: {
      accounts: [{ id: "acct-gmail", provider: "gmail", label: "Gmail", email: "owner@gmail.test", purpose: "General / Signup / Noise Catcher" }],
      workspaces,
      categories: [],
    },
  }));
  await page.route("**/api/contacts?**", (route) => route.fulfill({
    json: {
      generatedAt: "2026-07-03T14:00:00.000Z",
      query: "tay",
      workspaceId: "workspace:gmail",
      accountId: "acct-gmail",
      items: [{
        id: "contact:acct-gmail:taylor@example.test",
        accountId: "acct-gmail",
        accountLabel: "Gmail",
        accountProvider: "gmail",
        name: "Taylor Recruiter",
        email: "taylor@example.test",
        source: "sender",
        messageCount: 2,
        lastSeenAt: "2026-07-03T14:00:00.000Z",
        relationship: "2 received messages",
      }],
    },
  }));
  await page.route("**/api/drafts", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      posts.push(body);
      createdDraft = {
        id: "outdraft-e2e",
        sourceType: "new",
        sourceMessageId: null,
        accountId: body.accountId,
        accountLabel: "Gmail",
        accountEmail: "owner@gmail.test",
        accountProvider: "gmail",
        fromEmail: "owner@gmail.test",
        to: body.to,
        cc: body.cc,
        bcc: body.bcc,
        subject: body.subject,
        body: body.body,
        attachments: [],
        contentHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        version: 1,
        status: "draft",
        approvalSnapshot: null,
        providerMessageId: null,
        lastError: null,
        sendDisabledReason: "New and forwarded mail will send only after the Outbox exact-review approval flow is enabled.",
        createdAt: "2026-07-03T14:00:00.000Z",
        updatedAt: "2026-07-03T14:00:00.000Z",
      };
      return route.fulfill({ json: createdDraft });
    }
    return route.fulfill({ json: [] });
  });
  await page.route("**/api/outbox/actions", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (!createdDraft) return route.fulfill({ json: { ok: false, message: "No draft." } });
    if (body.action === "request_approval") {
      const snapshot = approvalSnapshotForE2eDraft(createdDraft);
      createdDraft = { ...createdDraft, status: "awaiting_approval", approvalSnapshot: JSON.stringify(snapshot) };
      return route.fulfill({
        json: {
          ok: true,
          message: "Exact review snapshot is ready.",
          item: outboxItemFromE2eDraft(createdDraft, "new", null),
        },
      });
    }
    if (body.action === "approve") {
      createdDraft = { ...createdDraft, status: "approved" };
      return route.fulfill({
        json: {
          ok: true,
          message: "Outgoing draft approved and ready for Gmail send.",
          item: outboxItemFromE2eDraft(createdDraft, "new", null),
        },
      });
    }
    if (body.action === "send") {
      createdDraft = { ...createdDraft, status: "sent", providerMessageId: "gmail-provider-message-1" };
      return route.fulfill({
        json: {
          ok: true,
          message: "Outgoing Gmail draft sent.",
          providerMessageId: "gmail-provider-message-1",
          item: outboxItemFromE2eDraft(createdDraft, "new", null),
        },
      });
    }
    return route.fulfill({ json: { ok: false, message: "Provider send execution is still locked." } });
  });
  await page.route("**/api/outbox/*/attachments", async (route) => {
    if (!createdDraft) return route.fulfill({ status: 404, json: { error: "No draft." } });
    if (route.request().method() === "POST") {
      createdDraft = {
        ...createdDraft,
        attachments: [{ id: "outattach-e2e", name: "notes.txt", mimeType: "text/plain", size: 9, sha256: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef", available: true }],
        version: Number(createdDraft.version || 1) + 1,
        status: "draft",
        approvalSnapshot: null,
        contentHash: "fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321",
      };
      return route.fulfill({ json: createdDraft });
    }
    createdDraft = { ...createdDraft, attachments: [], version: Number(createdDraft.version || 1) + 1, status: "draft", approvalSnapshot: null };
    return route.fulfill({ json: createdDraft });
  });
  await page.route("**/api/outbox?**", (route) => route.fulfill({
    json: {
      generatedAt: "2026-07-03T14:00:00.000Z",
      counts: {
        total: createdDraft ? 1 : 0,
        draft: createdDraft && createdDraft.status === "draft" ? 1 : 0,
        awaitingApproval: createdDraft && createdDraft.status === "awaiting_approval" ? 1 : 0,
        approved: createdDraft && createdDraft.status === "approved" ? 1 : 0,
        sending: 0,
        sent: createdDraft && createdDraft.status === "sent" ? 1 : 0,
        failed: 0,
        cancelled: 0,
        blocked: createdDraft && outboxItemFromE2eDraft(createdDraft, "new", null).blockedReason ? 1 : 0,
        cancellable: createdDraft && ["draft", "awaiting_approval", "approved", "failed"].includes(String(createdDraft.status)) ? 1 : 0,
      },
      items: createdDraft ? [outboxItemFromE2eDraft(createdDraft, "new", null)] : [],
    },
  }));
}

async function mockForwardCompositionApi(page: Page, posts: Array<Record<string, unknown>>) {
  const workspaces = [
    {
      id: "workspace:gmail",
      label: "Gmail",
      purpose: "General / Signup / Noise Catcher",
      accountIds: ["acct-gmail"],
      isAllAccounts: false,
      calendarRole: "none",
      provider: "gmail",
    },
    {
      id: "workspace:microsoft",
      label: "Hotmail",
      purpose: "Professional / Personal / Submissions",
      accountIds: [],
      isAllAccounts: false,
      calendarRole: "primary_future",
      provider: "microsoft",
    },
    {
      id: "workspace:all",
      label: "All accounts",
      purpose: "Explicit blend",
      accountIds: ["acct-gmail"],
      isAllAccounts: true,
      calendarRole: "none",
      provider: "all",
    },
  ];
  const forwardMessage = {
    ...mailItem("mail-forward", "jennifer.ortiz@target.com", "Target Application Follow Up"),
    hasAttachments: true,
    isPinned: false,
    isFlagged: false,
    organizationCapabilities: {
      pin: { state: "supported", mapping: "gmail_star" },
      flag: { state: "supported", mapping: "gmail_important" },
    },
  };
  let createdDraft: Record<string, unknown> | null = null;

  await page.route("**/api/auth/session", (route) => route.fulfill({
    json: { authenticated: true, configured: true, developmentBypass: true, expiresAt: null },
  }));
  await page.route("**/api/today?**", (route) => route.fulfill({ json: todayBrief() }));
  await page.route("**/api/mail/meta", (route) => route.fulfill({
    json: {
      accounts: [{ id: "acct-gmail", provider: "gmail", label: "Gmail", email: "owner@gmail.test", purpose: "General / Signup / Noise Catcher" }],
      workspaces,
      categories: ["job application"],
    },
  }));
  await page.route("**/api/views?**", (route) => route.fulfill({ json: savedViewsPage("workspace:gmail") }));
  await page.route("**/api/contacts?**", (route) => route.fulfill({
    json: {
      generatedAt: "2026-07-03T14:00:00.000Z",
      query: "",
      workspaceId: "workspace:gmail",
      accountId: "acct-gmail",
      items: [],
    },
  }));
  await page.route("**/api/mail?**", (route) => route.fulfill({
    json: { items: [forwardMessage], nextCursor: null, total: 1 },
  }));
  await page.route("**/api/mail/mail-forward", (route) => route.fulfill({
    json: {
      detail: {
        message: forwardMessage,
        bodyText: "Hi Eric,\n\nPlease schedule your interview.",
        bodyIsExcerpt: false,
        attachments: [
          { id: "preview-file", name: "report.pdf", mimeType: "application/pdf", size: 24 },
          { id: "image-file", name: "picture.png", mimeType: "image/png", size: 24 },
          { id: "text-file", name: "notes.txt", mimeType: "text/plain", size: 24 },
          { id: "archive-file", name: "archive.zip", mimeType: "application/zip", size: 24 },
          { id: "large-file", name: "large.pdf", mimeType: "application/pdf", size: 6_000_000 },
        ],
        contactMemory: {
          summary: "First message from this contact.",
          messageCount: 1,
          firstSeenAt: "2026-07-03T14:00:00.000Z",
          lastSeenAt: "2026-07-03T14:00:00.000Z",
          categories: [],
        },
      },
      thread: [],
      capabilities: {
        unsubscribeSupported: false,
        protectedMessage: false,
        organization: {
          pin: { state: "supported", mapping: "gmail_star" },
          flag: { state: "supported", mapping: "gmail_important" },
        },
      },
    },
  }));
  await page.route("**/api/mail/mail-forward/attachments/preview-file/preview", (route) => route.fulfill({
    body: "%PDF-1.7\nSafe preview",
    contentType: "application/pdf",
  }));
  await page.route("**/api/mail/mail-forward/attachments/image-file/preview", (route) => route.fulfill({
    body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    contentType: "image/png",
  }));
  await page.route("**/api/mail/mail-forward/attachments/text-file/preview", (route) => route.fulfill({
    body: "Safe plain text preview.",
    contentType: "text/plain; charset=utf-8",
  }));
  await page.route("**/api/mail/mail-forward/attachments/archive-file/preview", (route) => route.fulfill({
    json: { preview: { status: "unsupported", reason: "Ezra can preview only PDFs, common images, and plain-text documents." } },
  }));
  await page.route("**/api/mail/mail-forward/attachments/large-file/preview", (route) => route.fulfill({
    json: { preview: { status: "too_large", reason: "This attachment is too large to preview safely." } },
  }));
  await page.route("**/api/mail/actions", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    posts.push(body);
    if (body.action === "pin") forwardMessage.isPinned = true;
    if (body.action === "unpin") forwardMessage.isPinned = false;
    if (body.action === "flag") forwardMessage.isFlagged = true;
    if (body.action === "unflag") forwardMessage.isFlagged = false;
    return route.fulfill({
      json: {
        actionId: "action-pin-e2e",
        action: body.action,
        successCount: Array.isArray(body.messageIds) ? body.messageIds.length : 0,
        failureCount: 0,
        reversible: body.action === "pin",
        failures: [],
        changedIds: body.messageIds || [],
        unchangedIds: [],
      },
    });
  });
  await page.route("**/api/drafts", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    posts.push(body);
    createdDraft = {
      id: "outdraft-forward-e2e",
      sourceType: "forward",
      sourceMessageId: body.messageId,
      accountId: "acct-gmail",
      accountLabel: "Gmail",
      accountEmail: "owner@gmail.test",
      accountProvider: "gmail",
      fromEmail: "owner@gmail.test",
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      subject: body.subject,
      body: body.body,
      attachments: [],
      contentHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      version: 1,
      status: "draft",
      approvalSnapshot: null,
      providerMessageId: null,
      lastError: null,
      sendDisabledReason: "New and forwarded mail will send only after the Outbox exact-review approval flow is enabled.",
      createdAt: "2026-07-03T14:00:00.000Z",
      updatedAt: "2026-07-03T14:00:00.000Z",
    };
    return route.fulfill({ json: createdDraft });
  });
  await page.route("**/api/outbox?**", (route) => route.fulfill({
    json: {
      generatedAt: "2026-07-03T14:00:00.000Z",
      counts: {
        total: createdDraft ? 1 : 0,
        draft: createdDraft ? 1 : 0,
        awaitingApproval: 0,
        approved: 0,
        sending: 0,
        sent: 0,
        failed: 0,
        cancelled: 0,
        blocked: createdDraft ? 1 : 0,
        cancellable: createdDraft ? 1 : 0,
      },
      items: createdDraft ? [{
        id: "outbox:outdraft-forward-e2e",
        draftId: "outdraft-forward-e2e",
        sourceType: "forward",
        sourceMessageId: "mail-forward",
        accountId: "acct-gmail",
        accountLabel: "Gmail",
        accountEmail: "owner@gmail.test",
        accountProvider: "gmail",
        fromEmail: "owner@gmail.test",
        to: createdDraft.to,
        cc: createdDraft.cc,
        bcc: createdDraft.bcc,
        recipientCount: 2,
        subject: createdDraft.subject,
        body: createdDraft.body,
        attachments: [],
        bodyPreview: String(createdDraft.body),
        status: "draft",
        version: 1,
        contentHash: createdDraft.contentHash,
        approvalSnapshot: null,
        providerMessageId: null,
        lastError: null,
        canSend: false,
        canCancel: true,
        canRetry: false,
        blockedReason: "Send is blocked until this draft goes through the Outbox exact-review approval flow.",
        createdAt: createdDraft.createdAt,
        updatedAt: createdDraft.updatedAt,
      }] : [],
    },
  }));
}

async function mockDirectReplyApi(page: Page, posts: Array<Record<string, unknown>>) {
  await mockForwardCompositionApi(page, []);
  const gmailMessage = {
    ...mailItem("mail-reply-gmail", "sender@example.test", "Gmail reply test"),
    senderName: "Sender",
  };
  const hotmailMessage = {
    ...mailItem("mail-reply-hotmail", "sender@example.test", "Hotmail reply-all test"),
    accountId: "acct-hotmail",
    accountLabel: "Hotmail",
    accountProvider: "microsoft",
    externalMessageId: "immutable-hotmail-message-id",
  };
  let createdDraft: Record<string, unknown> | null = null;

  await page.route("**/api/mail?**", (route) => route.fulfill({
    json: { items: [gmailMessage, hotmailMessage], nextCursor: null, total: 2 },
  }));
  for (const message of [gmailMessage, hotmailMessage]) {
    await page.route(`**/api/mail/${message.id}`, (route) => route.fulfill({
      json: {
        detail: {
          message,
          bodyText: "Please let everyone know whether Friday works.",
          bodyIsExcerpt: false,
          content: {
            plainText: "Please let everyone know whether Friday works.\n\nEarlier message",
            sanitizedHtml: '<p>Please let everyone know whether Friday works.</p><blockquote><p>Earlier message</p></blockquote><img alt="Chart" data-ezra-remote-src="https://images.example.test/chart.png">',
            contentHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
            providerRevision: "e2e-revision",
            fetchedAt: "2026-08-04T12:00:00.000Z",
            source: "cache",
            remoteImageCount: 1,
            trackingPixelCount: 0,
            truncated: false,
          },
          attachments: [],
          contactMemory: {
            summary: "Known contact.",
            messageCount: 2,
            firstSeenAt: "2026-07-03T14:00:00.000Z",
            lastSeenAt: "2026-07-03T14:00:00.000Z",
            categories: [],
          },
        },
        thread: [],
        capabilities: { unsubscribeSupported: false, protectedMessage: false },
      },
    }));
  }
  await page.route("**/api/drafts", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const isMicrosoft = body.messageId === "mail-reply-hotmail";
    const replyMode = body.replyMode === "all" ? "all" : "sender";
    const to = isMicrosoft
      ? [{ name: "Sender", email: "sender@example.test" }]
      : [{ name: "Reply To", email: "reply-to@example.test" }];
    const cc = isMicrosoft && replyMode === "all"
      ? [{ name: "Colleague", email: "colleague@example.test" }]
      : [];
    if (body.action === "prepare_reply") {
      return route.fulfill({
        json: {
          content: isMicrosoft ? "Thanks everyone." : "Thanks.",
          citations: [],
          replyMode,
          accountId: isMicrosoft ? "acct-hotmail" : "acct-gmail",
          accountLabel: isMicrosoft ? "Hotmail" : "Gmail",
          accountEmail: isMicrosoft ? "owner@hotmail.test" : "owner@gmail.test",
          to,
          cc,
        },
      });
    }
    if (body.action === "polish_reply") {
      return route.fulfill({
        json: {
          original: body.body,
          proposed: "Thanks so much. Friday morning works for me.",
          mode: body.mode,
          appliedContext: [`Mode: ${String(body.mode)}`],
          preservationChecks: [],
          factualChangesDetected: false,
          warnings: [],
        },
      });
    }
    posts.push(body);
    createdDraft = {
      id: isMicrosoft ? "outdraft-reply-hotmail" : "outdraft-reply-gmail",
      sourceType: "reply",
      sourceMessageId: body.messageId,
      replyMode,
      legacyReplyDraftId: null,
      providerDraftId: null,
      accountId: isMicrosoft ? "acct-hotmail" : "acct-gmail",
      accountLabel: isMicrosoft ? "Hotmail" : "Gmail",
      accountEmail: isMicrosoft ? "owner@hotmail.test" : "owner@gmail.test",
      accountProvider: isMicrosoft ? "microsoft" : "gmail",
      fromEmail: isMicrosoft ? "owner@hotmail.test" : "owner@gmail.test",
      to,
      cc,
      bcc: [],
      subject: isMicrosoft ? "Re: Hotmail reply-all test" : "Re: Gmail reply test",
      body: body.body,
      attachments: [],
      contentHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      version: 1,
      status: "draft",
      approvalSnapshot: null,
      providerMessageId: null,
      lastError: null,
      sendDisabledReason: isMicrosoft ? "Enable replies and keep Calendar to grant Microsoft Mail.Send before sending." : null,
      createdAt: "2026-07-03T14:00:00.000Z",
      updatedAt: "2026-07-03T14:00:00.000Z",
    };
    return route.fulfill({ json: createdDraft });
  });
  await page.route("**/api/outbox?**", (route) => {
    const draft = createdDraft;
    const isMicrosoft = draft?.accountProvider === "microsoft";
    return route.fulfill({
      json: {
        generatedAt: "2026-07-03T14:00:00.000Z",
        counts: {
          total: draft ? 1 : 0,
          draft: draft ? 1 : 0,
          awaitingApproval: 0,
          approved: 0,
          sending: 0,
          sendUnknown: 0,
          sent: 0,
          failed: 0,
          cancelled: 0,
          blocked: draft ? 1 : 0,
          cancellable: draft ? 1 : 0,
        },
        items: draft ? [{
          ...outboxItemFromE2eDraft(draft, "forward", String(draft.sourceMessageId)),
          sourceType: "reply",
          replyMode: draft.replyMode,
          legacyReplyDraftId: null,
          providerDraftId: null,
          canReconcile: false,
          blockedReason: isMicrosoft
            ? "Enable replies and keep Calendar to grant Microsoft Mail.Send before sending."
            : "Send is blocked until this draft goes through the Outbox exact-review approval flow.",
        }] : [],
      },
    });
  });
}

function outboxItemFromE2eDraft(draft: Record<string, unknown>, sourceType: "new" | "forward", sourceMessageId: string | null) {
  const status = String(draft.status || "draft");
  const to = Array.isArray(draft.to) ? draft.to : [];
  const cc = Array.isArray(draft.cc) ? draft.cc : [];
  const bcc = Array.isArray(draft.bcc) ? draft.bcc : [];
  return {
    id: `outbox:${String(draft.id)}`,
    draftId: String(draft.id),
    sourceType,
    sourceMessageId,
    accountId: String(draft.accountId || "acct-gmail"),
    accountLabel: String(draft.accountLabel || "Gmail"),
    accountEmail: String(draft.accountEmail || "owner@gmail.test"),
    accountProvider: String(draft.accountProvider || "gmail"),
    fromEmail: String(draft.fromEmail || "owner@gmail.test"),
    to,
    cc,
    bcc,
    recipientCount: to.length + cc.length + bcc.length,
    subject: String(draft.subject || ""),
    body: String(draft.body || ""),
    attachments: Array.isArray(draft.attachments) ? draft.attachments : [],
    bodyPreview: String(draft.body || ""),
    status,
    version: Number(draft.version || 1),
    contentHash: String(draft.contentHash || "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"),
    approvalSnapshot: draft.approvalSnapshot || null,
    providerMessageId: draft.providerMessageId || null,
    lastError: draft.lastError || null,
    canSend: status === "approved" && String(draft.accountProvider || "gmail") === "gmail",
    canCancel: ["draft", "awaiting_approval", "approved", "failed"].includes(status),
    canRetry: false,
    blockedReason: e2eBlockedReason(status),
    createdAt: String(draft.createdAt || "2026-07-03T14:00:00.000Z"),
    updatedAt: String(draft.updatedAt || "2026-07-03T14:00:00.000Z"),
  };
}

function approvalSnapshotForE2eDraft(draft: Record<string, unknown>) {
  return {
    draftId: String(draft.id),
    sourceType: "new",
    sourceMessageId: null,
    accountId: String(draft.accountId || "acct-gmail"),
    accountLabel: String(draft.accountLabel || "Gmail"),
    accountEmail: String(draft.accountEmail || "owner@gmail.test"),
    accountProvider: String(draft.accountProvider || "gmail"),
    fromEmail: String(draft.fromEmail || "owner@gmail.test"),
    to: Array.isArray(draft.to) ? draft.to : [],
    cc: Array.isArray(draft.cc) ? draft.cc : [],
    bcc: Array.isArray(draft.bcc) ? draft.bcc : [],
    subject: String(draft.subject || ""),
    body: String(draft.body || ""),
    attachments: Array.isArray(draft.attachments) ? draft.attachments : [],
    contentHash: String(draft.contentHash || ""),
    version: Number(draft.version || 1),
    requestedAt: "2026-07-03T14:00:00.000Z",
  };
}

function e2eBlockedReason(status: string) {
  if (status === "awaiting_approval") return "Send is blocked until you approve the exact reviewed snapshot.";
  if (status === "approved") return null;
  if (status === "failed") return "Retry is blocked until provider send execution records retry-safe failures.";
  if (status === "sent" || status === "cancelled") return null;
  return "Send is blocked until this draft goes through the Outbox exact-review approval flow.";
}

function mailItem(id: string, senderEmail: string, subject: string) {
  return {
    id,
    accountId: "acct-gmail",
    accountLabel: "Gmail",
    accountProvider: "gmail",
    externalMessageId: `external-${id}`,
    threadId: `thread-${id}`,
    senderName: senderEmail.startsWith("sale") ? "Sale Sender" : "Recruiter",
    senderEmail,
    subject,
    receivedAt: "2026-07-03T14:00:00.000Z",
    snippet: `${subject} snippet`,
    gmailUrl: "#",
    hasAttachments: false,
    isUnread: false,
    mailboxLabels: ["INBOX"],
    status: "triaged",
    attention: senderEmail.startsWith("sale") ? "suppress" : "interrupt",
    urgency: senderEmail.startsWith("sale") ? 12 : 90,
    confidence: 0.9,
    category: senderEmail.startsWith("sale") ? "marketing/promotional" : "job application",
    summary: `${subject} summary`,
    reason: "Mocked e2e reason.",
    recommendation: "Review.",
    needsReply: false,
    deadline: null,
    injectionFlags: [],
    model: "mock",
    notifiedAt: null,
    threadCount: 1,
  };
}

function todayBrief() {
  return {
    id: "today-test",
    workspaceId: "workspace:gmail",
    date: "2026-07-03",
    generatedAt: "2026-07-03T14:00:00.000Z",
    quietReviewed: 0,
    mailActivity: {
      receivedToday: 3,
      handledToday: 0,
      unhandledToday: 3,
      attentionCounts: { interrupt: 1, digest: 0, suppress: 2, unknown: 0 },
      stillNeedsAttention: 1,
      categoryCounts: [],
      lastPollAt: "2026-07-03T14:00:00.000Z",
      lastPollError: null,
    },
    topics: [],
    cleanup: [],
    oneMoreGlance: [],
    history: { generatedAt: "2026-07-03T14:00:00.000Z", sections: [] },
    counts: { action: 0, reply: 0, deadline: 0, fyi: 0 },
    briefCandidates: [],
    replyCandidates: [],
    sourceStatus: [],
    agenda: [],
    needsAttention: [],
    carryovers: [],
    completedSinceLastBrief: [],
  };
}

function savedViewsPage(workspaceId: string): { generatedAt: string; workspaceId: string; items: SavedView[] } {
  return {
    generatedAt: "2026-07-03T14:00:00.000Z",
    workspaceId,
    items: [
      {
        id: "builtin:job-search",
        workspaceId,
        label: "Job search",
        description: "Recruiters, applications, interviews, job alerts, and hiring follow-ups.",
        definition: {
          kind: "mail",
          semanticKey: "job_search",
          sort: "priority",
          filters: {
            folder: "inbox",
            categories: ["job application", "job alert", "career", "interview request"],
            search: "job recruiter interview application hiring",
            handled: "active",
          },
        },
        isBuiltin: true,
        isEnabled: true,
        isAllAccounts: workspaceId === "workspace:all",
        accountScopeLabel: workspaceId === "workspace:all" ? "All accounts · explicit blend" : "Gmail workspace",
        sortOrder: 10,
        createdAt: "builtin",
        updatedAt: "builtin",
      },
      {
        id: "builtin:security",
        workspaceId,
        label: "Security",
        description: "Sign-in alerts, account protection, verification, fraud, and security notices.",
        definition: {
          kind: "mail",
          semanticKey: "security",
          sort: "priority",
          filters: {
            folder: "inbox",
            categories: ["account-security", "fraud"],
            handled: "active",
          },
        },
        isBuiltin: true,
        isEnabled: true,
        isAllAccounts: workspaceId === "workspace:all",
        accountScopeLabel: workspaceId === "workspace:all" ? "All accounts · explicit blend" : "Gmail workspace",
        sortOrder: 40,
        createdAt: "builtin",
        updatedAt: "builtin",
      },
    ],
  };
}

function defaultE2eLaneDefinition(): SavedViewDefinition {
  return { kind: "mail", filters: { folder: "inbox", handled: "any" }, sort: "newest" };
}

function fallbackE2eSavedView(id: string): SavedView {
  return {
    id,
    workspaceId: "workspace:gmail",
    label: "Custom lane",
    description: "",
    definition: defaultE2eLaneDefinition(),
    isBuiltin: false,
    isEnabled: true,
    isAllAccounts: false,
    accountScopeLabel: "Gmail workspace",
    sortOrder: 1000,
    createdAt: "2026-07-03T14:00:00.000Z",
    updatedAt: "2026-07-03T14:00:00.000Z",
  };
}

test("PWA Settings explains installation independently of notification enrollment", async ({ page }, testInfo) => {
  await mockEzraMailApi(page, []);
  await mockSetupChecklistApi(page);
  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "Delivery", exact: true }).click();
  const panel = page.getByRole("region", { name: "Install Ezra Mail" });
  await expect(panel.getByText("App connection ready")).toBeVisible();
  await expect(panel.getByText(/installing does not enable notifications/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "Check for updates" })).toBeVisible();
  await panel.getByText("App connection help", { exact: true }).click();
  await expect(panel.getByRole("button", { name: "Repair app connection" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  expect((await new AxeBuilder({ page }).include('[aria-labelledby="pwa-heading"]').analyze()).violations).toEqual([]);
  await panel.screenshot({ path: testInfo.outputPath("pwa-settings.png") });
});

test("PWA-controlled navigation preserves an exact Mail target without provider writes", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (request) => { if (request.method() !== "GET") posts.push(new URL(request.url()).pathname); });
  await mockForwardCompositionApi(page, []);
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.goto("/?view=mail&message=mail-forward");
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toContain("/ezra-sw.js");
  await expect(page.getByRole("heading", { name: "Target Application Follow Up", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Target Application Follow Up", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/view=mail&message=mail-forward$/);
  expect(posts).toEqual([]);
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
});
