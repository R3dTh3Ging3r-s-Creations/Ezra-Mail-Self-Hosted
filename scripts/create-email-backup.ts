import { loadEnvConfig } from "@next/env";
import { createVerifiedBackup } from "../src/lib/email/system-recovery";

loadEnvConfig(process.cwd());

void createVerifiedBackup().then((result) => {
  process.stdout.write(`Created and verified ${result.fileName} (SHA-256 ${result.sha256}).\n`);
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
