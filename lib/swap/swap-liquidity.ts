// Read-only canonical factory discovery. NEVER feeds swap-route-candidates or signing.
import { isAddress, parseAbi, type Abi, type Address } from "viem";
import { BASE_MAINNET_UNISWAP_V3 as uni, BASE_MAINNET_SLIPSTREAM as slip, BASE_MAINNET_USDC, CANONICAL_WETH } from "@/lib/executor/executor-config";
import { isNativeEthSentinel } from "@/lib/trade/trade-config";
import { exactSwapAddress, finishSwapSnapshot, snapshotEvidence, startSwapSnapshot, SwapDiscoveryError, type SwapDiscoveryClient } from "./swap-discovery-read";
import { readSwapTokenMetadata } from "./swap-token-metadata";

// Official upstream sources/pins are recorded in PR113-SWAP-DEX-EXPANSION.md.
// These are read-only discovery sources, NOT Executor permissions or execution routers.
export const SWAP_DISCOVERY_V2_FACTORY: Address = "0x8909dc15e40173ff4699343b6eb8132c65e18ec6";
export const SWAP_DISCOVERY_CLASSIC_FACTORY: Address = "0x420dd381b31aef6683db6b902084cb0ffece40da";
export const SWAP_LIQUIDITY_SOURCES = [
  ...[100, 500, 3000, 10000].map(key => ({ venue: "uniswap-v3" as const, factory: uni.factory, key })),
  { venue: "slipstream" as const, factory: slip.factory, key: 10 },
  { venue: "uniswap-v2" as const, factory: SWAP_DISCOVERY_V2_FACTORY, key: 0 },
  { venue: "aerodrome-classic" as const, factory: SWAP_DISCOVERY_CLASSIC_FACTORY, key: false },
  { venue: "aerodrome-classic" as const, factory: SWAP_DISCOVERY_CLASSIC_FACTORY, key: true },
] as const;
type Source = (typeof SWAP_LIQUIDITY_SOURCES)[number];
const uniFactoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const slipFactoryAbi = parseAbi(["function getPool(address,address,int24) view returns (address)"]);
const v2FactoryAbi = parseAbi(["function getPair(address,address) view returns (address)"]);
const classicFactoryAbi = parseAbi(["function getPool(address,address,bool) view returns (address)"]);
const identityAbi = parseAbi(["function factory() view returns (address)", "function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)", "function tickSpacing() view returns (int24)", "function stable() view returns (bool)", "function liquidity() view returns (uint128)"]);
const v2ReservesAbi = parseAbi(["function getReserves() view returns (uint112,uint112,uint32)"]);
const classicReservesAbi = parseAbi(["function getReserves() view returns (uint256,uint256,uint256)"]);
const eq = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const nonzeroAddress = (v: unknown): v is Address => typeof v === "string" && isAddress(v, { strict: false }) && !/^0x0{40}$/i.test(v);
export type SwapPoolObservation = {
  venue: Source["venue"]; factory: Address; key: number | boolean; tokenA: Address; tokenB: Address;
  pool: Address | null; status: "not-found" | "active-liquidity" | "no-active-liquidity" | "identity-mismatch" | "provider-unavailable";
};
export type SwapLiquidityResult = {
  chainId: 8453; executionAuthorized: false; feeExecution: "IMMUTABLE_FEE_EXECUTOR_REQUIRED";
  snapshot: ReturnType<typeof snapshotEvidence>;
  tokens: Awaited<ReturnType<typeof readSwapTokenMetadata>>[];
  observations: SwapPoolObservation[];
  paths: { tokens: Address[]; poolsPerHop: Address[][]; executionSupported: false }[];
  scope: string; partial: boolean;
};
// <= 5 unique edges x 8 source keys = 40 candidates. Four workers; all reads pinned.
// No logs/backfills, client-supplied providers, arbitrary targets or unbounded graph walks.
export async function discoverSwapLiquidity(client: SwapDiscoveryClient, from: unknown, to: unknown): Promise<SwapLiquidityResult> {
  const poolAsset = (input: unknown) => { const a = exactSwapAddress(input); return isNativeEthSentinel(a) ? CANONICAL_WETH : a; };
  const a = poolAsset(from), b = poolAsset(to);
  if (eq(a, b)) throw new SwapDiscoveryError("SAME_UNDERLYING", "Choose two different assets. ETH and WETH are the same pool asset.", 400);
  const snapshot = await startSwapSnapshot(client);
  const paths = [[a, b], ...[BASE_MAINNET_USDC, CANONICAL_WETH].filter(bridge => !eq(bridge, a) && !eq(bridge, b)).map(bridge => [a, bridge, b])];
  const assets = [...new Map(paths.flat().map(address => [address.toLowerCase(), address])).values()];
  const tokens = await Promise.all(assets.map(address => readSwapTokenMetadata(client, address, snapshot.blockNumber)));
  const edges = new Map<string, [Address, Address]>();
  const edgeKey = (x: string, y: string) => [x.toLowerCase(), y.toLowerCase()].sort().join(":");
  for (const path of paths) for (let i = 0; i < path.length - 1; i++) edges.set(edgeKey(path[i], path[i + 1]), [path[i], path[i + 1]]);
  const read = (address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) => client.readContract({ address, abi, functionName, args, blockNumber: snapshot.blockNumber });
  const code = new Map<string, Promise<boolean>>();
  const hasCode = (address: Address) => {
    const key = address.toLowerCase();
    if (!code.has(key)) code.set(key, client.getCode({ address, blockNumber: snapshot.blockNumber }).then(c => !!c && c !== "0x"));
    return code.get(key)!;
  };
  const tasks = [...edges.values()].flatMap(([tokenA, tokenB]) => SWAP_LIQUIDITY_SOURCES.map(source => ({ tokenA, tokenB, source })));
  const observations: SwapPoolObservation[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < tasks.length) {
      const index = next++; const { tokenA, tokenB, source } = tasks[index];
      const result: SwapPoolObservation = { venue: source.venue, factory: source.factory, key: source.key, tokenA, tokenB, pool: null, status: "provider-unavailable" };
      observations[index] = result;
      try {
        if (!(await hasCode(source.factory))) { result.status = "identity-mismatch"; continue; }
        const v2 = source.venue === "uniswap-v2", classic = source.venue === "aerodrome-classic", concentrated = !v2 && !classic;
        const abi = v2 ? v2FactoryAbi : classic ? classicFactoryAbi : source.venue === "slipstream" ? slipFactoryAbi : uniFactoryAbi;
        const pool = await read(source.factory, abi, v2 ? "getPair" : "getPool", v2 ? [tokenA, tokenB] : [tokenA, tokenB, source.key]);
        if (typeof pool === "string" && /^0x0{40}$/i.test(pool)) { result.status = "not-found"; continue; }
        if (!nonzeroAddress(pool) || !(await hasCode(pool))) { result.status = "identity-mismatch"; continue; }
        const [factory, token0, token1, key, state] = await Promise.all([
          read(pool, identityAbi, "factory"), read(pool, identityAbi, "token0"), read(pool, identityAbi, "token1"),
          v2 ? Promise.resolve(0) : read(pool, identityAbi, classic ? "stable" : source.venue === "slipstream" ? "tickSpacing" : "fee"),
          read(pool, concentrated ? identityAbi : classic ? classicReservesAbi : v2ReservesAbi, concentrated ? "liquidity" : "getReserves"),
        ]);
        if (!eq(factory, source.factory) || !((eq(token0, tokenA) && eq(token1, tokenB)) || (eq(token0, tokenB) && eq(token1, tokenA))) || key !== source.key) { result.status = "identity-mismatch"; continue; }
        if (concentrated ? typeof state !== "bigint" || state < 0n : !Array.isArray(state) || state.length !== 3 || state.slice(0, 2).some(v => typeof v !== "bigint" || v < 0n)) { result.status = "identity-mismatch"; continue; }
        const active = concentrated ? (state as bigint) > 0n : (state as bigint[])[0] > 0n && (state as bigint[])[1] > 0n;
        result.pool = pool; result.status = active ? "active-liquidity" : "no-active-liquidity";
      } catch { /* Unknown remains explicitly partial, never "no route". No raw RPC errors. */ }
    }
  }));
  if (observations.every(o => o.status === "provider-unavailable")) throw new SwapDiscoveryError("LIQUIDITY_PROVIDER_UNAVAILABLE", "Base liquidity providers could not be read. Retry; this is not evidence of missing liquidity.");
  await finishSwapSnapshot(client, snapshot);
  const active = (x: Address, y: Address) => observations.filter(o => o.status === "active-liquidity" && o.pool && edgeKey(o.tokenA, o.tokenB) === edgeKey(x, y)).map(o => o.pool!);
  return { chainId: 8453, executionAuthorized: false, feeExecution: "IMMUTABLE_FEE_EXECUTOR_REQUIRED", snapshot: snapshotEvidence(snapshot), tokens, observations,
    paths: paths.map(tokens => ({ tokens, poolsPerHop: tokens.slice(1).map((t, i) => active(tokens[i], t)), executionSupported: false as const })).filter(p => p.poolsPerHop.every(h => h.length > 0)),
    scope: "Read-only: direct and two-hop via USDC/WETH; Uni V3 100/500/3000/10000, Slipstream spacing 10, Uni V2, Aerodrome Classic stable/volatile. Active liquidity/reserves are not an amount quote, execution authorization, gas estimate or settlement proof. Other tiers, bridges, venues and V4 are not searched.",
    partial: observations.some(o => o.status === "provider-unavailable" || o.status === "identity-mismatch"),
  };
}
