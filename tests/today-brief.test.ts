import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sourceMocks = vi.hoisted(() => ({
  getMailTodaySnapshot: vi.fn(),
  getCalendarPage: vi.fn(),
  getActionCenter: vi.fn(),
  getActivityTimeline: vi.fn(),
  getAccountFreshness: vi.fn(),
  readSentEvidence: vi.fn(),
  providerAdapterFor: vi.fn(),
}));

vi.mock("@/lib/email/professional", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/email/professional")>(),
  getMailTodaySnapshot: sourceMocks.getMailTodaySnapshot,
}));
vi.mock("@/lib/email/calendar", () => ({
  getCalendarPage: sourceMocks.getCalendarPage,
}));
vi.mock("@/lib/email/action-center", () => ({
  getActionCenter: sourceMocks.getActionCenter,
}));
vi.mock("@/lib/email/activity", () => ({
  getActivityTimeline: sourceMocks.getActivityTimeline,
}));
vi.mock("@/lib/email/account-health", () => ({
  getAccountFreshness: sourceMocks.getAccountFreshness,
}));
vi.mock("@/lib/email/provider-adapter", () => ({
  providerAdapterFor: sourceMocks.providerAdapterFor,
}));

import { updateBriefItemMemory } from "@/lib/email/brief-memory";
import { configureEmailDatabaseForTests, execute, setSetting } from "@/lib/email/database";
import { getTodayBrief, getLocalTodayBrief } from "@/lib/email/today-brief";
import type { AccountFreshnessItem } from "@/lib/email/types";

const NOW = "2026-08-30T15:00:00.000Z";
const GMAIL_WORKSPACE = "workspace:account:gmail:gmail-1";

describe("Living Daily Brief composition", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    configureEmailDatabaseForTests(`file:./today-brief-${randomUUID()}.sqlite`);
    await seedAccount("gmail-1", "gmail", "owner@gmail.test", "Gmail One");
    sourceMocks.getMailTodaySnapshot.mockReset().mockResolvedValue(mailSnapshot());
    sourceMocks.getCalendarPage.mockReset().mockResolvedValue(calendarPage());
    sourceMocks.getActionCenter.mockReset().mockResolvedValue(actionCenter());
    sourceMocks.getActivityTimeline.mockReset().mockResolvedValue(activityPage());
    sourceMocks.getAccountFreshness.mockReset().mockResolvedValue(freshnessPage());
    sourceMocks.readSentEvidence.mockReset().mockResolvedValue({ items: [], truncated: false });
    sourceMocks.providerAdapterFor.mockReset().mockImplementation(() => ({
      readSentEvidence: sourceMocks.readSentEvidence,
    }));
  });

  it("supplies the additive morning view, timezone and scoped attention metadata", async () => {
    const brief = await getTodayBrief({workspaceId:GMAIL_WORKSPACE});
    expect(brief.timezone).toBe("America/Chicago");
    expect(brief.morningBrief).toMatchObject({day:"2026-08-30",checkedAt:NOW});
    expect(brief.attentionMetadata).toEqual(expect.any(Object));
    expect(sourceMocks.getMailTodaySnapshot).toHaveBeenCalledTimes(1);
    expect(sourceMocks.readSentEvidence).toHaveBeenCalledTimes(1);
  });

  it("shows all-day and timed commitments without converting all-day dates into a clock time", async () => {
    const page = calendarPage();
    sourceMocks.getCalendarPage.mockResolvedValue({...page,events:[{...page.events[0],isAllDay:true,dateRange:{startDate:"2026-08-30",endDate:"2026-08-31"}}]});
    expect((await getLocalTodayBrief({workspaceId:GMAIL_WORKSPACE,now:NOW})).agenda[0].summary).toContain("All day");
    sourceMocks.getCalendarPage.mockResolvedValue(page);
    expect((await getLocalTodayBrief({workspaceId:GMAIL_WORKSPACE,now:NOW})).agenda[0].summary).toMatch(/AM|PM/);
  });

  it("composes stored reply evidence without reading any provider", async () => {
    const brief = await getLocalTodayBrief({ workspaceId: GMAIL_WORKSPACE, now: NOW });
    expect(brief.needsAttention.some(item => item.sourceKey === "mail:gmail-1:thread-reply")).toBe(true);
    expect(sourceMocks.providerAdapterFor).not.toHaveBeenCalled();
    expect(sourceMocks.readSentEvidence).not.toHaveBeenCalled();
    expect(sourceMocks.getCalendarPage).toHaveBeenCalledWith(expect.objectContaining({sync:false}));
    expect(brief.sourceStatus.some(item => item.source === "sent" && item.status === "current")).toBe(false);
  });

  it("settles every scoped source, reads Calendar without syncing, and preserves exact targets", async () => {
    const brief = await getTodayBrief({ workspaceId: GMAIL_WORKSPACE });

    expect(sourceMocks.getMailTodaySnapshot).toHaveBeenCalledWith({
      workspaceId: GMAIL_WORKSPACE,
      timezone: "America/Chicago",
      now: NOW,
    });
    expect(sourceMocks.getCalendarPage).toHaveBeenCalledWith({
      workspaceId: GMAIL_WORKSPACE,
      from: "2026-08-30T05:00:00.000Z",
      to: "2026-08-31T05:00:00.000Z",
      sync: false,
    });
    expect(sourceMocks.getActionCenter).toHaveBeenCalledWith({ workspaceId: GMAIL_WORKSPACE, includeCleanup: false });
    expect(sourceMocks.getActivityTimeline).toHaveBeenCalledWith({ workspaceId: GMAIL_WORKSPACE, limit: 40 });
    expect(sourceMocks.getAccountFreshness).toHaveBeenCalledTimes(1);
    expect(sourceMocks.readSentEvidence).toHaveBeenCalledTimes(1);
    expect(brief).toMatchObject({
      workspaceId: GMAIL_WORKSPACE,
      topics: expect.any(Array),
      mailActivity: expect.any(Object),
      counts: expect.any(Object),
    });
    expect(brief.agenda).toEqual([
      expect.objectContaining({
        sourceKey: "calendar:gmail-1:provider-event-1",
        sourceType: "calendar_event",
        target: { view: "calendar", eventId: "event-1", date: "2026-08-30" },
      }),
    ]);
    expect(brief.needsAttention).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKey: "mail:gmail-1:thread-reply", target: { view: "mail", messageId: "mail-reply" } }),
      expect.objectContaining({ sourceKey: "mail:gmail-1:thread-action", target: { view: "mail", messageId: "mail-action" } }),
      expect.objectContaining({ sourceKey: "action:approval-1", sourceType: "action_center", target: { view: "drafts", draftId: "draft-1", messageId: "mail-reply" } }),
    ]));
    expect(brief.sourceStatus).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "mail", status: "current" }),
      expect.objectContaining({ source: "calendar", status: "current" }),
      expect.objectContaining({ source: "action_center", status: "current" }),
      expect.objectContaining({ source: "activity", status: "current" }),
      expect.objectContaining({ source: "freshness", status: "current" }),
      expect.objectContaining({ source: "sent", status: "current", accountId: "gmail-1" }),
    ]));
  });

  it("defensively isolates account workspaces and includes every eligible account in All accounts", async () => {
    await seedAccount("gmail-2", "gmail", "second@gmail.test", "Gmail Two");
    await seedAccount("ms-1", "microsoft", "owner@hotmail.test", "Hotmail");
    sourceMocks.getMailTodaySnapshot.mockResolvedValue(mailSnapshot({ includeSecondAccount: true }));
    sourceMocks.getCalendarPage.mockResolvedValue(calendarPage({ includeSecondAccount: true }));
    sourceMocks.getActionCenter.mockResolvedValue(actionCenter({ includeSecondAccount: true }));
    sourceMocks.getAccountFreshness.mockResolvedValue(freshnessPage({ includeSecondAccount: true }));

    const gmailOne = await getTodayBrief({ workspaceId: GMAIL_WORKSPACE });

    expect(gmailOne.agenda.map((item) => item.sourceAccountId)).toEqual(["gmail-1"]);
    expect(gmailOne.needsAttention.map((item) => item.sourceAccountId)).not.toContain("gmail-2");
    expect(gmailOne.needsAttention.map((item) => item.sourceKey)).not.toContain("action:global-repair");
    expect(gmailOne.sourceStatus).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "freshness", status: "current" }),
    ]));

    const all = await getTodayBrief({ workspaceId: "workspace:all" });
    expect(all.agenda.map((item) => item.sourceAccountId).sort()).toEqual(["gmail-1", "gmail-2"]);
    expect(all.needsAttention.map((item) => item.sourceAccountId)).toContain("gmail-2");
    expect(all.needsAttention.map((item) => item.sourceKey)).toContain("action:global-repair");
    expect(sourceMocks.getCalendarPage).toHaveBeenLastCalledWith({
      workspaceId: "workspace:all",
      from: "2026-08-30T05:00:00.000Z",
      to: "2026-08-31T05:00:00.000Z",
      sync: false,
    });
  });

  it.each([
    ["overnight", "2026-08-30T04:00:00.000Z", "2026-08-30T06:00:00.000Z", true],
    ["multi-day", "2026-08-28T14:00:00.000Z", "2026-09-01T14:00:00.000Z", true],
    ["ends at day start", "2026-08-29T14:00:00.000Z", "2026-08-30T05:00:00.000Z", false],
    ["starts at day end", "2026-08-31T05:00:00.000Z", "2026-08-31T06:00:00.000Z", false],
  ])("includes timed agenda by strict overlap: %s", async (_name, startsAt, endsAt, included) => {
    const page = calendarPage();
    page.events[0] = { ...page.events[0], startsAt, endsAt };
    sourceMocks.getCalendarPage.mockResolvedValue(page);
    const brief = await getTodayBrief({ workspaceId: GMAIL_WORKSPACE });
    expect(brief.agenda).toHaveLength(included ? 1 : 0);
    if (included) expect(brief.agenda[0].target).toEqual({ view: "calendar", eventId: "event-1", date: "2026-08-30" });
  });

  it.each([
    ["2026-08-30", "2026-08-31", true],
    ["2026-08-28", "2026-08-31", true],
    ["2026-08-28", "2026-08-30", false],
  ])("keeps all-day provider dates %s through exclusive %s on the brief day", async (startDate, endDate, included) => {
    const page = calendarPage();
    sourceMocks.getCalendarPage.mockResolvedValue({ ...page, events: [{ ...page.events[0], isAllDay: true, startsAt: `${startDate}T00:00:00.000Z`, endsAt: `${endDate}T00:00:00.000Z`, dateRange: { startDate, endDate } }] });
    const brief = await getTodayBrief({ workspaceId: GMAIL_WORKSPACE });
    expect(brief.agenda).toHaveLength(included ? 1 : 0);
    if (included) expect(brief.agenda[0].target).toEqual({ view: "calendar", eventId: "event-1", date: "2026-08-30" });
  });

  it.each([
    ["2026-03-08T16:00:00.000Z", "2026-03-08T06:00:00.000Z", "2026-03-09T05:00:00.000Z"],
    ["2026-11-01T16:00:00.000Z", "2026-11-01T05:00:00.000Z", "2026-11-02T06:00:00.000Z"],
  ])("reads the exact DST-aware local day at %s without syncing", async (now, from, to) => {
    vi.setSystemTime(new Date(now));
    await getTodayBrief({ workspaceId: GMAIL_WORKSPACE });
    expect(sourceMocks.getCalendarPage).toHaveBeenCalledWith({ workspaceId: GMAIL_WORKSPACE, from, to, sync: false });
  });

  it("orders complete, bring back, then dismiss by the current dismissal time", async () => {
    const first = await getTodayBrief({ workspaceId: GMAIL_WORKSPACE });
    const [older, newer] = first.needsAttention;
    await updateBriefItemMemory({ workspaceId: GMAIL_WORKSPACE, itemId: older.id, action: "complete", now: "2026-08-30T15:01:00.000Z" });
    await updateBriefItemMemory({ workspaceId: GMAIL_WORKSPACE, itemId: newer.id, action: "complete", now: "2026-08-30T15:02:00.000Z" });
    await updateBriefItemMemory({ workspaceId: GMAIL_WORKSPACE, itemId: older.id, action: "bring_back", now: "2026-08-30T15:03:00.000Z" });
    await updateBriefItemMemory({ workspaceId: GMAIL_WORKSPACE, itemId: older.id, action: "dismiss", now: "2026-08-30T15:04:00.000Z" });
    vi.setSystemTime(new Date("2026-08-30T15:05:00.000Z"));
    const next = await getTodayBrief({ workspaceId: GMAIL_WORKSPACE });
    expect(next.completedSinceLastBrief.map((item) => item.id)).toEqual([older.id, newer.id]);
    expect(next.completedSinceLastBrief[0]).toMatchObject({ state: "dismissed", completedAt: "2026-08-30T15:01:00.000Z", dismissedAt: "2026-08-30T15:04:00.000Z", restoredAt: "2026-08-30T15:03:00.000Z" });
  });

  it("uses one configured non-Chicago local day for Calendar and composition", async () => {
    vi.setSystemTime(new Date("2026-08-30T06:30:00.000Z"));
    await setSetting("timezone", "America/Los_Angeles");
    sourceMocks.getMailTodaySnapshot.mockResolvedValue(mailSnapshot({ date: "2026-08-29" }));
    sourceMocks.getCalendarPage.mockResolvedValue({
      ...calendarPage({ date: "2026-08-29" }),
      range: {
        from: "2026-08-29T07:00:00.000Z",
        to: "2026-08-30T07:00:00.000Z",
        timezone: "America/Los_Angeles",
      },
    });

    const brief = await getTodayBrief({ workspaceId: GMAIL_WORKSPACE });

    expect(brief.date).toBe("2026-08-29");
    expect(sourceMocks.getMailTodaySnapshot).toHaveBeenCalledWith({
      workspaceId: GMAIL_WORKSPACE,
      timezone: "America/Los_Angeles",
      now: "2026-08-30T06:30:00.000Z",
    });
    expect(sourceMocks.getCalendarPage).toHaveBeenCalledWith({
      workspaceId: GMAIL_WORKSPACE,
      from: "2026-08-29T07:00:00.000Z",
      to: "2026-08-30T07:00:00.000Z",
      sync: false,
    });
    expect(brief.agenda).toEqual([
      expect.objectContaining({
        sourceKey: "calendar:gmail-1:provider-event-1",
        target: { view: "calendar", eventId: "event-1", date: "2026-08-29" },
      }),
    ]);
  });

  it("does not query or complete Sent evidence for an account whose inbound mail is stale", async () => {
    sourceMocks.getAccountFreshness.mockResolvedValue(freshnessPage({ stale: true }));
    sourceMocks.readSentEvidence.mockResolvedValue({
      items: [{
        accountId: "gmail-1",
        provider: "gmail",
        providerMessageId: "sent-stale",
        providerThreadId: "thread-reply",
        sentAt: "2026-08-30T14:30:00.000Z",
      }],
      truncated: false,
    });

    const brief = await getTodayBrief({ workspaceId: GMAIL_WORKSPACE });

    expect(sourceMocks.providerAdapterFor).not.toHaveBeenCalled();
    expect(sourceMocks.readSentEvidence).not.toHaveBeenCalled();
    expect(brief.needsAttention).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKey: "mail:gmail-1:thread-reply", state: "open" }),
    ]));
    expect(brief.completedSinceLastBrief.map((item) => item.sourceKey)).not.toContain("mail:gmail-1:thread-reply");
    expect(brief.sourceStatus).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "sent", accountId: "gmail-1", status: "stale" }),
    ]));
  });

  it("does not query Sent evidence when inbound mail is errored or unavailable", async () => {
    sourceMocks.getAccountFreshness.mockResolvedValue({
      ...freshnessPage(),
      items: [{
        ...freshnessItem("gmail-1", "gmail", "2026-08-30T14:59:00.000Z"),
        status: "error" as const,
        reconnectRecommended: true,
        lastError: "Inbound mail needs attention",
      }],
    });

    const errored = await getTodayBrief({ workspaceId: GMAIL_WORKSPACE });

    expect(sourceMocks.providerAdapterFor).not.toHaveBeenCalled();
    expect(sourceMocks.readSentEvidence).not.toHaveBeenCalled();
    expect(errored.sourceStatus).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "sent", accountId: "gmail-1", status: "error" }),
    ]));

    sourceMocks.getAccountFreshness.mockResolvedValue({ ...freshnessPage(), items: [] });

    const unavailable = await getTodayBrief({ workspaceId: GMAIL_WORKSPACE });

    expect(sourceMocks.providerAdapterFor).not.toHaveBeenCalled();
    expect(sourceMocks.readSentEvidence).not.toHaveBeenCalled();
    expect(unavailable.sourceStatus).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "sent", accountId: "gmail-1", status: "unavailable" }),
    ]));
  });

  it("keeps healthy Mail and Sent current when only Calendar needs reconnecting", async () => {
    sourceMocks.getAccountFreshness.mockResolvedValue({
      ...freshnessPage(),
      items: [{
        ...freshnessItem("gmail-1", "gmail", "2026-08-30T14:59:00.000Z"),
        reconnectRecommended: true,
        lastError: "Calendar permission expired",
        recoveryMessage: "Reconnect Calendar",
        issues: [
          {
            feature: "mail" as const,
            status: "ok" as const,
            message: null,
            reconnectRecommended: false,
            lastSuccessAt: "2026-08-30T14:59:00.000Z",
          },
          {
            feature: "calendar" as const,
            status: "error" as const,
            message: "Calendar permission expired",
            reconnectRecommended: true,
            lastSuccessAt: null,
          },
        ],
      }],
    });

    const brief = await getTodayBrief({ workspaceId: GMAIL_WORKSPACE });

    expect(sourceMocks.providerAdapterFor).toHaveBeenCalledTimes(1);
    expect(sourceMocks.readSentEvidence).toHaveBeenCalledTimes(1);
    expect(brief.sourceStatus).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "mail", status: "current" }),
      expect.objectContaining({ source: "sent", accountId: "gmail-1", status: "current" }),
    ]));
  });

  it("does not let a global last-poll error override healthy scoped Mail evidence", async () => {
    const snapshot = mailSnapshot();
    sourceMocks.getMailTodaySnapshot.mockResolvedValue({
      ...snapshot,
      mailActivity: {
        ...snapshot.mailActivity,
        lastPollError: "A different account failed its previous poll",
      },
    });

    const brief = await getTodayBrief({ workspaceId: GMAIL_WORKSPACE });

    expect(sourceMocks.providerAdapterFor).toHaveBeenCalledTimes(1);
    expect(sourceMocks.readSentEvidence).toHaveBeenCalledTimes(1);
    expect(brief.sourceStatus).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "mail", status: "current" }),
      expect.objectContaining({ source: "sent", accountId: "gmail-1", status: "current" }),
    ]));
  });

  it("keeps healthy sections when a source fails and reports stale, unavailable, and truncated evidence honestly", async () => {
    sourceMocks.getCalendarPage.mockRejectedValue(new Error("raw calendar credential detail"));
    sourceMocks.getActionCenter.mockRejectedValue(new Error("raw action database detail"));
    sourceMocks.readSentEvidence.mockResolvedValue({ items: [], truncated: true });

    const brief = await getTodayBrief({ workspaceId: GMAIL_WORKSPACE });

    expect(brief.topics).toHaveLength(2);
    expect(brief.needsAttention.map((item) => item.sourceKey)).toEqual(expect.arrayContaining([
      "mail:gmail-1:thread-reply",
      "mail:gmail-1:thread-action",
    ]));
    expect(brief.agenda).toEqual([]);
    expect(brief.sourceStatus).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "calendar", status: "error" }),
      expect.objectContaining({ source: "action_center", status: "error" }),
      expect.objectContaining({ source: "freshness", status: "current" }),
      expect.objectContaining({ source: "sent", status: "truncated", accountId: "gmail-1" }),
    ]));
    expect(JSON.stringify(brief.sourceStatus)).not.toContain("raw calendar credential detail");
    expect(JSON.stringify(brief.sourceStatus)).not.toContain("raw action database detail");
  });

  it("distinguishes stale cached mail and Calendar from unavailable account source data", async () => {
    sourceMocks.getAccountFreshness.mockResolvedValue(freshnessPage({ stale: true }));
    sourceMocks.getCalendarPage.mockResolvedValue(calendarPage({ stale: true }));

    const stale = await getTodayBrief({ workspaceId: GMAIL_WORKSPACE });
    expect(stale.sourceStatus).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "mail", status: "stale" }),
      expect.objectContaining({ source: "calendar", status: "stale" }),
      expect.objectContaining({ source: "freshness", status: "stale" }),
    ]));

    sourceMocks.getCalendarPage.mockResolvedValue({
      ...calendarPage(),
      events: [],
      accounts: [],
    });
    sourceMocks.getAccountFreshness.mockResolvedValue({ ...freshnessPage(), items: [] });
    const unavailable = await getTodayBrief({ workspaceId: GMAIL_WORKSPACE });
    expect(unavailable.sourceStatus).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "mail", status: "unavailable" }),
      expect.objectContaining({ source: "calendar", status: "unavailable" }),
      expect.objectContaining({ source: "freshness", status: "unavailable" }),
    ]));
  });

  it("shows current-day local completions, carries older open items, and reopens a later mail revision", async () => {
    const first = await getTodayBrief({ workspaceId: GMAIL_WORKSPACE });
    const reply = first.needsAttention.find((item) => item.sourceKey === "mail:gmail-1:thread-reply");
    const approval = first.needsAttention.find((item) => item.sourceKey === "action:approval-1");
    expect(reply).toBeDefined();
    expect(approval).toBeDefined();
    await updateBriefItemMemory({ workspaceId: GMAIL_WORKSPACE, itemId: reply!.id, action: "complete", now: "2026-08-30T15:05:00.000Z" });
    await updateBriefItemMemory({ workspaceId: GMAIL_WORKSPACE, itemId: approval!.id, action: "dismiss", now: "2026-08-30T15:06:00.000Z" });

    const sameDay = await getTodayBrief({ workspaceId: GMAIL_WORKSPACE });
    expect(sameDay.completedSinceLastBrief).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKey: "mail:gmail-1:thread-reply", state: "completed" }),
      expect.objectContaining({ sourceKey: "action:approval-1", state: "dismissed" }),
    ]));

    vi.setSystemTime(new Date("2026-08-31T15:00:00.000Z"));
    sourceMocks.getMailTodaySnapshot.mockResolvedValue(mailSnapshot({ date: "2026-08-31" }));
    sourceMocks.getCalendarPage.mockResolvedValue(calendarPage({ date: "2026-08-31" }));
    const nextDay = await getTodayBrief({ workspaceId: GMAIL_WORKSPACE });
    expect(nextDay.completedSinceLastBrief).toEqual([]);
    expect(nextDay.carryovers).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKey: "mail:gmail-1:thread-action", state: "open" }),
    ]));
    expect(nextDay.needsAttention.map((item) => item.sourceKey)).not.toContain("mail:gmail-1:thread-action");

    sourceMocks.getMailTodaySnapshot.mockResolvedValue(mailSnapshot({
      date: "2026-08-31",
      replyRevisionAt: "2026-08-31T14:00:00.000Z",
      replyTitle: "Quarterly review changed",
    }));
    const reopened = await getTodayBrief({ workspaceId: GMAIL_WORKSPACE });
    expect(reopened.needsAttention).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceKey: "mail:gmail-1:thread-reply",
        state: "open",
        title: "Quarterly review changed",
      }),
    ]));
    expect(reopened.completedSinceLastBrief.map((item) => item.sourceKey)).not.toContain("mail:gmail-1:thread-reply");
  });

  it("persists candidates before one Sent read and returns exact external completion in the same response", async () => {
    sourceMocks.readSentEvidence.mockResolvedValue({
      items: [{
        accountId: "gmail-1",
        provider: "gmail",
        providerMessageId: "sent-1",
        providerThreadId: "thread-reply",
        sentAt: "2026-08-30T14:30:00.000Z",
      }],
      truncated: false,
    });

    const brief = await getTodayBrief({ workspaceId: GMAIL_WORKSPACE });
    const evidence = await execute("SELECT source_key, account_id, provider_message_id FROM reply_completion_evidence");

    expect(sourceMocks.readSentEvidence).toHaveBeenCalledTimes(1);
    expect(brief.needsAttention.map((item) => item.sourceKey)).not.toContain("mail:gmail-1:thread-reply");
    expect(brief.completedSinceLastBrief).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKey: "mail:gmail-1:thread-reply", state: "completed", completedAt: "2026-08-30T14:30:00.000Z" }),
    ]));
    expect(evidence.rows).toEqual([
      expect.objectContaining({ source_key: "mail:gmail-1:thread-reply", account_id: "gmail-1", provider_message_id: "sent-1" }),
    ]);
  });
});

function mailSnapshot(input: {
  date?: string;
  includeSecondAccount?: boolean;
  replyRevisionAt?: string;
  replyTitle?: string;
} = {}) {
  const date = input.date || "2026-08-30";
  const replyRevisionAt = input.replyRevisionAt || "2026-08-30T14:00:00.000Z";
  const replyTitle = input.replyTitle || "Quarterly review";
  const reply = mailCandidate({
    accountId: "gmail-1",
    threadId: "thread-reply",
    messageId: "mail-reply",
    revisionAt: replyRevisionAt,
    title: replyTitle,
  });
  const action = mailCandidate({
    accountId: "gmail-1",
    threadId: "thread-action",
    messageId: "mail-action",
    revisionAt: "2026-08-30T13:00:00.000Z",
    title: "Security review",
  });
  const second = mailCandidate({
    accountId: "gmail-2",
    threadId: "thread-second",
    messageId: "mail-second",
    revisionAt: "2026-08-30T13:30:00.000Z",
    title: "Second account item",
    provider: "gmail",
  });
  const briefCandidates = [reply, action, ...(input.includeSecondAccount ? [second] : [])];
  return {
    id: `mail-${date}`,
    date,
    generatedAt: `${date}T15:00:00.000Z`,
    quietReviewed: 1,
    mailActivity: {
      receivedToday: 2,
      handledToday: 2,
      unhandledToday: 0,
      attentionCounts: { interrupt: 1, digest: 1, suppress: 0, unknown: 0 },
      stillNeedsAttention: 2,
      categoryCounts: [{ category: "project", count: 2 }],
      lastPollAt: `${date}T14:59:00.000Z`,
      lastPollError: null,
    },
    topics: [
      { id: "mail-reply", kind: "reply", title: replyTitle, summary: "Reply requested", senderName: "Avery", accountLabel: "Gmail One", receivedAt: replyRevisionAt, deadline: null, urgency: 80, threadCount: 1 },
      { id: "mail-action", kind: "action", title: "Security review", summary: "Review this alert", senderName: "Security", accountLabel: "Gmail One", receivedAt: "2026-08-30T13:00:00.000Z", deadline: null, urgency: 90, threadCount: 1 },
    ],
    cleanup: [],
    oneMoreGlance: [],
    history: { generatedAt: `${date}T15:00:00.000Z`, sections: [] },
    counts: { action: 1, reply: 1, deadline: 0, fyi: 0 },
    briefCandidates,
    replyCandidates: [reply],
  };
}

function mailCandidate(input: {
  accountId: string;
  threadId: string;
  messageId: string;
  revisionAt: string;
  title: string;
  provider?: "gmail" | "microsoft";
}) {
  return {
    sourceType: "mail_thread" as const,
    sourceKey: `mail:${input.accountId}:${input.threadId}`,
    sourceAccountId: input.accountId,
    provider: input.provider || "gmail" as const,
    providerThreadId: input.threadId,
    revisionAt: input.revisionAt,
    occurredAt: input.revisionAt,
    role: "attention" as const,
    title: input.title,
    summary: input.title,
    target: { view: "mail" as const, messageId: input.messageId },
  };
}

function calendarPage(input: { includeSecondAccount?: boolean; date?: string; stale?: boolean } = {}) {
  const date = input.date || "2026-08-30";
  const events = [calendarEvent("event-1", "provider-event-1", "gmail-1", "Gmail One", `${date}T16:00:00.000Z`)];
  const accounts = [calendarAccount(
    "gmail-1",
    "Gmail One",
    "owner@gmail.test",
    "gmail",
    input.stale ? "2026-08-30T12:00:00.000Z" : NOW,
  )];
  if (input.includeSecondAccount) {
    events.push(calendarEvent("event-2", "provider-event-2", "gmail-2", "Gmail Two", `${date}T18:00:00.000Z`));
    accounts.push(calendarAccount("gmail-2", "Gmail Two", "second@gmail.test", "gmail"));
  }
  return {
    events,
    drafts: [],
    accounts,
    range: { from: `${date}T00:00:00.000Z`, to: `${date}T23:59:59.999Z`, timezone: "America/Chicago" },
  };
}

function calendarEvent(id: string, externalEventId: string, accountId: string, accountLabel: string, startsAt: string) {
  return {
    id,
    accountId,
    accountLabel,
    accountProvider: "gmail" as const,
    externalEventId,
    calendarId: "primary",
    calendarName: "Primary",
    title: `${accountLabel} planning`,
    description: null,
    location: null,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 60 * 60_000).toISOString(),
    isAllDay: false,
    timezone: "America/Chicago",
    status: "confirmed",
    visibility: null,
    isBusy: true,
    organizerName: null,
    organizerEmail: null,
    attendees: [],
    webLink: null,
    updatedAt: startsAt,
    syncedAt: NOW,
  };
}

function calendarAccount(
  accountId: string,
  accountLabel: string,
  accountEmail: string,
  provider: "gmail" | "microsoft",
  lastSyncAt = NOW,
) {
  return {
    accountId,
    accountLabel,
    accountEmail,
    provider,
    status: "connected" as const,
    calendarStatus: "connected" as const,
    calendarAccess: "write" as const,
    lastSyncAt,
    lastError: null,
  };
}

function actionCenter(input: { includeSecondAccount?: boolean } = {}) {
  const approvals = [actionItem("approval-1", "gmail-1", "gmail", { view: "drafts", draftId: "draft-1", messageId: "mail-reply" })];
  if (input.includeSecondAccount) approvals.push(actionItem("approval-2", "gmail-2", "gmail", { view: "outbox", draftId: "draft-2" }));
  const repairs = [actionItem("global-repair", null, undefined, { view: "settings" })];
  return {
    generatedAt: NOW,
    counts: { approvals: approvals.length, cleanup: 0, repairs: repairs.length, total: approvals.length + repairs.length },
    sections: [
      { id: "approvals" as const, title: "Needs approval", description: "", count: approvals.length, items: approvals },
      { id: "cleanup" as const, title: "Cleanup", description: "", count: 0, items: [] },
      { id: "repairs" as const, title: "Needs repair", description: "", count: repairs.length, items: repairs },
    ],
  };
}

function actionItem(
  id: string,
  accountId: string | null,
  accountProvider: "gmail" | "microsoft" | undefined,
  target: Record<string, string>,
) {
  return {
    id,
    type: "reply_draft" as const,
    priority: "approval" as const,
    accountId,
    accountLabel: accountId,
    accountProvider,
    title: `Action ${id}`,
    subtitle: "Action subtitle",
    detail: "Action detail",
    updatedAt: "2026-08-30T14:10:00.000Z",
    status: "draft",
    count: 1,
    target,
  };
}

function activityPage() {
  return {
    generatedAt: NOW,
    filters: { workspaceId: GMAIL_WORKSPACE, q: "", kind: "all", accountId: "", provider: "gmail", from: null, to: null, limit: 40 },
    counts: { total: 1, shown: 1, errors: 0, warnings: 0, byKind: [{ kind: "mail_sync", count: 1 }] },
    accounts: [{ id: "gmail-1", label: "Gmail One", email: "owner@gmail.test", provider: "gmail" }],
    items: [],
  };
}

function freshnessPage(input: { includeSecondAccount?: boolean; stale?: boolean } = {}) {
  const items: AccountFreshnessItem[] = [
    freshnessItem("gmail-1", "gmail", input.stale ? "2026-08-30T12:00:00.000Z" : "2026-08-30T14:59:00.000Z"),
  ];
  if (input.includeSecondAccount) {
    items.push({
      ...freshnessItem("gmail-2", "gmail", "2026-08-30T14:59:00.000Z"),
      status: "error" as const,
      reconnectRecommended: true,
      lastError: "Sibling account must not affect this account workspace",
    });
  }
  return { generatedAt: NOW, pollIntervalMinutes: 5, manualSyncCooldownSeconds: 60, items };
}

function freshnessItem(
  accountId: string,
  accountProvider: "gmail" | "microsoft",
  lastSuccessfulPollAt: string,
): AccountFreshnessItem {
  return {
    accountId,
    accountLabel: accountId,
    accountEmail: `${accountId}@example.test`,
    accountProvider,
    purposeLabel: "Purpose",
    syncRangeDays: 2,
    status: "connected" as const,
    lastSuccessfulPollAt,
    lastProviderActionAt: null,
    lastError: null,
    nextExpectedCheckAt: new Date(Date.parse(lastSuccessfulPollAt) + 5 * 60_000).toISOString(),
    manualSyncAvailableAt: null,
    canSyncNow: true,
    reconnectRecommended: false,
    recoveryMessage: null,
    issues: [],
  };
}

async function seedAccount(
  id: string,
  provider: "gmail" | "microsoft",
  email: string,
  label: string,
) {
  await execute(
    `INSERT INTO email_accounts
      (id, provider, email, label, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'connected', ?, ?)`,
    [id, provider, email, label, NOW, NOW],
  );
}
