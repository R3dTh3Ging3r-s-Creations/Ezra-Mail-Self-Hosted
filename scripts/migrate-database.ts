import { ensureEmailDatabase } from "../src/lib/email/database";

async function main() {
  await ensureEmailDatabase();
  console.log("Ezra Mail database migration complete.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
