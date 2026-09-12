import { describe, expect, it } from "vitest";
import { createDeterministicRng } from "./deterministic-rng";

describe("deterministic RNG", () => {
  it("produces the same sequence for the same seed", () => {
    const a = createDeterministicRng(123456789);
    const b = createDeterministicRng(123456789);

    const sequenceA = Array.from({ length: 20 }, () => a.next());
    const sequenceB = Array.from({ length: 20 }, () => b.next());

    expect(sequenceA).toEqual(sequenceB);
  });

  it("produces a different sequence for different seeds", () => {
    const a = createDeterministicRng(123456789);
    const b = createDeterministicRng(987654321);

    expect(Array.from({ length: 10 }, () => a.next()))
      .not.toEqual(Array.from({ length: 10 }, () => b.next()));
  });

  it("keeps next() in [0, 1)", () => {
    const rng = createDeterministicRng(42);

    for (let i = 0; i < 1000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("returns inclusive integer ranges", () => {
    const rng = createDeterministicRng(42);
    const seen = new Set<number>();

    for (let i = 0; i < 1000; i += 1) {
      const value = rng.int(1, 3);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(3);
      seen.add(value);
    }

    expect(seen).toEqual(new Set([1, 2, 3]));
  });

  it("returns values inside the requested range", () => {
    const rng = createDeterministicRng(42);

    for (let i = 0; i < 1000; i += 1) {
      const value = rng.range(10, 20);
      expect(value).toBeGreaterThanOrEqual(10);
      expect(value).toBeLessThan(20);
    }
  });

  it("picks only from the supplied collection", () => {
    const rng = createDeterministicRng(42);
    const items = ["a", "b", "c"];

    for (let i = 0; i < 100; i += 1) {
      expect(items).toContain(rng.pick(items));
    }
  });

  it("shuffles deterministically without mutating the input", () => {
    const items = [0, 1, 2, 3, 4, 5];

    const a = createDeterministicRng(42);
    const b = createDeterministicRng(42);

    const original = [...items];
    const shuffledA = a.shuffle(items);
    const shuffledB = b.shuffle(items);

    expect(items).toEqual(original);
    expect(shuffledA).toEqual(shuffledB);
    expect(shuffledA).toHaveLength(items.length);
    expect([...shuffledA].sort()).toEqual([...items].sort());
  });

  it("normalizes seeds to unsigned 32-bit state", () => {
    const a = createDeterministicRng(-1);
    const b = createDeterministicRng(0xffffffff);

    expect(Array.from({ length: 10 }, () => a.next()))
      .toEqual(Array.from({ length: 10 }, () => b.next()));
  });

  it("rejects invalid ranges and empty picks", () => {
    const rng = createDeterministicRng(1);

    expect(() => rng.int(2, 1)).toThrow();
    expect(() => rng.range(2, 1)).toThrow();
    expect(() => rng.pick([])).toThrow();
  });
});

describe("server-issued hexadecimal seeds", () => {
  it("produces the same sequence for the same 32-byte seed", () => {
    const seed = "ab".repeat(32);
    const a = createDeterministicRng(seed);
    const b = createDeterministicRng(seed);

    expect(Array.from({ length: 20 }, () => a.next())).toEqual(
      Array.from({ length: 20 }, () => b.next()),
    );
  });

  it("produces a different sequence when the server seed changes", () => {
    const a = createDeterministicRng("ab".repeat(32));
    const b = createDeterministicRng("ac".repeat(32));

    expect(Array.from({ length: 20 }, () => a.next())).not.toEqual(
      Array.from({ length: 20 }, () => b.next()),
    );
  });

  it("rejects malformed server seeds", () => {
    expect(() => createDeterministicRng("ab".repeat(31))).toThrow();
    expect(() => createDeterministicRng("ab".repeat(33))).toThrow();
    expect(() => createDeterministicRng("zz".repeat(32))).toThrow();
  });

  it("accepts uppercase hexadecimal server seeds", () => {
    const lower = createDeterministicRng("ab".repeat(32));
    const upper = createDeterministicRng("AB".repeat(32));

    expect(Array.from({ length: 10 }, () => lower.next())).toEqual(
      Array.from({ length: 10 }, () => upper.next()),
    );
  });
});
