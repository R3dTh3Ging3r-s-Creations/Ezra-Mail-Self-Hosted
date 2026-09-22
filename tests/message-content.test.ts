import { describe, expect, it } from "vitest";
import {
  normalizePlainText,
  sanitizeMessageHtml,
} from "@/lib/email/message-content";

describe("message content safety", () => {
  it("removes active content, event handlers, embeds, forms, and unsafe links", () => {
    const result = sanitizeMessageHtml(`
      <script>alert('x')</script>
      <style>body { display: none }</style>
      <form action="https://attacker.example"><input name="secret"></form>
      <iframe src="https://attacker.example"></iframe>
      <p onclick="steal()">Hello <a href="javascript:steal()">there</a>.</p>
      <a href="https://safe.example/path">Safe link</a>
    `);

    expect(result.sanitizedHtml).not.toMatch(/script|style|form|input|iframe|onclick|javascript:/i);
    expect(result.sanitizedHtml).toContain("Hello");
    expect(result.sanitizedHtml).toContain('href="https://safe.example/path"');
    expect(result.sanitizedHtml).toContain('rel="noopener noreferrer nofollow"');
  });

  it("blocks remote images without dropping useful alt text", () => {
    const result = sanitizeMessageHtml(
      '<p>Receipt</p><img src="https://images.example/receipt.png" alt="Receipt image" width="640" height="480">',
    );

    expect(result.remoteImageCount).toBe(1);
    expect(result.sanitizedHtml).not.toMatch(/(?:^|\s)src="https:\/\/images\.example\/receipt\.png"/);
    expect(result.sanitizedHtml).toContain('data-ezra-remote-src="https://images.example/receipt.png"');
    expect(result.sanitizedHtml).toContain('alt="Receipt image"');
  });

  it("drops one-pixel tracking images completely", () => {
    const result = sanitizeMessageHtml(
      '<p>Hello</p><img src="https://tracker.example/open" width="1" height="1" alt="">',
    );

    expect(result.trackingPixelCount).toBe(1);
    expect(result.remoteImageCount).toBe(0);
    expect(result.sanitizedHtml).not.toContain("tracker.example");
  });

  it("marks recognizable provider signatures and legal disclaimers for calm collapsing", () => {
    const result = sanitizeMessageHtml(`
      <p>The useful message.</p>
      <div class="gmail_signature">Warmly,<br>Jamie</div>
      <div class="email-disclaimer">This message may contain confidential information.</div>
    `);

    expect(result.sanitizedHtml).toContain('data-ezra-section="signature"');
    expect(result.sanitizedHtml).toContain('data-ezra-section="disclaimer"');
    expect(result.sanitizedHtml).not.toContain("gmail_signature");
  });

  it("normalizes readable plain text and decodes entities", () => {
    expect(normalizePlainText('<p>Hello&nbsp;Eric,</p><p>Thanks &amp; good luck.</p>')).toBe(
      "Hello Eric,\n\nThanks & good luck.",
    );
  });

  it("limits oversized content and records truncation", () => {
    const result = sanitizeMessageHtml(`<p>${"x".repeat(140_000)}</p>`);

    expect(result.truncated).toBe(true);
    expect(result.plainText.length).toBeLessThanOrEqual(100_000);
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
