import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvConfig } from "@next/env";
import { createFirstOwnerSetup, type FirstOwnerSetupTransport } from "../src/lib/email/first-owner-setup";

export async function bootstrapFirstOwner(input: {
  envPath: string;
  origin: string;
  transport: FirstOwnerSetupTransport;
}) {
  await ensureAuthSecret(input.envPath);
  return createFirstOwnerSetup({ origin: input.origin, transport: input.transport });
}

async function ensureAuthSecret(envPath: string) {
  const current = await fs.readFile(envPath, "utf8").catch(() => "");
  const secretKey = ["EZRA", "AUTH", "SECRET"].join("_");
  if (new RegExp(`^${secretKey}=.+$`, "m").test(current)) return;
  const next = setEnvValue(current, secretKey, crypto.randomBytes(32).toString("base64url"));
  await fs.mkdir(path.dirname(envPath), { recursive: true });
  const temporaryPath = path.join(path.dirname(envPath), `.${path.basename(envPath)}.${process.pid}.tmp`);
  await fs.writeFile(temporaryPath, next, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, envPath);
  await fs.chmod(envPath, 0o600).catch(() => undefined);
}

function setEnvValue(source: string, key: string, value: string) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const updated = pattern.test(source) ? source.replace(pattern, line) : `${source.replace(/\s*$/, "")}\n${line}\n`;
  return updated.startsWith("\n") ? updated.slice(1) : updated;
}

function parseCliArgs(args: string[]) {
  let origin = "";
  let transport: FirstOwnerSetupTransport = "local";
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--origin") origin = args[++index] || "";
    else if (argument === "--transport") {
      const supplied = args[++index];
      if (supplied !== "local" && supplied !== "tailscale" && supplied !== "lan") {
        throw new Error("--transport must be local, tailscale, or lan.");
      }
      transport = supplied;
    } else if (argument === "--json") json = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!origin) throw new Error("--origin is required.");
  return { origin, transport, json };
}

async function main() {
  loadEnvConfig(process.cwd());
  const options = parseCliArgs(process.argv.slice(2));
  const envPath = process.env.EZRA_ENV_FILE || path.join(process.cwd(), ".env.local");
  const created = await bootstrapFirstOwner({ ...options, envPath });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ setupUrl: created.setupUrl, expiresAt: created.expiresAt })}\n`);
    return;
  }
  process.stdout.write(`Open this Ezra Mail setup link before it expires: ${created.setupUrl}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
