// Swap-only route admission. Discovery/imports never feed this registry.
import { isAddress, parseAbi, type Abi, type Address, type PublicClient, type Hex } from "viem";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as deployment, BASE_MAINNET_SLIPSTREAM, BASE_MAINNET_UNISWAP_V3, RouterKind, type ExecutorRoute } from "@/lib/executor/executor-config";
import { MPGR_EXECUTOR_ABI } from "@/lib/executor/mpgr-executor-abi";
import type { ChainReader } from "@/lib/executor/executor-chain";
import { isSwapRouteCandidate } from "./swap-route-candidates";
import { swapPoolAsset, swapRouteIssue } from "./swap-capability";

export type SwapRouteReadClient = Pick<PublicClient, "getChainId" | "getBlockNumber" | "readContract" | "getCode" | "getBalance" | "simulateContract"> & { getBlock(args: { blockNumber: bigint }): Promise<{ number: bigint | null; hash: Hex | null; timestamp: bigint }> };
export class SwapRouteQualificationError extends Error {
  constructor(public reason: string, message: string, public status: 422 | 503 = 422) { super(message); }
}
const reject = (reason: string, message: string): never => { throw new SwapRouteQualificationError(reason, message); };
const eq = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const slipFactoryAbi = parseAbi(["function getPool(address,address,int24) view returns (address)"]);
const poolAbi = parseAbi(["function factory() view returns (address)", "function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)", "function tickSpacing() view returns (int24)"]);
const tokenAbi = parseAbi(["function decimals() view returns (uint8)"]);

/** Exactly the already registered pair, never an arbitrary discovered pool or a first-match fallback. */
export function selectRegisteredSwapRoute(from: string, to: string) {
  const issue = swapRouteIssue(from, to);
  if (issue) return reject(issue.code, issue.message);
  const a = swapPoolAsset(from), b = swapPoolAsset(to);
  const routes = deployment.routes.filter(r => (eq(r.tokenA, a) && eq(r.tokenB, b)) || (eq(r.tokenA, b) && eq(r.tokenB, a)));
  // There is currently one approved route per pair. Do not silently choose if
  // a future registry introduces alternatives without matching quote/policy review.
  if (!routes.length) return reject("FEE_ROUTE_UNREGISTERED", "No legacy pair registration exists. Use the bounded Swap-only pool search.");
  if (routes.length !== 1) return reject("ROUTE_AMBIGUOUS", "Multiple registrations require explicit route comparison and review. No swap was prepared.");
  const route = routes[0];
  const uni = route.kind === RouterKind.UNISWAP_V3_ROUTER02;
  const venue = uni ? BASE_MAINNET_UNISWAP_V3 : BASE_MAINNET_SLIPSTREAM;
  const router = uni ? BASE_MAINNET_UNISWAP_V3.swapRouter02 : BASE_MAINNET_SLIPSTREAM.swapRouter;
  if (!eq(route.router, router) || !eq(route.quoter, venue.quoterV2)) return reject("VENUE_UNVERIFIED", "The registered router/quoter does not match the approved venue.");
  return { route, factory: venue.factory, uni };
}

/** All admission reads AND the existing proposal builder's reads/quotes share one block. */
export async function qualifyRegisteredSwapRoute(client: SwapRouteReadClient, from: string, to: string, pinnedBlock?: bigint) {
  return qualifySwapRouteCandidate(client, from, to, selectRegisteredSwapRoute(from, to).route, pinnedBlock);
}

/** Candidate must be from the deterministic approved-token/venue search space. */
export async function qualifySwapRouteCandidate(client: SwapRouteReadClient, from: string, to: string, route: ExecutorRoute, pinnedBlock?: bigint) {
  if (!isSwapRouteCandidate(from, to, route)) return reject("VENUE_UNVERIFIED", "This route is outside the approved assisted single-hop search space.");
  const uni = route.kind === RouterKind.UNISWAP_V3_ROUTER02;
  const selected = { route, factory: (uni ? BASE_MAINNET_UNISWAP_V3 : BASE_MAINNET_SLIPSTREAM).factory, uni };
  try {
    if (await client.getChainId() !== 8453) throw new SwapRouteQualificationError("UNSUPPORTED_NETWORK", "Base Mainnet could not be verified.", 503);
    const blockNumber = pinnedBlock ?? await client.getBlockNumber({ cacheTime: 0 });
    const block = await client.getBlock({ blockNumber });
    const age = Date.now() - Number(block.timestamp) * 1000;
    if (block.number !== blockNumber || !block.hash || !/^0x[0-9a-f]{64}$/i.test(block.hash) || !Number.isFinite(age) || age > 30_000 || age < -15_000) return reject("STALE_BLOCK", "A fresh Base block could not be verified. Retry shortly.");
    const read = (address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) => client.readContract({ address, abi, functionName, args, blockNumber });
    const a = swapPoolAsset(from) as Address, b = swapPoolAsset(to) as Address;
    const { factory } = selected;
    const [sellAllowed, buyAllowed, kind, recipient, bps, owner, paused, da, db, pool] = await Promise.all([
      read(deployment.executor, MPGR_EXECUTOR_ABI, "isTokenAllowed", [a]),
      read(deployment.executor, MPGR_EXECUTOR_ABI, "isTokenAllowed", [b]),
      read(deployment.executor, MPGR_EXECUTOR_ABI, "routerKind", [route.router]),
      read(deployment.executor, MPGR_EXECUTOR_ABI, "feeRecipient"), read(deployment.executor, MPGR_EXECUTOR_ABI, "feeBps"),
      read(deployment.executor, MPGR_EXECUTOR_ABI, "owner"), read(deployment.executor, MPGR_EXECUTOR_ABI, "paused"),
      read(a, tokenAbi, "decimals"), read(b, tokenAbi, "decimals"),
      read(factory, uni ? factoryAbi : slipFactoryAbi, "getPool", [a, b, uni ? route.poolFee : route.tickSpacing]),
    ]);
    if (sellAllowed !== true || buyAllowed !== true || kind !== route.kind) return reject("EXECUTOR_PERMISSION_MISMATCH", "This route no longer matches the Executor's token/router permissions. No approval or swap was requested.");
    if (!eq(recipient, deployment.feeRecipient)) return reject("FEE_RECIPIENT_CHANGED", "The Executor fee recipient changed. Owner verification is required; no swap was prepared.");
    if (bps !== 25 && bps !== 25n) return reject("FEE_POLICY_INVALID", "The Executor must currently collect the 0.25% trading fee. No swap was prepared.");
    if (!eq(owner, deployment.owner) || paused !== false) return reject("EXECUTOR_POSTURE_CHANGED", "The Executor owner or pause state changed. Operator verification is required.");
    for (const [address, decimals] of [[a, da], [b, db]] as const) {
      if (deployment.tokens.find(t => eq(t.address, address))?.decimals !== decimals) return reject("TOKEN_METADATA_UNAVAILABLE", "Live decimals do not match the approved registration.");
    }
    if (typeof pool !== "string" || !isAddress(pool) || /^0x0{40}$/i.test(pool)) return reject("POOL_UNVERIFIED", "The approved factory has no verified direct pool for this route. No swap was prepared.");
    const [poolFactory, token0, token1, key, ...codes] = await Promise.all([
      read(pool, poolAbi, "factory"), read(pool, poolAbi, "token0"), read(pool, poolAbi, "token1"), read(pool, poolAbi, uni ? "fee" : "tickSpacing"),
      ...[deployment.executor, route.router, route.quoter, factory, pool].map(address => client.getCode({ address, blockNumber })),
    ]);
    if (!eq(poolFactory, factory) || !((eq(token0, a) && eq(token1, b)) || (eq(token0, b) && eq(token1, a))) || key !== (uni ? route.poolFee : route.tickSpacing) || codes.some(code => !code || code === "0x")) return reject("POOL_UNVERIFIED", "The direct pool identity, key or deployed contracts could not be verified. No swap was prepared.");
    const reader: ChainReader = {
      chainId: 8453,
      getBytecode: async ({ address }) => await client.getCode({ address, blockNumber }) ?? null,
      readContract: args => client.readContract({ ...args, abi: args.abi as Abi, blockNumber }),
      simulateContract: async args => { const result = await client.simulateContract({ ...args, abi: args.abi as Abi, blockNumber }); return { result: result.result }; },
      getBalance: args => client.getBalance({ ...args, blockNumber }),
      getTransactionReceipt: async () => { throw new Error("Receipt reads are outside quote admission"); },
    };
    await verifyQualifiedSwapBlock(client, { blockNumber, blockHash: block.hash });
    // This is permission/pool identity admission, NOT an Executor execution or settlement proof.
    return { ...selected, pool, blockNumber, blockHash: block.hash, reader };
  } catch (error) {
    if (error instanceof SwapRouteQualificationError) throw error;
    throw new SwapRouteQualificationError("ROUTE_VERIFICATION_UNAVAILABLE", "Current Base route permissions and pool identity could not be verified. Retry shortly; no swap was prepared.", 503);
  }
}

/** Detect reorg/staleness again after slow quote/impact reads; never extend expiry. */
export async function verifyQualifiedSwapBlock(client: SwapRouteReadClient, context: { blockNumber: bigint; blockHash: Hex }) {
  const end = await client.getBlock({ blockNumber: context.blockNumber });
  if (end.number !== context.blockNumber || end.hash !== context.blockHash) return reject("BLOCK_CHANGED", "The Base block changed during quote preparation. Request a fresh quote.");
  const age = Date.now() - Number(end.timestamp) * 1000;
  if (!Number.isFinite(age) || age > 30_000 || age < -15_000) return reject("STALE_BLOCK", "The Base snapshot expired during preparation. Request a fresh quote.");
}
