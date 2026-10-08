import { loadEnvConfig } from "@next/env";
import { prepareRestoredAgentAccess } from "../src/lib/email/system-recovery";

loadEnvConfig(process.cwd());
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--staged") {
  process.stderr.write("Usage: prepare-restored-agent-access.ts --staged <offline-copy.sqlite>\n");
  process.exitCode = 1;
} else {
  void prepareRestoredAgentAccess(args[1]).then(result => {
    process.stdout.write(`Staged restore prepared; ${result.revokedKeys} restored agent keys revoked. Fresh owner issuance is required.\n`);
  }).catch(() => {
    process.stderr.write("Staged restore preparation failed. Do not start services on this copy.\n");
    process.exitCode = 1;
  });
}
