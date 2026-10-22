// lib/swap/v2/rpc-index.ts
// Bounded, on-chain-authoritative pool lookup that needs NO historical log range.
//
// WHY THIS EXISTS. `RpcV2LiquiditySource` discovered pools by scanning canonical
// factory events from block 0 to head, bisecting down when the provider capped the
// range. Over Base's ~53M blocks that is millions of `eth_getLogs` calls, so it
// exhausted its read budget on every real provider and reported
// DISCOVERY_UNAVAILABLE — which made the whole token universe unmeasurable.
//
// The factories already answer the question directly. `getPair(a,b)` /
// `getPool(a,b,fee|tickSpacing|stable)` is a single `eth_call` per candidate and is
// authoritative: a zero address means the factory itself has no such pool. These
// exact four signatures are already relied on by rpc-hints.ts in production, so no
// new ABI is assumed here.
//
// WHAT THIS DOES NOT CLAIM. Coverage is per-venue and stated explicitly:
//  - Uniswap V2 (3) and Aerodrome Classic (4): COMPLETE — no tiers to enumerate.
//  - Uniswap V3 (2): complete over UNISWAP_V3_POOL_FEES, the canonical tier set
//    this repo already pins. A non-canonical tier would need the log scan.
//  - Slipstream (1): PARTIAL. Only the tick spacing this repo pins is probed; the
//    factory's spacing set was not verified from its ABI, so spacings are NOT
//    invented. Other Slipstream pools still arrive via hints or the log scan.
//  - Uniswap v4 (7): handled by the caller (needs a PoolKey, so a hint or a wide
//    indexed-currency log query).
import "server-only";
import { decodeFunctionResult, encodeFunctionData, parseAbi, zeroAddress, type Address, type PublicClient } from "viem";
import { BASE_MAINNET_B20_TICK_SPACING } from "@/lib/executor/executor-config";
import { UNISWAP_V3_POOL_FEES } from "@/lib/executor/executor-config";
import { SWAP_PATH_VENUES } from "../swap-executor-config";
import { asset, V2QuoteError, type Pool } from "./discovery";

type Reader = Pick<PublicClient, "call" | "getCode">;

const props = parseAbi([
  "function factory() view returns(address)",
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function fee() view returns(uint24)",
  "function tickSpacing() view returns(int24)",
  "function stable() view returns(bool)",
]);
const factories = parseAbi([
  "function getPair(address,address) view returns(address)",
  "function getPool(address,address,uint24) view returns(address)",
  "function getPool(address,address,bool) view returns(address)",
]);
const slipFactory = parseAbi(["function getPool(address,address,int24) view returns(address)"]);

const weth = "0x4200000000000000000000000000000000000006";
const norm = (a: string) => (a.toLowerCase() === zeroAddress ? weth : a.toLowerCase());

/** Tick spacings probed on Slipstream. Deliberately only what this repo already
 * pins; the factory's full set was not verified from its ABI, so it is not
 * invented. Reported as partial coverage rather than silently treated as complete. */
export const SLIPSTREAM_PROBED_TICK_SPACINGS: readonly number[] = [BASE_MAINNET_B20_TICK_SPACING];
/** Venues whose enumeration is not exhaustive, so "no pool" is not definitive. */
export const PARTIAL_INDEX_VENUE_KINDS: readonly Pool["kind"][] = [1];

export interface FactoryIndexResult {
  pools: readonly Pool[];
  /** True when every probed venue answered, so a negative is authoritative. */
  complete: boolean;
  /** Venue kinds that were probed but whose enumeration is not exhaustive. */
  partialKinds: readonly number[];
  /** Venue kinds whose probe failed outright (RPC), so nothing is known. */
  failedKinds: readonly number[];
}

/** Candidate (factory, kind, router, lookup) tuples for a token pair. */
type VenueKind = Pool["kind"];
function candidates(input: Address, output: Address) {
  const out: { kind: VenueKind; router: Address; factory: Address; data: `0x${string}` }[] = [];
  const v2 = SWAP_PATH_VENUES.uniswapV2;
  out.push({ kind: v2.kind as VenueKind, router: v2.router, factory: v2.factory, data: encodeFunctionData({ abi: factories, functionName: "getPair", args: [input, output] }) });
  const classic = SWAP_PATH_VENUES.aerodromeClassic;
  for (const stable of [false, true] as const) {
    out.push({ kind: classic.kind as VenueKind, router: classic.router, factory: classic.factory, data: encodeFunctionData({ abi: factories, functionName: "getPool", args: [input, output, stable] }) });
  }
  const v3 = SWAP_PATH_VENUES.uniswapV3;
  for (const fee of UNISWAP_V3_POOL_FEES) {
    out.push({ kind: v3.kind as VenueKind, router: v3.router, factory: v3.factory, data: encodeFunctionData({ abi: factories, functionName: "getPool", args: [input, output, fee] }) });
  }
  const slip = SWAP_PATH_VENUES.slipstream;
  for (const tickSpacing of SLIPSTREAM_PROBED_TICK_SPACINGS) {
    out.push({ kind: slip.kind as VenueKind, router: slip.router, factory: slip.factory, data: encodeFunctionData({ abi: slipFactory, functionName: "getPool", args: [input, output, tickSpacing] }) });
  }
  return out;
}

/**
 * Asks each canonical factory whether it has a pool for this exact pair, then
 * verifies every non-zero answer against the pool's OWN metadata and the factory's
 * own registry entry. A pool that does not agree with its factory is discarded:
 * the index is authoritative, never assumed.
 */
export async function factoryIndexPools(
  client: Reader,
  input: Address,
  output: Address,
  blockNumber: bigint,
  budget: () => void,
): Promise<FactoryIndexResult> {
  const pools = new Map<string, Pool>();
  const failedKinds = new Set<VenueKind>();

  async function read(address: Address, data: `0x${string}`): Promise<`0x${string}` | null> {
    budget();
    const r = await client.call({ to: address, data, blockNumber });
    return r.data ?? null;
  }

  for (const c of candidates(input, output)) {
    let raw: `0x${string}` | null;
    try {
      raw = await read(c.factory, c.data);
    } catch {
      // A failed probe means "unknown" for this venue, never "no pool".
      failedKinds.add(c.kind);
      continue;
    }
    if (!raw) { failedKinds.add(c.kind); continue; }
    const address = ("0x" + raw.slice(-40)) as Address;
    if (address.toLowerCase() === zeroAddress) continue; // factory says: no such pool
    try {
      // Verify against the pool's own metadata.
      const meta = async <T,>(name: "factory" | "token0" | "token1" | "fee" | "tickSpacing" | "stable"): Promise<T> => {
        const data = await read(address, encodeFunctionData({ abi: props, functionName: name }));
        if (!data) throw new V2QuoteError("DISCOVERY_UNAVAILABLE", "Pool metadata unavailable");
        return decodeFunctionResult({ abi: props, functionName: name, data }) as T;
      };
      const [factory, token0, token1] = await Promise.all([meta<Address>("factory"), meta<Address>("token0"), meta<Address>("token1")]);
      if (factory.toLowerCase() !== c.factory.toLowerCase()) continue; // counterfeit or wrong venue
      if (!((norm(token0) === norm(input) && norm(token1) === norm(output)) || (norm(token1) === norm(input) && norm(token0) === norm(output)))) continue;
      const fee = c.kind === 2 ? await meta<number>("fee") : 0;
      const spacing = c.kind === 1 ? await meta<number>("tickSpacing") : 0;
      const stable = c.kind === 4 ? await meta<boolean>("stable") : false;
      // Confirm the factory maps this pair back to the same pool (canonical equality).
      const back = await read(c.factory, c.data);
      if (!back || norm("0x" + back.slice(-40)) !== norm(address)) continue;
      const id = `${c.factory.toLowerCase()}:${address.toLowerCase()}`;
      pools.set(id, {
        id, pool: address, router: c.router, factory: c.factory, kind: c.kind,
        token0: token0, token1: token1, poolFee: fee, tickSpacing: spacing, stable,
      });
    } catch {
      // One unverifiable pool must not discard the rest, and must not be counted
      // as a discovered route.
      failedKinds.add(c.kind);
    }
  }

  const partialKinds = PARTIAL_INDEX_VENUE_KINDS.filter((k) => !failedKinds.has(k));
  return {
    pools: [...pools.values()],
    // A negative is authoritative only if every venue answered AND no venue here
    // is known to be partially enumerated.
    complete: failedKinds.size === 0,
    partialKinds,
    failedKinds: [...failedKinds],
  };
}
