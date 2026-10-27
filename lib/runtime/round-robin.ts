// In-process round-robin. Spreads free-tier quota across a pool without
// dropping failover: the caller still walks the rotated list in order.
// Not durable across serverless isolates, which is what we want — each
// isolate keeps its own cursor and a cold start just begins at index 0.

const cursors = new Map<string, number>();

export function roundRobin<T>(poolId: string, items: readonly T[]): T[] {
  if (items.length <= 1) return [...items];
  const start = (cursors.get(poolId) ?? 0) % items.length;
  cursors.set(poolId, (start + 1) % items.length);
  return [...items.slice(start), ...items.slice(0, start)];
}

export function resetRoundRobinForTests(): void {
  cursors.clear();
}
