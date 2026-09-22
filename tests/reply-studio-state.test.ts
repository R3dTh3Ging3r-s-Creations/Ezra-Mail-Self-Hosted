import { describe, expect, it } from "vitest";
import {
  appendSignature,
  polishAcceptanceReady,
  replyStudioStorageKey,
  shouldApplyGeneratedText,
} from "@/components/ezra/replyStudioState";

describe("Reply Studio state guards", () => {
  it("scopes recovered text to a message and reply mode", () => {
    expect(replyStudioStorageKey("mail-1", "sender")).toBe("ezra.reply-studio.mail-1.sender");
    expect(replyStudioStorageKey("mail-1", "all")).not.toBe(replyStudioStorageKey("mail-1", "sender"));
  });

  it("accepts only the newest result for the unchanged editor identity", () => {
    expect(shouldApplyGeneratedText({
      requestGeneration: 3,
      currentGeneration: 3,
      requestBody: "",
      currentBody: "",
      requestMessageId: "mail-1",
      currentMessageId: "mail-1",
      requestMode: "sender",
      currentMode: "sender",
    })).toBe(true);
  });

  it("rejects late results after typing, navigation, mode changes, or a newer request", () => {
    const base = {
      requestGeneration: 3,
      currentGeneration: 3,
      requestBody: "",
      currentBody: "",
      requestMessageId: "mail-1",
      currentMessageId: "mail-1",
      requestMode: "sender" as const,
      currentMode: "sender" as const,
    };
    expect(shouldApplyGeneratedText({ ...base, currentBody: "I started writing." })).toBe(false);
    expect(shouldApplyGeneratedText({ ...base, currentMessageId: "mail-2" })).toBe(false);
    expect(shouldApplyGeneratedText({ ...base, currentMode: "all" })).toBe(false);
    expect(shouldApplyGeneratedText({ ...base, currentGeneration: 4 })).toBe(false);
  });

  it("adds an enabled signature exactly once", () => {
    expect(appendSignature("Thanks.", "Eric\nEzra Mail", true)).toBe("Thanks.\n\nEric\nEzra Mail");
    expect(appendSignature("Thanks.\n\nEric\nEzra Mail", "Eric\nEzra Mail", true)).toBe("Thanks.\n\nEric\nEzra Mail");
    expect(appendSignature("Thanks.", "Eric", false)).toBe("Thanks.");
  });

  it("requires explicit review before accepting a polish with factual warnings", () => {
    expect(polishAcceptanceReady([], false)).toBe(true);
    expect(polishAcceptanceReady(["Amount changed."], false)).toBe(false);
    expect(polishAcceptanceReady(["Amount changed."], true)).toBe(true);
  });
});
