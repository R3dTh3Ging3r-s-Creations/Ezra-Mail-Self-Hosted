import { createClient } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/email/service', () => ({
  consolidatePreferences: vi.fn(), ensureTelegramStarted: vi.fn(),
  isInteractiveModelBusy: vi.fn(async () => false), pollGmail: vi.fn(),
  processUnreadBacklogBatch: vi.fn(async () => undefined),
}));
vi.mock('@/lib/email/notification-worker', () => ({ runNotificationWork: vi.fn() }));
vi.mock('@/lib/email/calendar', async original => ({
  ...await original<typeof import('@/lib/email/calendar')>(), syncCalendarAccounts: vi.fn(async () => undefined),
}));
vi.mock('@/lib/email/system-recovery', () => ({ readDeploymentRevision: vi.fn(async () => 'synthetic-revision') }));
import { configureEmailDatabaseForTests, closeEmailDatabaseForTests, execute, getServiceState, nowIso } from '@/lib/email/database';
import { startEmailWorker, stopEmailWorker } from '@/lib/email/worker';
afterEach(async () => { stopEmailWorker(); await closeEmailDatabaseForTests(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it('persists worker heartbeats alongside real morning brief database work', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-21T14:00:00Z'));
  vi.stubEnv('EZRA_EMAIL_MODEL_REF', 'unsupported/synthetic');
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected synthetic network access'));
  const url = configureEmailDatabaseForTests('file:./worker-integration-' + randomUUID() + '.sqlite');
  await execute("INSERT INTO email_accounts (id,provider,email,label,status,created_at,updated_at) VALUES ('gmail-1','gmail','owner@example.test','Synthetic','connected',?,?)", [nowIso(), nowIso()]);
  await closeEmailDatabaseForTests();
  let interval!: () => void;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => { interval = callback; return 1; }) as typeof setInterval);
  await startEmailWorker();
  expect(await getServiceState('worker_heartbeat')).toBe('2026-09-21T14:00:00.000Z');
  expect(await getServiceState('worker_revision')).toBe('synthetic-revision');
  vi.setSystemTime(new Date('2026-09-21T14:01:00Z'));
  interval();
  await vi.waitFor(async () => expect(Date.parse((await getServiceState('worker_heartbeat'))!)).toBeGreaterThanOrEqual(Date.parse('2026-09-21T14:01:00Z')));
  await vi.waitFor(async () => expect((await execute("SELECT COUNT(*) AS n FROM morning_brief_jobs WHERE state='done'")).rows[0].n).toBe(2));
  const reader = createClient({ url });
  try {
    const persisted = (await reader.execute("SELECT value FROM service_state WHERE key='worker_heartbeat'")).rows[0].value;
    expect(persisted).toBe(await getServiceState('worker_heartbeat'));
    expect((await reader.execute("SELECT COUNT(*) AS n FROM morning_brief_snapshots WHERE published_at IS NOT NULL")).rows[0].n).toBe(2);
  } finally { reader.close(); }
  await vi.waitFor(() => {
    const state = (globalThis as typeof globalThis & { __ezraEmailWorker?: { ticking: boolean; morningBriefTicking: boolean } }).__ezraEmailWorker;
    expect(state?.ticking || state?.morningBriefTicking).toBe(false);
  });
  expect(network).not.toHaveBeenCalled();
});

