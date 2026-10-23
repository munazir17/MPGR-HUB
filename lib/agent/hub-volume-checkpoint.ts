import type { Hex } from "viem";

import type { VolumeAnchor } from "@/lib/agent/hub-volume";

/**
 * Inclusive block through which agent + swap v1 + swap v2 were fully read
 * on https://base.rpc.blxrbdn.com (2026-10-23, head 52991695, 0 failed chunks).
 *
 * totalUsdcAtomic is the sum of SwapExecuted USDC notionals (USDC in =
 * grossAmountIn, USDC out = amountOut) plus the one verified historical
 * agent trade that did not emit SwapExecuted. 24 on-chain USDC swaps +
 * that seed = 25 trades = 23.428317 USDC. Four WETH↔stock swaps had no
 * USDC leg and are not priced. Live reads start at throughBlock + 1.
 */
export const HUB_VOLUME_CHECKPOINT = {
  throughBlock: 52_991_695n,
  totalUsdcAtomic: 23_428_317n,
  tradeCount: 25,
  seedTxHashes: [
    "0x0f52a3b3a13e8fabf79f9185bc3198e60275223ceb4225b24c84782aa43551de",
    "0x935607b73388e7d53263577d1b6856708b01cecf1911f991fe2c78850fd75ab3",
    "0xd7d3a9098ec3615e9dee82a710531f345c96b52c746aef1d65402614a66d55c6",
  ] as readonly Hex[],
};

export function checkpointAnchor(): VolumeAnchor {
  return {
    throughBlock: HUB_VOLUME_CHECKPOINT.throughBlock,
    totalUsdcAtomic: HUB_VOLUME_CHECKPOINT.totalUsdcAtomic,
    tradeCount: HUB_VOLUME_CHECKPOINT.tradeCount,
    seedTxHashes: HUB_VOLUME_CHECKPOINT.seedTxHashes,
  };
}
