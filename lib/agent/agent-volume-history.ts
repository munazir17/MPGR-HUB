import "server-only";

export type HistoricalAgentTrade = {
  txHash: `0x${string}`;
  /** USDC-equivalent gross executed notional, in atomic USDC units. */
  usdcAtomic: bigint;
};

export const VERIFIED_HISTORICAL_AGENT_TRADES: readonly HistoricalAgentTrade[] = [
  {
    txHash: "0x0f52a3b3a13e8fabf79f9185bc3198e60275223ceb4225b24c84782aa43551de",
    usdcAtomic: 2_000_000n,
  },
  {
    txHash: "0x935607b73388e7d53263577d1b6856708b01cecf1911f991fe2c78850fd75ab3",
    usdcAtomic: 1_000_000n,
  },
  {
    txHash: "0xd7d3a9098ec3615e9dee82a710531f345c96b52c746aef1d65402614a66d55c6",
    usdcAtomic: 267_304n,
  },
];
