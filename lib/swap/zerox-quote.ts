// lib/swap/zerox-quote.ts
// 0x Swap API v2 (Base) quote client — QUOTES ONLY, no execution consumer.
//
// DO NOT wire this into Swap execution against the currently deployed
// MPGRSwapExecutor: its swapViaAggregator leg cannot settle any genuine 0x
// payload (fork-proven 2026-10-19, see
// test/swap-fork/MPGRSwapExecutorDeployedBaseFork.t.sol). The executor
// calls the registry-authenticated Settler directly, but a Settler can
// only collect the sell token inside an AllowanceHolder.exec(...) call
// (ephemeral-allowance ceremony) or via a Permit2 signature from the payer
// — neither is reachable from that direct call, so every real payload
// reverts atomically in the payment step. Execution support requires a
// NEW executor deployment whose aggregator leg routes through
// AllowanceHolder.exec with the operator authenticated against the 0x
// deployer registry (see docs/SWAP-ROUTING-AUDIT.md). Until then this
// client stays dormant: quotes must never be rendered as executable.
//
// Also note the API's allowance-holder `transaction.to` is the
// AllowanceHolder itself, not the Settler (the Settler is the `operator`
// inside the exec calldata) — `quote.target` below therefore names the
// holder, and authenticateZeroxSettler() only becomes meaningful once a
// caller extracts the operator from the payload.
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
