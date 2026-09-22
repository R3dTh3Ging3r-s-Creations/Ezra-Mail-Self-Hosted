import { hashPassword } from "../src/lib/email/auth";

async function main() {
  const password = process.env.EZRA_AUTH_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error("Set EZRA_AUTH_PASSWORD to a password of at least 12 characters.");
  }
  console.log(await hashPassword(password));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
