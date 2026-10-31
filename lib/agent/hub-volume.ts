import "server-only";

import { decodeEventLog, parseAbiItem, type Address, type Hex } from "viem";

import { VERIFIED_HISTORICAL_AGENT_TRADES } from "@/lib/agent/agent-volume-history";
import { PRICED_WETH_LEG_TRADES } from "@/lib/agent/hub-weth-legs";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT } from "@/lib/executor/executor-config";
import { SWAP_PATH_EXECUTOR_DEPLOYMENT } from "@/lib/swap/swap-executor-config";
import { SWAP_V2_SEALED_MANIFEST } from "@/lib/swap/v2/sealed-manifest";
import { classifyExecutedTrade, PENDING_LEG_CAP, type PendingLeg } from "@/lib/agent/executed-trade-value";
import { isNativeEthSentinel } from "@/lib/trade/trade-config";
import { KNOWN_TRADE_TOKENS } from "@/lib/trade/trade-tokens";
import delegatedMainnet from "../../deployments/base-mainnet/mpgr-executor-delegated.json";

// Hub volume is the USD notional of every successful SwapExecuted on the
// agent executor, both swap executors, and the delegated mainnet executor.
// BUY (stable in) counts grossAmountIn. SELL (stable out) counts amountOut.
// One side only. A leg that cannot be priced is queued on the cursor and
// retried; it does not block stable legs and it is not dropped. A log range
// that cannot be read still stops the scan — a hole is not a total.

// Public archive endpoints in 5,000-block waves (BlockPI's cap). A capped
// Alchemy key cannot read this range.
export const HUB_VOLUME_RPCS = [
  "https://base.public.blockpi.network/v1/rpc/public",
  "https://base.rpc.blxrbdn.com",
] as const;
export const HUB_VOLUME_RPC = HUB_VOLUME_RPCS[0];
export const HUB_LOG_SPAN = 5_000n;
const TOPIC =
  "0x80331ce92a7885c99237a1428f76bc2281c3b972ccae3004a248a6c0cf714a22" as const;
const EVENT = parseAbiItem(
  "event SwapExecuted(address indexed taker,address indexed router,bytes32 indexed intentId,address tokenIn,address tokenOut,uint256 grossAmountIn,uint256 feeAmount,uint256 swapAmountIn,uint256 amountOut,address feeRecipient,uint16 feeBps,uint8 routerKind,uint8 flags)",
);
const PROVIDER_TIMEOUT_MS = [8_000, 12_000] as const;
const WETH = "0x4200000000000000000000000000000000000006";
const DELEGATED_EXECUTOR = delegatedMainnet.executor as Address;
const DELEGATED_DEPLOY_BLOCK = BigInt(delegatedMainnet.deployedAtBlock);
const ETH_USD_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
const LATEST_ROUND_DATA = "0xfeaf968c";
const DECIMALS_SELECTOR = "0x313ce567";
const DEX_TOKEN_URL = "https://api.dexscreener.com/latest/dex/tokens/";

const KNOWN_DECIMALS = new Map<string, number>();
for (const token of KNOWN_TRADE_TOKENS) {
  if (isNativeEthSentinel(token.address)) continue;
  KNOWN_DECIMALS.set(token.address.toLowerCase(), token.decimals);
}

/** Chainlink ETH/USD answer (8 decimals) from latestRoundData, or null. */
export function decodeEthUsdAnswer(data: string): bigint | null {
  if (!/^0x[0-9a-fA-F]{320}$/.test(data)) return null;
  const answer = BigInt(`0x${data.slice(66, 130)}`);
  if (answer <= 0n || answer > 20_000n * 10n ** 8n) return null;
  return answer;
}

/** Token atomic units to USDC atomic (6 decimals) at an 8-decimal USD price. */
export function tokenAmountToUsdcAtomic(amount: bigint, decimals: number, price8: bigint): bigint {
  if (amount <= 0n || price8 <= 0n || decimals < 0 || decimals > 36) return 0n;
  return (amount * price8) / 10n ** BigInt(decimals + 2);
}

/** WETH wei to USDC atomic units (6 decimals) at an 8-decimal ETH/USD price. */
export function wethWeiToUsdcAtomic(wethWei: bigint, ethUsd8: bigint): bigint {
  return tokenAmountToUsdcAtomic(wethWei, 18, ethUsd8);
}

/** "123.45" → 8-decimal USD price. Rejects empty, signed, and non-numeric text. */
export function parseUsdPrice8(usd: string | undefined): bigint | null {
  if (!usd || !/^\d+(\.\d+)?$/.test(usd) || usd.split(".")[0].length > 12) return null;
  const [whole, frac = ""] = usd.split(".");
  const price = BigInt(whole) * 10n ** 8n + BigInt((frac + "00000000").slice(0, 8));
  return price > 0n ? price : null;
}

/** Add sealed WETH-leg dollars once. A cursor that already lists the hashes is unchanged. */
export function foldPricedWethLegs(anchor: VolumeAnchor): VolumeAnchor {
  if (anchor.wethLegTxHashes) return anchor;
  let total = anchor.totalUsdcAtomic;
  let count = anchor.tradeCount;
  const hashes: string[] = [];
  for (const trade of PRICED_WETH_LEG_TRADES) {
    total += trade.usdcAtomic;
    count += 1;
    hashes.push(trade.txHash.toLowerCase());
  }
  return { ...anchor, totalUsdcAtomic: total, tradeCount: count, wethLegTxHashes: hashes };
}

export interface HubVolumeSource {
  address: Address;
  fromBlock: bigint;
}

export interface VolumeAnchor {
  /** Inclusive. The next read starts at throughBlock + 1. */
  throughBlock: bigint;
  totalUsdcAtomic: bigint;
  tradeCount: number;
  /** Lowercase hashes of historical trades already included in the totals. */
  seedTxHashes: readonly string[];
  /** Lowercase hashes of WETH-leg swaps already included in totalUsdcAtomic.
   * Missing means those sealed legs have not been folded in yet. */
  wethLegTxHashes?: readonly string[];
  /** Inclusive block through which the delegated executor was scanned.
   * Missing means history at or before throughBlock has not been read yet. */
  delegatedThroughBlock?: bigint;
  /** Unpriced legs waiting for a USD price. Not included in the totals yet. */
  pendingLegs?: readonly PendingLeg[];
}

export interface HubVolume {
  totalValueTradedUsd: number;
  tradeCount: number;
}

export type SettleResult =
  | { done: true; volume: HubVolume; anchor: VolumeAnchor }
  | { done: false; anchor: VolumeAnchor };

interface Chunk { address: Address; fromBlock: bigint; toBlock: bigint }
interface RawLog { transactionHash?: Hex; data?: Hex; topics?: Hex[]; logIndex?: Hex | number | bigint }

export function hubVolumeSources(): HubVolumeSource[] {
  const swap = SWAP_PATH_EXECUTOR_DEPLOYMENT;
  return [
    { address: BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor, fromBlock: BigInt(BASE_MAINNET_EXECUTOR_DEPLOYMENT.deployBlock) },
    ...(swap ? [{ address: swap.executor, fromBlock: BigInt(swap.deployBlock) }] : []),
    { address: SWAP_V2_SEALED_MANIFEST.executor, fromBlock: BigInt(SWAP_V2_SEALED_MANIFEST.deployBlock) },
    { address: DELEGATED_EXECUTOR, fromBlock: DELEGATED_DEPLOY_BLOCK },
  ];
}

/** Prefer a cursor only when it is ahead of the sealed checkpoint and not smaller. */
export function anchorFromCursor(checkpoint: VolumeAnchor, stored: VolumeAnchor | null): VolumeAnchor {
  if (!stored) return checkpoint;
  if (stored.throughBlock < checkpoint.throughBlock) return checkpoint;
  if (stored.totalUsdcAtomic < checkpoint.totalUsdcAtomic) return checkpoint;
  if (stored.tradeCount < checkpoint.tradeCount) return checkpoint;
  const seeds = new Set<string>([
    ...checkpoint.seedTxHashes.map((hash) => hash.toLowerCase()),
    ...stored.seedTxHashes.map((hash) => hash.toLowerCase()),
  ]);
  return { ...stored, seedTxHashes: [...seeds] };
}

/**
 * Full read from deployment, including historical seeds. Returns null unless
 * every wave completes — a partial sum is not a total.
 */
export async function scanHubVolume(deadline: number, fetchImpl: typeof fetch = fetch): Promise<HubVolume | null> {
  const settled = await settleHubVolume(deadline, fetchImpl, {
    throughBlock: 0n,
    totalUsdcAtomic: 0n,
    tradeCount: 0,
    seedTxHashes: [],
  });
  return settled?.done ? settled.volume : null;
}

/**
 * Add executed swap notionals after `anchor`. `done: false` means a
 * hole-free prefix was saved in `anchor` but head was not reached — do not
 * publish that prefix as the live total. Unpriced legs stay on the anchor
 * and are retried; they are not published as value and they do not erase
 * stable BUY or SELL legs already read in a completed wave.
 */
export async function settleHubVolume(deadline: number, fetchImpl: typeof fetch, anchor: VolumeAnchor): Promise<SettleResult | null> {
  const latest = await blockNumber(fetchImpl);
  if (latest === null || Date.now() > deadline) return null;

  const state: ScanState = {
    total: anchor.totalUsdcAtomic,
    count: anchor.tradeCount,
    pending: [...(anchor.pendingLegs ?? [])],
    seen: new Set<string>(),
    pricedWeth: new Set((anchor.wethLegTxHashes ?? []).map((hash) => hash.toLowerCase())),
    ethUsd: undefined,
    dexPrice8: new Map(),
    decimalsCache: new Map(),
  };
  let through = anchor.throughBlock;
  let delegatedThrough = anchor.delegatedThroughBlock ?? (DELEGATED_DEPLOY_BLOCK - 1n);
  let progressed = false;

  const beforePending = state.pending.length;
  await retryPending(fetchImpl, state);
  if (state.pending.length !== beforePending) progressed = true;

  const historyEnd = through < latest ? through : latest;
  if (delegatedThrough < historyEnd && historyEnd >= DELEGATED_DEPLOY_BLOCK) {
    let cursor = delegatedThrough < DELEGATED_DEPLOY_BLOCK - 1n ? DELEGATED_DEPLOY_BLOCK - 1n : delegatedThrough;
    while (cursor < historyEnd) {
      if (Date.now() > deadline) {
        if (!progressed) return null;
        return { done: false, anchor: snapshot(anchor, through, state, delegatedThrough) };
      }
      const to = cursor + HUB_LOG_SPAN < historyEnd ? cursor + HUB_LOG_SPAN : historyEnd;
      const from = cursor + 1n < DELEGATED_DEPLOY_BLOCK ? DELEGATED_DEPLOY_BLOCK : cursor + 1n;
      if (from > to) {
        cursor = to;
        delegatedThrough = to;
        continue;
      }
      const logs = await readChunk(fetchImpl, { address: DELEGATED_EXECUTOR, fromBlock: from, toBlock: to }, deadline);
      if (!logs) {
        if (!progressed) return null;
        return { done: false, anchor: snapshot(anchor, through, state, delegatedThrough) };
      }
      if (await absorbLogs(fetchImpl, state, logs) === "capped") {
        if (!progressed) return null;
        return { done: false, anchor: snapshot(anchor, through, state, delegatedThrough) };
      }
      cursor = to;
      delegatedThrough = to;
      progressed = true;
    }
  }

  if (latest <= through) {
    if (delegatedThrough < through) delegatedThrough = through;
    const finished = applyMissingSeeds(snapshot(anchor, through, state, delegatedThrough), state.seen);
    const volume = toVolume(finished);
    return volume ? { done: true, volume, anchor: finished } : null;
  }

  const earliest = hubVolumeSources().reduce((min, source) => source.fromBlock < min ? source.fromBlock : min, through + 1n) - 1n;
  if (through < earliest) through = earliest;

  while (through < latest) {
    if (Date.now() > deadline) break;
    const to = through + HUB_LOG_SPAN < latest ? through + HUB_LOG_SPAN : latest;
    const from = through + 1n;
    const slices = hubVolumeSources()
      .filter((source) => source.fromBlock <= to)
      .map((source) => ({
        address: source.address,
        fromBlock: source.fromBlock > from ? source.fromBlock : from,
        toBlock: to,
      }))
      .filter((slice) => slice.fromBlock <= slice.toBlock);
    const groups = slices.length === 0
      ? []
      : await mapPool(slices, slices.length, (slice) => readChunk(fetchImpl, slice, deadline));
    if (!groups) break;
    if (await absorbLogs(fetchImpl, state, groups.flat()) === "capped") break;
    through = to;
    if (through > delegatedThrough) delegatedThrough = through;
    progressed = true;
  }

  if (through < latest) {
    if (!progressed) return null;
    return { done: false, anchor: snapshot(anchor, through, state, delegatedThrough) };
  }

  if (delegatedThrough < latest) delegatedThrough = latest;
  const finished = applyMissingSeeds(snapshot(anchor, latest, state, delegatedThrough), state.seen);
  const volume = toVolume(finished);
  return volume ? { done: true, volume, anchor: finished } : null;
}

interface ScanState {
  total: bigint;
  count: number;
  pending: PendingLeg[];
  seen: Set<string>;
  pricedWeth: Set<string>;
  ethUsd: bigint | null | undefined;
  dexPrice8: Map<string, bigint>;
  decimalsCache: Map<string, number>;
}

function snapshot(anchor: VolumeAnchor, throughBlock: bigint, state: ScanState, delegatedThroughBlock: bigint): VolumeAnchor {
  return {
    ...anchor,
    throughBlock,
    totalUsdcAtomic: state.total,
    tradeCount: state.count,
    delegatedThroughBlock,
    pendingLegs: state.pending,
  };
}

async function retryPending(fetchImpl: typeof fetch, state: ScanState): Promise<void> {
  if (state.pending.length === 0) return;
  const kept: PendingLeg[] = [];
  for (const leg of state.pending) {
    let amount: bigint;
    try {
      amount = BigInt(leg.amount);
    } catch {
      continue;
    }
    const usd = leg.kind === "weth"
      ? await priceWeth(fetchImpl, state, amount)
      : await tokenLegToUsdcAtomic(fetchImpl, leg.token, amount, state.dexPrice8, state.decimalsCache);
    if (usd === null) kept.push(leg);
    else {
      state.total += usd;
      state.count += 1;
    }
  }
  state.pending = kept;
}

/** Commit the wave only when every unpriced leg fits in the pending cap. */
async function absorbLogs(fetchImpl: typeof fetch, state: ScanState, logs: RawLog[]): Promise<"ok" | "capped"> {
  const draft = {
    total: state.total,
    count: state.count,
    pending: [...state.pending],
    seen: new Set(state.seen),
  };
  const ids = new Set(draft.pending.map((leg) => leg.id));
  for (const log of logs) {
    const hash = log.transactionHash?.toLowerCase();
    const id = logId(log);
    if (hash && state.pricedWeth.has(hash)) continue;
    if (ids.has(id)) continue;
    const leg = swapLeg(log);
    if (!leg) continue;
    if (leg.kind === "usd") {
      draft.total += leg.amount;
      draft.count += 1;
      if (hash) draft.seen.add(hash);
      ids.add(id);
      continue;
    }
    const usd = leg.kind === "weth"
      ? await priceWeth(fetchImpl, state, leg.amount)
      : await tokenLegToUsdcAtomic(fetchImpl, leg.token, leg.amount, state.dexPrice8, state.decimalsCache);
    if (usd === null) {
      if (draft.pending.length >= PENDING_LEG_CAP) return "capped";
      draft.pending.push({
        id,
        kind: leg.kind,
        token: leg.kind === "weth" ? WETH : leg.token,
        amount: leg.amount.toString(),
      });
      ids.add(id);
      if (hash) draft.seen.add(hash);
      continue;
    }
    draft.total += usd;
    draft.count += 1;
    if (hash) draft.seen.add(hash);
    ids.add(id);
  }
  state.total = draft.total;
  state.count = draft.count;
  state.pending = draft.pending;
  state.seen = draft.seen;
  return "ok";
}

async function priceWeth(fetchImpl: typeof fetch, state: ScanState, wei: bigint): Promise<bigint | null> {
  if (state.ethUsd === undefined) state.ethUsd = await readEthUsd(fetchImpl);
  if (state.ethUsd === null) return null;
  const usd = wethWeiToUsdcAtomic(wei, state.ethUsd);
  return usd > 0n ? usd : null;
}

function logId(log: RawLog): string {
  const hash = log.transactionHash?.toLowerCase() ?? "no-tx";
  const index = log.logIndex;
  const suffix = typeof index === "bigint" ? index.toString() : index === undefined ? "0" : String(index).toLowerCase();
  return `${hash}:${suffix}`;
}

function applyMissingSeeds(anchor: VolumeAnchor, seenLogs: ReadonlySet<string>): VolumeAnchor {
  const seeds = new Set(anchor.seedTxHashes.map((hash) => hash.toLowerCase()));
  let total = anchor.totalUsdcAtomic;
  let count = anchor.tradeCount;
  for (const trade of VERIFIED_HISTORICAL_AGENT_TRADES) {
    const hash = trade.txHash.toLowerCase();
    if (seeds.has(hash) || seenLogs.has(hash)) {
      seeds.add(hash);
      continue;
    }
    total += trade.usdcAtomic;
    count += 1;
    seeds.add(hash);
  }
  return { ...anchor, totalUsdcAtomic: total, tradeCount: count, seedTxHashes: [...seeds] };
}

function toVolume(anchor: VolumeAnchor): HubVolume | null {
  if (anchor.totalUsdcAtomic > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return {
    totalValueTradedUsd: Number(anchor.totalUsdcAtomic) / 1_000_000,
    tradeCount: anchor.tradeCount,
  };
}

async function readChunk(fetchImpl: typeof fetch, chunk: Chunk, deadline: number): Promise<RawLog[] | null> {
  if (Date.now() > deadline) return null;
  const params = [{
    address: chunk.address,
    topics: [TOPIC],
    fromBlock: hex(chunk.fromBlock),
    toBlock: hex(chunk.toBlock),
  }];
  for (let i = 0; i < HUB_VOLUME_RPCS.length; i += 1) {
    const timeout = PROVIDER_TIMEOUT_MS[i] ?? 8_000;
    let result = await rpc(fetchImpl, HUB_VOLUME_RPCS[i], "eth_getLogs", params, timeout);
    if (!result.ok && result.retryable) result = await rpc(fetchImpl, HUB_VOLUME_RPCS[i], "eth_getLogs", params, timeout);
    if (result.ok && Array.isArray(result.result)) {
      return result.result.filter((row): row is RawLog => !!row && typeof row === "object");
    }
  }
  return null;
}

function swapLeg(log: RawLog): ReturnType<typeof classifyExecutedTrade> {
  if (!log.data || !log.topics || log.topics.length < 1) return null;
  try {
    const decoded = decodeEventLog({ abi: [EVENT], data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    const args = decoded.args as { tokenIn?: Address; tokenOut?: Address; grossAmountIn?: bigint; amountOut?: bigint };
    if (!args.tokenIn || !args.tokenOut || args.grossAmountIn === undefined || args.amountOut === undefined) return null;
    return classifyExecutedTrade({
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
      grossAmountIn: args.grossAmountIn,
      amountOut: args.amountOut,
    });
  } catch {
    return null;
  }
}

async function tokenLegToUsdcAtomic(
  fetchImpl: typeof fetch,
  token: string,
  amount: bigint,
  prices: Map<string, bigint>,
  decimalsCache: Map<string, number>,
): Promise<bigint | null> {
  const decimals = await readTokenDecimals(fetchImpl, token, decimalsCache);
  if (decimals === null) return null;
  let price = prices.get(token);
  if (price === undefined) {
    const read = await readDexPrice8(fetchImpl, token);
    if (read === null) return null;
    price = read;
    prices.set(token, price);
  }
  return tokenAmountToUsdcAtomic(amount, decimals, price);
}

async function readTokenDecimals(fetchImpl: typeof fetch, token: string, cache: Map<string, number>): Promise<number | null> {
  const known = cache.get(token) ?? KNOWN_DECIMALS.get(token);
  if (known !== undefined) {
    cache.set(token, known);
    return known;
  }
  const params = [{ to: token, data: DECIMALS_SELECTOR }, "latest"];
  for (let i = 0; i < HUB_VOLUME_RPCS.length; i += 1) {
    const timeout = PROVIDER_TIMEOUT_MS[i] ?? 8_000;
    let result = await rpc(fetchImpl, HUB_VOLUME_RPCS[i], "eth_call", params, timeout);
    if (!result.ok && result.retryable) result = await rpc(fetchImpl, HUB_VOLUME_RPCS[i], "eth_call", params, timeout);
    if (result.ok && typeof result.result === "string") {
      const decoded = decodeDecimals(result.result);
      if (decoded !== null) {
        cache.set(token, decoded);
        return decoded;
      }
    }
  }
  return null;
}

function decodeDecimals(data: string): number | null {
  if (!/^0x[0-9a-fA-F]+$/.test(data)) return null;
  try {
    const value = BigInt(data);
    if (value > 36n) return null;
    return Number(value);
  } catch {
    return null;
  }
}

async function readDexPrice8(fetchImpl: typeof fetch, token: string): Promise<bigint | null> {
  try {
    const response = await fetchImpl(`${DEX_TOKEN_URL}${token}`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return null;
    const body = await response.json() as {
      pairs?: { chainId?: string; priceUsd?: string; liquidity?: { usd?: number }; baseToken?: { address?: string } }[];
    };
    let best: { price: bigint; liquidity: number } | null = null;
    for (const pair of body.pairs ?? []) {
      if (pair.chainId !== "base" || pair.baseToken?.address?.toLowerCase() !== token) continue;
      const price = parseUsdPrice8(pair.priceUsd);
      const liquidity = Number(pair.liquidity?.usd ?? 0);
      if (price === null) continue;
      if (!best || liquidity > best.liquidity) best = { price, liquidity };
    }
    return best?.price ?? null;
  } catch {
    return null;
  }
}

async function readEthUsd(fetchImpl: typeof fetch): Promise<bigint | null> {
  const params = [{ to: ETH_USD_FEED, data: LATEST_ROUND_DATA }, "latest"];
  for (let i = 0; i < HUB_VOLUME_RPCS.length; i += 1) {
    const timeout = PROVIDER_TIMEOUT_MS[i] ?? 8_000;
    let result = await rpc(fetchImpl, HUB_VOLUME_RPCS[i], "eth_call", params, timeout);
    if (!result.ok && result.retryable) result = await rpc(fetchImpl, HUB_VOLUME_RPCS[i], "eth_call", params, timeout);
    if (result.ok && typeof result.result === "string") {
      const answer = decodeEthUsdAnswer(result.result);
      if (answer !== null) return answer;
    }
  }
  return null;
}

async function blockNumber(fetchImpl: typeof fetch): Promise<bigint | null> {
  for (let i = 0; i < HUB_VOLUME_RPCS.length; i += 1) {
    const timeout = PROVIDER_TIMEOUT_MS[i] ?? 8_000;
    let result = await rpc(fetchImpl, HUB_VOLUME_RPCS[i], "eth_blockNumber", [], timeout);
    if (!result.ok && result.retryable) result = await rpc(fetchImpl, HUB_VOLUME_RPCS[i], "eth_blockNumber", [], timeout);
    if (result.ok && typeof result.result === "string" && /^0x[0-9a-f]+$/i.test(result.result)) return BigInt(result.result);
  }
  return null;
}

async function rpc(
  fetchImpl: typeof fetch,
  url: string,
  method: string,
  params: unknown[],
  timeoutMs: number,
): Promise<{ ok: true; result: unknown } | { ok: false; retryable: boolean }> {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await response.json() as { result?: unknown; error?: { message?: unknown } };
    if (!response.ok || body.error) {
      const message = typeof body.error?.message === "string" ? body.error.message : String(response.status);
      return { ok: false, retryable: response.status === 429 || response.status === 503 || /rate|limit|timeout|unavailable|busy/i.test(message) };
    }
    return { ok: true, result: body.result };
  } catch {
    return { ok: false, retryable: true };
  }
}

function hex(value: bigint): Hex {
  return `0x${value.toString(16)}`;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R | null>): Promise<R[] | null> {
  if (items.length === 0) return [];
  const out: R[] = [];
  let cursor = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const value = await fn(items[index]);
      if (value === null) {
        failed = true;
        return;
      }
      out.push(value);
    }
  });
  await Promise.all(workers);
  return failed ? null : out;
}
