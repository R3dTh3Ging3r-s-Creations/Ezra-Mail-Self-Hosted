import { randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import { afterEach, expect, it } from 'vitest';
import { configureEmailDatabaseForTests, closeEmailDatabaseForTests, execute, executeBatch, setServiceState } from '@/lib/email/database';
import { withNotificationStoreWrite } from '@/lib/email/notification-store';
afterEach(closeEmailDatabaseForTests);

it('lets an owned transaction commit before a concurrent heartbeat and atomic batch enter SQLite', async () => {
  const url = configureEmailDatabaseForTests('file:./database-access-' + randomUUID() + '.sqlite');
  await execute('PRAGMA busy_timeout = 0');
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => entered = resolve);
  const held = new Promise<void>(resolve => release = resolve);
  const transaction = withNotificationStoreWrite(async tx => {
    await tx.execute("INSERT INTO service_state VALUES ('transaction','committed','synthetic')");
    entered();
    await held;
  });
  await ready;
  const heartbeat = setServiceState('worker_heartbeat', 'synthetic-current');
  const batch = executeBatch([
    "INSERT INTO service_state VALUES ('batch-first','committed','synthetic')",
    "INSERT INTO service_state VALUES ('batch-second','committed','synthetic')",
  ]);
  const outcome = Promise.allSettled([transaction, heartbeat, batch]);
  // The event loop is free to finish the existing transaction.
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  release();
  expect((await outcome).map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
  const reader = createClient({ url });
  try {
    expect((await reader.execute("SELECT key,value FROM service_state ORDER BY key")).rows).toEqual([
      expect.objectContaining({ key: 'batch-first', value: 'committed' }),
      expect.objectContaining({ key: 'batch-second', value: 'committed' }),
      expect.objectContaining({ key: 'transaction', value: 'committed' }),
      expect.objectContaining({ key: 'worker_heartbeat', value: 'synthetic-current' }),
    ]);
  } finally { reader.close(); }
});

it('rolls back a failed transaction and lets queued heartbeat work persist', async () => {
  configureEmailDatabaseForTests('file:./database-access-' + randomUUID() + '.sqlite');
  await execute('SELECT 1');
  const failed = withNotificationStoreWrite(async tx => {
    await tx.execute("INSERT INTO service_state VALUES ('rolled-back','no','synthetic')");
    throw new Error('Synthetic transaction failure');
  });
  const heartbeat = setServiceState('worker_heartbeat', 'after-rollback');
  const results = await Promise.allSettled([failed, heartbeat]);
  expect(results[0].status).toBe('rejected');
  expect(results[1].status).toBe('fulfilled');
  expect((await execute("SELECT key,value FROM service_state ORDER BY key")).rows).toEqual([
    expect.objectContaining({ key: 'worker_heartbeat', value: 'after-rollback' }),
  ]);
});
