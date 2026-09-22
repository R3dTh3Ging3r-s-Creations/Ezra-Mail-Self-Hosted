import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeMailActionResult } from "@/components/ezra/mailActionSummary";
import { resolveBulkSelectionTargets } from "@/components/ezra/mailSelection";
import {
  configureEmailDatabaseForTests,
  execute,
  nowIso,
  saveTriageDecision,
} from "@/lib/email/database";
import { getProviderPermissions } from "@/lib/email/permissions";
import { getMailPage, getTodayBrief } from "@/lib/email/professional";
import type { AttentionLevel } from "@/lib/email/types";

const UTC_CHICAGO_DATE_BOUNDARY = "2026-08-23T01:35:00.000Z";

describe("v0.4 closeout stress coverage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(UTC_CHICAGO_DATE_BOUNDARY));
    configureEmailDatabaseForTests(`file:./v04-closeout-${randomUUID()}.sqlite`);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps workspace queries, sweep targeting, partial failures, and permission errors stable under load", async () => {
    expect(zonedNoonOnDate(new Date(UTC_CHICAGO_DATE_BOUNDARY), "America/Chicago").toISOString())
      .toBe("2026-08-22T17:00:00.000Z");
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    await seedAccount("acct-hotmail", "microsoft", "owner@hotmail.test", "Hotmail");
    await seedMessages(240);

    const allMail = await getMailPage({ workspaceId: "workspace:all", folder: "inbox", limit: 100 });
    const gmailMail = await getMailPage({ workspaceId: "workspace:gmail", folder: "inbox", limit: 100 });
    const hotmailMail = await getMailPage({ workspaceId: "workspace:microsoft", folder: "inbox", limit: 100 });
    const today = await getTodayBrief({ workspaceId: "workspace:all" });

    expect(allMail.items).toHaveLength(100);
    expect(allMail.total).toBe(240);
    expect(allMail.nextCursor).toBeTruthy();
    expect(gmailMail.total).toBe(120);
    expect(hotmailMail.total).toBe(120);
    expect(today.mailActivity.receivedToday).toBe(240);
    expect(today.mailActivity.attentionCounts.interrupt).toBeGreaterThan(0);
    expect(today.mailActivity.attentionCounts.suppress).toBeGreaterThan(0);

    const sweepItems = Array.from({ length: 1_500 }, (_, index) => ({
      id: `visible-${index}`,
      senderEmail: index < 900 ? "bulk@example.test" : `sender-${index}@example.test`,
    }));
    const swept = resolveBulkSelectionTargets(sweepItems, ["visible-42"], true);
    expect(swept).toHaveLength(900);
    expect(swept.every((id) => id.startsWith("visible-"))).toBe(true);

    const partial = summarizeMailActionResult({
      actionId: "stress-action",
      action: "delete",
      successCount: 900,
      failureCount: 12,
      reversible: true,
      changedIds: swept,
      unchangedIds: Array.from({ length: 15 }, (_, index) => `unchanged-${index}`),
      failures: Array.from({ length: 12 }, (_, index) => ({
        id: `failed-${index}`,
        error: "Reconnect Hotmail from Settings to grant Microsoft Mail.ReadWrite access.",
      })),
    });
    expect(partial.variant).toBe("partial");
    expect(partial.headline).toContain("Partial action");
    expect(partial.retryGuidance).toContain("Reconnect");

    await execute(
      `INSERT INTO account_integrations
        (account_id, feature, provider, access, status, last_connected_at, last_error, updated_at)
       VALUES ('acct-hotmail', 'calendar', 'microsoft', 'none', 'error', NULL, 'Calendars.ReadWrite missing', ?)`,
      [nowIso()],
    );
    const permissions = await getProviderPermissions({ workspaceId: "workspace:all" });
    expect(permissions.summary.errors).toBeGreaterThanOrEqual(1);
    expect(permissions.accounts.find((account) => account.accountId === "acct-hotmail")?.reconnectRecommended).toBe(true);
  }, 20_000);
});

async function seedAccount(id: string, provider: "gmail" | "microsoft", email: string, label: string) {
  const now = nowIso();
  await execute(
    `INSERT INTO email_accounts
      (id, provider, email, label, status, last_sync_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'connected', ?, ?, ?)`,
    [id, provider, email, label, now, now, now],
  );
}

async function seedMessages(count: number) {
  const todayAtNoon = zonedNoonOnDate(new Date(), "America/Chicago");
  const now = todayAtNoon.getTime();
  for (let index = 0; index < count; index += 1) {
    const accountId = index % 2 === 0 ? "acct-gmail" : "acct-hotmail";
    const receivedAt = new Date(now - index * 60_000).toISOString();
    const id = `stress-mail-${index}`;
    const attention: AttentionLevel = index % 6 === 0 ? "interrupt" : index % 3 === 0 ? "suppress" : "digest";
    await execute(
      `INSERT INTO email_messages
        (id, account_id, external_message_id, thread_id, sender_name, sender_email, subject,
         received_at, snippet, gmail_url, has_attachments, gmail_labels, is_unread, ingest_source,
         status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '#', 0, ?, 1, 'live', 'triaged', ?, ?)`,
      [
        id,
        accountId,
        `external-${id}`,
        `thread-${id}`,
        attention === "suppress" ? "Bulk Sender" : "Priority Sender",
        attention === "suppress" ? "bulk@example.test" : `sender-${index}@example.test`,
        `Stress message ${index}`,
        receivedAt,
        `Stress snippet ${index}`,
        JSON.stringify(["INBOX", "UNREAD"]),
        receivedAt,
        receivedAt,
      ],
    );
    await saveTriageDecision(id, "stress-model", {
      attention,
      urgency: attention === "interrupt" ? 92 : attention === "digest" ? 48 : 10,
      confidence: 0.9,
      category: attention === "suppress" ? "marketing/promotional" : attention === "interrupt" ? "job application" : "general",
      summary: `Stress summary ${index}`,
      reason: "Stress seeded closeout item.",
      recommendation: "Review when useful.",
      needsReply: attention === "interrupt",
      deadline: null,
      draftReply: null,
      injectionFlags: [],
      criticalReason: null,
    });
  }
}

function zonedNoonOnDate(date: Date, timeZone: string) {
  return zonedTimeToUtc({
    ...timeZoneDateParts(date, timeZone),
    hour: 12,
    minute: 0,
    timeZone,
  });
}

function timeZoneDateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
  };
}

function zonedTimeToUtc(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}) {
  const { year, month, day, hour, minute, timeZone } = input;
  let candidate = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute);
  for (let index = 0; index < 3; index += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(candidate);
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
    const actualUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"));
    candidate = new Date(candidate.getTime() + targetUtc - actualUtc);
  }
  return candidate;
}
