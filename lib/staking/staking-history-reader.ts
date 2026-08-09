// lib/staking/staking-history-reader.ts

import { getClient } from "wagmi/actions";
import { getBlock, getBlockNumber, getLogs } from "viem/actions";
import type { Address, Log } from "viem";
import { config } from "@/lib/wagmi";
import { MPGR_STAKING_CONFIG } from "./staking-config";
import { stakedEventAbiItem, unstakedEventAbiItem, rewardPaidEventAbiItem } from "./staking-events-abi";
import { withRetry } from "@/lib/token/rpc-retry";
import { logger } from "@/lib/architecture/core/logger";
import type { StakingHistoryEvent, StakingHistoryEventKind } from "./staking-types";
// TEMPORARY — Phase 3F diagnostic trace only. See lib/_debug/reward-hub-trace.ts.
import { trace } from "@/lib/_debug/reward-hub-trace";

// Phase 3F perf fix (measured-evidence pass) — see fetchHistory() below for
// the full rationale. Staked/Unstaked/RewardPaid all live on the same
// contract address and share the same indexed `user` parameter at the same
// position, so a single chunked getLogs() scan requesting all three event
// signatures at once replaces what used to be three independent full
// chunked scans. Same lookback, same chunk size, same
// historyChunkConcurrency value, same event/block coverage — only the
// number of RPC round trips changes.
interface DecodedStakingLog extends Log {
  // Present on every log returned by viem's getLogs() when called with the
  // `events` (plural) parameter — used here to tell the three event kinds
  // apart post-fetch. Typed loosely (string, not the narrower union) and
  // validated via isStakingHistoryEventKind() below rather than assumed,
  // so an unexpected value is skipped and logged instead of crashing.
  eventName?: string;
  args: {
    user?: Address;
    amount?: bigint;
    reward?: bigint;
  };
}

function isStakingHistoryEventKind(name: string | undefined): name is StakingHistoryEventKind {
  return name === "Staked" || name === "Unstaked" || name === "RewardPaid";
}

const blockTimestampCache = new Map<bigint, number>();

function getViemClient() {
  const client = getClient(config, { chainId: MPGR_STAKING_CONFIG.chainId });
  if (!client) {
    throw new Error(`No viem client configured for chain ${MPGR_STAKING_CONFIG.chainId}`);
  }
  return client;
}

// TEMPORARY — Phase 3F diagnostic trace only.
let getBlockCallCount = 0;
export function __resetGetBlockCallCount(): void {
  getBlockCallCount = 0;
}

// TEMPORARY — Phase 3F diagnostic trace only. Lets the next trace run
// directly confirm the ~300 -> ~100 request-count reduction.
let getLogsCallCount = 0;
export function __resetGetLogsCallCount(): void {
  getLogsCallCount = 0;
}

async function getBlockTimestampMs(blockNumber: bigint): Promise<number> {
  const cached = blockTimestampCache.get(blockNumber);
  if (cached !== undefined) return cached;

  const client = getViemClient();
  // TEMPORARY — Phase 3F diagnostic trace only.
  getBlockCallCount += 1;
  const started = trace.start(`getBlock:${blockNumber}`);
  const block = await withRetry(
    `stakingHistoryReader.getBlock:${blockNumber}`,
    () => getBlock(client, { blockNumber }),
    MPGR_STAKING_CONFIG.retry
  );
  trace.end(`getBlock:${blockNumber}`, started);
  const timestampMs = Number(block.timestamp) * 1000;
  blockTimestampCache.set(blockNumber, timestampMs);
  return timestampMs;
}

// Phase 3F perf fix (measured-evidence pass). Previously this file called
// scanEventKind() three times — once per event kind — each running its own
// independent 100-chunk scan, all three fired concurrently via
// Promise.all(). That meant up to 8 (historyChunkConcurrency) x 3 = 24
// simultaneous getLogs requests against a single public RPC endpoint, and
// ~300 total requests for one cold load. Measured trace evidence showed
// nearly every one of those requests getting 429'd by mainnet.base.org,
// with retry/backoff consuming the ~40-55s cold load.
//
// scanAllEvents() replaces all three calls with ONE chunked scan per block
// range, requesting all three event signatures in a single getLogs() call
// per chunk (viem's `events` — plural — parameter). Same 100 chunks, same
// historyChunkConcurrency-bounded batching, same fromBlock/toBlock range,
// same per-wallet `user` filter, same retry wrapper, same "failed chunk
// logs and contributes nothing rather than aborting the scan" behavior —
// only the request count changes: ~300 -> ~100, and peak concurrent
// requests: 24 -> 8.
async function scanAllEvents(
  walletAddress: Address,
  fromBlock: bigint,
  toBlock: bigint
): Promise<DecodedStakingLog[]> {
  const client = getViemClient();
  const chunkSize = BigInt(MPGR_STAKING_CONFIG.historyChunkSize);
  const concurrency = Math.max(1, MPGR_STAKING_CONFIG.historyChunkConcurrency);

  const ranges: [bigint, bigint][] = [];
  let chunkStart = fromBlock;
  while (chunkStart <= toBlock) {
    const chunkEnd = chunkStart + chunkSize - 1n > toBlock ? toBlock : chunkStart + chunkSize - 1n;
    ranges.push([chunkStart, chunkEnd]);
    chunkStart = chunkEnd + 1n;
  }

  // TEMPORARY — Phase 3F diagnostic trace only.
  const scanStarted = trace.start("combined scan (Staked+Unstaked+RewardPaid, single getLogs per chunk)", {
    totalChunks: ranges.length,
    totalBatches: Math.ceil(ranges.length / concurrency),
    concurrency,
  });

  const results: DecodedStakingLog[] = [];

  for (let i = 0; i < ranges.length; i += concurrency) {
    const batch = ranges.slice(i, i + concurrency);
    const batchIndex = i / concurrency;
    // TEMPORARY — Phase 3F diagnostic trace only.
    const batchStarted = trace.start(`combined scan batch ${batchIndex}`, { chunksInBatch: batch.length });
    const batchResults = await Promise.all(
      batch.map(async ([batchChunkStart, batchChunkEnd]) => {
        try {
          // TEMPORARY — Phase 3F diagnostic trace only.
          getLogsCallCount += 1;
          const logs = await withRetry(
            `stakingHistoryReader.getLogs:combined:${batchChunkStart}-${batchChunkEnd}`,
            () =>
              getLogs(client, {
                address: MPGR_STAKING_CONFIG.address,
                events: [stakedEventAbiItem, unstakedEventAbiItem, rewardPaidEventAbiItem],
                args: { user: walletAddress },
                fromBlock: batchChunkStart,
                toBlock: batchChunkEnd,
              }),
            MPGR_STAKING_CONFIG.retry
          );
          return logs as DecodedStakingLog[];
        } catch (err) {
          logger.error("stakingHistoryReader.scanAllEvents chunk failed, skipping chunk", {
            chunkStart: batchChunkStart.toString(),
            chunkEnd: batchChunkEnd.toString(),
            error: err instanceof Error ? err.message : String(err),
          });
          return [] as DecodedStakingLog[];
        }
      })
    );
    // TEMPORARY — Phase 3F diagnostic trace only.
    trace.end(`combined scan batch ${batchIndex}`, batchStarted);

    for (const logs of batchResults) {
      results.push(...logs);
    }
  }

  // TEMPORARY — Phase 3F diagnostic trace only.
  trace.end("combined scan (Staked+Unstaked+RewardPaid, single getLogs per chunk)", scanStarted, {
    logs: results.length,
    staked: results.filter((l) => l.eventName === "Staked").length,
    unstaked: results.filter((l) => l.eventName === "Unstaked").length,
    rewardPaid: results.filter((l) => l.eventName === "RewardPaid").length,
    getLogsCallCount,
  });

  return results;
}

function toHistoryEvent(
  log: DecodedStakingLog,
  kind: StakingHistoryEventKind,
  timestampMs: number
): StakingHistoryEvent {
  const rawAmount = kind === "RewardPaid" ? log.args.reward ?? 0n : log.args.amount ?? 0n;
  return {
    id: `${log.transactionHash ?? "0x0"}:${log.logIndex ?? 0}`,
    kind,
    amount: rawAmount,
    txHash: (log.transactionHash ?? "0x0") as `0x${string}`,
    blockNumber: log.blockNumber ?? 0n,
    timestamp: new Date(timestampMs).toISOString(),
  };
}

export const stakingHistoryReader = {
  async getLatestBlockNumber(): Promise<bigint> {
    const client = getViemClient();
    return withRetry(
      "stakingHistoryReader.getLatestBlockNumber",
      () => getBlockNumber(client, {}),
      MPGR_STAKING_CONFIG.retry
    );
  },

  async fetchHistory(
    walletAddress: Address,
    fromBlock: bigint,
    toBlock: bigint
  ): Promise<StakingHistoryEvent[]> {
    if (fromBlock > toBlock) return [];

    // TEMPORARY — Phase 3F diagnostic trace only.
    __resetGetBlockCallCount();
    __resetGetLogsCallCount();
    const fetchStarted = trace.start("fetchHistory internal", {
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
    });
    trace.rpcSnapshot("fetchHistory internal BEFORE scans");

    try {
      const scansStarted = trace.start("combined scanAllEvents");
      const combinedLogs = await scanAllEvents(walletAddress, fromBlock, toBlock);
      trace.end("combined scanAllEvents", scansStarted, { logs: combinedLogs.length });
      trace.rpcSnapshot("fetchHistory internal AFTER scans, BEFORE timestamp phase");

      const decoded = combinedLogs
        .filter((log) => log.blockNumber !== null && isStakingHistoryEventKind(log.eventName))
        .map((log) => ({ log, kind: log.eventName as StakingHistoryEventKind }));

      const uniqueBlocks = [...new Set(decoded.map(({ log }) => log.blockNumber as bigint))];

      // Timestamp fan-out — measured at ~400ms with 3 unique blocks on the
      // last cold load, not a meaningful contributor to the ~40-55s total.
      // Left as-is (still bounded per-batch below), unchanged from the
      // prior diagnostic pass.
      const timestampConcurrency = Math.max(1, MPGR_STAKING_CONFIG.historyChunkConcurrency);
      // TEMPORARY — Phase 3F diagnostic trace only.
      const timestampPhaseStarted = trace.start("timestamp phase (getBlockTimestampMs fan-out)", {
        uniqueBlocks: uniqueBlocks.length,
        concurrency: timestampConcurrency,
        totalBatches: Math.ceil(uniqueBlocks.length / timestampConcurrency),
      });
      const timestampEntries: (readonly [bigint, number])[] = [];
      for (let i = 0; i < uniqueBlocks.length; i += timestampConcurrency) {
        const batch = uniqueBlocks.slice(i, i + timestampConcurrency);
        const batchIndex = i / timestampConcurrency;
        // TEMPORARY — Phase 3F diagnostic trace only.
        const batchStarted = trace.start(`timestamp phase batch ${batchIndex}`, { blocksInBatch: batch.length });
        const batchResults = await Promise.all(
          batch.map(async (blockNumber) => [blockNumber, await getBlockTimestampMs(blockNumber)] as const)
        );
        // TEMPORARY — Phase 3F diagnostic trace only.
        trace.end(`timestamp phase batch ${batchIndex}`, batchStarted);
        timestampEntries.push(...batchResults);
      }
      trace.end("timestamp phase (getBlockTimestampMs fan-out)", timestampPhaseStarted, {
        uniqueBlocks: uniqueBlocks.length,
        getBlockCallCount,
      });
      trace.rpcSnapshot("fetchHistory internal AFTER timestamp phase");
      const timestampsByBlock = new Map(timestampEntries);

      const events = decoded.map(({ log, kind }) => {
        const timestampMs = timestampsByBlock.get(log.blockNumber as bigint) ?? Date.now();
        return toHistoryEvent(log, kind, timestampMs);
      });

      const seen = new Set<string>();
      const deduped: StakingHistoryEvent[] = [];
      for (const event of events) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        deduped.push(event);
      }
      deduped.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));

      // TEMPORARY — Phase 3F diagnostic trace only.
      trace.end("fetchHistory internal", fetchStarted, {
        eventCount: deduped.length,
        uniqueBlocks: uniqueBlocks.length,
        getLogsCallCount,
      });
      return deduped;
    } catch (err) {
      logger.error("stakingHistoryReader.fetchHistory failed", {
        walletAddress,
        fromBlock: fromBlock.toString(),
        toBlock: toBlock.toString(),
        error: err instanceof Error ? err.message : String(err),
      });
      // TEMPORARY — Phase 3F diagnostic trace only.
      trace.end("fetchHistory internal", fetchStarted, { failed: true });
      return [];
    }
  },
} as const;
