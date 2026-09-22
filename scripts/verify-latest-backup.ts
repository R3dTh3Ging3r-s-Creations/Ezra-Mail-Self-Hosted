import { loadEnvConfig } from "@next/env";
import { verifyLatestBackup } from "../src/lib/email/system-recovery";

loadEnvConfig(process.cwd());

async function main() {
  const result = await verifyLatestBackup();
  const latest = result.backup.latest;
  if (!latest || !result.backup.verified || !result.backup.sha256) {
    throw new Error("The latest Ezra Mail backup did not produce complete verification evidence.");
  }
  process.stdout.write(
    `Verified ${latest.fileName} (${latest.sizeBytes} bytes, SHA-256 ${result.backup.sha256}).\n`,
  );
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
