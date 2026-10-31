// Public multi-hop quotes. Kyber and LI.FI can price a pair, but their
// calldata cannot be proven to take the 0.25% MPGR fee in the sell token.
// quotePublicRoute remains for diagnostics. publicRouterPolicyError refuses
// every executable public-router proposal so a wallet is never asked to sign it.
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { isNativeEthSentinel } from "@/lib/trade/trade-config";

/** Kyber MetaAggregationRouterV2 on Base, and the LI.FI diamond. */
export const PUBLIC_ROUTER_ALLOWLIST = [
  "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
  "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
] as const;

const KYBER_ROUTES = "https://aggregator-api.kyberswap.com/base/api/v1/routes";
const KYBER_BUILD = "https://aggregator-api.kyberswap.com/base/api/v1/route/build";
const LIFI_QUOTE = "https://li.quest/v1/quote";

export interface PublicRouteHop { exchange: string }
export interface PublicRouteQuote {
  venue: "kyber" | "lifi";
  amountOut: bigint;
  router: Address;
  data: Hex;
  value: bigint;
  hops: PublicRouteHop[];
}

export function isAllowlistedPublicRouter(value: string | null | undefined): value is Address {
  if (!value || !isAddress(value)) return false;
  const checksum = getAddress(value).toLowerCase();
  return PUBLIC_ROUTER_ALLOWLIST.some((item) => item.toLowerCase() === checksum);
}

function asBigint(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(value)) {
    try { return BigInt(value); } catch { return null; }
  }
  return null;
}

function asHex(value: unknown): Hex | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) && value.length >= 10 ? value as Hex : null;
}

async function readJson(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal, cache: "no-store" });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function kyberHops(summary: Record<string, unknown>): PublicRouteHop[] {
  const route = summary.route;
  if (!Array.isArray(route)) return [];
  const hops: PublicRouteHop[] = [];
  for (const leg of route) {
    const swaps = Array.isArray(leg) ? leg : [leg];
    for (const swap of swaps) {
      if (!swap || typeof swap !== "object") continue;
      const exchange = (swap as { exchange?: unknown }).exchange;
      if (typeof exchange === "string" && exchange.trim()) hops.push({ exchange: exchange.trim() });
      if (hops.length >= 4) return hops;
    }
  }
  return hops;
}

async function quoteKyber(input: { tokenIn: Address; tokenOut: Address; amountIn: bigint; taker: Address; slippageBps: number }, fetchImpl: typeof fetch): Promise<PublicRouteQuote | null> {
  const params = new URLSearchParams({ tokenIn: input.tokenIn, tokenOut: input.tokenOut, amountIn: input.amountIn.toString() });
  const quoted = await readJson(`${KYBER_ROUTES}?${params}`, { headers: { Accept: "application/json", "x-client-id": "paigerswap" } }, fetchImpl);
  const summary = (quoted as { data?: { routeSummary?: Record<string, unknown> } } | null)?.data?.routeSummary;
  const amountOut = asBigint(summary?.amountOut);
  if (!summary || amountOut === null || amountOut <= 0n) return null;
  const built = await readJson(KYBER_BUILD, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "x-client-id": "paigerswap" },
    body: JSON.stringify({
      routeSummary: summary,
      sender: input.taker,
      recipient: input.taker,
      slippageTolerance: input.slippageBps,
    }),
  }, fetchImpl);
  const data = (built as { data?: Record<string, unknown> } | null)?.data;
  const router = typeof data?.routerAddress === "string" ? data.routerAddress : null;
  const calldata = asHex(data?.data);
  if (!router || !isAllowlistedPublicRouter(router) || !calldata) return null;
  const settledOut = asBigint(data?.amountOut) ?? amountOut;
  if (settledOut <= 0n) return null;
  return { venue: "kyber", amountOut: settledOut, router: getAddress(router), data: calldata, value: isNativeEthSentinel(input.tokenIn) ? input.amountIn : 0n, hops: kyberHops(summary) };
}

async function quoteLifi(input: { tokenIn: Address; tokenOut: Address; amountIn: bigint; taker: Address; slippageBps: number }, fetchImpl: typeof fetch): Promise<PublicRouteQuote | null> {
  const slippage = (input.slippageBps / 10_000).toFixed(4);
  const params = new URLSearchParams({
    fromChain: "8453", toChain: "8453", fromToken: input.tokenIn, toToken: input.tokenOut,
    fromAmount: input.amountIn.toString(), fromAddress: input.taker, slippage,
  });
  const body = await readJson(`${LIFI_QUOTE}?${params}`, { headers: { Accept: "application/json" } }, fetchImpl) as {
    estimate?: { toAmount?: unknown };
    transactionRequest?: { to?: unknown; data?: unknown; value?: unknown };
    includedSteps?: { tool?: unknown }[];
  } | null;
  const amountOut = asBigint(body?.estimate?.toAmount);
  const tx = body?.transactionRequest;
  const router = typeof tx?.to === "string" ? tx.to : null;
  const calldata = asHex(tx?.data);
  const value = asBigint(tx?.value);
  if (amountOut === null || amountOut <= 0n || !router || !isAllowlistedPublicRouter(router) || !calldata || value === null) return null;
  const hops = (body?.includedSteps ?? [])
    .map((step) => (typeof step.tool === "string" ? step.tool.trim() : ""))
    .filter(Boolean)
    .slice(0, 4)
    .map((exchange) => ({ exchange }));
  return { venue: "lifi", amountOut, router: getAddress(router), data: calldata, value, hops };
}

/** Best executable public route, or null when neither venue can price the pair. */
export async function quotePublicRoute(
  input: { tokenIn: Address; tokenOut: Address; amountIn: bigint; taker: Address; slippageBps: number },
  fetchImpl: typeof fetch = fetch,
): Promise<PublicRouteQuote | null> {
  if (input.amountIn <= 0n || input.tokenIn.toLowerCase() === input.tokenOut.toLowerCase()) return null;
  const native = isNativeEthSentinel(input.tokenIn);
  const [kyber, lifi] = await Promise.all([quoteKyber(input, fetchImpl), quoteLifi(input, fetchImpl)]);
  return [kyber, lifi]
    .filter((item): item is PublicRouteQuote => item !== null && (native ? item.value === input.amountIn : item.value === 0n))
    .sort((a, b) => (a.amountOut === b.amountOut ? a.hops.length - b.hops.length : a.amountOut > b.amountOut ? -1 : 1))[0] ?? null;
}

export const PUBLIC_ROUTER_FEE_BLOCK =
  "This route cannot collect the 0.25% fee in the token you're selling, so it wasn't prepared.";

/** Kyber and LI.FI calldata cannot be proven to take exactly 25 bps of the sell
 * token for the MPGR fee recipient. Allowlisting their routers is not fee
 * collection, so the route is refused instead of signed. */
export function publicRouterPolicyError(p: {
  provider: string;
  chainId?: number;
  agentFee?: { status?: string } | null;
  transaction?: { to: string; data: string; value: string } | null;
  permit2?: unknown;
  from?: { address: string };
  fromAmount?: string;
  needsPermit2Approval?: boolean;
  permit2Spender?: string | null;
}): string | null {
  if (p.provider !== "public-router") return "Not a public multi-hop route.";
  return PUBLIC_ROUTER_FEE_BLOCK;
}
