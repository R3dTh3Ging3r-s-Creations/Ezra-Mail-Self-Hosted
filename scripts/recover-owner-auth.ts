import { loadEnvConfig } from "@next/env";
import path from "node:path";
import { recoverOwnerAccess } from "../src/lib/email/auth-recovery";
import { readHidden } from "./interactive-hidden-input";

loadEnvConfig(process.cwd());

async function main() {
  process.stdout.write("Ezra Mail owner recovery will rotate authentication secrets and revoke every session and trusted device.\n");
  const first = await readHidden("New owner password: ");
  const second = await readHidden("Confirm new password: ");
  if (first !== second) throw new Error("Passwords did not match; nothing was changed.");
  const recoveryCode = await readHidden("First-owner recovery code (press Enter for legacy installations): ");
  const envPath = process.env.EZRA_ENV_FILE || path.join(process.cwd(), ".env.local");
  await recoverOwnerAccess({ envPath, newPassword: first, recoveryCode });
  process.stdout.write("Owner access recovered. Restart only Ezra Mail web and worker services before signing in.\n");
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
