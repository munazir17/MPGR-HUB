import { describe, expect, it } from "vitest";
import { RunDrawQueue, runDrawQueue } from "./run-draw-queue";

describe("reusable presentation depth queue", () => {
  it("sorts far-to-near, preserving insertion order at equal depths", () => {
    const q = new RunDrawQueue();
    q.add(0, 2, 0, 1); q.add(100, 3, 1, 0.75); q.add(0, 4, 2, 1);
    q.sort(); expect(q.entries.map(e => e.index)).toEqual([1, 0, 2]);
  });
  it("reuses objects, excludes stale items, and remains stable after shrinking", () => {
    const q = new RunDrawQueue();
    for (let i = 0; i < 20; i++) q.add(i, 0, i, 1);
    const originals = new Set(q.entries);
    for (let frame = 0; frame < 100; frame++) {
      q.begin(); const count = frame % 20 + 1;
      for (let i = 0; i < count; i++) q.add(10, i, i, 1);
      q.sort(); expect(q.count).toBe(count); expect(q.entries).toHaveLength(20);
      expect(q.entries.every(e => originals.has(e))).toBe(true);
      expect(q.entries.slice(0, count).map(e => e.index)).toEqual(Array.from({ length: count }, (_, i) => i));
      expect(q.entries.slice(count).every(e => e.z === -Infinity)).toBe(true);
    }
  });
  it("isolates contexts and starts each frame empty", () => {
    const a = {} as CanvasRenderingContext2D, b = {} as CanvasRenderingContext2D;
    const qa = runDrawQueue(a); qa.add(20, 0, 0, 1);
    expect(runDrawQueue(b)).not.toBe(qa);
    expect(runDrawQueue(a)).toBe(qa); expect(qa.count).toBe(0);
  });
});
