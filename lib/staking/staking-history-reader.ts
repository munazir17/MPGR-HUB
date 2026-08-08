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

async function getBlockTimestampMs(blockNumber: bigint): Promise<number> {
  const cached = blockTimestampCache.get(blockNumber);
  if (cached !== undefined) return cached;

  const client = getViemClient();
  const block = await withRetry(
    `stakingHistoryReader.getBlock:${blockNumber}`,
    () => getBlock(client, { blockNumber }),
    MPGR_STAKING_CONFIG.retry
  );
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

  const results: DecodedStakingLog[] = [];

  for (let i = 0; i < ranges.length; i += concurrency) {
    const batch = ranges.slice(i, i + concurrency);
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

    for (const logs of batchResults) {
      results.push(...logs);
    }
  }

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

    try {
      const scans = await Promise.all(
        EVENTS.map(({ kind, item }) => scanEventKind(walletAddress, kind, item, fromBlock, toBlock))
      );

      const decoded = EVENTS.flatMap(({ kind }, i) =>
        scans[i].filter((log) => log.blockNumber !== null).map((log) => ({ log, kind }))
      );

      const uniqueBlocks = [...new Set(decoded.map(({ log }) => log.blockNumber as bigint))];
      const timestampEntries = await Promise.all(
        uniqueBlocks.map(async (blockNumber) => [blockNumber, await getBlockTimestampMs(blockNumber)] as const)
      );
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

      return deduped;
    } catch (err) {
      logger.error("stakingHistoryReader.fetchHistory failed", {
        walletAddress,
        fromBlock: fromBlock.toString(),
        toBlock: toBlock.toString(),
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  },
} as const;
