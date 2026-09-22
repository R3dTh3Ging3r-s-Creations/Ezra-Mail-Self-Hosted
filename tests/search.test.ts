import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  configureEmailDatabaseForTests,
  execute,
  nowIso,
  saveTriageDecision,
} from "@/lib/email/database";
import {
  getNaturalLanguageSearchPage,
  interpretNaturalLanguageSearch,
  runNaturalLanguageSearchAction,
} from "@/lib/email/search";
import type { AttentionLevel } from "@/lib/email/types";

describe("natural-language mail search", () => {
  beforeEach(() => {
    configureEmailDatabaseForTests(`file:./natural-search-${randomUUID()}.sqlite`);
  });

  it("interprets unhandled job mail as active local Gmail search", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    await seedMessage({
      id: "job-active",
      accountId: "acct-gmail",
      senderName: "Target Recruiter",
      senderEmail: "target@example.test",
      subject: "Interview request",
      category: "job application",
      attention: "interrupt",
      needsReply: true,
      labels: ["INBOX", "UNREAD"],
    });
    await seedMessage({
      id: "job-handled",
      accountId: "acct-gmail",
      senderName: "Old Recruiter",
      senderEmail: "old@example.test",
      subject: "Handled application update",
      category: "job application",
      attention: "interrupt",
      isUnread: false,
      status: "read",
      labels: ["INBOX"],
    });

    const page = await getNaturalLanguageSearchPage({
      query: "show job emails I have not handled",
      workspaceId: "workspace:gmail",
      limit: 10,
    });

    expect(page.interpretation).toMatchObject({
      workspaceId: "workspace:gmail",
      filters: {
        folder: "inbox",
        handled: "active",
      },
      providerSearch: { requested: false, readOnly: true },
    });
    expect(page.interpretation.filters.categories).toContain("job application");
    expect(page.results.items.map((item) => item.id)).toEqual(["job-active"]);
  });

  it("answers what Ezra quieted today without requiring provider search", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    await seedMessage({
      id: "quiet-today",
      accountId: "acct-gmail",
      senderName: "Offers",
      senderEmail: "offers@example.test",
      subject: "Summer sale",
      category: "marketing/promotional",
      attention: "suppress",
      labels: ["INBOX", "UNREAD"],
    });
    await seedMessage({
      id: "urgent-today",
      accountId: "acct-gmail",
      senderName: "Security",
      senderEmail: "security@example.test",
      subject: "New sign-in",
      category: "account-security",
      attention: "interrupt",
      labels: ["INBOX", "UNREAD"],
    });

    const page = await getNaturalLanguageSearchPage({
      query: "what did Ezra quiet today",
      workspaceId: "workspace:gmail",
      limit: 10,
    });

    expect(page.interpretation.filters).toMatchObject({
      folder: "inbox",
      priority: "suppress",
      date: "today",
      handled: "any",
    });
    expect(page.interpretation.providerSearch.requested).toBe(false);
    expect(page.results.items.map((item) => item.id)).toEqual(["quiet-today"]);
  });

  it("honors Hotmail and date hints for calendar mail", async () => {
    await seedAccount("acct-gmail", "gmail", "owner@gmail.test", "Gmail");
    await seedAccount("acct-hotmail", "microsoft", "owner@hotmail.test", "Hotmail");
    await seedMessage({
      id: "hotmail-calendar",
      accountId: "acct-hotmail",
      senderName: "Scheduler",
      senderEmail: "scheduler@example.test",
      subject: "Calendar invite for next week",
      category: "calendar",
      attention: "digest",
      receivedAt: daysAgo(3),
      labels: ["INBOX", "UNREAD"],
    });
    await seedMessage({
      id: "gmail-calendar",
      accountId: "acct-gmail",
      senderName: "Google Calendar",
      senderEmail: "calendar@example.test",
      subject: "Calendar invite",
      category: "calendar",
      attention: "digest",
      receivedAt: daysAgo(3),
      labels: ["INBOX", "UNREAD"],
    });
    await seedMessage({
      id: "hotmail-old-calendar",
      accountId: "acct-hotmail",
      senderName: "Old Scheduler",
      senderEmail: "old@example.test",
      subject: "Old calendar invite",
      category: "calendar",
      attention: "digest",
      receivedAt: daysAgo(10),
      labels: ["INBOX", "UNREAD"],
    });

    const page = await getNaturalLanguageSearchPage({
      query: "find Hotmail calendar emails from last week",
      workspaceId: "workspace:gmail",
      limit: 10,
    });

    expect(page.interpretation.workspaceId).toBe("workspace:microsoft");
    expect(page.interpretation.filters.date).toBe("last7");
    expect(page.interpretation.filters.categories).toContain("calendar");
    expect(page.results.items.map((item) => item.id)).toEqual(["hotmail-calendar"]);
  });

  it("maps recruiter reply searches to reply-needed job results", async () => {
    await seedAccount("acct-hotmail", "microsoft", "owner@hotmail.test", "Hotmail");
    await seedMessage({
      id: "reply-recruiter",
      accountId: "acct-hotmail",
      senderName: "Recruiter",
      senderEmail: "recruiter@example.test",
      subject: "Interview follow-up",
      category: "job application",
      attention: "interrupt",
      needsReply: true,
      labels: ["INBOX", "UNREAD"],
    });
    await seedMessage({
      id: "no-reply-recruiter",
      accountId: "acct-hotmail",
      senderName: "Recruiter Digest",
      senderEmail: "digest@example.test",
      subject: "Hiring newsletter",
      category: "job alert",
      attention: "digest",
      needsReply: false,
      labels: ["INBOX", "UNREAD"],
    });

    const page = await getNaturalLanguageSearchPage({
      query: "show recruiters I need to reply to",
      workspaceId: "workspace:microsoft",
      limit: 10,
    });

    expect(page.interpretation.filters.needsReply).toBe(true);
    expect(page.interpretation.filters.categories).toContain("job application");
    expect(page.results.items.map((item) => item.id)).toEqual(["reply-recruiter"]);
  });

  it("keeps interpret-only actions local and marks explicit provider search read-only", async () => {
    const interpretation = interpretNaturalLanguageSearch({
      query: "show security alerts",
      workspaceId: "workspace:gmail",
    });
    const interpretOnly = await runNaturalLanguageSearchAction({
      action: "interpret",
      query: "show security alerts",
      workspaceId: "workspace:gmail",
    });
    const microsoftProvider = await runNaturalLanguageSearchAction({
      action: "provider_search",
      query: "find Outlook calendar emails",
      workspaceId: "workspace:microsoft",
    });

    expect(interpretation.providerSearch).toMatchObject({ requested: false, readOnly: true });
    expect(interpretOnly).toMatchObject({
      action: "interpret",
      interpretation: { providerSearch: { requested: false, readOnly: true } },
    });
    expect(microsoftProvider).toMatchObject({
      action: "provider_search",
      provider: {
        readOnly: true,
        items: [],
        accountCount: 0,
      },
    });
  });
});

async function seedAccount(
  id: string,
  provider: "gmail" | "microsoft",
  email: string,
  label: string,
) {
  const now = nowIso();
  await execute(
    `INSERT INTO email_accounts
      (id, provider, email, label, status, last_sync_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'connected', ?, ?, ?)`,
    [id, provider, email, label, now, now, now],
  );
}

async function seedMessage(input: {
  id: string;
  accountId: string;
  senderName: string;
  senderEmail: string;
  subject: string;
  category: string;
  attention: AttentionLevel;
  receivedAt?: string;
  needsReply?: boolean;
  isUnread?: boolean;
  status?: string;
  labels?: string[];
}) {
  const now = nowIso();
  const labels = input.labels || ["INBOX", "UNREAD"];
  await execute(
    `INSERT INTO email_messages
      (id, account_id, external_message_id, thread_id, sender_name, sender_email,
       subject, received_at, snippet, gmail_url, has_attachments, gmail_labels,
       is_unread, ingest_source, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '#', 0, ?, ?, 'live', ?, ?, ?)`,
    [
      input.id,
      input.accountId,
      `external-${input.id}`,
      `thread-${input.id}`,
      input.senderName,
      input.senderEmail,
      input.subject,
      input.receivedAt || now,
      `${input.subject} snippet`,
      JSON.stringify(labels),
      input.isUnread === false ? 0 : 1,
      input.status || "triaged",
      now,
      now,
    ],
  );
  await saveTriageDecision(input.id, "test-model", {
    attention: input.attention,
    urgency: input.attention === "interrupt" ? 90 : 35,
    confidence: 0.92,
    category: input.category,
    summary: `${input.subject} summary`,
    reason: "Seeded search test message.",
    recommendation: "Review.",
    needsReply: Boolean(input.needsReply),
    deadline: null,
    draftReply: null,
    injectionFlags: [],
    criticalReason: null,
  });
}

function daysAgo(days: number) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}
