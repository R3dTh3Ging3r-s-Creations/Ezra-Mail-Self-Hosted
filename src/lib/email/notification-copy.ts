import { execute, getSetting } from "./database";
import type { NotificationKind } from "./notification-types";

/** Reviewed generic phrases: model output must match one exactly for the finalized class. */
export const notificationCopyPhrases = {
  interrupt: ["A message is ready for your attention.", "There is a message to review in Ezra."],
  brief: ["Your mail brief is ready when you are.", "A brief is available in Ezra."],
  checkin: ["Your scheduled mail check-in is ready.", "It is time for your mail check-in."],
  in_app: ["Your mail is available in Ezra.", "Open Ezra when you are ready."],
} as const;

type CopyInput = {
  level: NotificationKind;
  count: number;
  useLocalModel?: boolean;
  /** Explicit per-device opt-in; never passed to the model. */
  detailedCopy?: {
    sender: string;
    subject: string;
  };
};

function sanitizedDetail(value: string, limit: number) {
  return value.slice(0, 2048)
    .replace(/<[^>]*>/g, "")
    .replace(/(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f<>]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, limit);
}

/** The wording helper receives only the finalized level and bounded count. */
async function selectLocalPhrase(level: NotificationKind, count: number): Promise<string | null> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const request = async () => {
    const state = await execute("SELECT value FROM service_state WHERE key = ?", ["interactive_model_until"]);
    const busyUntil = state.rows[0]?.value;
    if (busyUntil && Date.parse(String(busyUntil)) > Date.now())
      return null;
    // Same precedence as model.ts, without calling its hosted-capable entry points.
    const reference = (process.env.EZRA_EMAIL_MODEL_REF || process.env.EZRA_EMAIL_TRIAGE_MODEL || await getSetting("active_model") || "qwen3:8b-maxctx").trim();
    const separator = reference.indexOf("/");
    if (separator >= 0 && reference.slice(0, separator).trim().toLowerCase() !== "ollama")
      return null;
    const model = separator >= 0 ? reference.slice(separator + 1) : reference;
    if (!model || model.length > 200 || /[\s\x00-\x1f]/.test(model))
      return null;
    const base = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
    if (base.length > 2048 || !/^https?:\/\/[^/?#\\\s]+(?:\/[^?#\\\s]*)?$/.test(base)) return null;
    const endpoint = new URL(base);
    if (!["http:", "https:"].includes(endpoint.protocol)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      return null;
    if (controller.signal.aborted)
      return null;
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, "") + "/api/chat";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      redirect: "error",
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        keep_alive: "0",
        options: {
          temperature: 0,
          num_predict: 64,
          num_ctx: 1024
        },
        messages: [{
          role: "user",
          content: JSON.stringify({
            instruction: "Select exactly one allowed phrase. Return only that phrase.",
            level,
            count,
            phrases: notificationCopyPhrases[level],
          }),
        }],
      }),
    });
    if (!response.ok || !response.body) {
      if (response.body) void response.body.cancel().catch(() => undefined);
      return null;
    }
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > 16384)) {
      void response.body.cancel().catch(() => undefined);
      return null;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (controller.signal.aborted) {
        cancel();
        return null;
      }
      while (true) {
        const { value, done } = await reader.read();
        if (done)
          break;
        size += value.byteLength;
        if (size > 16384) {
          cancel();
          return null;
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const phrase: unknown = parsed?.message?.content;
      return typeof phrase === "string" && phrase.length <= 100 && (notificationCopyPhrases[level] as readonly string[]).includes(phrase)
        ? phrase : null;
    }
    finally {
      controller.signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  };
  try {
    return await Promise.race([
      request().catch(() => null),
      new Promise<null>(resolve => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, 1500);
      }),
    ]);
  }
  finally {
    if (timeout)
      clearTimeout(timeout);
  }
}

export async function createNotificationCopy(input: CopyInput): Promise<{
  title: string;
  body: string;
}> {
  const count = Number.isFinite(input.count) ? Math.min(999, Math.max(0, Math.floor(input.count))) : 0;
  const selected = input.useLocalModel ? await selectLocalPhrase(input.level, count) : null;
  let body: string = selected || notificationCopyPhrases[input.level][0];
  if (input.detailedCopy) {
    const details = [sanitizedDetail(input.detailedCopy.sender, 60), sanitizedDetail(input.detailedCopy.subject, 120)].filter(Boolean);
    if (details.length)
      body += ` ${details.join(": ")}`;
  }
  return {
    title: "Ezra Mail",
    body
  };
}
