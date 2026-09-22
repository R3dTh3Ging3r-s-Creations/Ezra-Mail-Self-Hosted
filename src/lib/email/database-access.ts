// SQLite's native calls are synchronous. Never let one local connection wait
// for a transaction whose continuation needs this same JavaScript thread.
// Callbacks must use their supplied connection, never re-enter this queue.
let accessTail: Promise<unknown> = Promise.resolve();
export function withEmailDatabaseAccess<T>(operation: () => Promise<T>): Promise<T> {
  const run = accessTail.then(operation);
  accessTail = run.catch(() => undefined);
  return run;
}
