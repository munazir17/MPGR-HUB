// Unreleased V2 path. Pure routing policy over liquidity-discovered pools, NOT
// the legacy catalog. A source must return all matching on-chain pool keys or
// throw DISCOVERY_UNAVAILABLE; an RPC/index failure is not a no-liquidity proof.
import { isAddress, type Address, type Hex } from "viem";
import { BASE_WETH, isNativeEthSentinel } from "@/lib/trade/trade-config";
export const V2_FEE_BPS = 25;
export const V2_FEE_RECIPIENT = "0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4" as Address;
export const V2_DEPLOYMENT = null; // No mainnet activation in this pass.
export const V4_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b" as Address;
export interface V4Key { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
export interface Pool {
  id: string; pool: Address; router: Address; factory: Address; kind: 1 | 2 | 3 | 4 | 7;
  token0: Address; token1: Address; poolFee: number; tickSpacing: number; stable: boolean;
  v4Key?: V4Key;
}
export interface LiquiditySource {
  hints?(input: Address, output: Address): Promise<readonly Pool[]>;
  pools(input: Address, output?: Address): Promise<readonly Pool[]>;
  quote(pool: Pool, input: Address, amount: bigint): Promise<bigint>;
}
export interface Leg { pools: readonly Pool[]; tokens: readonly Address[]; amountIn: bigint; amountOut: bigint }
export interface V2Quote {
  tokenIn: Address; tokenOut: Address; gross: bigint; feeBps: 25; feeRecipient: Address;
  fee: bigint; net: bigint; amountOut: bigint; legs: readonly Leg[];
}
export class V2QuoteError extends Error {
  constructor(public code: "INVALID_PAIR" | "INVALID_AMOUNT" | "LIQUIDITY_UNAVAILABLE" | "DISCOVERY_UNAVAILABLE" | "FEE_POLICY_INVALID", message: string) { super(message); }
}
export function asset(value: string): Address {
  if (!isAddress(value, { strict: false })) throw new V2QuoteError("INVALID_PAIR", "Invalid Base asset address");
  return (isNativeEthSentinel(value) ? BASE_WETH : value).toLowerCase() as Address;
}
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const other = (p: Pool, token: Address): Address | null => eq(p.token0, token) ? p.token1 : eq(p.token1, token) ? p.token0 : null;
function validPool(p: Pool): boolean {
  if (![1, 2, 3, 4, 7].includes(p.kind) || eq(p.token0, p.token1)) return false;
  if (p.kind === 7) {
    const key = p.v4Key;
    if (!key || !eq(p.pool, V4_MANAGER) || !eq(p.router, V4_MANAGER) || !eq(p.factory, V4_MANAGER) || BigInt(key.currency0) >= BigInt(key.currency1) || key.tickSpacing <= 0 || key.tickSpacing > 32767) return false;
    const token0 = key.currency0 === "0x0000000000000000000000000000000000000000" ? BASE_WETH : key.currency0;
    return eq(token0, p.token0) && eq(key.currency1, p.token1);
  }
  return true;
}
async function quoteLeg(source: LiquiditySource, pools: readonly Pool[], tokens: readonly Address[], amountIn: bigint): Promise<Leg | null> {
  let amount = amountIn;
  for (let i = 0; i < pools.length; i++) {
    try { amount = await source.quote(pools[i], tokens[i], amount); } catch (error) { if (error instanceof V2QuoteError) throw error; throw new V2QuoteError("DISCOVERY_UNAVAILABLE", "Venue quote unavailable"); }
    if (amount <= 0n) return null;
  }
  return { pools, tokens, amountIn, amountOut: amount };
}
export function validateV2Quote(q: V2Quote): void {
  const expected = q.gross * 25n / 10000n;
  if (q.feeBps !== 25 || !eq(q.feeRecipient, V2_FEE_RECIPIENT) || expected <= 0n || q.fee !== expected || q.net !== q.gross - expected ||
      q.legs.reduce((s, l) => s + l.amountIn, 0n) !== q.net || q.amountOut <= 0n ||
      q.legs.reduce((s, l) => s + l.amountOut, 0n) !== q.amountOut || q.legs.length === 0 || q.legs.length > 4 ||
      q.legs.some(l => l.amountIn <= 0n || l.amountOut <= 0n || l.pools.length < 1 || l.pools.length > 3 || l.tokens.length !== l.pools.length + 1 ||
        !eq(l.tokens[0], q.tokenIn) || !eq(l.tokens[l.tokens.length - 1], q.tokenOut) ||
        new Set(l.tokens.map(t => t.toLowerCase())).size !== l.tokens.length ||
        l.pools.some((p, i) => !validPool(p) || !eq(other(p, l.tokens[i]) ?? "", l.tokens[i + 1])))) {
    throw new V2QuoteError("FEE_POLICY_INVALID", "Invalid gross-input fee, allocation, or typed path");
  }
}
/** Direct quotes always win over multihop, regardless of hypothetical hop output.
 * Multi-hop discovers neighbors from actual pools, never a fixed bridge list. */
export async function discoverV2Quote(source: LiquiditySource, from: string, to: string, gross: bigint): Promise<V2Quote> {
  const tokenIn = asset(from), tokenOut = asset(to);
  if (eq(tokenIn, tokenOut)) throw new V2QuoteError("INVALID_PAIR", "ETH and WETH are the same asset; select distinct assets");
  const fee = gross * 25n / 10000n, net = gross - fee;
  if (gross <= 0n || fee <= 0n) throw new V2QuoteError("INVALID_AMOUNT", "Sell amount is too small for the mandatory fee");
  let direct = (await (source.hints ? source.hints(tokenIn, tokenOut) : source.pools(tokenIn, tokenOut))).filter(p => validPool(p) && eq(other(p, tokenIn) ?? "", tokenOut));
  let quoted = (await Promise.all(direct.map(p => quoteLeg(source, [p], [tokenIn, tokenOut], net)))).filter((l): l is Leg => l !== null);
  if (source.hints && !quoted.length) {
    // Hints cannot prove absence. Complete canonical discovery is mandatory
    // before allowing multi-hop or returning LIQUIDITY_UNAVAILABLE.
    direct = (await source.pools(tokenIn, tokenOut)).filter(p => validPool(p) && eq(other(p, tokenIn) ?? "", tokenOut));
    quoted = (await Promise.all(direct.map(p => quoteLeg(source, [p], [tokenIn, tokenOut], net)))).filter((l): l is Leg => l !== null);
  }
  let legs: readonly Leg[] = [];
  if (quoted.length) {
    const best = quoted.reduce((a, b) => b.amountOut > a.amountOut ? b : a);
    legs = [best];
    // Optimize direct venue splits on net allocation, never fee each leg. No
    // repeated pool: quoter calls are independent; shared liquidity is not additive.
    for (let i = 0; i < direct.length; i++) for (let j = i + 1; j < direct.length; j++) {
      if (direct[i].id === direct[j].id) continue;
      for (const weight of [25n, 50n, 75n]) {
        const first = net * weight / 100n;
        if (!first || first === net) continue;
        const a = await quoteLeg(source, [direct[i]], [tokenIn, tokenOut], first);
        const b = await quoteLeg(source, [direct[j]], [tokenIn, tokenOut], net - first);
        if (a && b && a.amountOut + b.amountOut > legs.reduce((s, l) => s + l.amountOut, 0n)) legs = [a, b];
      }
    }
  } else {
    const candidates: Leg[] = [];
    // Meet in the middle: enumerate liquidity neighbors of the requested
    // endpoints only. Never enumerate every WETH/USDC pool as a bridge catalog.
    const first = (await source.pools(tokenIn)).filter(validPool);
    const last = (await source.pools(tokenOut)).filter(validPool);
    for (const a of first) {
      const x = other(a, tokenIn);
      if (!x || eq(x, tokenOut) || eq(x, tokenIn)) continue;
      for (const b of last) {
        const y = other(b, tokenOut);
        if (!y || eq(y, tokenIn) || eq(y, tokenOut)) continue;
        if (eq(x, y)) {
          const q = await quoteLeg(source, [a, b], [tokenIn, x, tokenOut], net);
          if (q) candidates.push(q);
        } else {
          for (const middle of await source.pools(x, y)) {
            if (!validPool(middle) || !eq(other(middle, x) ?? "", y)) continue;
            const q = await quoteLeg(source, [a, middle, b], [tokenIn, x, y, tokenOut], net);
            if (q) candidates.push(q);
          }
        }
      }
    }
    candidates.sort((a, b) => a.amountOut === b.amountOut ? a.pools.length - b.pools.length : a.amountOut > b.amountOut ? -1 : 1);
    if (candidates.length) legs = [candidates[0]];
  }
  if (!legs.length) throw new V2QuoteError("LIQUIDITY_UNAVAILABLE", "No liquid direct or up-to-three-hop route quotes for this Base pair");
  const result: V2Quote = { tokenIn, tokenOut, gross, feeBps: 25, feeRecipient: V2_FEE_RECIPIENT, fee, net, amountOut: legs.reduce((s, l) => s + l.amountOut, 0n), legs };
  validateV2Quote(result); return result;
}
export interface V2Snapshot { number: bigint; hash: Hex }
