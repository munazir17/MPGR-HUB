import { beforeEach, describe, expect, it } from "vitest";

import {
  TAPE_HISTORY_CAPACITY,
  TAPE_HISTORY_MIN_SPACING_SECONDS,
  readTapeSamples,
  recordTapeSample,
  resetTapeHistory,
  tapeHistorySymbols,
} from "../tape-history";

describe("tape history sampler", () => {
  beforeEach(() => resetTapeHistory());

  it("records observed prices and keeps them ordered", () => {
    recordTapeSample("cbADA", 0.52, 1_000);
    recordTapeSample("cbADA", 0.53, 1_000 + TAPE_HISTORY_MIN_SPACING_SECONDS);
    expect(readTapeSamples("cbADA")).toEqual([
      { t: 1_000, price: 0.52 },
      { t: 1_000 + TAPE_HISTORY_MIN_SPACING_SECONDS, price: 0.53 },
    ]);
  });

  it("never records a missing or zero price", () => {
    recordTapeSample("cbBTC", null, 1_000);
    recordTapeSample("cbBTC", 0, 1_000);
    recordTapeSample("cbBTC", Number.NaN, 1_000);
    expect(tapeHistorySymbols()).toEqual([]);
  });

  it("throttles to one sample per spacing window", () => {
    recordTapeSample("AAPLc", 300, 1_000);
    recordTapeSample("AAPLc", 301, 1_001);
    recordTapeSample("AAPLc", 302, 1_000 + TAPE_HISTORY_MIN_SPACING_SECONDS - 1);
    expect(readTapeSamples("AAPLc")).toHaveLength(1);
    recordTapeSample("AAPLc", 303, 1_000 + TAPE_HISTORY_MIN_SPACING_SECONDS);
    expect(readTapeSamples("AAPLc")).toHaveLength(2);
  });

  it("is a bounded ring — the newest capacity points survive", () => {
    for (let i = 0; i < TAPE_HISTORY_CAPACITY + 20; i++) {
      recordTapeSample("cbETH", 1_000 + i, i * TAPE_HISTORY_MIN_SPACING_SECONDS);
    }
    const samples = readTapeSamples("cbETH", TAPE_HISTORY_CAPACITY + 50);
    expect(samples).toHaveLength(TAPE_HISTORY_CAPACITY);
    expect(samples[samples.length - 1].price).toBe(1_000 + TAPE_HISTORY_CAPACITY + 19);
  });

  it("keys symbols case-insensitively and clears on reset", () => {
    recordTapeSample("cbada", 1, 1_000);
    expect(readTapeSamples("CBADA")).toHaveLength(1);
    resetTapeHistory();
    expect(readTapeSamples("cbADA")).toEqual([]);
  });

  it("limits what a single read returns without dropping stored points", () => {
    for (let i = 0; i < 10; i++) {
      recordTapeSample("TSLAc", 100 + i, i * TAPE_HISTORY_MIN_SPACING_SECONDS);
    }
    const limited = readTapeSamples("TSLAc", 3);
    expect(limited).toHaveLength(3);
    expect(limited[2].price).toBe(109);
    expect(readTapeSamples("TSLAc")).toHaveLength(10);
  });
});
