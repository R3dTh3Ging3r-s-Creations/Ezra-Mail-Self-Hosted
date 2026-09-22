import { describe, expect, it } from "vitest";
import { friendlyFailure, summarizeMailActionResult } from "@/components/ezra/mailActionSummary";
import type { MailActionResult } from "@/lib/email/types";

function result(overrides: Partial<MailActionResult>): MailActionResult {
  return {
    actionId: "action-test",
    action: "delete",
    successCount: 0,
    failureCount: 0,
    reversible: false,
    failures: [],
    ...overrides,
  };
}

describe("mail action summaries", () => {
  it("summarizes partial action outcomes with changed unchanged and failed counts", () => {
    const summary = summarizeMailActionResult(result({
      action: "delete",
      successCount: 2,
      failureCount: 1,
      changedIds: ["a", "b"],
      unchangedIds: ["c"],
      failures: [{ id: "d", error: "Reconnect Hotmail from Settings to grant Microsoft Mail.ReadWrite access." }],
    }));

    expect(summary.variant).toBe("partial");
    expect(summary.headline).toBe("Partial action: 2 changed, 1 unchanged, 1 failed.");
    expect(summary.detailLines).toEqual([
      "Changed: 2 messages moved to Trash.",
      "Unchanged: 1 message already in Trash.",
      "Failed: 1 message could not be changed — Reconnect Hotmail from Settings to grant Microsoft Mail.ReadWrite access.",
    ]);
    expect(summary.retryGuidance).toBe("Reconnect or upgrade the account permissions in Settings, then retry.");
  });

  it("shows already-satisfied actions as informational", () => {
    const summary = summarizeMailActionResult(result({
      action: "mark_read",
      unchangedIds: ["a", "b"],
    }));

    expect(summary.variant).toBe("info");
    expect(summary.headline).toBe("2 messages were already acknowledged.");
  });

  it("keeps custom success labels without hiding failures", () => {
    const success = summarizeMailActionResult(result({ action: "done", successCount: 1, changedIds: ["a"] }), "Nice and handled.");
    const failure = summarizeMailActionResult(result({
      action: "done",
      successCount: 1,
      failureCount: 1,
      changedIds: ["a"],
      failures: [{ id: "b", error: "Provider timed out." }],
    }), "Nice and handled.");

    expect(success.headline).toBe("Nice and handled.");
    expect(failure.headline).toBe("Partial action: 1 changed, 1 failed.");
  });

  it.each([
    ["pin", "1 pinned."],
    ["unpin", "1 unpinned."],
    ["flag", "1 flagged."],
    ["unflag", "1 unflagged."],
  ] as const)("uses the provider organization receipt wording for %s", (action, expectedHeadline) => {
    const summary = summarizeMailActionResult(result({
      action,
      successCount: 1,
      changedIds: ["mail-1"],
    }));

    expect(summary.headline).toBe(expectedHeadline);
  });

  it("trims provider trace ids from friendly failure text", () => {
    expect(friendlyFailure("AADSTS issue Trace ID: abc Correlation ID: def")).toBe("AADSTS issue");
  });
});
