import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { setServiceState } from "../src/lib/email/database";
import { modelDefinitions } from "../src/lib/email/models";

const execFileAsync = promisify(execFile);

async function main() {
  const model = process.argv[2];
  const definition = modelDefinitions.find((candidate) => candidate.id === model);
  if (!definition) throw new Error("Unsupported model.");
  const stateKey = `model_update:${definition.id}`;
  try {
    await setServiceState(stateKey, `running|Pulling ${definition.baseModel}`);
    await runOllama(["pull", definition.baseModel], 3_600_000);
    await setServiceState(stateKey, `running|Rebuilding ${definition.id}`);
    await runOllama(
      [
        "create",
        definition.id,
        "-f",
        path.join(process.cwd(), definition.modelfile),
      ],
      600_000,
    );
    await setServiceState(stateKey, `completed|${definition.label} is current`);
  } catch (error) {
    await setServiceState(
      stateKey,
      `error|${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

async function runOllama(args: string[], timeout: number) {
  const result = await execFileAsync("ollama.exe", args, {
    cwd: process.cwd(),
    timeout,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
