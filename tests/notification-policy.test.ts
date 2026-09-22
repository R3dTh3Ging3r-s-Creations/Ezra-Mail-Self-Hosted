import { describe, expect, it } from "vitest";
import { evaluateBriefDelivery, evaluateInterruptNudge } from "@/lib/email/notification-policy";
import { isTelegramTokenFormat } from "@/lib/email/telegram";
import type { InboxItem } from "@/lib/email/types";

const now = new Date("2026-06-26T18:00:00.000Z");

function item(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "mail-1",
    accountId: "account-1",
    accountLabel: "Personal",
    externalMessageId: "external-1",
    threadId: "thread-1",
    senderName: "Example",
    senderEmail: "sender@example.com",
    subject: "Review needed",
    receivedAt: "2026-06-26T17:30:00.000Z",
    snippet: "A useful message.",
    gmailUrl: "https://mail.google.com/",
    hasAttachments: false,
    isUnread: true,
    mailboxLabels: ["INBOX", "UNREAD"],
    status: "triaged",
    attention: "interrupt",
    urgency: 92,
    confidence: 0.9,
    category: "deadline",
    summary: "A useful message.",
    reason: "A near-term action is needed.",
    recommendation: "Review it.",
    needsReply: false,
    deadline: null,
    injectionFlags: [],
    model: "test",
    notifiedAt: null,
    ...overrides,
  };
}

describe("smart notification policy", () => {
  it("lets fresh critical security mail bypass quiet hours", () => {
    const decision = evaluateInterruptNudge({
      item: item({ category: "account-security" }),
      now: new Date("2026-06-27T05:00:00.000Z"),
      timezone: "America/Chicago",
    });
    expect(decision.send).toBe(true);
  });

  it("holds noncritical nudges during quiet hours", () => {
    const decision = evaluateInterruptNudge({
      item: item({ receivedAt: "2026-06-27T04:45:00.000Z" }),
      now: new Date("2026-06-27T05:00:00.000Z"),
      timezone: "America/Chicago",
    });
    expect(decision).toMatchObject({ send: false, reason: expect.stringContaining("quiet hours") });
  });

  it("enforces general and sender cooldowns", () => {
    const general = evaluateInterruptNudge({
      item: item(),
      now,
      lastAnySentAt: "2026-06-26T17:15:00.000Z",
    });
    const sender = evaluateInterruptNudge({
      item: item(),
      now,
      lastSenderSentAt: "2026-06-26T14:00:00.000Z",
    });
    expect(general.send).toBe(false);
    expect(sender.send).toBe(false);
  });

  it("never nudges for stale or excluded-folder mail", () => {
    expect(evaluateInterruptNudge({ item: item({ receivedAt: "2026-06-24T12:00:00.000Z" }), now }).send).toBe(false);
    expect(evaluateInterruptNudge({ item: item({ mailboxLabels: ["SPAM"] }), now }).send).toBe(false);
  });

  it("holds a lone low-pressure afternoon item for morning", () => {
    const decision = evaluateBriefDelivery([
      item({ attention: "digest", urgency: 52, needsReply: false }),
    ], "afternoon", now);
    expect(decision.send).toBe(false);
  });

  it("sends an afternoon brief for meaningful or multiple new topics", () => {
    const reply = evaluateBriefDelivery([
      item({ attention: "digest", urgency: 52, needsReply: true }),
    ], "afternoon", now);
    const multiple = evaluateBriefDelivery([
      item({ id: "mail-1", attention: "digest", urgency: 52 }),
      item({ id: "mail-2", attention: "digest", urgency: 48 }),
    ], "afternoon", now);
    expect(reply.send).toBe(true);
    expect(multiple.send).toBe(true);
  });
});

describe("Telegram configuration validation", () => {
  it("accepts BotFather token structure and rejects placeholder or encrypted values", () => {
    expect(isTelegramTokenFormat("123456789:ABC_def-123")).toBe(true);
    expect(isTelegramTokenFormat("DISABLED-secret-placeholder")).toBe(false);
    expect(isTelegramTokenFormat("DPAPI:encrypted-value")).toBe(false);
  });
});
