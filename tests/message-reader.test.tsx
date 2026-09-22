import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageReader } from "@/components/ezra/MessageReader";

const content = {
  plainText: "Hello Eric,\n\nThe current note.\n\nEarlier message",
  sanitizedHtml: '<p>Hello Eric,</p><p>The current note.</p><blockquote><p>Earlier message</p></blockquote><img alt="Chart" data-ezra-remote-src="https://images.example/chart.png">',
  contentHash: "a".repeat(64),
  providerRevision: "revision-1",
  fetchedAt: "2026-08-04T12:00:00.000Z",
  source: "cache" as const,
  remoteImageCount: 1,
  trackingPixelCount: 1,
  truncated: false,
};

describe("MessageReader", () => {
  it("defaults to the clean reading mode with quoted history collapsed", () => {
    const { container } = render(<MessageReader content={content} fallbackText="Fallback" />);

    expect(screen.getByRole("button", { name: "Clean reading" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Quoted conversation").closest("details")).not.toHaveAttribute("open");
    expect(container.querySelector("img")?.getAttribute("src")).toBeNull();
  });

  it("collapses marked signatures and disclaimers in clean mode", () => {
    render(<MessageReader content={{
      ...content,
      sanitizedHtml: '<p>The useful message.</p><details data-ezra-section="signature">Warmly,<br>Jamie</details><details data-ezra-section="disclaimer">Confidentiality notice.</details>',
      remoteImageCount: 0,
    }} fallbackText="Fallback" />);

    expect(screen.getByText("Signature").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Notice and disclaimer").closest("details")).not.toHaveAttribute("open");
  });

  it("reveals remote images only after an explicit one-time choice", () => {
    const { container } = render(<MessageReader content={content} fallbackText="Fallback" />);

    fireEvent.click(screen.getByRole("button", { name: /show 1 image once/i }));

    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://images.example/chart.png");
  });

  it("offers an account-scoped sender image preference", () => {
    const onAlwaysShowImages = vi.fn();
    render(
      <MessageReader
        content={content}
        fallbackText="Fallback"
        senderEmail="sender@example.com"
        onAlwaysShowImages={onAlwaysShowImages}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /always show for sender@example.com/i }));
    expect(onAlwaysShowImages).toHaveBeenCalledWith("sender@example.com");
  });

  it("switches to plain text without rendering provider markup", () => {
    const { container } = render(<MessageReader content={content} fallbackText="Fallback" />);

    fireEvent.click(screen.getByRole("button", { name: "Plain text" }));

    expect(screen.getByText(/The current note/)).toBeInTheDocument();
    expect(container.querySelector("blockquote")).toBeNull();
  });

  it("falls back cleanly when only an excerpt exists", () => {
    render(<MessageReader fallbackText="Only the local excerpt." isExcerpt />);

    expect(screen.getByText("Only the local excerpt.")).toBeInTheDocument();
    expect(screen.getByText(/locally available excerpt/i)).toBeInTheDocument();
  });
});
