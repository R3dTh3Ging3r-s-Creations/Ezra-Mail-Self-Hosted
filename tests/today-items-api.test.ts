import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  updateBriefItemMemory: vi.fn(),
  applyProfessionalMailAction: vi.fn(),
}));

vi.mock("@/lib/email/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/auth")>();
  return { ...actual, requireAuth: mocks.requireAuth };
});
vi.mock("@/lib/email/brief-memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/brief-memory")>();
  mocks.updateBriefItemMemory.mockImplementation(actual.updateBriefItemMemory);
  return { ...actual, updateBriefItemMemory: mocks.updateBriefItemMemory };
});
vi.mock("@/lib/email/professional", () => ({
  applyProfessionalMailAction: mocks.applyProfessionalMailAction,
}));

import { POST } from "@/app/api/today/items/route";
import { AuthError } from "@/lib/email/auth";
import { reconcileBriefMemory } from "@/lib/email/brief-memory";
import { closeEmailDatabaseForTests, configureEmailDatabaseForTests, execute } from "@/lib/email/database";

const NOW = "2026-08-31T14:00:00.000Z";
const WORKSPACE = "workspace:account:gmail:gmail-1";
const VALID_ITEM_ID = "brief-item";

describe("POST /api/today/items", () => {
  let itemId: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    mocks.requireAuth.mockReset().mockResolvedValue(undefined);
    mocks.updateBriefItemMemory.mockClear();
    mocks.applyProfessionalMailAction.mockReset();
    configureEmailDatabaseForTests(`file:./today-items-api-${randomUUID()}.sqlite`);
    await seedAccount("gmail-1", "gmail");
    const memory = await reconcileBriefMemory({
      workspaceId: WORKSPACE,
      now: NOW,
      candidates: [candidate("gmail-1", "thread-1")],
    });
    itemId = memory.current[0].id;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeEmailDatabaseForTests();
  });

  it("authenticates before any local mutation", async () => {
    mocks.requireAuth.mockRejectedValue(new AuthError("Sign in required.", 401));

    const response = await POST(request({ workspaceId: WORKSPACE, itemId, action: "complete" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "Sign in required." });
    expect(mocks.updateBriefItemMemory).not.toHaveBeenCalled();
    expect(mocks.applyProfessionalMailAction).not.toHaveBeenCalled();
  });

  it.each([
    ["missing workspace", { itemId: VALID_ITEM_ID, action: "complete" }],
    ["blank workspace", { workspaceId: " ", itemId: VALID_ITEM_ID, action: "complete" }],
    ["missing item", { workspaceId: WORKSPACE, action: "complete" }],
    ["blank item", { workspaceId: WORKSPACE, itemId: " ", action: "complete" }],
    ["unknown action", { workspaceId: WORKSPACE, itemId: VALID_ITEM_ID, action: "archive" }],
    ["extra input", { workspaceId: WORKSPACE, itemId: VALID_ITEM_ID, action: "complete", providerToken: "secret" }],
    ["oversized workspace", { workspaceId: `workspace:${"x".repeat(300)}`, itemId: VALID_ITEM_ID, action: "complete" }],
    ["oversized item", { workspaceId: WORKSPACE, itemId: "x".repeat(300), action: "complete" }],
  ])("rejects %s", async (_label, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(mocks.updateBriefItemMemory).not.toHaveBeenCalled();
    expect(mocks.applyProfessionalMailAction).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before mutation", async () => {
    const response = await POST(new Request("http://localhost/api/today/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    }));

    expect(response.status).toBe(400);
    expect(mocks.updateBriefItemMemory).not.toHaveBeenCalled();
  });

  it("forwards Complete, Bring back, and Dismiss as exact local memory actions", async () => {
    const complete = await POST(request({ workspaceId: WORKSPACE, itemId, action: "complete" }));
    expect(complete.status).toBe(200);
    await expect(complete.json()).resolves.toMatchObject({ item: { id: itemId, state: "completed" } });
    expect(mocks.updateBriefItemMemory).toHaveBeenLastCalledWith({ workspaceId: WORKSPACE, itemId, action: "complete" });

    const bringBack = await POST(request({ workspaceId: WORKSPACE, itemId, action: "bring_back" }));
    expect(bringBack.status).toBe(200);
    await expect(bringBack.json()).resolves.toMatchObject({ item: { id: itemId, state: "open" } });
    expect(mocks.updateBriefItemMemory).toHaveBeenLastCalledWith({ workspaceId: WORKSPACE, itemId, action: "bring_back" });

    const dismiss = await POST(request({ workspaceId: WORKSPACE, itemId, action: "dismiss" }));
    expect(dismiss.status).toBe(200);
    await expect(dismiss.json()).resolves.toMatchObject({ item: { id: itemId, state: "dismissed" } });
    expect(mocks.updateBriefItemMemory).toHaveBeenLastCalledWith({ workspaceId: WORKSPACE, itemId, action: "dismiss" });
    expect(mocks.updateBriefItemMemory).toHaveBeenCalledTimes(3);
    expect(mocks.applyProfessionalMailAction).not.toHaveBeenCalled();
  });

  it("rejects a missing item and an owning-workspace mismatch without changing the item", async () => {
    const missing = await POST(request({ workspaceId: WORKSPACE, itemId: "brief-missing", action: "complete" }));
    expect(missing.status).toBe(400);

    const mismatch = await POST(request({
      workspaceId: "workspace:account:microsoft:microsoft-1",
      itemId,
      action: "dismiss",
    }));
    expect(mismatch.status).toBe(400);

    const rows = await execute("SELECT state FROM brief_item_memory WHERE id = ?", [itemId]);
    expect(rows.rows).toEqual([{ state: "open" }]);
    expect(mocks.applyProfessionalMailAction).not.toHaveBeenCalled();
  });

  it("rejects an item whose account is outside the selected workspace", async () => {
    await seedAccount("microsoft-1", "microsoft");
    const other = await reconcileBriefMemory({
      workspaceId: "workspace:all",
      now: NOW,
      candidates: [candidate("microsoft-1", "thread-ms", "microsoft")],
    });

    const response = await POST(request({
      workspaceId: WORKSPACE,
      itemId: other.current[0].id,
      action: "complete",
    }));

    expect(response.status).toBe(400);
    const rows = await execute("SELECT state FROM brief_item_memory WHERE id = ?", [other.current[0].id]);
    expect(rows.rows).toEqual([{ state: "open" }]);
    expect(mocks.applyProfessionalMailAction).not.toHaveBeenCalled();
  });
});

function request(body: unknown) {
  return new Request("http://localhost/api/today/items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function candidate(accountId: string, threadId: string, provider: "gmail" | "microsoft" = "gmail") {
  return {
    sourceType: "mail_thread" as const,
    sourceKey: `mail:${accountId}:${threadId}`,
    sourceAccountId: accountId,
    provider,
    providerThreadId: threadId,
    revisionAt: "2026-08-31T13:30:00.000Z",
    occurredAt: "2026-08-31T13:30:00.000Z",
    role: "attention" as const,
    title: `Reply on ${threadId}`,
    summary: "A reply is still needed.",
    target: { view: "mail" as const, messageId: `${threadId}-message` },
  };
}

async function seedAccount(id: string, provider: "gmail" | "microsoft") {
  await execute(
    `INSERT INTO email_accounts
      (id, provider, email, label, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'connected', ?, ?)`,
    [id, provider, `${id}@example.test`, id, NOW, NOW],
  );
}
