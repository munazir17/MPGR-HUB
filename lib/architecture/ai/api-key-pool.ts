// Server-only key lists. A single key stays valid. Extra keys are a
// comma or whitespace separated list. Rotation spreads free-tier quota;
// a 429/5xx tries the next key. Keys are never logged.

const cursors = new Map<string, number>();

export function readApiKeys(singleEnv: string, listEnv: string): string[] {
  const raw = [process.env[singleEnv], process.env[listEnv]];
  const keys: string[] = [];
  for (const value of raw) {
    if (!value) continue;
    for (const part of value.split(/[\s,]+/)) {
      const key = part.trim();
      if (key && !keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/** Next request starts on the following key so one free account is not hit first every time. */
export function rotateApiKeys(poolId: string, keys: readonly string[]): string[] {
  if (keys.length <= 1) return [...keys];
  const start = (cursors.get(poolId) ?? 0) % keys.length;
  cursors.set(poolId, start + 1);
  return [...keys.slice(start), ...keys.slice(0, start)];
}

export function isRetryableProviderStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function resetApiKeyCursorsForTests(): void {
  cursors.clear();
}
