import { describe, expect, it } from "vitest";
import { gasCostInOutput, netOutput, rankByNetOutput, splitBeatsSingle, splitLegGross, type RankingContext } from "../route-ranking";

// 1 gwei gas price; 3000 USDC(6dp) per native => rate 3e9 atomic/native, 1e18-scaled.
const ctxUsdc: RankingContext = { gasPriceWei: 1_000_000_000n, nativeToOutputRate: 3_000_000_000n * 10n ** 18n };

describe("net-output ranking", () => {
  it("converts gas to output units with exact integer arithmetic", () => {
    // 100k gas * 1 gwei = 1e14 wei = 1e-4 native; at 3000 USDC/native = 0.3 USDC = 300000 atomic
    expect(gasCostInOutput(100_000n, ctxUsdc)).toBe(300_000n);
  });
  it("ranks a gas-cheaper lower-quote route above a gas-hungry higher-quote route", () => {
    const quotes = [
      { key: "v3", label: "Uniswap V3", quotedOut: 10_000_000n, gasEstimate: 300_000n },
      { key: "agg", label: "0x Settler", quotedOut: 10_200_000n, gasEstimate: 900_000n },
    ];
    const ranked = rankByNetOutput(quotes, ctxUsdc);
    expect(ranked[0].input.key).toBe("v3"); // 10.0 - 0.9 USDC gas > 10.2 - 2.7
    expect(ranked[0].net).toBe(10_000_000n - 900_000n);
  });
  it("never reports negative nets", () => {
    expect(netOutput({ key: "x", label: "x", quotedOut: 10n, gasEstimate: 5_000_000n }, ctxUsdc)).toBe(0n);
  });
});

describe("split evaluation", () => {
  it("adopts a split only when the edge exceeds the extra gas cost", () => {
    const legs = [
      { key: "a", label: "a", quotedOut: 6_300_000n, gasEstimate: 150_000n, shareBps: 6000 },
      { key: "b", label: "b", quotedOut: 4_300_000n, gasEstimate: 150_000n, shareBps: 4000 },
    ];
    const single = { key: "s", label: "s", quotedOut: 9_900_000n, gasEstimate: 150_000n };
    const singleNet = netOutput(single, ctxUsdc);
    const extra = 60_000n; // second leg overhead beyond the single route
    const res = splitBeatsSingle(legs, singleNet, extra, ctxUsdc);
    // split nets 9.7M vs single 9.45M; extra gas 0.18 USDC => edge positive
    expect(res.adopted).toBe(true);
    const tight = splitBeatsSingle(legs, netOutput({ ...single, quotedOut: 10_090_000n }, ctxUsdc), extra, ctxUsdc);
    expect(tight.adopted).toBe(false);
  });
  it("splits gross exactly, remainder to the second leg", () => {
    const [a, b] = splitLegGross(1_000_003n, [6000, 4000]);
    expect(a + b).toBe(1_000_003n);
    expect(a).toBe(600_001n);
  });
});
