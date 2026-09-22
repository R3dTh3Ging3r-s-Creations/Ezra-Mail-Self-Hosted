import { describe, expect, it } from "vitest";
import { cleanDraftOutput, normalizeTriageResult } from "@/lib/email/model";

describe("draft output cleanup", () => {
  it("removes subject metadata and an invented Ezra signature", () => {
    expect(
      cleanDraftOutput(
        "Subject: Re: Account notice\n\nHello,\n\nCould you clarify this alert?\n\nThank you.\nEzra",
      ),
    ).toBe("Hello,\n\nCould you clarify this alert?\n\nThank you.");
  });

  it("preserves a user-provided signature that is not Ezra", () => {
    expect(cleanDraftOutput("Hello,\n\nFriday works for me.\n\nBest,\nEric")).toBe(
      "Hello,\n\nFriday works for me.\n\nBest,\nEric",
    );
  });
});

describe("triage output normalization", () => {
  it("bounds verbose model fields without rejecting an otherwise valid judgment", () => {
    const normalized = normalizeTriageResult({
      attention: "interrupt",
      urgency: 90,
      confidence: 0.9,
      category: "account-security",
      summary: "Summary",
      reason: "Reason",
      recommendation: "Review now.",
      needsReply: false,
      deadline: null,
      draftReply: null,
      injectionFlags: ["x".repeat(100)],
      criticalReason: "y".repeat(200),
    });

    expect(normalized.injectionFlags[0]).toHaveLength(80);
    expect(normalized.criticalReason).toHaveLength(120);
  });
});
