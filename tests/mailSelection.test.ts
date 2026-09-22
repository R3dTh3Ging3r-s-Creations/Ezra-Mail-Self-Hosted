import { describe, expect, it } from "vitest";
import {
  bulkConfirmationSentence,
  bulkSelectionLabel,
  resolveBulkSelectionTargets,
} from "@/components/ezra/mailSelection";

const items = [
  { id: "a", senderEmail: "alpha@example.com" },
  { id: "b", senderEmail: "beta@example.com" },
  { id: "c", senderEmail: "ALPHA@example.com" },
  { id: "d", senderEmail: "delta@example.com" },
];

describe("mail bulk selection helpers", () => {
  it("uses only explicit selections when sweep is off", () => {
    expect(resolveBulkSelectionTargets(items, ["a", "b"], false)).toEqual(["a", "b"]);
  });

  it("expands to visible sender matches when sweep is on", () => {
    expect(resolveBulkSelectionTargets(items, ["a"], true)).toEqual(["a", "c"]);
  });

  it("ignores sweep when no explicit selected sender is visible", () => {
    expect(resolveBulkSelectionTargets(items, ["missing"], true)).toEqual([]);
  });

  it("labels explicit versus sender-sweep matches clearly", () => {
    expect(bulkSelectionLabel(1, 3, true)).toBe("1 checked · 3 sender matches");
    expect(bulkSelectionLabel(2, 2, false)).toBe("2 selected");
  });

  it("explains destructive action scope for sweep confirmations", () => {
    expect(bulkConfirmationSentence(1, 3, true)).toBe(
      "This will affect 3 conversations: 1 explicitly selected and 2 additional sender matches.",
    );
    expect(bulkConfirmationSentence(0, 1, false)).toBe("This will affect 1 conversation.");
  });
});
