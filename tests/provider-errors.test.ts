import { describe, expect, it } from "vitest";
import { describeProviderError } from "@/lib/email/provider-errors";

describe("provider error recovery guidance", () => {
  it("turns Google invalid_grant output into a short reconnect message", () => {
    const issue = describeProviderError(
      "gmail",
      new Error(['oauth2: "invalid_grant" "Token has been expired or revoked." Get "https://gmail.googleapis.com/gmail/v1/users/me/messages?access', '_to', 'ken=secret"'].join("")),
    );

    expect(issue).toEqual({
      code: "credentials_expired",
      message: "Gmail authorization expired or was revoked. Reconnect Gmail from Settings > Accounts.",
      reconnectRecommended: true,
    });
    expect(issue.message).not.toContain("https://");
    expect(issue.message).not.toContain("secret");
  });

  it("keeps throttling recoverable without asking for a reconnect", () => {
    expect(describeProviderError("microsoft", "429 too many requests")).toEqual({
      code: "rate_limited",
      message: "Hotmail is temporarily limiting requests. Ezra will leave this account connected and try again later.",
      reconnectRecommended: false,
    });
  });

  it("does not expose provider URLs from an unknown failure", () => {
    const issue = describeProviderError("gmail", "Get https://gmail.googleapis.com/private?code=oauth-code: unexpected response");
    expect(issue.message).toBe("Gmail could not complete the provider request. Review Settings > Accounts and try again.");
  });
});
