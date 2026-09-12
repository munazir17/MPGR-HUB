/**
 * Deterministic pseudo-random number generator for MPGR Run.
 *
 * The same unsigned 32-bit seed always produces the same sequence.
 * This module is intentionally pure from the game's perspective:
 * no Math.random(), Date.now(), crypto, or browser APIs.
 */

export interface DeterministicRng {
  /** Returns the next value in [0, 1). */
  next(): number;

  /** Returns an integer in [min, max]. */
  int(min: number, max: number): number;

  /** Returns a value in [min, max). */
  range(min: number, max: number): number;

  /** Returns one item from a non-empty array. */
  pick<T>(items: readonly T[]): T;

  /** Returns a shuffled copy without mutating the input. */
  shuffle<T>(items: readonly T[]): T[];
}

/**
 * Mulberry32 PRNG.
 *
 * Kept deliberately small and dependency-free so it can run identically
 * in browser and server environments.
 */
export function createDeterministicRng(seed: number): DeterministicRng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;

    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
      throw new Error("Invalid deterministic RNG integer range");
    }

    return min + Math.floor(next() * (max - min + 1));
  };

  const range = (min: number, max: number): number => {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      throw new Error("Invalid deterministic RNG range");
    }

    return min + next() * (max - min);
  };

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) {
      throw new Error("Cannot pick from an empty array");
    }

    return items[Math.floor(next() * items.length)];
  };

  const shuffle = <T>(items: readonly T[]): T[] => {
    const result = [...items];

    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
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
