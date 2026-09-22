import { describe, expect, it } from "vitest";
import {
  analyzeReplyPreservation,
  buildPolishInstruction,
  polishReply,
} from "@/lib/email/reply-polish";

describe("reply polish safety", () => {
  it.each([
    ["grammar", "Correct grammar and punctuation only"],
    ["clearer", "Make the message easier to understand"],
    ["concise", "Make the message shorter"],
    ["warmer", "Make the message warmer"],
    ["professional", "Make the message professionally polished"],
    ["firmer", "Make the message respectfully firmer"],
  ] as const)("defines a bounded %s mode", (mode, phrase) => {
    expect(buildPolishInstruction(mode)).toContain(phrase);
  });

  it("flags changed names, dates, amounts, links, and commitments", () => {
    const result = analyzeReplyPreservation(
      "Hi Sarah,\n\nI will pay $250 by August 12. Details: https://example.com/a",
      "Hi Sara,\n\nI can pay $200 by August 14. Details: https://example.com/b",
    );

    expect(result.factualChangesDetected).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/Sarah|\$250|August 12|example\.com\/a|I will/i);
  });

  it("accepts a style-only rewrite that preserves concrete facts", () => {
    const result = analyzeReplyPreservation(
      "Hi Sarah, I will pay $250 by August 12. See https://example.com/a.",
      "Hi Sarah,\n\nI will pay $250 by August 12. Please see https://example.com/a.",
    );

    expect(result.factualChangesDetected).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("returns both versions and never mutates the original", async () => {
    const result = await polishReply(
      {
        body: "Thanks for the note.",
        mode: "warmer",
        direction: "Keep it brief.",
        messageId: "mail-1",
        threadId: "thread-1",
      },
      async () => "Thanks so much for the thoughtful note.",
    );

    expect(result.original).toBe("Thanks for the note.");
    expect(result.proposed).toBe("Thanks so much for the thoughtful note.");
    expect(result.appliedContext).toEqual(["Mode: warmer", "Keep it brief."]);
  });
});
