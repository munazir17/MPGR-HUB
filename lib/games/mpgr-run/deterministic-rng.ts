export interface DeterministicRng {
  next(): number;
  int(min: number, max: number): number;
  range(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
}

function normalizeSeed(seed: number | string): number {
  if (typeof seed === "number") {
    if (!Number.isFinite(seed)) {
      throw new Error("Seed must be finite");
    }

    return seed >>> 0;
  }

  if (!/^[0-9a-fA-F]{64}$/.test(seed)) {
    throw new Error("Seed must be a 32-byte hexadecimal string");
  }

  // Fold the complete 256-bit server seed into the 32-bit state expected
  // by Mulberry32. Every byte participates; no unsafe JS integer conversion
  // of the 256-bit value is performed.
  let state = 0x811c9dc5;

  for (let i = 0; i < seed.length; i += 2) {
    state ^= Number.parseInt(seed.slice(i, i + 2), 16);
    state = Math.imul(state, 0x01000193);
  }

  return state >>> 0;
}

export function createDeterministicRng(seed: number | string): DeterministicRng {
  let state = normalizeSeed(seed);

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;

    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
      throw new Error("Invalid integer range");
    }

    return Math.floor(next() * (max - min + 1)) + min;
  };

  const range = (min: number, max: number): number => {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      throw new Error("Invalid range");
    }

    return min + next() * (max - min);
  };

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) {
      throw new Error("Cannot pick from an empty collection");
    }

    return items[int(0, items.length - 1)];
  };

  const shuffle = <T>(items: readonly T[]): T[] => {
    const result = [...items];

    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = int(0, i);
      [result[i], result[j]] = [result[j], result[i]];
    }

    return result;
  };

  return {
    next,
    int,
    range,
    pick,
    shuffle,
  };
}
