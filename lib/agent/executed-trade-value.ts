import { isNativeEthSentinel } from "@/lib/trade/trade-config";
import { KNOWN_TRADE_TOKENS } from "@/lib/trade/trade-tokens";

// One SwapExecuted log is one trade. The executed notional is a single side:
// stable spent (BUY) or stable received (SELL). The other leg is not added.
// Quotes, requested amounts and reverted transactions never reach this
// function — callers only pass logs from a successful SwapExecuted event.

export const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";
export const PENDING_LEG_CAP = 48;

const USD_PEG_SYMBOLS = new Set(["usdc", "usdt", "dai", "usdbc", "usds"]);

const USD_PEG_DECIMALS = new Map<string, number>();
for (const token of KNOWN_TRADE_TOKENS) {
  if (isNativeEthSentinel(token.address)) continue;
  if (USD_PEG_SYMBOLS.has(token.symbol.toLowerCase())) {
    USD_PEG_DECIMALS.set(token.address.toLowerCase(), token.decimals);
  }
}

export type ExecutedLeg =
  | { kind: "usd"; amount: bigint }
  | { kind: "weth"; amount: bigint }
  | { kind: "token"; token: string; amount: bigint };

export interface PendingLeg {
  id: string;
  kind: "weth" | "token";
  token: string;
  amount: string;
}

/** Token atomic units → 6-decimal USD atomic units. Non-positive input is zero. */
export function toUsdAtomic6(amount: bigint, decimals: number): bigint {
  if (amount <= 0n || decimals < 0 || decimals > 36) return 0n;
  if (decimals === 6) return amount;
  if (decimals > 6) return amount / 10n ** BigInt(decimals - 6);
  return amount * 10n ** BigInt(6 - decimals);
}

/**
 * Executed USD notional of one successful swap.
 * Stable in (BUY) uses grossAmountIn. Stable out (SELL) uses amountOut.
 * Otherwise WETH in uses gross, WETH out uses amountOut, else the sold token.
 * Returns null when the executed amount is not positive.
 */
export function classifyExecutedTrade(input: {
  tokenIn: string;
  tokenOut: string;
  grossAmountIn: bigint;
  amountOut: bigint;
}): ExecutedLeg | null {
  const tokenIn = input.tokenIn.toLowerCase();
  const tokenOut = input.tokenOut.toLowerCase();
  const pegIn = USD_PEG_DECIMALS.get(tokenIn);
  if (pegIn !== undefined) {
    const amount = toUsdAtomic6(input.grossAmountIn, pegIn);
    return amount > 0n ? { kind: "usd", amount } : null;
  }
  const pegOut = USD_PEG_DECIMALS.get(tokenOut);
  if (pegOut !== undefined) {
    const amount = toUsdAtomic6(input.amountOut, pegOut);
    return amount > 0n ? { kind: "usd", amount } : null;
  }
  if (tokenIn === WETH_ADDRESS) {
    return input.grossAmountIn > 0n ? { kind: "weth", amount: input.grossAmountIn } : null;
  }
  if (tokenOut === WETH_ADDRESS) {
    return input.amountOut > 0n ? { kind: "weth", amount: input.amountOut } : null;
  }
  if (input.grossAmountIn <= 0n) return null;
  return { kind: "token", token: tokenIn, amount: input.grossAmountIn };
}
