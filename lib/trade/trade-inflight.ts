/** Single-flight only: completed values/quotes are never reused here. */
export function createSingleFlight<T>() {
  const pending = new Map<string, Promise<T>>();
  return (key: string, compute: () => Promise<T>): Promise<T> => {
    const existing = pending.get(key);
    if (existing) return existing;
    const promise = Promise.resolve().then(compute).finally(() => { pending.delete(key); });
    pending.set(key, promise);
    return promise;
  };
}
