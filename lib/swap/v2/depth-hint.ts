// Untrusted liquidity hint. Dexscreener says which book is deep; it never
// becomes a pool and never sets a price. The quote path still executes the
// on-chain quoter and keeps the route only when it pays more.
import type { Address } from "viem";
import { BASE_USDC, BASE_WETH } from "@/lib/trade/trade-config";

const HUBS = new Set([BASE_WETH.toLowerCase(), BASE_USDC.toLowerCase()]);
const ZERO = "0x0000000000000000000000000000000000000000";
/** A direct book at or above this is already a real market. Leave it on getters. */
const DEEP_DIRECT_USD = 25_000;
/** The other hub has to be large enough to be a route, not a dust pool. */
const MIN_HUB_USD = 5_000;

/**
 * Token whose pairs we compare.
 *
 * When one side is WETH or USDC, that hub is the counter-asset, not the subject.
 * Querying WETH itself would call every WETH pair "thin" next to WETH/USDC.
 * Both sides hubs (USDC/WETH) has nothing to compare: null, and no request.
 */
export function depthSubject(tokenIn: Address, tokenOut: Address): Address | null {
  const inn = tokenIn.toLowerCase();
  const out = tokenOut.toLowerCase();
  if (HUBS.has(inn) && HUBS.has(out)) return null;
  if (HUBS.has(inn) && !HUBS.has(out)) return tokenOut;
  return tokenIn;
}

function asAddress(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function usdOf(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * True when the direct pair is a thin book and the same token has a clearly
 * deeper WETH or USDC book. Native ETH on the indexer is the zero address and
 * is treated as WETH, which is how the route settles it.
 */
export function pairDepthIsThin(rows: unknown, tokenIn: Address, tokenOut: Address): boolean {
  const subject = depthSubject(tokenIn, tokenOut);
  if (!subject || !Array.isArray(rows)) return false;
  const input = subject.toLowerCase();
  const directRaw = (tokenIn.toLowerCase() === input ? tokenOut : tokenIn).toLowerCase();
  const directOther = directRaw === ZERO ? BASE_WETH.toLowerCase() : directRaw;
  let directUsd = 0;
  let hubUsd = 0;
  for (const row of rows.slice(0, 40)) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { baseToken?: { address?: unknown }; quoteToken?: { address?: unknown }; liquidity?: { usd?: unknown } };
    const base = asAddress(rec.baseToken?.address);
    const quote = asAddress(rec.quoteToken?.address);
    const usd = usdOf(rec.liquidity?.usd);
    if (usd <= 0) continue;
    const otherRaw = base === input ? quote : quote === input ? base : "";
    if (!otherRaw) continue;
    const other = otherRaw === ZERO ? BASE_WETH.toLowerCase() : otherRaw;
    if (other === directOther) directUsd = Math.max(directUsd, usd);
    else if (HUBS.has(other)) hubUsd = Math.max(hubUsd, usd);
  }
  if (directUsd >= DEEP_DIRECT_USD) return false;
  if (hubUsd < MIN_HUB_USD) return false;
  return hubUsd >= Math.max(directUsd, 1) * 3;
}

/** Fail-soft. A timeout, a non-200, or a bad body means "don't know", not "thin". */
export async function fetchPairDepthHint(
  tokenIn: Address, tokenOut: Address, fetchImpl: typeof fetch = fetch,
): Promise<boolean | null> {
  const subject = depthSubject(tokenIn, tokenOut);
  if (!subject) return false;
  try {
    const response = await fetchImpl(`https://api.dexscreener.com/token-pairs/v1/base/${subject}`, {
      signal: AbortSignal.timeout(900),
    });
    if (!response.ok) return null;
    return pairDepthIsThin(await response.json(), tokenIn, tokenOut);
  } catch {
    return null;
  }
}
