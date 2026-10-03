import "server-only";

export type HistoricalAgentTrade = {
  txHash: `0x${string}`;
  /** USDC-equivalent gross executed notional, in atomic USDC units. */
  usdcAtomic: bigint;
};

/**
 * Historical Agent trades that are explicitly documented/verified in the repo.
 *
 * These are seeds only: the runtime also scans the deployed Executor. The
 * txHash is the dedupe key, so Executor-backed historical records cannot be
 * counted twice.
 *
 * Do not add wallet transfers or ordinary DEX swaps here unless there is
 * concrete evidence that the transaction was an MPGR Agent execution.
 */
export const VERIFIED_HISTORICAL_AGENT_TRADES: readonly HistoricalAgentTrade[] = [
  {
    // Browser B20 Agent swap documented in EXECUTOR/CHANGELOG:
    // 2 USDC -> 0.00587536 AAPLc.
    txHash: "0x0f52a3b3a13e8fabf79f9185bc3198e60275223ceb4225b24c84782aa43551de",
    usdcAtomic: 2_000_000n,
  },
  {
    // MCP/Executor historical evidence: USDC -> WETH, 1 USDC gross.
    txHash: "0x935607b73388e7d53263577d1b6856708b01cecf1911f991fe2c78850fd75ab3",
    usdcAtomic: 1_000_000n,
  },
  {
    // MCP/Executor historical evidence: WETH -> USDC, 0.267304 USDC received.
    txHash: "0xd7d3a9098ec3615e9dee82a710531f345c96b52c746aef1d65402614a66d55c6",
    usdcAtomic: 267_304n,
  },
];
