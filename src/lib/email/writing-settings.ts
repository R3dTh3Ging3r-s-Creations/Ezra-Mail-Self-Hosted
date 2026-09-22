import { ensureEmailDatabase, execute, nowIso } from "./database";

export const writingTones = ["grammar", "clearer", "concise", "warmer", "professional", "firmer"] as const;
export type WritingTone = (typeof writingTones)[number];
export const writingLengths = ["brief", "balanced", "detailed"] as const;
export type WritingLength = (typeof writingLengths)[number];

export type AccountWritingSettings = {
  accountId: string;
  signature: string;
  signatureEnabled: boolean;
  defaultTone: WritingTone;
  preferredLength: WritingLength;
  remoteImagesAllowed: boolean;
  updatedAt: string | null;
};

export async function getWritingSettings(accountId: string, senderEmail?: string): Promise<AccountWritingSettings> {
  await ensureEmailDatabase();
  await requireAccount(accountId);
  const [settings, sender] = await Promise.all([
    execute(`SELECT * FROM account_writing_settings WHERE account_id = ?`, [accountId]),
    senderEmail
      ? execute(
          `SELECT allow_remote_images FROM sender_content_preferences WHERE account_id = ? AND sender_email = ?`,
          [accountId, normalizeSender(senderEmail)],
        )
      : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
  ]);
  const row = settings.rows[0];
  return {
    accountId,
    signature: row ? String(row.signature || "") : "",
    signatureEnabled: Boolean(row?.signature_enabled),
    defaultTone: tone(row?.default_tone),
    preferredLength: length(row?.preferred_length),
    remoteImagesAllowed: Boolean(sender.rows[0]?.allow_remote_images),
    updatedAt: row?.updated_at ? String(row.updated_at) : null,
  };
}

export async function updateWritingSettings(input: {
  accountId: string;
  signature?: string;
  signatureEnabled?: boolean;
  defaultTone?: WritingTone;
  preferredLength?: WritingLength;
}) {
  await ensureEmailDatabase();
  const current = await getWritingSettings(input.accountId);
  const signature = input.signature === undefined ? current.signature : input.signature.trim().slice(0, 4_000);
  const signatureEnabled = input.signatureEnabled ?? current.signatureEnabled;
  const defaultTone = input.defaultTone ?? current.defaultTone;
  const preferredLength = input.preferredLength ?? current.preferredLength;
  if (!writingTones.includes(defaultTone)) throw new Error("Choose a supported writing tone.");
  if (!writingLengths.includes(preferredLength)) throw new Error("Choose a supported reply length.");
  const updatedAt = nowIso();
  await execute(
    `INSERT INTO account_writing_settings
      (account_id, signature, signature_enabled, default_tone, preferred_length, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       signature = excluded.signature,
       signature_enabled = excluded.signature_enabled,
       default_tone = excluded.default_tone,
       preferred_length = excluded.preferred_length,
       updated_at = excluded.updated_at`,
    [input.accountId, signature, signatureEnabled ? 1 : 0, defaultTone, preferredLength, updatedAt],
  );
  return getWritingSettings(input.accountId);
}

export async function setRemoteImagesForSender(accountId: string, senderEmail: string, allowed: boolean) {
  await ensureEmailDatabase();
  await requireAccount(accountId);
  const normalized = normalizeSender(senderEmail);
  if (!normalized || !normalized.includes("@")) throw new Error("A valid sender email is required.");
  await execute(
    `INSERT INTO sender_content_preferences (account_id, sender_email, allow_remote_images, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, sender_email) DO UPDATE SET
       allow_remote_images = excluded.allow_remote_images,
       updated_at = excluded.updated_at`,
    [accountId, normalized, allowed ? 1 : 0, nowIso()],
  );
  return getWritingSettings(accountId, normalized);
}

async function requireAccount(accountId: string) {
  const result = await execute(`SELECT id FROM email_accounts WHERE id = ? AND status <> 'disabled'`, [accountId]);
  if (!result.rows[0]) throw new Error("Mail account was not found.");
}

function normalizeSender(value: string) {
  return value.trim().toLowerCase();
}

function tone(value: unknown): WritingTone {
  const candidate = String(value || "professional") as WritingTone;
  return writingTones.includes(candidate) ? candidate : "professional";
}

function length(value: unknown): WritingLength {
  const candidate = String(value || "balanced") as WritingLength;
  return writingLengths.includes(candidate) ? candidate : "balanced";
}
