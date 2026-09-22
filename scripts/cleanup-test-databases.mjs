import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const testRoot = path.join(process.cwd(), "data", "tests");
const relative = path.relative(process.cwd(), testRoot);
if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
  throw new Error(`Refusing to clean test artifacts outside the workspace: ${testRoot}`);
}

try {
  const bytes = (await stat(testRoot)).size;
  await rm(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  console.log(`Removed private test artifacts (${(bytes / 1024 / 1024).toFixed(1)} MiB).`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const legacyArtifact = /^(?:[a-z0-9][a-z0-9-]*-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:sqlite|db)(?:-(?:shm|wal))?|(?:system|auth)-recovery-[0-9a-f-]{36})$/i;
for (const entry of await readdir(process.cwd(), { withFileTypes: true })) {
  if (!legacyArtifact.test(entry.name)) continue;
  await rm(path.join(process.cwd(), entry.name), { recursive: entry.isDirectory(), force: true });
}
