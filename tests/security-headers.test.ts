import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error Next's JavaScript configuration has no declaration file.
import nextConfig from "../next.config.mjs";
import { isAuthoritativePublicMirror } from "../scripts/build-public-mirror";

const isExportedWorkspace = await isAuthoritativePublicMirror(process.cwd());
const publicProxyPath = isExportedWorkspace
  ? path.join(process.cwd(), "docs", "proxy-example.conf")
  : path.join(process.cwd(), "public-release", "proxy-example.conf");

describe("application security baseline", () => {
  it("applies the same defensive headers to every application route", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    const entries = await nextConfig.headers();
    const baseline = entries.find((entry: { source: string }) => entry.source === "/(.*)");
    expect(baseline).toBeDefined();
    const headers = Object.fromEntries(baseline.headers.map((item: { key: string; value: string }) => [item.key.toLowerCase(), item.value]));
    expect(headers["strict-transport-security"]).toContain("max-age=31536000");
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("same-origin");
    expect(headers["permissions-policy"]).toContain("camera=()");
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
    for (const entry of entries) {
      const overrides = Object.fromEntries(entry.headers.map((item: { key: string; value: string }) => [item.key.toLowerCase(), item.value]));
      expect({ ...headers, ...overrides }).toMatchObject(headers);
    }
    const worker = entries.find((entry: { source: string }) => entry.source === "/ezra-sw.js");
    expect(worker).toBeDefined();
    expect(Object.fromEntries(worker.headers.map((item: { key: string; value: string }) => [item.key.toLowerCase(), item.value]))).toMatchObject({
      "cache-control": "no-store", "content-type": "application/javascript; charset=utf-8", "service-worker-allowed": "/",
    });
  });

  it("keeps the checked-in public proxy fixture on a secure origin with one explicit backend", async () => {
    const proxy = await fs.readFile(publicProxyPath, "utf8");

    expect(proxy).toMatch(/^https:\/\/192\.0\.2\.10\s*\{/m);
    expect(proxy).toMatch(/^\s*reverse_proxy 127\.0\.0\.1:3000\s*$/m);
    expect(proxy.match(/^\s*reverse_proxy\s+/gm)).toHaveLength(1);
    expect(proxy).not.toContain("http://");
  });
});
