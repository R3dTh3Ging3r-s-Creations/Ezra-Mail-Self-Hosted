import { describe, expect, it } from "vitest";
import {
  attentionLabel,
  mailActionCopy,
  mailActionHistoryTitle,
  notificationStatusLabel,
  ruleActionLabel,
  whyThisMattersRows,
} from "@/lib/email/vocabulary";

describe("Ezra Mail vocabulary", () => {
  it("uses one canonical label set for common mail actions", () => {
    expect(mailActionCopy("done")).toMatchObject({ label: "Acknowledge", pastTense: "acknowledged" });
    expect(mailActionCopy("mark_read")).toMatchObject({ label: "Acknowledge", pastTense: "acknowledged" });
    expect(mailActionCopy("raise_priority").label).toBe("Care more");
    expect(mailActionCopy("lower_priority").label).toBe("Care less");
    expect(mailActionCopy("keep").label).toBe("Keep useful");
    expect(mailActionCopy("quiet").label).toBe("Quiet sender");
    expect(mailActionCopy("delete").description).toContain("not permanent deletion");
    expect(mailActionCopy("delete_and_teach").label).toBe("Trash & teach");
  });

  it("keeps history and rule labels consistent with the action vocabulary", () => {
    expect(mailActionHistoryTitle("mark_read")).toBe("Acknowledged mail");
    expect(mailActionHistoryTitle("raise_priority")).toBe("Care more");
    expect(mailActionHistoryTitle("lower_priority", "Problem with ")).toBe("Problem with Care less");
    expect(ruleActionLabel("interrupt")).toBe("Care more");
    expect(ruleActionLabel("digest")).toBe("Keep useful");
    expect(ruleActionLabel("suppress")).toBe("Care less");
    expect(ruleActionLabel("mark_read")).toBe("Acknowledge");
  });

  it("standardizes Why This Matters rows and care/notification labels", () => {
    expect(attentionLabel("interrupt")).toBe("Priority");
    expect(attentionLabel("digest")).toBe("Useful");
    expect(attentionLabel("suppress")).toBe("Quiet");
    expect(notificationStatusLabel("skipped")).toBe("Notification held or skipped");
    expect(whyThisMattersRows({
      summary: "A recruiter asked Eric to schedule an interview.",
      reason: "This is a job follow-up.",
      recommendation: "Schedule the interview.",
      currentAttention: "interrupt",
      preferenceCount: 0,
      notificationStatus: "sent",
    }).map((row) => row.label)).toEqual([
      "What Ezra saw",
      "Why it matters",
      "Suggested move",
      "Current care",
      "Learning applied",
      "Notification",
    ]);
  });
});
