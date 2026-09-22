import { isCurrentNotificationOrigin } from "./notification-origin";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { InboxItem } from "./types";
import { execute } from "./database";
import { recordNotificationFeedbackInTransaction, withNotificationStoreWrite } from "./notification-store";
import { getActiveTelegramBinding, readTelegramConfiguration, sendTelegramMessage, telegramControlRequest, type TelegramBinding, type TelegramNetwork } from "./notification-telegram";
export { isTelegramTokenFormat } from "./notification-telegram";
/** Legacy mail/provider-action paths are retired. All alerts use shared dispatch. */
export async function sendEmailAlert(_item: InboxItem) { return { ok: false, skipped: true, reason: "shared_notifications_required" }; }
export async function sendDigest(_items: InboxItem[], _label: string) { return { ok: false, skipped: true, reason: "shared_notifications_required" }; }
const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const chat = z.object({ id: positiveId, type: z.literal("private") });
const sender = z.object({ id: positiveId });
const callback = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), data: z.string().min(1).refine(v => Buffer.byteLength(v, "utf8") <= 64), from: sender, message: z.object({ message_id: positiveId, chat }) });
const command = z.object({ text: z.string().max(256), from: sender, chat });
const updateId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
type UpdateOptions = {
    now?: string;
    network?: TelegramNetwork;
    signal?: AbortSignal;
    leaseOwner?: string;
};
let polling: {
    controller: AbortController;
    timer?: ReturnType<typeof setTimeout>;
} | null = null;
let pollingEpoch = 0;
let offset = 0, lastError: string | null = null;
export function getTelegramStatus() { return { configured: !!readTelegramConfiguration(), running: !!polling, offset, lastError }; }
export async function telegramUpdateOffset(binding: TelegramBinding): Promise<number> {
    const row = (await execute("SELECT MAX(update_id) AS last FROM notification_telegram_updates WHERE fingerprint=? AND device_id=? AND generation=?", [binding.fingerprint, binding.deviceId, binding.generation])).rows[0];
    return row?.last == null ? 0 : Number(row.last) + 1;
}
/** Claim, local action and durable offset commit together. No transaction spans I/O.
 * A response after commit is best effort: ambiguous acknowledgement is never replayed. */
export async function processTelegramUpdate(binding: TelegramBinding, input: unknown, options: UpdateOptions = {}) {
    const envelope = z.object({ update_id: updateId, callback_query: z.unknown().optional(), message: z.unknown().optional() }).safeParse(input);
    if (!envelope.success || options.signal?.aborted)
        return false;
    const configuration = readTelegramConfiguration();
    if (!configuration || !isCurrentNotificationOrigin(binding.origin) || configuration.fingerprint !== binding.fingerprint)
        return false;
    const cb = callback.safeParse(envelope.data.callback_query), message = command.safeParse(envelope.data.message);
    const ownerCallback = cb.success && String(cb.data.from.id) === configuration.chatId && String(cb.data.message.chat.id) === configuration.chatId ? cb.data : null;
    const ownerCommand = message.success && String(message.data.from.id) === configuration.chatId && String(message.data.chat.id) === configuration.chatId ? message.data : null;
    const response = await withNotificationStoreWrite(async (tx) => {
        const now = options.now ?? new Date().toISOString();
        if (options.leaseOwner && !(await tx.execute({ sql: "SELECT owner FROM notification_telegram_poll_leases WHERE fingerprint=? AND device_id=? AND generation=? AND owner=? AND expires_at>?", args: [binding.fingerprint, binding.deviceId, binding.generation, options.leaseOwner, now] })).rows.length)
            return null;
        if (options.signal?.aborted || !isCurrentNotificationOrigin(binding.origin) || readTelegramConfiguration()?.fingerprint !== binding.fingerprint)
            return null;
        const live = (await tx.execute({ sql: `SELECT d.id FROM notification_devices d JOIN trusted_devices t ON t.id=d.trusted_device_id
      WHERE d.id=? AND d.generation=? AND d.trusted_device_id=? AND d.origin=? AND d.telegram_binding_fingerprint=?
      AND d.channel='telegram' AND d.permission='granted' AND d.revoked_at IS NULL AND t.revoked_at IS NULL`, args: [binding.deviceId, binding.generation, binding.trustedDeviceId, binding.origin, binding.fingerprint] })).rows[0];
        if (!live)
            return null;
        const duplicateCallback = ownerCallback ? (await tx.execute({ sql: "SELECT update_id FROM notification_telegram_updates WHERE fingerprint=? AND device_id=? AND generation=? AND callback_id=?", args: [binding.fingerprint, binding.deviceId, binding.generation, ownerCallback.id] })).rows.length > 0 : false;
        const claimed = (await tx.execute({ sql: `INSERT INTO notification_telegram_updates (fingerprint,device_id,generation,update_id,callback_id,processed_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING update_id`, args: [binding.fingerprint, binding.deviceId, binding.generation, envelope.data.update_id, duplicateCallback ? null : ownerCallback?.id ?? null, now] })).rows.length;
        if (!claimed || duplicateCallback)
            return null;
        let answer = "Open Ezra to review this action.";
        if (ownerCallback) {
            const match = /^n:([uqs]):([A-Za-z0-9_-]{1,40})$/.exec(ownerCallback.data);
            if (match) {
                const attempt = (await tx.execute({ sql: `SELECT r.event_id FROM notification_attempts a JOIN notification_deliveries r ON r.id=a.delivery_id JOIN notification_events e ON e.id=r.event_id
          WHERE a.id=? AND a.channel='telegram' AND a.outcome='accepted' AND a.external_id=? AND a.generation=?
          AND r.device_id=? AND r.generation=? AND r.state='accepted' AND e.expires_at>?
          AND NOT EXISTS (SELECT 1 FROM notification_attempts newer JOIN notification_deliveries nr ON nr.id=newer.delivery_id
            WHERE nr.device_id=r.device_id AND newer.generation=a.generation AND newer.channel='telegram' AND newer.outcome='accepted' AND newer.external_id=a.external_id AND newer.rowid>a.rowid)`, args: [match[2], String(ownerCallback.message.message_id), binding.generation, binding.deviceId, binding.generation, now] })).rows[0];
                if (attempt) {
                    if (match[1] === "s") {
                        await tx.execute({ sql: "INSERT INTO settings (key,value,updated_at) VALUES ('notification_snoozed_until',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", args: [JSON.stringify(new Date(Date.parse(now) + 3600000).toISOString()), now] });
                        answer = "Notifications snoozed for one hour.";
                    }
                    else {
                        await recordNotificationFeedbackInTransaction(tx, { deviceId: binding.deviceId, eventId: String(attempt.event_id), kind: match[1] === "u" ? "useful" : "too_noisy", now });
                        answer = "Notification feedback saved.";
                    }
                }
            }
        }
        // Last synchronous check prevents a stopped poll from committing after an awaited mutation.
        if (options.signal?.aborted || !isCurrentNotificationOrigin(binding.origin) || readTelegramConfiguration()?.fingerprint !== binding.fingerprint)
            throw new Error("Telegram update interrupted.");
        return { answer, callbackId: ownerCallback?.id, command: ownerCommand?.text };
    });
    if (!response)
        return false;
    const current = await getActiveTelegramBinding(binding.deviceId);
    if (options.signal?.aborted || !current || current.generation !== binding.generation || current.fingerprint !== binding.fingerprint || current.trustedDeviceId !== binding.trustedDeviceId || current.origin !== binding.origin)
        return true;
    if (response.callbackId)
        await telegramControlRequest(configuration, "answerCallbackQuery", { callback_query_id: response.callbackId, text: response.answer }, options.network, options.signal);
    else if (response.command) {
        const cmd = response.command.trim();
        const text = cmd === "/today" ? "Open your current private brief in Ezra." : cmd === "/status" ? "Telegram notifications are enrolled. Local notification feedback is enabled. API acceptance does not confirm display or reading." : "Ezra notifications are enrolled. Use /today for your private brief and /status for notification status. Useful, Too noisy and Snooze change local notification preferences. Review mail actions in Ezra.";
        await sendTelegramMessage(configuration, { text, reply_markup: { inline_keyboard: [[{ text: "Open Ezra", url: binding.origin + "/?view=today" }]] } }, options.network);
    }
    return true;
}
export async function startTelegramPolling(options: UpdateOptions = {}) {
    if (process.env.TELEGRAM_POLLING_ENABLED === "false")
        return stopTelegramPolling();
    const startupEpoch = pollingEpoch;
    if (polling || !await getActiveTelegramBinding())
        return getTelegramStatus();
    // A stop during lookup invalidates this startup even before a timer exists.
    if (startupEpoch !== pollingEpoch || polling)
        return getTelegramStatus();
    const state = { controller: new AbortController(), timer: undefined as ReturnType<typeof setTimeout> | undefined };
    polling = state;
    lastError = null;
    const poll = async () => {
        try {
            const binding = await getActiveTelegramBinding(), configuration = readTelegramConfiguration();
            if (polling !== state || state.controller.signal.aborted)
                return;
            if (!binding || !configuration) {
                stopTelegramPolling();
                return;
            }
            if (process.env.TELEGRAM_POLLING_ENABLED === "false") {
                stopTelegramPolling();
                return;
            }
            await pollTelegramUpdatesOnce({ ...options, signal: state.controller.signal });
        }
        catch {
            lastError = "Telegram polling unavailable.";
        }
        finally {
            if (polling === state && !state.controller.signal.aborted)
                state.timer = setTimeout(() => void poll(), lastError ? 10000 : 1000);
        }
    };
    state.timer = setTimeout(() => void poll(), 0);
    return getTelegramStatus();
}
export function stopTelegramPolling() { pollingEpoch++; const state = polling; polling = null; if (state) {
    clearTimeout(state.timer);
    state.controller.abort();
} return getTelegramStatus(); }
export async function sendTelegramConnectionTest(owner: {
    trustedDeviceId: string;
    origin: string;
}, expected?: {
    deviceId: string;
    generation: number;
}) {
    const binding = await getActiveTelegramBinding(), configuration = readTelegramConfiguration();
    if (!binding || !configuration || (expected && (binding.deviceId !== expected.deviceId || binding.generation !== expected.generation)) || binding.fingerprint !== configuration.fingerprint || binding.trustedDeviceId !== owner.trustedDeviceId || binding.origin !== owner.origin)
        throw new Error("Telegram enrollment required.");
    const result = await sendTelegramMessage(configuration, { text: "Ezra Mail connection test. This message tests Telegram delivery only." });
    if (result.outcome !== "accepted")
        throw new Error("Telegram test delivery could not be confirmed.");
    return { ok: true, messageId: result.externalId ?? null };
}
/** A short durable lease serializes Telegram batches across worker processes.
 * Renewal is conditional; an expired owner cannot revive itself or skip its remainder. */
export async function pollTelegramUpdatesOnce(options: UpdateOptions = {}) {
    const binding = await getActiveTelegramBinding(), configuration = readTelegramConfiguration();
    if (!binding || !configuration || options.signal?.aborted || process.env.TELEGRAM_POLLING_ENABLED === "false")
        return;
    const owner = randomUUID();
    const acquired = await withNotificationStoreWrite(async (tx) => {
        const now = options.now ?? new Date().toISOString(), expiry = new Date(Date.parse(now) + 30000).toISOString();
        return (await tx.execute({ sql: `INSERT INTO notification_telegram_poll_leases (fingerprint,device_id,generation,owner,expires_at) VALUES (?,?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET device_id=excluded.device_id,generation=excluded.generation,owner=excluded.owner,expires_at=excluded.expires_at WHERE notification_telegram_poll_leases.expires_at<=? RETURNING owner`, args: [binding.fingerprint, binding.deviceId, binding.generation, owner, expiry, now] })).rows.length > 0;
    });
    if (!acquired)
        return;
    try {
        const readyOffset = await withNotificationStoreWrite(async tx => {
            const now = options.now ?? new Date().toISOString();
            if (options.signal?.aborted || !isCurrentNotificationOrigin(binding.origin) || readTelegramConfiguration()?.fingerprint !== binding.fingerprint) return null;
            const live = (await tx.execute({ sql: "SELECT d.id FROM notification_devices d JOIN trusted_devices t ON t.id=d.trusted_device_id JOIN notification_telegram_poll_leases l ON l.fingerprint=d.telegram_binding_fingerprint WHERE d.id=? AND d.generation=? AND d.trusted_device_id=? AND d.origin=? AND d.permission='granted' AND d.revoked_at IS NULL AND t.revoked_at IS NULL AND l.owner=? AND l.device_id=d.id AND l.generation=d.generation AND l.expires_at>?", args: [binding.deviceId,binding.generation,binding.trustedDeviceId,binding.origin,owner,now] })).rows[0];
            if (!live) return null;
            const row = (await tx.execute({ sql: "SELECT MAX(update_id) AS last FROM notification_telegram_updates WHERE fingerprint=? AND device_id=? AND generation=?", args: [binding.fingerprint,binding.deviceId,binding.generation] })).rows[0];
            return row?.last == null ? 0 : Number(row.last) + 1;
        });
        if (readyOffset === null || options.signal?.aborted || !isCurrentNotificationOrigin(binding.origin) || readTelegramConfiguration()?.fingerprint !== binding.fingerprint) return;
        offset = readyOffset;
        const result = await telegramControlRequest(configuration, "getUpdates", { offset }, options.network, options.signal);
        if (options.signal?.aborted)
            return;
        const parsed = result.ok ? z.array(z.object({ update_id: updateId }).passthrough()).max(20).safeParse(result.result) : null;
        if (!parsed?.success) {
            lastError = "Telegram polling unavailable.";
            return;
        }
        lastError = null;
        for (const value of parsed.data.sort((a, b) => a.update_id - b.update_id)) {
            const renewed = await withNotificationStoreWrite(async (tx) => {
                const now = options.now ?? new Date().toISOString();
                if (options.signal?.aborted || !isCurrentNotificationOrigin(binding.origin) || readTelegramConfiguration()?.fingerprint !== binding.fingerprint)
                    return false;
                return (await tx.execute({ sql: "UPDATE notification_telegram_poll_leases SET expires_at=? WHERE fingerprint=? AND device_id=? AND generation=? AND owner=? AND expires_at>? RETURNING owner", args: [new Date(Date.parse(now) + 30000).toISOString(), binding.fingerprint, binding.deviceId, binding.generation, owner, now] })).rows.length > 0;
            });
            if (!renewed)
                break;
            await processTelegramUpdate(binding, value, { ...options, leaseOwner: owner });
        }
        offset = await telegramUpdateOffset(binding);
    }
    finally {
        await withNotificationStoreWrite(async (tx) => { await tx.execute({ sql: "DELETE FROM notification_telegram_poll_leases WHERE fingerprint=? AND owner=?", args: [binding.fingerprint, owner] }); });
    }
}
