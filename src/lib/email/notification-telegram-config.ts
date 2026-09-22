import { createHash } from "node:crypto";
export function isTelegramTokenFormat(value: string) { return /^\d{1,20}:[A-Za-z0-9_-]{1,200}$/.test(value); }
/** Internal runtime-only configuration: never return or log this object. */
export function readTelegramConfiguration() {
    const token = process.env.TELEGRAM_BOT_TOKEN || "", chatId = process.env.TELEGRAM_DEFAULT_CHAT_ID || "";
    if (!isTelegramTokenFormat(token) || !/^[1-9]\d{0,15}$/.test(chatId) || !Number.isSafeInteger(Number(chatId)))
        return null;
    return { token, chatId, fingerprint: createHash("sha256").update(JSON.stringify([token, chatId])).digest("hex") };
}
export type TelegramConfiguration = NonNullable<ReturnType<typeof readTelegramConfiguration>>;
