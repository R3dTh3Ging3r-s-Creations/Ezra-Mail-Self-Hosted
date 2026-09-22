// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNotificationCopy, notificationCopyPhrases } from "@/lib/email/notification-copy";

vi.mock("@/lib/email/database", () => ({
  getSetting: vi.fn(),
  execute: vi.fn()
}));

import { execute, getSetting } from "@/lib/email/database";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv("EZRA_EMAIL_MODEL_REF", "");
  vi.stubEnv("EZRA_EMAIL_TRIAGE_MODEL", "");
  vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");
  vi.mocked(getSetting).mockResolvedValue("ollama/fixture-model");
  vi.mocked(execute).mockResolvedValue({
    rows: [],
    columns: [],
    columnTypes: [],
    rowsAffected: 0,
    lastInsertRowid: undefined,
    toJSON: () => ({})
  });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function response(content: string) {
  return new Response(JSON.stringify({ message: { content } }));
}

describe("bounded notification copy", () => {
  it.each(["interrupt", "brief", "checkin", "in_app"] as const)("renders deterministic generic %s without model access by default", async (level) => {
    expect(await createNotificationCopy({
      level,
      count: 2
    })).toEqual({
      title: "Ezra Mail",
      body: notificationCopyPhrases[level][0]
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("allows only reviewed wording for the finalized class and passes no private inputs", async () => {
    fetchMock.mockResolvedValue(response(notificationCopyPhrases.interrupt[1]));
    const copy = await createNotificationCopy({
      level: "interrupt",
      count: 1,
      useLocalModel: true,
      detailedCopy: {
        sender: "Private Person",
        subject: "Private account information"
      }
    });
    expect(copy.body).toContain(notificationCopyPhrases.interrupt[1]);
    expect(copy.body).toContain("Private Person");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:11434/api/chat");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("fixture-model");
    expect(JSON.stringify(body)).not.toMatch(/Private|account information|sender|subject|accountId|messageId/);
    expect(body.stream).toBe(false);
    expect(init.redirect).toBe("error");
  });
  it.each(["Visit https://example.test", "Your account was compromised", "private sender", "", "x".repeat(300), "All caught up."])("rejects unreviewed output %s", async (text) => {
    fetchMock.mockResolvedValue(response(text));
    expect((await createNotificationCopy({
      level: "interrupt",
      count: 1,
      useLocalModel: true
    })).body).toBe(notificationCopyPhrases.interrupt[0]);
  });
  it("falls back on failed, malformed and over-limit responses with one attempt", async () => {
    for (const result of [new Response("broken"), new Response("{}"), new Response("x".repeat(16385)), new Response("refused", { status: 500 })]) {
      fetchMock.mockReset().mockResolvedValue(result);
      expect((await createNotificationCopy({
        level: "brief",
        count: 1,
        useLocalModel: true
      })).body).toBe(notificationCopyPhrases.brief[0]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
    fetchMock.mockReset().mockRejectedValue(new Error("fixture transport error"));
    expect((await createNotificationCopy({
      level: "brief",
      count: 1,
      useLocalModel: true
    })).body).toBe(notificationCopyPhrases.brief[0]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("bounds a hung request and response stream to 1500ms", async () => {
    vi.useFakeTimers();
    for (const result of [() => new Promise(() => {
    }), () => Promise.resolve(new Response(new ReadableStream({
      start() {
      }
    })))]) {
      fetchMock.mockImplementation(result);
      const promise = createNotificationCopy({
        level: "brief",
        count: 1,
        useLocalModel: true
      });
      await vi.advanceTimersByTimeAsync(1500);
      expect((await promise).body).toBe(notificationCopyPhrases.brief[0]);
    }
  });
  it("honors active-reference precedence without hosted fallback", async () => {
    vi.stubEnv("EZRA_EMAIL_MODEL_REF", "openai/fixture");
    vi.stubEnv("EZRA_EMAIL_TRIAGE_MODEL", "ollama/secondary");
    await createNotificationCopy({
      level: "brief",
      count: 1,
      useLocalModel: true
    });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv("EZRA_EMAIL_MODEL_REF", "");
    fetchMock.mockResolvedValue(response(notificationCopyPhrases.brief[0]));
    await createNotificationCopy({
      level: "brief",
      count: 1,
      useLocalModel: true
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe("secondary");
    vi.stubEnv("EZRA_EMAIL_TRIAGE_MODEL", "anthropic/fixture");
    fetchMock.mockClear();
    await createNotificationCopy({
      level: "brief",
      count: 1,
      useLocalModel: true
    });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv("EZRA_EMAIL_TRIAGE_MODEL", "");
    vi.mocked(getSetting).mockResolvedValue("openai/fixture");
    await createNotificationCopy({
      level: "brief",
      count: 1,
      useLocalModel: true
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("skips a busy interactive model and rejects malformed Ollama endpoints", async () => {
    vi.mocked(execute).mockResolvedValue({ rows: [{ value: new Date(Date.now() + 60000).toISOString() }] } as never);
    await createNotificationCopy({
      level: "brief",
      count: 1,
      useLocalModel: true
    });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.mocked(execute).mockResolvedValue({ rows: [] } as never);
    vi.stubEnv("OLLAMA_BASE_URL", "https://self-hosted.example.test/?private=yes");
    await createNotificationCopy({
      level: "brief",
      count: 1,
      useLocalModel: true
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("appends only bounded sanitized details after explicit opt-in", async () => {
    const result = await createNotificationCopy({
      level: "interrupt",
      count: 1,
      detailedCopy: {
        sender: "<b>Person</b>\n\u202e",
        subject: "https://private.test \u0000" + "x".repeat(500)
      }
    });
    expect(result.title).toBe("Ezra Mail");
    expect(result.body).toContain("Person");
    expect(result.body).not.toMatch(/<|>|https:|\n|\u202e|\u0000/);
    expect(result.body.length).toBeLessThanOrEqual(260);
  });
});

it("uses an explicitly configured LAN Ollama endpoint with the same bounded generic request", async () => {
  vi.stubEnv("OLLAMA_BASE_URL", "http://192.0.2.10:11434");
  fetchMock.mockResolvedValue(response(notificationCopyPhrases.brief[1]));
  const result = await createNotificationCopy({
    level: "brief",
    count: 1,
    useLocalModel: true
  });
  expect(result.body).toBe(notificationCopyPhrases.brief[1]);
  expect(String(fetchMock.mock.calls[0][0])).toBe("http://192.0.2.10:11434/api/chat");
});

it.each(["ftp://self-hosted.example.test", "https://user:password@self-hosted.example.test", "https://self-hosted.example.test/#fragment", "not a URL", "https://self-hosted.example.test/ollama?query=private"])("rejects unsafe base URL %s", async base => {
  vi.stubEnv("OLLAMA_BASE_URL", base);
  await createNotificationCopy({
    level: "brief",
    count: 1,
    useLocalModel: true
  });
  expect(fetchMock).not.toHaveBeenCalled();
});


it.each([
  "https://models.example.test/ollama",
  "https://models.example.test/ollama/",
])("preserves the configured Ollama path prefix %s", async base => {
  vi.stubEnv("OLLAMA_BASE_URL", base);
  fetchMock.mockResolvedValue(response(notificationCopyPhrases.brief[1]));
  const result = await createNotificationCopy({
    level: "brief",
    count: 1,
    useLocalModel: true,
  });
  expect(result.body).toBe(notificationCopyPhrases.brief[1]);
  expect(String(fetchMock.mock.calls[0][0])).toBe("https://models.example.test/ollama/api/chat");
  expect(fetchMock.mock.calls[0][1].redirect).toBe("error");
});
