import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import pdf from "pdf-parse";

async function main() {
  const [filePath, suppliedName] = process.argv.slice(2);
  if (!filePath || !suppliedName) throw new Error("File path and name are required.");
  const extension = path.extname(suppliedName).toLowerCase();
  let text = "";

  if (extension === ".txt" || extension === ".csv") {
    text = await fs.readFile(filePath, "utf8");
  } else if (extension === ".docx") {
    text = (await mammoth.extractRawText({ path: filePath })).value;
  } else if (extension === ".pdf") {
    text = (await pdf(await fs.readFile(filePath))).text;
  } else if (extension === ".xlsx") {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const rows: string[] = [];
    workbook.eachSheet((sheet) => {
      rows.push(`[Sheet: ${sheet.name}]`);
      sheet.eachRow((row) => {
        const values = Array.isArray(row.values) ? row.values : Object.values(row.values);
        rows.push(
          values
            .slice(1)
            .map((value: unknown) =>
              value === null || value === undefined ? "" : String(value),
            )
            .join("\t"),
        );
      });
    });
    text = rows.join("\n");
  } else {
    throw new Error("Unsupported attachment type.");
  }

  process.stdout.write(text.replace(/\0/g, "").slice(0, 100_000));
}

void main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
