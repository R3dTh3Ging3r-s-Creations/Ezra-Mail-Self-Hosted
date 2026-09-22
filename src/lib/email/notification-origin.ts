import { isIP } from "node:net";

export class NotificationOriginError extends Error {
  constructor(public code: string, public status: number) { super("Notification origin unavailable."); }
}
function rejectOrigin(): never { throw new NotificationOriginError("origin_not_allowed", 403); }

/** Parse authority before URL parsing, which otherwise repairs dangerous input. */
export function authority(value: string): { hostname: string; port: string } {
  if (!value || value.length > 300 || /[\s\x00-\x1f\x7f,@/\\%?#]/.test(value)) rejectOrigin();
  const match = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::([1-9][0-9]{0,4}))?$/.exec(value);
  if (!match || (match[2] && Number(match[2]) > 65535)) rejectOrigin();
  const hostname = match[1].toLowerCase(), port = match[2] ?? "";
  if (hostname.startsWith("[")) {
    if (isIP(hostname.slice(1, -1)) !== 6) rejectOrigin();
  } else {
    if (hostname.length > 253 || hostname.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) rejectOrigin();
    // Reject numeric/IP shorthand and any parser normalization of a host.
    try { if (new URL(`https://${value}`).hostname !== hostname) rejectOrigin(); } catch { rejectOrigin(); }
  }
  return { hostname, port };
}
export function matchesHost(host: ReturnType<typeof authority>, url: URL) {
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  return host.hostname === url.hostname && (host.port || defaultPort) === (url.port || defaultPort);
}
export function configuredOrigins(): URL[] {
  try {
    const additional = process.env.EZRA_NOTIFICATION_ORIGINS?.trim();
    const values = [process.env.APP_BASE_URL ?? "", ...(additional ? additional.split(",") : [])];
    if (values.join(",").length > 8192) rejectOrigin();
    const urls = values.map((raw) => {
      const value = raw.trim(), match = /^(https?):\/\/([^/]+)\/?$/.exec(value);
      if (!match) rejectOrigin();
      const host = authority(match[2]), url = new URL(value);
      if (!matchesHost(host, url) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) rejectOrigin();
      return url;
    });
    const unique = [...new Map(urls.map((url) => [url.origin, url])).values()];
    if (unique.length > 9) rejectOrigin();
    // A Host must resolve one public origin even when no Origin is present.
    for (const [index, left] of unique.entries()) for (const right of unique.slice(index + 1)) {
      if (matchesHost(authority(left.host), right) || matchesHost(authority(right.host), left)) rejectOrigin();
    }
    return unique;
  } catch { throw new NotificationOriginError("origin_configuration_unavailable", 503); }
}

/** Exact persisted origin membership; invalid configuration revokes runtime authority. */
export function currentNotificationOrigins(): string[] {
  try { return configuredOrigins().map(url => url.origin); } catch { return []; }
}
export function isCurrentNotificationOrigin(origin: string): boolean {
  return currentNotificationOrigins().includes(origin);
}
