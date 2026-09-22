// Minimal transactional IDB boundary double. Browser fixture also exercises real IDB.
export function markerDatabase() {
  const rows = new Map<string, { eventId: string; receivedAt: number }>();
  let queue = Promise.resolve();
  const database = {
    close() {}, createObjectStore() {},
    transaction() {
      const staged = new Map<string, { eventId: string; receivedAt: number }>();
      let release!: () => void;
      const before = queue;
      queue = new Promise<void>(resolve => { release = resolve; });
      const tx: any = { oncomplete: null, onerror: null, onabort: null };
      let pending = 0, initialized = false;
      const request = (action: () => unknown) => {
        pending++;
        const req: any = {};
        void before.then(() => {
          if (!initialized) { for (const [key, value] of rows) staged.set(key, value); initialized = true; }
          req.result = action();
          req.onsuccess?.();
          pending--;
          if (!pending) {
            rows.clear();
            for (const [key, value] of staged) rows.set(key, value);
            tx.oncomplete?.(); release();
          }
        });
        return req;
      };
      tx.objectStore = () => ({
        getAll: () => request(() => [...staged.values()]),
        get: (key: string) => request(() => staged.get(key)),
        put: (value: { eventId: string; receivedAt: number }) => request(() => staged.set(value.eventId, value)),
        delete: (key: string) => request(() => staged.delete(key)),
      });
      return tx;
    },
  };
  return { rows, open() {
    const req: any = {};
    queueMicrotask(() => { req.result = database; req.onupgradeneeded?.(); req.onsuccess?.(); });
    return req;
  } };
}
