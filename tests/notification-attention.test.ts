// @vitest-environment node
import { describe, expect, it } from "vitest";
import { evaluateAttention, evaluateAttentionCandidate, evaluateAttentionAdmission, localAttentionDay, nextAttentionTime } from "@/lib/email/notification-attention";
import { parseNotificationPolicySettings } from "@/lib/email/notification-center";
import type { InboxItem } from "@/lib/email/types";

const now = new Date("2026-09-14T18:00:00.000Z");

const policy = () => parseNotificationPolicySettings({}, now);

function item(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "mail-1",
    accountId: "account-1",
    accountLabel: "Personal",
    externalMessageId: "external-1",
    threadId: "thread-1",
    senderName: "Private Person",
    senderEmail: "sender@example.test",
    subject: "Private subject",
    receivedAt: "2026-09-14T17:30:00.000Z",
    snippet: "Private snippet",
    gmailUrl: "",
    hasAttachments: false,
    isUnread: true,
    mailboxLabels: ["INBOX"],
    status: "triaged",
    attention: "interrupt",
    urgency: 90,
    confidence: 0.8,
    category: "deadline",
    summary: null,
    reason: null,
    recommendation: null,
    needsReply: false,
    deadline: null,
    injectionFlags: [],
    model: "fixture",
    notifiedAt: null,
    ...overrides,
  };
}

function evaluate(overrides: Partial<InboxItem> = {}, extra = {}) {
  return evaluateAttention({
    item: item(overrides),
    policy: policy(),
    now,
    history: [],
    feedback: [],
    hasEnrolledDevice: true,
    ...extra
  });
}

function event(id: string, minutes: number, extra = {}) {
  return {
    eventId: id,
    accountId: "account-1",
    senderEmail: "other@example.test",
    admittedAt: new Date(now.getTime() - minutes * 60000).toISOString(),
    critical: false,
    ...extra
  };
}

describe("attention candidate policy", () => {
  it("admits the exact confidence and urgency boundary with bounded opaque grouping", () => {
    const result = evaluate();
    expect(result).toMatchObject({
      level: "interrupt",
      reasonCode: "attention",
      critical: false,
      notBefore: "2026-09-14T18:01:00.000Z"
    });
    expect(result.groupingKey).toMatch(/^[a-f0-9]{64}$/);
    expect(result.categoryTag).toMatch(/^[a-f0-9]{64}$/);
    expect(result.ruleTrace.length).toBeLessThanOrEqual(16);
    expect(JSON.stringify(result)).not.toMatch(/Private|sender@|account-1|thread-1/);
    expect(evaluate({ id: "second" }).groupingKey).toBe(result.groupingKey);
    expect(evaluate({ accountId: "second" }).groupingKey).not.toBe(result.groupingKey);
    expect(evaluate({ category: "Deadline" }).categoryTag).toBe(result.categoryTag);
    expect(evaluate({ accountId: "second" }).categoryTag).not.toBe(result.categoryTag);
  });
  it.each([
    { receivedAt: "invalid" }, { receivedAt: "2026-09-14T18:00:00.001Z" },
    { receivedAt: "2026-09-13T17:59:59.999Z" }, { isUnread: false },
    ...["snoozed", "maintained", "spammed", "read", "cleared", "digested"].map(status => ({ status })),
    ...["SENT", "SPAM", "TRASH"].map(label => ({ mailboxLabels: [label] })),
    { injectionFlags: ["untrusted instruction"] },
    ...[NaN, Infinity, -0.1, 1.01, 0.7999, null].map(confidence => ({ confidence })),
  ])("rejects unsafe interruption input %j including critical", (overrides) => {
    expect(evaluate(overrides).level).not.toBe("interrupt");
    expect(evaluate({
      ...overrides,
      category: "fraud"
    }).level).not.toBe("interrupt");
  });
  it("accepts exactly 24-hour-old mail and concrete deadlines through 24 hours", () => {
    expect(evaluate({ receivedAt: "2026-09-13T18:00:00.000Z" }).level).toBe("interrupt");
    for (const deadline of [now.toISOString(), "2026-09-15T18:00:00.000Z"]) {
      expect(evaluate({
        urgency: 89,
        deadline
      }).level).toBe("interrupt");
    }
    for (const deadline of ["tomorrow", "2026-09-14T17:59:59.999Z", "2026-09-15T18:00:00.001Z", null]) {
      expect(evaluate({
        urgency: 89,
        deadline
      }).level).not.toBe("interrupt");
    }
    expect(evaluate({ urgency: NaN }).level).not.toBe("interrupt");
  });
  it.each(["newsletter", "marketing/promotional", "promotion", "routine", "bulk-mail", "learned-low-priority", "shipping", "receipt"])("keeps %s noninterrupting despite urgency", category => {
    expect(evaluate({ category }).level).not.toBe("interrupt");
  });
  it("requires baseline attention and respects absolute category preferences", () => {
    expect(evaluate({
      attention: "digest",
      category: "fraud"
    }).level).toBe("brief");
    expect(evaluate({
      attention: "suppress",
      category: "fraud"
    }).level).toBe("in_app");
    for (const preference of ["quiet", "digest"]) {
      const configured = parseNotificationPolicySettings({ notification_category_preferences: JSON.stringify({ security: preference }) }, now);
      expect(evaluate({ category: "fraud" }, { policy: configured }).level).toBe(preference === "quiet" ? "in_app" : "brief");
    }
  });
  it("uses exact critical categories and explicitly permitted aliases", () => {
    for (const category of ["account-security", "ACCOUNT SECURITY", "security alert", "security threat", "account-compromise", "fraud", "legal"]) {
      expect(evaluate({ category }).critical).toBe(true);
    }
    for (const category of ["legal newsletter", "not-fraud", "security threat promotion", "illegal", "security"]) {
      expect(evaluate({ category }).critical).toBe(false);
    }
    expect(evaluate({
      category: "fraud",
      urgency: 89
    }).critical).toBe(false);
  });
  it("defers ordinary quiet-hour mail but narrowly permits critical", () => {
    const at = new Date("2026-09-15T03:00:00.000Z");
    expect(evaluate({}, { now: at })).toMatchObject({
      level: "brief",
      reasonCode: "quiet_hours",
      notBefore: "2026-09-15T13:30:00.000Z"
    });
    expect(evaluate({ category: "fraud" }, { now: at })).toMatchObject({
      level: "interrupt",
      critical: true
    });
    expect(evaluate({ category: "fraud" }, { now: at }).ruleTrace).toContain("critical_quiet_bypass");
  });
  it("snoozes every external class and defaults absent enrollment to in-app", () => {
    const snoozed = {
      ...policy(),
      snoozedUntil: "2026-09-14T20:00:00.000Z"
    };
    for (const overrides of [{}, { category: "fraud" }, { attention: "digest" as const }]) {
      expect(evaluate(overrides, { policy: snoozed })).toMatchObject({
        level: "in_app",
        reasonCode: "snoozed"
      });
    }
    expect(evaluate({}, { handled: true }).level).toBe("in_app");
    expect(evaluate({}, { hasEnrolledDevice: false }).level).toBe("in_app");
    expect(evaluate({}, { hasEnrolledDevice: undefined }).level).toBe("in_app");
  });
  it("scopes latest feedback to sender/account and Useful only restores baseline", () => {
    const noisy = {
      accountId: "account-1",
      senderEmail: "SENDER@example.test",
      kind: "too_noisy",
      createdAt: "2026-09-14T17:00:00.000Z"
    };
    const useful = {
      ...noisy,
      kind: "useful",
      createdAt: "2026-09-14T17:01:00.000Z"
    };
    expect(evaluate({}, { feedback: [noisy] }).level).toBe("brief");
    expect(evaluate({ category: "fraud" }, { feedback: [noisy] }).level).toBe("brief");
    expect(evaluate({}, { feedback: [useful, noisy] }).level).toBe("interrupt");
    expect(evaluate({ attention: "digest" }, { feedback: [useful] }).level).toBe("brief");
    expect(evaluate({ category: "newsletter" }, { feedback: [useful] }).level).toBe("in_app");
    expect(evaluate({}, {
      feedback: [{
        ...noisy,
        accountId: "other"
      }]
    }).level).toBe("interrupt");
    expect(evaluate({}, {
      feedback: [{
        ...noisy,
        createdAt: "2099-01-01T00:00:00Z"
      }]
    }).level).toBe("interrupt");
  });
});

describe("new canonical event admission", () => {
  it("separates candidate grouping/claim checks from history admission", () => {
    const context = {
      item: item(),
      policy: policy(),
      now,
      feedback: [],
      hasEnrolledDevice: true
    };
    const candidate = evaluateAttentionCandidate(context);
    expect(candidate.level).toBe("interrupt");
    expect(evaluateAttentionAdmission({
      ...context,
      candidate,
      history: [event("recent", 1)]
    }).reasonCode).toBe("cooldown");
    expect(evaluateAttentionCandidate(context)).toEqual(candidate);
  });
  it("counts canonical ordinary events once across devices and local calendar days", () => {
    const one = event("one", 120);
    expect(evaluate({}, { history: [one, one, one] }).level).toBe("interrupt");
    const history = [event("one", 120), event("two", 240), event("three", 360)];
    expect(evaluate({}, { history }).reasonCode).toBe("over_budget");
    expect(evaluate({ category: "fraud" }, { history }).level).toBe("interrupt");
    expect(evaluate({}, {
      history: history.map(entry => ({
        ...entry,
        critical: true
      }))
    }).level).toBe("interrupt");
    expect(evaluate({}, {
      history: [event("yesterday", 840)],
      policy: {
        ...policy(),
        dailyInterruptBudget: 1
      }
    }).level).toBe("interrupt");
    expect(evaluate({}, {
      policy: {
        ...policy(),
        dailyInterruptBudget: 0
      }
    }).reasonCode).toBe("over_budget");
  });
  it("enforces global 90-minute and account-scoped sender cooldown boundaries", () => {
    expect(evaluate({}, { history: [event("one", 89.99)] }).reasonCode).toBe("cooldown");
    expect(evaluate({}, { history: [event("one", 90)] }).level).toBe("interrupt");
    const own = { senderEmail: "SENDER@example.test" };
    expect(evaluate({}, { history: [event("one", 359.99, own)] }).reasonCode).toBe("cooldown");
    expect(evaluate({}, { history: [event("one", 360, own)] }).level).toBe("interrupt");
    expect(evaluate({}, {
      history: [event("one", 100, {
        ...own,
        accountId: "other"
      })]
    }).level).toBe("interrupt");
    expect(evaluate({ category: "fraud" }, { history: [event("one", 19.99, own)] }).reasonCode).toBe("cooldown");
    expect(evaluate({ category: "fraud" }, { history: [event("one", 20, own)] }).level).toBe("interrupt");
  });
  it("limits critical bursts to two canonical events per rolling 15 minutes", () => {
    const history = [event("one", 1, { critical: true }), event("two", 14.99, { critical: true })];
    expect(evaluate({ category: "fraud" }, { history }).reasonCode).toBe("burst");
    expect(evaluate({ category: "fraud" }, { history: [history[0], event("two", 15, { critical: true })] }).level).toBe("interrupt");
    expect(evaluate({ category: "fraud" }, { history: [history[0], history[0]] }).level).toBe("interrupt");
  });
});

describe("timezone scheduling", () => {
  it("uses the local day across UTC midnight", () => {
    expect(localAttentionDay(new Date("2026-09-15T04:59:59Z"), "America/Chicago")).toBe("2026-09-14");
    expect(localAttentionDay(new Date("2026-09-15T05:00:00Z"), "America/Chicago")).toBe("2026-09-15");
  });
  it("skips nonexistent DST times and selects the next repeated time deterministically", () => {
    expect(nextAttentionTime(new Date("2026-03-08T07:00:00Z"), "America/Chicago", ["02:30", "08:30"])).toBe("2026-03-08T13:30:00.000Z");
    expect(nextAttentionTime(new Date("2026-11-01T06:31:00Z"), "America/Chicago", ["01:30"])).toBe("2026-11-01T07:30:00.000Z");
  });
});

describe("pure bounded policy snapshots", () => {
  it("reverts each corrupt field without discarding valid neighboring settings", () => {
    expect(parseNotificationPolicySettings({
      timezone: "Mars/Base",
      digest_times: "[\"25:00\"]",
      quiet_start: "99:99",
      notification_daily_interrupt_budget: "21",
      notification_burst_window_seconds: "-1",
      notification_sender_cooldown_minutes: "19",
      notification_snoozed_until: "\"2099-01-01T00:00:00Z\"",
      notification_calm_checkin_enabled: "\"true\"",
      notification_calm_checkin_time: "25:00",
      notification_category_preferences: "{\"security\":\"loud\"}",
      quiet_end: "08:15",
    }, now)).toMatchObject({
      timezone: "America/Chicago",
      digestTimes: ["08:30", "16:30"],
      quietStart: "22:00",
      quietEnd: "08:15",
      dailyInterruptBudget: 3,
      burstWindowSeconds: 60,
      senderCooldownMinutes: 360,
      snoozedUntil: null,
      calmCheckinEnabled: false,
      calmCheckinTime: "12:30",
    });
    expect(parseNotificationPolicySettings({
      timezone: "x".repeat(4097),
      digest_times: null
    }, now)).toMatchObject({
      timezone: "America/Chicago",
      digestTimes: ["08:30", "16:30"]
    });
  });
  it("does not silently erase valid quiet policy when another preference is corrupt", () => {
    const parsed = parseNotificationPolicySettings({ notification_category_preferences: '{"security":"quiet","jobs":"invalid"}' }, now);
    expect(evaluate({ category: "fraud" }, { policy: parsed }).level).toBe("in_app");
  });
  it("keeps an all-quiet digest schedule in-app instead of inventing a delivery slot", () => {
    expect(evaluate({ attention: "digest" }, {
      policy: {
        ...policy(),
        digestTimes: ["23:00"]
      }
    }).level).toBe("in_app");
  });
});

it("counts either prior class for the general and sender cooldowns", () => {
  expect(evaluate({}, { history: [event("critical", 1, { critical: true })] }).reasonCode).toBe("cooldown");
  expect(evaluate({}, {
    history: [event("critical", 100, {
      critical: true,
      senderEmail: "sender@example.test"
    })]
  }).reasonCode).toBe("cooldown");
  expect(evaluate({ category: "fraud" }, { history: [event("ordinary", 19, { senderEmail: "sender@example.test" })] }).reasonCode).toBe("cooldown");
});


it("rejects impossible calendar timestamps instead of normalizing them into fresh mail", () => {
  expect(evaluate({ receivedAt: "2026-02-30T18:00:00Z" }, { now: new Date("2026-03-03T18:00:00Z") }).level).toBe("in_app");
});

it("retains concrete ISO date-only deadlines within the next 24 hours", () => {
  expect(evaluate({ urgency: 89, deadline: "2026-09-15" }).level).toBe("interrupt");
});


it.each([
  { category: "legal notice", preference: "quiet", level: "in_app" },
  { category: "account_security", preference: "quiet", level: "in_app" },
  { category: "legal notice", preference: "digest", level: "brief" },
  { category: "account_security", preference: "digest", level: "brief" },
])("preserves explicit security $preference for $category without granting critical bypass", ({ category, preference, level }) => {
  const configured = parseNotificationPolicySettings({
    notification_category_preferences: JSON.stringify({ security: preference }),
  }, now);
  const result = evaluate({ category }, { policy: configured });
  expect(result.level).toBe(level);
  expect(result.critical).toBe(false);
  expect(result.ruleTrace).not.toContain("critical_quiet_bypass");
  const quietResult = evaluate({ category }, {
    now: new Date("2026-09-15T03:00:00.000Z"),
  });
  expect(quietResult.level).toBe("brief");
  expect(quietResult.critical).toBe(false);
  expect(quietResult.ruleTrace).not.toContain("critical_quiet_bypass");
});
