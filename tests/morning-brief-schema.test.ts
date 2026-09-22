import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { configureEmailDatabaseForTests, ensureEmailDatabase, getEmailClient, closeEmailDatabaseForTests } from '@/lib/email/database';
import { migrateMorningBriefSchema } from '@/lib/email/morning-brief-schema';
describe('morning schema migration', () => {
    it('is additive, repeatable and never downgrades a later schema', async () => {
        configureEmailDatabaseForTests('file:./morning-schema-' + randomUUID() + '.sqlite');
        try {
            await ensureEmailDatabase();
            const c = getEmailClient();
            await c.execute('PRAGMA user_version=9');
            await migrateMorningBriefSchema(c);
            await migrateMorningBriefSchema(c);
            expect((await c.execute('PRAGMA user_version')).rows[0].user_version).toBe(10);
            expect((await c.execute("SELECT name FROM sqlite_master WHERE name IN ('daily_briefs','brief_item_memory','morning_brief_snapshots')")).rows).toHaveLength(3);
            await c.execute('PRAGMA user_version=11');
            await migrateMorningBriefSchema(c);
            expect((await c.execute('PRAGMA user_version')).rows[0].user_version).toBe(11);
        }
        finally {
            await closeEmailDatabaseForTests();
        }
    });
    it('rolls back its tables and version when migration fails before commit', async () => {
        configureEmailDatabaseForTests('file:./morning-rollback-' + randomUUID() + '.sqlite');
        try {
            await ensureEmailDatabase();
            const c = getEmailClient();
            for (const table of ['morning_brief_updates', 'morning_brief_jobs', 'morning_brief_snapshots'])
                await c.execute('DROP TABLE ' + table);
            await c.execute('PRAGMA user_version=9');
            const original = c.transaction.bind(c);
            const spy = vi.spyOn(c, 'transaction').mockImplementation(async () => { const tx = await original('write'); const run = tx.execute.bind(tx); vi.spyOn(tx, 'execute').mockImplementation(async (stmt) => { if (stmt === 'PRAGMA user_version=10')
                throw new Error('synthetic migration failure'); return run(stmt); }); return tx; });
            await expect(migrateMorningBriefSchema(c)).rejects.toThrow('synthetic migration failure');
            spy.mockRestore();
            expect((await c.execute('PRAGMA user_version')).rows[0].user_version).toBe(9);
            expect((await c.execute("SELECT name FROM sqlite_master WHERE name='morning_brief_snapshots'")).rows).toHaveLength(0);
        }
        finally {
            await closeEmailDatabaseForTests();
        }
    });
});
