import { describe, expect, it } from "vitest";

import { interleaveTapeEntries, tapeMarqueeCopies } from "../tape-order";
import { TAPE_STOCK_PAIRS, TAPE_WRAPPED_PAIRS } from "../base-pairs";

describe("interleaveTapeEntries", () => {
  it("alternates stock → Coinbase asset → stock → …", () => {
    expect(interleaveTapeEntries(["AAPLc", "TSLAc", "NVDAc"], ["cbBTC", "cbETH"])).toEqual([
      "AAPLc",
      "cbBTC",
      "TSLAc",
      "cbETH",
      "NVDAc",
    ]);
  });

  it("appends the remainder once one side runs out", () => {
    expect(interleaveTapeEntries(["a", "b"], ["1"])).toEqual(["a", "1", "b"]);
    expect(interleaveTapeEntries(["a"], ["1", "2"])).toEqual(["a", "1", "2"]);
  });

  it("is deterministic for the same inputs (stable marquee across refreshes)", () => {
    const first = interleaveTapeEntries(["AAPLc", "TSLAc"], ["cbBTC"]);
    const second = interleaveTapeEntries(["AAPLc", "TSLAc"], ["cbBTC"]);
    expect(first).toEqual(second);
  });

  it("only ever uses the two authoritative tape sources", () => {
    // The ticker symbols are derived from the typed allowlist segments —
    // no arbitrary stock tickers can appear.
    const ticker = interleaveTapeEntries(
      TAPE_STOCK_PAIRS.map((pair) => pair.symbol),
      TAPE_WRAPPED_PAIRS.map((pair) => pair.symbol),
    );
    const allowed = new Set([
      ...TAPE_STOCK_PAIRS.map((pair) => pair.symbol),
      ...TAPE_WRAPPED_PAIRS.map((pair) => pair.symbol),
    ]);
    expect(ticker.length).toBe(allowed.size);
    for (const symbol of ticker) expect(allowed.has(symbol)).toBe(true);
  });
});

describe("tapeMarqueeCopies", () => {
  it("uses the minimum two copies and never exceeds five", () => {
    expect(tapeMarqueeCopies(0, 1440)).toBe(2);
    expect(tapeMarqueeCopies(1800, 390)).toBe(2);
    expect(tapeMarqueeCopies(1800, 2000)).toBe(3);
    expect(tapeMarqueeCopies(10, 4000)).toBe(5);
  });
});
