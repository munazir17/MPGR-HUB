import { describe, expect, it } from "vitest";

import {
  YieldMathInputError,
  bpsToPercentString,
  estimateLinearAprReward,
  parseTokenAmount,
  rankByAprDescending,
} from "../yield-math";

describe("bpsToPercentString", () => {
  it("formats a whole-percent bps value", () => {
    expect(bpsToPercentString(1000n)).toBe("10.00");
  });

  it("formats a fractional-percent bps value", () => {
    expect(bpsToPercentString(1234n)).toBe("12.34");
  });

  it("formats zero", () => {
    expect(bpsToPercentString(0n)).toBe("0.00");
  });

  it("formats a sub-1% bps value with a leading zero", () => {
    expect(bpsToPercentString(5n)).toBe("0.05");
  });

  it("formats a negative bps value", () => {
    expect(bpsToPercentString(-250n)).toBe("-2.50");
  });
});

describe("parseTokenAmount", () => {
  it("parses a whole-number decimal string", () => {
    expect(parseTokenAmount("1000", 18)).toBe(
      1000n * 10n ** 18n
    );
  });

  it("parses a fractional decimal string", () => {
    expect(parseTokenAmount("1000.5", 18)).toBe(
      1000n * 10n ** 18n +
        5n * 10n ** 17n
    );
  });

  it("rejects an empty string", () => {
    expect(() =>
      parseTokenAmount("", 18)
    ).toThrow(YieldMathInputError);
  });

  it("rejects a negative amount", () => {
    expect(() =>
      parseTokenAmount("-5", 18)
    ).toThrow(YieldMathInputError);
  });

  it("rejects a non-numeric string", () => {
    expect(() =>
      parseTokenAmount("abc", 18)
    ).toThrow(YieldMathInputError);
  });

  it("rejects scientific notation", () => {
    expect(() =>
      parseTokenAmount("1e18", 18)
    ).toThrow(YieldMathInputError);
  });
});

describe("estimateLinearAprReward", () => {
  it("computes a one-year projection at a round APR", () => {
    const principal = 1000n * 10n ** 18n;

    const { estimatedRewardRaw } =
      estimateLinearAprReward(
        principal,
        1000n,
        365
      );

    expect(estimatedRewardRaw).toBe(
      100n * 10n ** 18n
    );
  });

  it("computes a partial-year projection", () => {
    const principal = 1000n * 10n ** 18n;

    const { estimatedRewardRaw } =
      estimateLinearAprReward(
        principal,
        1000n,
        36
      );

    const expected =
      (principal * 1000n * 36n) /
      (10_000n * 365n);

    expect(estimatedRewardRaw).toBe(expected);
  });

  it("returns zero reward for zero duration", () => {
    const { estimatedRewardRaw } =
      estimateLinearAprReward(
        1000n * 10n ** 18n,
        1000n,
        0
      );

    expect(estimatedRewardRaw).toBe(0n);
  });

  it("returns zero reward for zero principal", () => {
    const { estimatedRewardRaw } =
      estimateLinearAprReward(
        0n,
        1000n,
        365
      );

    expect(estimatedRewardRaw).toBe(0n);
  });

  it("rejects a negative principal", () => {
    expect(() =>
      estimateLinearAprReward(
        -1n,
        1000n,
        365
      )
    ).toThrow(YieldMathInputError);
  });

  it("rejects a negative APR", () => {
    expect(() =>
      estimateLinearAprReward(
        1000n,
        -1n,
        365
      )
    ).toThrow(YieldMathInputError);
  });

  it("rejects a negative duration", () => {
    expect(() =>
      estimateLinearAprReward(
        1000n,
        1000n,
        -1
      )
    ).toThrow(YieldMathInputError);
  });

  it("truncates a fractional duration toward zero", () => {
    const a = estimateLinearAprReward(
      1000n * 10n ** 18n,
      1000n,
      36.9
    );

    const b = estimateLinearAprReward(
      1000n * 10n ** 18n,
      1000n,
      36
    );

    expect(a.estimatedRewardRaw).toBe(
      b.estimatedRewardRaw
    );
  });
});

describe("rankByAprDescending", () => {
  it("sorts known-APR entries descending", () => {
    const entries = [
      { id: "a", aprBps: 500n },
      { id: "b", aprBps: 1500n },
      { id: "c", aprBps: 1000n },
    ];

    const ranked =
      rankByAprDescending(entries);

    expect(
      ranked.map((e) => e.id)
    ).toEqual(["b", "c", "a"]);
  });

  it("moves unknown APR entries to the end", () => {
    const entries = [
      { id: "a", aprBps: 500n },
      { id: "unknown-1", aprBps: null },
      { id: "b", aprBps: 0n },
    ];

    const ranked =
      rankByAprDescending(entries);

    expect(
      ranked.map((e) => e.id)
    ).toEqual([
      "a",
      "b",
      "unknown-1",
    ]);
  });

  it("preserves relative order among unknown entries", () => {
    const entries = [
      { id: "unknown-1", aprBps: null },
      { id: "a", aprBps: 500n },
      { id: "unknown-2", aprBps: null },
    ];

    const ranked =
      rankByAprDescending(entries);

    expect(
      ranked.map((e) => e.id)
    ).toEqual([
      "a",
      "unknown-1",
      "unknown-2",
    ]);
  });

  it("does not mutate the input array", () => {
    const entries = [
      { id: "a", aprBps: 500n },
      { id: "b", aprBps: 1500n },
    ];

    const copy = [...entries];

    rankByAprDescending(entries);

    expect(entries).toEqual(copy);
  });
});
