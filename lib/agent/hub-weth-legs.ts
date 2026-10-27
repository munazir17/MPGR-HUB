import type { Hex } from "viem";

/**
 * SwapExecuted trades with no USDC leg (agent and PaigerSwap). Dollar value
 * is the WETH side times the Chainlink ETH/USD answer read on 2026-10-27
 * (round answer 232840432832, 8 decimals, about $2,328.40).
 * These hashes were already behind the live cursor, so the scanner will
 * not see them again. foldPricedWethLegs adds them once to an older cursor.
 */
export const PRICED_WETH_LEG_TRADES: readonly { txHash: Hex; usdcAtomic: bigint }[] = [
  { txHash: "0xb5203027414f519dd7e0d40bc4c2eb9bafde8784af2deb1396d9ea35dadf6c2c", usdcAtomic: 232_840n },
  { txHash: "0x52dd005d27df3bc80500941793d3344ea1a842bdd4b18dce019e35b666a6f2b1", usdcAtomic: 201_982n },
  { txHash: "0x0c96614fb21bc82a219c914c56a8ed75c253ff751a45539ebb7dbc4894760149", usdcAtomic: 100_924n },
  { txHash: "0x7fdab156b8e7da34771b84d167ec647d103276da3e8afed010efc2e90e5d6335", usdcAtomic: 15_806n },
  { txHash: "0x5b3338a06bad6c9ebc39078030c8b2908421dac0c7baf727d46c935bde5ffa79", usdcAtomic: 118_484n },
  { txHash: "0xaee50d0d138c07b944cd771be447a479ec4da9be9d1c7e9a95e78727e237526d", usdcAtomic: 9_275_745n },
  { txHash: "0x6f24b9e5f4736511a70ea2124dedda85ac47a2ccb5d13915367d4464932ab911", usdcAtomic: 4_650_344n },
];
