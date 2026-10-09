export function memoryIndexedDB(): IDBFactory {
  const stores = new Map<string, Map<string, unknown>>();
  const clone = (value: unknown): unknown => {
    if (value instanceof Blob) return value;
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, clone(item)]),
      );
    return value;
  };
  type Request = { result?: unknown; onsuccess?: () => void };
  const database = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => stores.set(name, new Map()),
    transaction: () => {
      let pending = 0;
      const transaction = {
        oncomplete: undefined as (() => void) | undefined,
        objectStore: (name: string) => {
          const values = stores.get(name)!;
          const schedule = (work: () => void) => {
            pending++;
            queueMicrotask(() => {
              work();
              pending--;
              queueMicrotask(() => {
                if (!pending) transaction.oncomplete?.();
              });
            });
          };
          const request = (work: () => unknown): Request => {
            const result: Request = {};
            schedule(() => {
              result.result = clone(work());
              result.onsuccess?.();
            });
            return result;
          };
          return {
            get: (key: string) => request(() => values.get(key)),
            getAll: () => request(() => [...values.values()]),
            put: (value: unknown, key: string) =>
              request(() => values.set(key, clone(value))),
            delete: (key: string) => request(() => values.delete(key)),
            openCursor: () => {
              const result: Request = {},
                keys = [...values.keys()];
              let index = 0;
              const next = () =>
                schedule(() => {
                  const key = keys[index++];
                  result.result =
                    key === undefined
                      ? null
                      : {
                          key,
                          value: clone(values.get(key)),
                          delete: () => values.delete(key),
                          continue: next,
                        };
                  result.onsuccess?.();
                });
              next();
              return result;
            },
          };
        },
      };
      return transaction;
    },
  };
  return {
    open: () => {
      const request = {
        result: database,
        onupgradeneeded: undefined as (() => void) | undefined,
        onsuccess: undefined as (() => void) | undefined,
      };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
}
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
