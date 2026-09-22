import { loadEnvConfig } from "@next/env";
import { rehearseLatestRestore } from "../src/lib/email/system-recovery";

loadEnvConfig(process.cwd());

void rehearseLatestRestore().then((result) => {
  process.stdout.write(`Restore rehearsal passed for ${result.sourceFile} (${result.tableCount} tables).\n`);
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
