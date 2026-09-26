import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetTradeQuoteCache, withTradeQuoteCache } from "../trade-quote-cache";

describe("withTradeQuoteCache", () => {
  beforeEach(() => {
    resetTradeQuoteCache();
    vi.useRealTimers();
  });

  it("shares one computation between concurrent callers", async () => {
    const compute = vi.fn(async () => "quote-1");
    const [a, b] = await Promise.all([
      withTradeQuoteCache("k", 1_000, compute),
      withTradeQuoteCache("k", 1_000, compute),
    ]);
    expect(a).toBe("quote-1");
    expect(b).toBe("quote-1");
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("reuses a value inside the TTL and recomputes after it", async () => {
    vi.useFakeTimers();
    const compute = vi.fn(async () => `quote-${compute.mock.calls.length}`);
    await withTradeQuoteCache("k", 1_000, compute);
    await withTradeQuoteCache("k", 1_000, compute);
    expect(compute).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_500);
    await withTradeQuoteCache("k", 1_000, compute);
    expect(compute).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("never caches a rejection", async () => {
    const failing = vi.fn(async () => {
      throw new Error("upstream down");
    });
    await expect(withTradeQuoteCache("k", 1_000, failing)).rejects.toThrow("upstream down");
    await expect(withTradeQuoteCache("k", 1_000, failing)).rejects.toThrow("upstream down");
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("keys are independent — another wallet or pair is a separate quote", async () => {
    const compute = vi.fn(async (tag: string) => tag);
    await withTradeQuoteCache("wallet-a", 1_000, () => compute("a"));
    await withTradeQuoteCache("wallet-b", 1_000, () => compute("b"));
    expect(compute.mock.calls.map((call) => call[0])).toEqual(["a", "b"]);
  });
});

describe("quote cache failure and age boundaries", () => {
  it("never reuses ok:false values", async () => {
    resetTradeQuoteCache();
    const compute = vi.fn(async () => ({ ok: false, error: "no route" }));
    await withTradeQuoteCache("failure", 6000, compute);
    await withTradeQuoteCache("failure", 6000, compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });
  it("does not cache a computation that took longer than its freshness window", async () => {
    resetTradeQuoteCache(); vi.useFakeTimers();
    const compute = vi.fn(async () => { vi.advanceTimersByTime(7000); return { ok: true }; });
    try {
      await withTradeQuoteCache("slow", 6000, compute);
      await withTradeQuoteCache("slow", 6000, compute);
      expect(compute).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});
