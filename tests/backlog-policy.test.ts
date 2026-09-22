import { describe, expect, it } from "vitest";
import { prefilterBacklogMessage } from "@/lib/email/service";

const base = {
  senderName: "Weekly Store",
  senderEmail: "offers@example.com",
  subject: "Weekly sale and coupon roundup",
  snippet: "Save 25% and unsubscribe at any time.",
  receivedAt: "2026-06-01T12:00:00.000Z",
};

describe("backlog prefilter", () => {
  it("handles obvious bulk mail without spending a model run", () => {
    const result = prefilterBacklogMessage(base);
    expect(result?.attention).toBe("suppress");
    expect(result?.category).toBe("bulk-mail");
  });

  it("routes consequential automated mail to the model", () => {
    expect(
      prefilterBacklogMessage({
        ...base,
        subject: "Security alert: unauthorized sign-in",
      }),
    ).toBeNull();
  });

  it("honors a learned alert preference before bulk-mail rules", () => {
    expect(prefilterBacklogMessage(base, "interrupt")).toBeNull();
  });

  it("keeps financial notifications out of the bulk-mail fast path", () => {
    expect(
      prefilterBacklogMessage({
        ...base,
        senderName: "Schwab Alerts",
        senderEmail: "alerts@example.com",
        subject: "Trade confirmation for your investment account",
      }),
    ).toBeNull();
  });
});
