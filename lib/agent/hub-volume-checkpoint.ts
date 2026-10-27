import type { Hex } from "viem";

import type { VolumeAnchor } from "@/lib/agent/hub-volume";

/**
 * Inclusive block through which agent + swap v1 + swap v2 were fully read
 * on https://base.rpc.blxrbdn.com (2026-10-23, head 52991695, 0 failed chunks).
 *
 * totalUsdcAtomic is SwapExecuted USDC notionals (USDC in = grossAmountIn,
 * USDC out = amountOut) plus the one verified historical agent trade that
 * did not emit SwapExecuted, plus seven WETH-leg swaps priced from Chainlink
 * ETH/USD (see hub-weth-legs.ts). 24 on-chain USDC swaps + that seed +
 * 7 WETH legs = 32 trades. Live reads start at throughBlock + 1 and price
 * any newer WETH leg at scan time.
 */
export const HUB_VOLUME_CHECKPOINT = {
  throughBlock: 52_991_695n,
  totalUsdcAtomic: 38_024_442n,
  tradeCount: 32,
  seedTxHashes: [
    "0x0f52a3b3a13e8fabf79f9185bc3198e60275223ceb4225b24c84782aa43551de",
    "0x935607b73388e7d53263577d1b6856708b01cecf1911f991fe2c78850fd75ab3",
    "0xd7d3a9098ec3615e9dee82a710531f345c96b52c746aef1d65402614a66d55c6",
  ] as readonly Hex[],
  wethLegTxHashes: [
    "0xb5203027414f519dd7e0d40bc4c2eb9bafde8784af2deb1396d9ea35dadf6c2c",
    "0x52dd005d27df3bc80500941793d3344ea1a842bdd4b18dce019e35b666a6f2b1",
    "0x0c96614fb21bc82a219c914c56a8ed75c253ff751a45539ebb7dbc4894760149",
    "0x7fdab156b8e7da34771b84d167ec647d103276da3e8afed010efc2e90e5d6335",
    "0x5b3338a06bad6c9ebc39078030c8b2908421dac0c7baf727d46c935bde5ffa79",
    "0xaee50d0d138c07b944cd771be447a479ec4da9be9d1c7e9a95e78727e237526d",
    "0x6f24b9e5f4736511a70ea2124dedda85ac47a2ccb5d13915367d4464932ab911",
  ] as readonly Hex[],
};

export function checkpointAnchor(): VolumeAnchor {
  return {
    throughBlock: HUB_VOLUME_CHECKPOINT.throughBlock,
    totalUsdcAtomic: HUB_VOLUME_CHECKPOINT.totalUsdcAtomic,
    tradeCount: HUB_VOLUME_CHECKPOINT.tradeCount,
    seedTxHashes: HUB_VOLUME_CHECKPOINT.seedTxHashes,
    wethLegTxHashes: HUB_VOLUME_CHECKPOINT.wethLegTxHashes,
  };
}
