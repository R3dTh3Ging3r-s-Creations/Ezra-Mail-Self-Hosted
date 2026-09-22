import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OpenSourceNotice } from "@/components/ezra/OpenSourceNotice";

describe("OpenSourceNotice", () => {
  it("offers unique links to the public source and licensing information", () => {
    render(<OpenSourceNotice />);

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(3);
    expect(new Set(links.map((link) => link.getAttribute("href"))).size).toBe(3);
    expect(screen.getByRole("link", { name: "Public source" })).toHaveAttribute(
      "href",
      "https://github.com/R3dTh3Ging3r-s-Creations/Ezra-Mail-Self-Hosted",
    );
    expect(screen.getByRole("link", { name: "AGPL-3.0-only license" })).toHaveAttribute(
      "href",
      "https://github.com/R3dTh3Ging3r-s-Creations/Ezra-Mail-Self-Hosted/blob/main/LICENSE",
    );
    expect(screen.getByRole("link", { name: "Commercial licensing" })).toHaveAttribute(
      "href",
      "https://github.com/R3dTh3Ging3r-s-Creations/Ezra-Mail-Self-Hosted/blob/main/COMMERCIAL-LICENSING.md",
    );
  });
});
