import { readTelegramConfiguration, isTelegramTokenFormat, type TelegramConfiguration } from "./notification-telegram-config";
export { readTelegramConfiguration, isTelegramTokenFormat, type TelegramConfiguration } from "./notification-telegram-config";
import { isCurrentNotificationOrigin } from "./notification-origin";
import { request as httpsRequest } from "node:https";
import { execute } from "./database";
import { cancelNotificationDeviceWork, withNotificationStoreWrite } from "./notification-store";
import { parseNotificationTarget } from "./notification-target";
import type { PushPayload, PushTransportResult } from "./notification-web-push";
export const telegramPrivacyDisclosure = "Telegram bots are not end-to-end encrypted. Generic notification copy is recommended. Enabling here replaces the previous Telegram enrollment for this destination.";
export type TelegramBinding = {
    deviceId: string;
    generation: number;
    trustedDeviceId: string;
    origin: string;
    fingerprint: string;
};
export async function getActiveTelegramBinding(deviceId?: string): Promise<TelegramBinding | null> {
    const configuration = readTelegramConfiguration();
    if (!configuration)
        return null;
    const row = (await execute(`SELECT d.* FROM notification_devices d JOIN trusted_devices t ON t.id=d.trusted_device_id
    WHERE d.channel='telegram' AND d.permission='granted' AND d.revoked_at IS NULL AND t.revoked_at IS NULL
    AND d.telegram_binding_fingerprint=? AND (? IS NULL OR d.id=?)`, [configuration.fingerprint, deviceId ?? null, deviceId ?? null])).rows[0];
    return row && isCurrentNotificationOrigin(String(row.origin)) ? { deviceId: String(row.id), generation: Number(row.generation), trustedDeviceId: String(row.trusted_device_id), origin: String(row.origin), fingerprint: configuration.fingerprint } : null;
}
export async function telegramEnrollmentStatus(owner: {
    trustedDeviceId: string;
    origin: string;
}) {
    const configured = !!readTelegramConfiguration(), binding = configured ? await getActiveTelegramBinding() : null;
    const enrolled = !!binding && binding.trustedDeviceId === owner.trustedDeviceId && binding.origin === owner.origin;
    return { configured, enrolled, deviceId: enrolled ? binding!.deviceId : null, reason: enrolled ? "enrolled" : configured ? "enrollment_required" : "configuration_unavailable", disclosure: telegramPrivacyDisclosure };
}
/** CAS: a blocked response for old bytes cannot disable a newly enrolled destination. */
export async function disableTelegramBindingIfCurrent(binding: TelegramBinding, now: string) {
    await withNotificationStoreWrite(async (tx) => {
        if (readTelegramConfiguration()?.fingerprint !== binding.fingerprint)
            return;
        const changed = await tx.execute({ sql: `UPDATE notification_devices SET permission='denied',telegram_binding_fingerprint=NULL,updated_at=?
      WHERE id=? AND generation=? AND telegram_binding_fingerprint=? AND revoked_at IS NULL RETURNING id`, args: [now, binding.deviceId, binding.generation, binding.fingerprint] });
        if (changed.rows.length)
            await cancelNotificationDeviceWork(tx, binding.deviceId, now);
    });
}
export interface TelegramNetwork {
    request?: typeof httpsRequest;
}
export type TelegramTransportResult = PushTransportResult & {
    externalId?: string;
    editRefused?: boolean;
    blocked?: boolean;
};
export type TelegramMessage = {
    text: string;
    reply_markup?: {
        inline_keyboard: Array<Array<{
            text: string;
            url?: string;
            callback_data?: string;
        }>>;
    };
};
export function telegramNotificationMessage(payload: PushPayload, origin: string): TelegramMessage {
    const parsed = parseNotificationTarget(payload.target), base = new URL(origin);
    if (!parsed || base.origin !== origin || base.username || base.password || (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))))
        throw new Error("Notification unavailable");
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(payload.attemptId) || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(payload.title + payload.body))
        throw new Error("Notification unavailable");
    return { text: `${payload.title}\n${payload.body}`, reply_markup: { inline_keyboard: [
                [{ text: "Open Ezra", url: origin + payload.target }],
                [{ text: "Useful", callback_data: `n:u:${payload.attemptId}` }, { text: "Too noisy", callback_data: `n:q:${payload.attemptId}` }],
                [{ text: "Snooze notifications", callback_data: `n:s:${payload.attemptId}` }],
            ] } };
}
function classify(status: number | undefined, payload: unknown, existingId: string | undefined, now: string): TelegramTransportResult {
    const unknown: TelegramTransportResult = { outcome: "unknown", errorCode: "transport_unknown" };
    if (!payload || typeof payload !== "object")
        return unknown;
    const data = payload as {
        ok?: unknown;
        result?: {
            message_id?: unknown;
        };
        error_code?: unknown;
        description?: unknown;
        parameters?: {
            retry_after?: unknown;
        };
    };
    const id = data.result?.message_id;
    if (status && status >= 200 && status < 300 && data.ok === true && typeof id === "number" && Number.isSafeInteger(id) && id > 0)
        return { outcome: "accepted", externalId: String(id) };
    if (data.ok !== false || data.error_code !== status)
        return unknown;
    if (status === 429) {
        const seconds = data.parameters?.retry_after;
        return { outcome: "failed", errorCode: "rate_limited", retryAt: new Date(Date.parse(now) + Math.max(30, Math.min(900, typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : 30)) * 1000).toISOString() };
    }
    if (status === 403 && typeof data.description === "string" && /^Forbidden: (bot was blocked by the user|user is deactivated)$/.test(data.description))
        return { outcome: "failed", errorCode: "permission_denied", blocked: true };
    if (status === 400 && existingId && typeof data.description === "string") {
        if (/^Bad Request: message is not modified(?::|$)/.test(data.description))
            return { outcome: "accepted", externalId: existingId };
        if (["Bad Request: message to edit not found", "Bad Request: message can't be edited"].includes(data.description))
            return { outcome: "failed", errorCode: "rejected", editRefused: true };
    }
    return unknown;
}
/** Fixed POST endpoint, no redirects, 15s total deadline, 16KiB request/response bounds.
 * Only sanitized outcomes escape. Accepted means API acceptance, never displayed/read. */
export function sendTelegramMessage(configuration: TelegramConfiguration, message: TelegramMessage, network: TelegramNetwork = {}, options: {
    existingId?: string;
    now?: string;
} = {}): Promise<TelegramTransportResult> {
    return new Promise(resolve => {
        let request: ReturnType<typeof httpsRequest> | undefined, response: {
            destroy(): void;
        } | undefined, finished = false;
        const finish = (result: TelegramTransportResult, abort = false) => { if (finished)
            return; finished = true; clearTimeout(timer); resolve(result); if (abort) {
            response?.destroy();
            request?.destroy();
        } };
        const unknown = () => finish({ outcome: "unknown", errorCode: "transport_unknown" }, true);
        const timer = setTimeout(() => finish({ outcome: "unknown", errorCode: "timeout" }, true), 15000);
        try {
            if (!isTelegramTokenFormat(configuration.token) || !/^[1-9]\d{0,15}$/.test(configuration.chatId) || !Number.isSafeInteger(Number(configuration.chatId)) || (options.existingId !== undefined && !/^[1-9]\d{0,15}$/.test(options.existingId)))
                throw new Error();
            if (!message.text || message.text.length > 4096)
                throw new Error();
            for (const row of message.reply_markup?.inline_keyboard ?? [])
                for (const button of row)
                    if (button.callback_data && Buffer.byteLength(button.callback_data, "utf8") > 64)
                        throw new Error();
            const body = JSON.stringify({ chat_id: configuration.chatId, text: message.text, disable_web_page_preview: true, ...(message.reply_markup ? { reply_markup: message.reply_markup } : {}), ...(options.existingId ? { message_id: Number(options.existingId) } : {}) });
            if (Buffer.byteLength(body, "utf8") > 16384)
                throw new Error();
            request = (network.request || httpsRequest)({ protocol: "https:", hostname: "api.telegram.org", port: 443, path: `/bot${configuration.token}/${options.existingId ? "editMessageText" : "sendMessage"}`, method: "POST", agent: false, rejectUnauthorized: true, maxHeaderSize: 16384, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, incoming => {
                response = incoming;
                let bytes = 0;
                const chunks: Buffer[] = [];
                incoming.on("error", unknown);
                incoming.on("aborted", unknown);
                incoming.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16384)
                    unknown();
                else
                    chunks.push(chunk); });
                incoming.on("end", () => { if (finished)
                    return; if (!incoming.complete)
                    return unknown(); try {
                    finish(classify(incoming.statusCode, JSON.parse(Buffer.concat(chunks).toString("utf8")), options.existingId, options.now ?? new Date().toISOString()));
                }
                catch {
                    unknown();
                } });
                incoming.on("close", () => { if (!finished)
                    unknown(); });
            });
            request.on("error", unknown);
            request.end(body);
        }
        catch {
            unknown();
        }
    });
}
/** Fixed allowlisted polling/acknowledgement endpoints. All failures are redacted.
 * Abort destroys the request; responses are bounded before JSON parsing. */
export function telegramControlRequest(configuration: TelegramConfiguration, method: "getUpdates" | "answerCallbackQuery", body: { offset: number } | { callback_query_id: string; text: string }, network: TelegramNetwork = {}, signal?: AbortSignal): Promise<{ ok: boolean; result?: unknown }> {
  return new Promise(resolve => {
    let request: ReturnType<typeof httpsRequest> | undefined, response: { destroy(): void } | undefined, finished = false;
    const finish = (value: { ok: boolean; result?: unknown }, abort = false) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener("abort", cancel); resolve(value);
      if (abort) { response?.destroy(); request?.destroy(); }
    };
    const cancel = () => finish({ ok: false }, true);
    const timer = setTimeout(cancel, 15000);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (signal?.aborted || !isTelegramTokenFormat(configuration.token)) return cancel();
      let data: object;
      if (method === "getUpdates" && "offset" in body && Number.isSafeInteger(body.offset) && body.offset >= 0) data = { offset: body.offset, limit: 20, timeout: 10, allowed_updates: ["message", "callback_query"] };
      else if (method === "answerCallbackQuery" && "callback_query_id" in body && /^[A-Za-z0-9_-]{1,128}$/.test(body.callback_query_id) && body.text.length <= 200) data = body;
      else return cancel();
      const encoded = JSON.stringify(data);
      request = (network.request || httpsRequest)({ protocol: "https:", hostname: "api.telegram.org", port: 443, path: `/bot${configuration.token}/${method}`, method: "POST", agent: false, rejectUnauthorized: true, maxHeaderSize: 16384, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) } }, incoming => {
        response = incoming; let bytes = 0; const chunks: Buffer[] = [];
        incoming.on("error", cancel); incoming.on("aborted", cancel);
        incoming.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) cancel(); else chunks.push(chunk); });
        incoming.on("end", () => {
          if (finished) return;
          try {
            if (!incoming.complete || incoming.statusCode !== 200) return cancel();
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (value?.ok !== true || (method === "getUpdates" ? !Array.isArray(value.result) || value.result.length > 20 : value.result !== true)) return cancel();
            finish({ ok: true, result: value.result });
          } catch { cancel(); }
        });
        incoming.on("close", () => { if (!finished) cancel(); });
      });
      request.on("error", cancel); request.end(encoded);
    } catch { cancel(); }
  });
}
