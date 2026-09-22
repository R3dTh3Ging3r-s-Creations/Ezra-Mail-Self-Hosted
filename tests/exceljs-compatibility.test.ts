import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("ExcelJS supported unzipper resolution", () => {
  it("installs unzipper inside ExcelJS's declared range without the unlicensed buffers chain", () => {
    const packageJson = require("../package.json") as { overrides?: Record<string, string> };
    const excelPackage = require("exceljs/package.json") as { dependencies: { unzipper: string } };
    const excelRoot = path.dirname(require.resolve("exceljs/package.json"));
    const unzipperPackage = require(require.resolve("unzipper/package.json", { paths: [excelRoot] })) as { version: string };

    expect(packageJson.overrides).not.toHaveProperty("unzipper");
    expect(excelPackage.dependencies.unzipper).toBe("^0.11.2");
    expect(unzipperPackage.version).toMatch(/^0\.11\./);
    expect(() => require.resolve("buffers/package.json", { paths: [excelRoot] })).toThrow();
  });

  it("reads a standard workbook through the installed dependency graph", async () => {
    const written = new ExcelJS.Workbook();
    written.addWorksheet("Mail").addRow(["Subject", "Status"]);
    written.getWorksheet("Mail")?.addRow(["Launch", "Ready"]);
    const bytes = await written.xlsx.writeBuffer();
    const read = new ExcelJS.Workbook();

    await read.xlsx.load(bytes);

    expect(read.getWorksheet("Mail")?.getCell("A2").value).toBe("Launch");
  });

  it("reads a workbook with the streaming reader through unzipper", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-exceljs-"));
    temporaryRoots.push(root);
    const workbookPath = path.join(root, "mail.xlsx");
    const written = new ExcelJS.Workbook();
    written.addWorksheet("Mail").addRow(["Launch", "Ready"]);
    await written.xlsx.writeFile(workbookPath);
    const values: unknown[] = [];

    for await (const worksheet of new ExcelJS.stream.xlsx.WorkbookReader(workbookPath, {})) {
      for await (const row of worksheet) values.push(row.getCell(1).value);
    }

    expect(values).toEqual(["Launch"]);
  });
});
