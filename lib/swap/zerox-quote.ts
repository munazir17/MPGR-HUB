// lib/swap/zerox-quote.ts
// 0x Swap API v2 (Base) quote client — QUOTES ONLY.
// The API key (env ZEROX_API_KEY) is optional: without it the aggregator venue
// is reported unavailable instead of silently degraded. Nothing from the API
// is executed raw: execution happens only through MPGRSwapExecutor's
// authenticated-settler path (on-chain Settler check, zero value, exact
// single-use AllowanceHolder approval, measured min-out, atomic fee).
import { isAddress, type Address, type Hex } from "viem";
import { ZEROX_ALLOWANCE_HOLDER, ZEROX_API_BASE, ZEROX_SETTLER_DEPLOYER, ZEROX_TAKER_FEATURE_ID } from "./swap-executor-config";

export interface ZeroxQuoteRequest {
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  taker: Address;
  slippageBps: number;
}
export interface ZeroxQuote {
  provider: "zerox";
  target: Address;
  data: Hex;
  buyAmount: bigint;
  sellAmount: bigint;
  gasEstimate: bigint;
  allowanceHolder: Address;
  minBuyAmount: bigint;
}
export type ZeroxQuoteResult = { ok: true; quote: ZeroxQuote } | { ok: false; reason: string };

const ERC721_OWNER_ABI = [{ type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] }] as const;

export function zeroxAvailable(): boolean {
  return Boolean(process.env.ZEROX_API_KEY || process.env.OX_API_KEY);
}

/** Fetches and strictly validates a 0x allowance-holder quote for Base. */
export async function fetchZeroxQuote(req: ZeroxQuoteRequest, fetchImpl: typeof fetch = fetch): Promise<ZeroxQuoteResult> {
  if (!zeroxAvailable()) return { ok: false, reason: "Aggregator quotes are not configured for this deployment." };
  const params = new URLSearchParams({
    chainId: "8453",
    sellToken: req.sellToken,
    buyToken: req.buyToken,
    sellAmount: req.sellAmount.toString(),
    taker: req.taker,
    slippageBps: String(req.slippageBps),
  });
  const key = process.env.ZEROX_API_KEY || process.env.OX_API_KEY;
  let res: Response;
  try {
    res = await fetchImpl(`${ZEROX_API_BASE}/swap/allowance-holder/quote?${params}`, {
      headers: key ? { "0x-api-key": key, "0x-version": "v2" } : { "0x-version": "v2" },
      cache: "no-store",
    });
  } catch {
    return { ok: false, reason: "The aggregator quote service is unreachable. Direct venue quotes remain available." };
  }
  if (!res.ok) return { ok: false, reason: `The aggregator quote service answered ${res.status}. Direct venue quotes remain available.` };
  const body = (await res.json()) as Record<string, unknown>;
  const tx = body.transaction as Record<string, unknown> | undefined;
  const to = tx?.to as string | undefined;
  const data = tx?.data as string | undefined;
  const value = tx?.value as string | undefined;
  const buyAmount = body.buyAmount as string | undefined;
  if (!tx || typeof to !== "string" || !isAddress(to) || typeof data !== "string" || !data.startsWith("0x")) {
    return { ok: false, reason: "The aggregator quote did not include a usable transaction payload." };
  }
  // Hard invariants before anything else: no native value, correct spender.
  if (value !== undefined && value !== "0" && value !== "0x0") return { ok: false, reason: "The aggregator quote requires native value; unsupported by the executor." };
  const holder = (body.issues as Record<string, unknown> | undefined)?.allowance as Record<string, unknown> | undefined;
  const spender = (holder?.spender as string | undefined) ?? ZEROX_ALLOWANCE_HOLDER;
  if (spender.toLowerCase() !== ZEROX_ALLOWANCE_HOLDER.toLowerCase()) {
    return { ok: false, reason: "The aggregator quote requests an unexpected allowance spender." };
  }
  if (typeof buyAmount !== "string" || !/^\d+$/.test(buyAmount)) return { ok: false, reason: "The aggregator quote omitted a numeric buy amount." };
  const gasRaw = (body.gas ?? body.estimatedGas) as string | number | undefined;
  const minBuy = body.minBuyAmount as string | undefined;
  return {
    ok: true,
    quote: {
      provider: "zerox",
      target: to as Address,
      data: data as Hex,
      buyAmount: BigInt(buyAmount),
      sellAmount: req.sellAmount,
      gasEstimate: typeof gasRaw === "string" && /^\d+$/.test(gasRaw) ? BigInt(gasRaw) : typeof gasRaw === "number" ? BigInt(Math.ceil(gasRaw)) : 350_000n,
      allowanceHolder: ZEROX_ALLOWANCE_HOLDER,
      minBuyAmount: typeof minBuy === "string" && /^\d+$/.test(minBuy) ? BigInt(minBuy) : BigInt(buyAmount),
    },
  };
}

/** On-chain authentication: the quote target must be the CURRENT taker-submitted
 *  0x Settler per the 0x deployer registry (ERC-721 feature ownership). */
export async function authenticateZeroxSettler(
  reader: { readContract: (args: { address: Address; abi: typeof ERC721_OWNER_ABI; functionName: "ownerOf"; args: [bigint] }) => Promise<unknown> },
  target: Address,
): Promise<boolean> {
  try {
    const owner = await reader.readContract({ address: ZEROX_SETTLER_DEPLOYER, abi: ERC721_OWNER_ABI, functionName: "ownerOf", args: [ZEROX_TAKER_FEATURE_ID] });
    return typeof owner === "string" && owner.toLowerCase() === target.toLowerCase();
  } catch {
    return false; // verification unavailable => the quote stays non-executable
  }
}
