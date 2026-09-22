import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const BROKEN_SEQUENCES = ["\u00c2\u00b7", "\u00e2\u2020\u2019"];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx", ".css"].includes(extname(path)) ? [path] : [];
  });
}

describe("source encoding", () => {
  it("does not contain confirmed double-encoded UI glyphs", () => {
    for (const file of sourceFiles("src")) {
      const source = readFileSync(file, "utf8");
      for (const sequence of BROKEN_SEQUENCES) expect(source, file).not.toContain(sequence);
    }
  });
});
