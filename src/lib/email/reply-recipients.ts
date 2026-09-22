import type { EmailRecipient, ReplyMode } from "./types";

export type ProviderReplyMetadata = {
  from: EmailRecipient | null;
  replyTo: EmailRecipient[];
  to: EmailRecipient[];
  cc: EmailRecipient[];
  subject: string;
};

export function resolveReplyRecipients(
  metadata: ProviderReplyMetadata,
  accountEmail: string,
  mode: ReplyMode,
) {
  const primary = metadata.replyTo.length ? metadata.replyTo : metadata.from ? [metadata.from] : [];
  if (!primary.length) throw new Error("The provider did not return a reply recipient for this message.");
  const excluded = new Set([accountEmail.trim().toLowerCase()]);
  const seen = new Set<string>();
  const normalize = (items: EmailRecipient[]) => items.flatMap((item) => {
    const email = String(item.email || "").trim().toLowerCase();
    if (!email || excluded.has(email) || seen.has(email)) return [];
    seen.add(email);
    return [{ email, name: item.name ? String(item.name).trim() || null : null }];
  });
  const to = normalize(primary);
  if (!to.length) throw new Error("The only resolved reply recipient is the sending account.");
  const cc = mode === "all" ? normalize([...metadata.to, ...metadata.cc]) : [];
  return { to, cc, bcc: [] as EmailRecipient[] };
}

export function parseMailboxList(value: string | null | undefined): EmailRecipient[] {
  if (!value) return [];
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angleDepth = 0;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    if (!quoted && char === "<") angleDepth += 1;
    if (!quoted && char === ">") angleDepth = Math.max(0, angleDepth - 1);
    if (char === "," && !quoted && angleDepth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current);
  return parts.flatMap((part) => {
    const match = part.trim().match(/^(.*?)\s*<([^>]+)>$/);
    const email = (match ? match[2] : part).trim().replace(/^mailto:/i, "").toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return [];
    const name = match?.[1].trim().replace(/^["']|["']$/g, "") || null;
    return [{ email, name }];
  });
}
