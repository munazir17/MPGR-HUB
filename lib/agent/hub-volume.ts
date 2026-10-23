import "server-only";

import { decodeEventLog, parseAbiItem, type Address, type Hex } from "viem";

import { VERIFIED_HISTORICAL_AGENT_TRADES } from "@/lib/agent/agent-volume-history";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT, BASE_MAINNET_USDC } from "@/lib/executor/executor-config";
import { SWAP_PATH_EXECUTOR_DEPLOYMENT } from "@/lib/swap/swap-executor-config";
import { SWAP_V2_SEALED_MANIFEST } from "@/lib/swap/v2/sealed-manifest";

// Hub volume is the USDC notional of SwapExecuted on the agent executor and
// both swap executors. A capped Alchemy key cannot read that range, so this
// uses public archive endpoints in 5,000-block waves (BlockPI's cap). A pair
// with no USDC leg is skipped — its dollar value is not invented.

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
}

export interface HubVolume {
  totalValueTradedUsd: number;
  tradeCount: number;
}

export type SettleResult =
  | { done: true; volume: HubVolume; anchor: VolumeAnchor }
  | { done: false; anchor: VolumeAnchor };

interface Chunk { address: Address; fromBlock: bigint; toBlock: bigint }
interface RawLog { transactionHash?: Hex; data?: Hex; topics?: Hex[] }

export function hubVolumeSources(): HubVolumeSource[] {
  const swap = SWAP_PATH_EXECUTOR_DEPLOYMENT;
  return [
    { address: BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor, fromBlock: BigInt(BASE_MAINNET_EXECUTOR_DEPLOYMENT.deployBlock) },
    ...(swap ? [{ address: swap.executor, fromBlock: BigInt(swap.deployBlock) }] : []),
    { address: SWAP_V2_SEALED_MANIFEST.executor, fromBlock: BigInt(SWAP_V2_SEALED_MANIFEST.deployBlock) },
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
 * Add SwapExecuted USDC notionals after `anchor`. `done: false` means a
 * hole-free prefix was saved in `anchor` but head was not reached — do not
 * publish that prefix as the live total.
 */
export async function settleHubVolume(deadline: number, fetchImpl: typeof fetch, anchor: VolumeAnchor): Promise<SettleResult | null> {
  const latest = await blockNumber(fetchImpl);
  if (latest === null || Date.now() > deadline) return null;
  if (latest <= anchor.throughBlock) {
    const finished = applyMissingSeeds(anchor, new Set());
    const volume = toVolume(finished);
    return volume ? { done: true, volume, anchor: finished } : null;
  }

  let through = anchor.throughBlock;
  const earliest = hubVolumeSources().reduce((min, source) => source.fromBlock < min ? source.fromBlock : min, through + 1n) - 1n;
  if (through < earliest) through = earliest;

  let total = anchor.totalUsdcAtomic;
  let count = anchor.tradeCount;
  const seenLogs = new Set<string>();
  let progressed = false;

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
    for (const log of groups.flat()) {
      const notion = usdcNotional(log);
      if (notion === null) continue;
      total += notion;
      count += 1;
      if (log.transactionHash) seenLogs.add(log.transactionHash.toLowerCase());
    }
    through = to;
    progressed = true;
  }

  if (through < latest) {
    if (!progressed) return null;
    return {
      done: false,
      anchor: { throughBlock: through, totalUsdcAtomic: total, tradeCount: count, seedTxHashes: anchor.seedTxHashes },
    };
  }

  const finished = applyMissingSeeds(
    { throughBlock: latest, totalUsdcAtomic: total, tradeCount: count, seedTxHashes: anchor.seedTxHashes },
    seenLogs,
  );
  const volume = toVolume(finished);
  return volume ? { done: true, volume, anchor: finished } : null;
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

function usdcNotional(log: RawLog): bigint | null {
  if (!log.data || !log.topics || log.topics.length < 1) return null;
  try {
    const decoded = decodeEventLog({ abi: [EVENT], data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    const args = decoded.args as { tokenIn?: Address; tokenOut?: Address; grossAmountIn?: bigint; amountOut?: bigint };
    if (!args.tokenIn || !args.tokenOut || args.grossAmountIn === undefined || args.amountOut === undefined) return null;
    const usdc = BASE_MAINNET_USDC.toLowerCase();
    if (args.tokenIn.toLowerCase() === usdc) return args.grossAmountIn;
    if (args.tokenOut.toLowerCase() === usdc) return args.amountOut;
    return null;
  } catch {
    return null;
  }
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
