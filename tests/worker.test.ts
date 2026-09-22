import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setServiceState: vi.fn(),
  getServiceState: vi.fn(async (_key: string) => null as string | null),
  pollGmail: vi.fn(),
  notificationTick: vi.fn(),
  briefTick: vi.fn(),
  stopBrief: vi.fn(),
  telegramStarted: vi.fn(),
}));

vi.mock("@/lib/email/database", () => ({
  getServiceState: mocks.getServiceState,
  getSetting: vi.fn(async (key: string) => key === "timezone" ? "America/Chicago" : key === "digest_times" ? "[]" : "5"),
  nowIso: vi.fn(() => "2026-07-13T00:00:00.000Z"),
  setServiceState: mocks.setServiceState,
}));

vi.mock("@/lib/email/service", () => ({
  consolidatePreferences: vi.fn(),
  ensureTelegramStarted: mocks.telegramStarted,
  isInteractiveModelBusy: vi.fn(async () => false),
  pollGmail: mocks.pollGmail,
  processUnreadBacklogBatch: vi.fn(async () => undefined),
  sendScheduledDigest: vi.fn(),
}));

vi.mock("@/lib/email/morning-brief-worker", () => ({ runMorningBriefWork: mocks.briefTick, stopMorningBriefWork: mocks.stopBrief }));

vi.mock("@/lib/email/notification-worker", () => ({ runNotificationWork: mocks.notificationTick }));

vi.mock("@/lib/email/system-recovery", () => ({
  readDeploymentRevision: vi.fn(async () => "revision-test"),
}));

vi.mock("@/lib/email/calendar", () => ({
  syncCalendarAccounts: vi.fn(async () => undefined),
}));

import { getWorkerStatus, startEmailWorker, stopEmailWorker } from "@/lib/email/worker";

describe("email worker resilience", () => {
  afterEach(() => {
    stopEmailWorker();
    mocks.setServiceState.mockReset();
    mocks.setServiceState.mockResolvedValue(undefined);
    mocks.getServiceState.mockReset();
    mocks.getServiceState.mockResolvedValue(null);
    mocks.pollGmail.mockReset();
    mocks.notificationTick.mockReset();
    mocks.briefTick.mockReset();
    mocks.stopBrief.mockReset();
    mocks.telegramStarted.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("drains notification work on later ticks while provider polling is still in flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T15:00:00Z"));
    let release!: () => void;
    mocks.pollGmail.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const starting = startEmailWorker();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.notificationTick).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60000);
      expect(mocks.notificationTick).toHaveBeenCalledTimes(2);
    } finally { release?.(); await starting; }
    stopEmailWorker(); await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.notificationTick).toHaveBeenCalledTimes(2);
  });

  it("keeps heartbeat and notifications moving while morning generation is pending", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-21T14:00:00Z"));
    let release!: () => void;
    mocks.briefTick.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const starting = startEmailWorker();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.briefTick).toHaveBeenCalledTimes(1);
      const before = mocks.setServiceState.mock.calls.filter(c => c[0] === "worker_heartbeat").length;
      await vi.advanceTimersByTimeAsync(60000);
      expect(mocks.notificationTick).toHaveBeenCalledTimes(2);
      expect(mocks.setServiceState.mock.calls.filter(c => c[0] === "worker_heartbeat").length).toBeGreaterThan(before);
      expect(mocks.briefTick).toHaveBeenCalledTimes(1);
    } finally { release?.(); await starting; }
    stopEmailWorker(); expect(mocks.stopBrief).toHaveBeenCalled();
  });

  it("stays running when a transient database error aborts a tick", async () => {
    mocks.setServiceState.mockRejectedValueOnce(new Error("SQLITE_BUSY: database is locked"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(startEmailWorker()).resolves.toMatchObject({ running: true });

    expect(getWorkerStatus().running).toBe(true);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("retrying on the next interval"));
  });

  it("keeps its heartbeat active while an emergency pause suppresses provider polling", async () => {
    mocks.getServiceState.mockImplementation(async (key: string) =>
      key === "polling_paused_at" ? "2026-07-16T12:00:00.000Z" : null,
    );

    await startEmailWorker();

    expect(mocks.pollGmail).not.toHaveBeenCalled();
    expect(mocks.setServiceState).toHaveBeenCalledWith("worker_revision", "revision-test");
    expect(mocks.setServiceState).toHaveBeenCalledWith("worker_heartbeat", "2026-07-13T00:00:00.000Z");
    expect(mocks.setServiceState).toHaveBeenCalledWith("worker_polling_state", "paused");
  });
});

it("checks Telegram enrollment again after worker startup without another delivery loop", async () => { vi.useFakeTimers(); try { await startEmailWorker(); const initial=mocks.telegramStarted.mock.calls.length; await vi.advanceTimersByTimeAsync(60000); expect(mocks.telegramStarted.mock.calls.length).toBeGreaterThan(initial); } finally { stopEmailWorker(); vi.useRealTimers(); } });
