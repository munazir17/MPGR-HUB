// lib/staking/staking-history-reader.ts

import { getClient } from "wagmi/actions";
import { getBlock, getBlockNumber, getLogs } from "viem/actions";
import type { Address, AbiEvent, Log } from "viem";
import { config } from "@/lib/wagmi";
import { MPGR_STAKING_CONFIG } from "./staking-config";
import { stakedEventAbiItem, unstakedEventAbiItem, rewardPaidEventAbiItem } from "./staking-events-abi";
import { withRetry } from "@/lib/token/rpc-retry";
import { logger } from "@/lib/architecture/core/logger";
import type { StakingHistoryEvent, StakingHistoryEventKind } from "./staking-types";
// TEMPORARY — Phase 3F diagnostic trace only. See lib/_debug/reward-hub-trace.ts.
import { trace } from "@/lib/_debug/reward-hub-trace";

interface DecodedStakingLog extends Log {
  args: {
    user?: Address;
    amount?: bigint;
    reward?: bigint;
  };
}

const EVENTS: { kind: StakingHistoryEventKind; item: AbiEvent }[] = [
  { kind: "Staked", item: stakedEventAbiItem },
  { kind: "Unstaked", item: unstakedEventAbiItem },
  { kind: "RewardPaid", item: rewardPaidEventAbiItem },
];

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

// Phase 3F — Reward Hub perf fix. Same block ranges, same chunk width as
// before — the only change is that up to historyChunkConcurrency chunk
// requests for this event kind are now in flight at once instead of
// strictly one at a time. A failed chunk still logs and contributes an
// empty result rather than aborting the scan, exactly as before.
async function scanEventKind(
  walletAddress: Address,
  kind: StakingHistoryEventKind,
  item: AbiEvent,
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
  const kindStarted = trace.start(`${kind} scan`, {
    totalChunks: ranges.length,
    totalBatches: Math.ceil(ranges.length / concurrency),
    concurrency,
  });

  const results: DecodedStakingLog[] = [];

  for (let i = 0; i < ranges.length; i += concurrency) {
    const batch = ranges.slice(i, i + concurrency);
    const batchIndex = i / concurrency;
    // TEMPORARY — Phase 3F diagnostic trace only.
    const batchStarted = trace.start(`${kind} scan batch ${batchIndex}`, { chunksInBatch: batch.length });
    const batchResults = await Promise.all(
      batch.map(async ([batchChunkStart, batchChunkEnd]) => {
        try {
          const logs = await withRetry(
            `stakingHistoryReader.getLogs:${kind}:${batchChunkStart}-${batchChunkEnd}`,
            () =>
              getLogs(client, {
                address: MPGR_STAKING_CONFIG.address,
                event: item,
                args: { user: walletAddress },
                fromBlock: batchChunkStart,
                toBlock: batchChunkEnd,
              }),
            MPGR_STAKING_CONFIG.retry
          );
          return logs as DecodedStakingLog[];
        } catch (err) {
          logger.error("stakingHistoryReader.scanEventKind chunk failed, skipping chunk", {
            kind,
            chunkStart: batchChunkStart.toString(),
            chunkEnd: batchChunkEnd.toString(),
            error: err instanceof Error ? err.message : String(err),
          });
          return [] as DecodedStakingLog[];
        }
      })
    );
    // TEMPORARY — Phase 3F diagnostic trace only.
    trace.end(`${kind} scan batch ${batchIndex}`, batchStarted);

    for (const logs of batchResults) {
      results.push(...logs);
    }
  }

  // TEMPORARY — Phase 3F diagnostic trace only.
  trace.end(`${kind} scan`, kindStarted, { logs: results.length });

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
    const fetchStarted = trace.start("fetchHistory internal", {
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
    });
    trace.rpcSnapshot("fetchHistory internal BEFORE scans");

    try {
      const scansStarted = trace.start("all scanEventKind (Staked/Unstaked/RewardPaid, parallel)");
      const scans = await Promise.all(
        EVENTS.map(({ kind, item }) => scanEventKind(walletAddress, kind, item, fromBlock, toBlock))
      );
      trace.end("all scanEventKind (Staked/Unstaked/RewardPaid, parallel)", scansStarted);
      trace.rpcSnapshot("fetchHistory internal AFTER scans, BEFORE timestamp phase");

      const decoded = EVENTS.flatMap(({ kind }, i) =>
        scans[i].filter((log) => log.blockNumber !== null).map((log) => ({ log, kind }))
      );

      const uniqueBlocks = [...new Set(decoded.map(({ log }) => log.blockNumber as bigint))];
      // TEMPORARY — Phase 3F diagnostic trace only.
      const timestampPhaseStarted = trace.start("timestamp phase (getBlockTimestampMs fan-out)", {
        uniqueBlocks: uniqueBlocks.length,
      });
      const timestampEntries = await Promise.all(
        uniqueBlocks.map(async (blockNumber) => [blockNumber, await getBlockTimestampMs(blockNumber)] as const)
      );
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
      trace.end("fetchHistory internal", fetchStarted, { eventCount: deduped.length, uniqueBlocks: uniqueBlocks.length });
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
