import { loadEnvConfig } from "@next/env";
import { startEmailWorker, stopEmailWorker } from "../src/lib/email/worker";
import { recordOwnerRecoveryStartup } from "../src/lib/email/auth-recovery";

loadEnvConfig(process.cwd());

async function main() {
  await startEmailWorker();
  await recordOwnerRecoveryStartup("worker");
  process.stdout.write("Ezra email worker is running.\n");

  const shutdown = () => {
    stopEmailWorker();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
