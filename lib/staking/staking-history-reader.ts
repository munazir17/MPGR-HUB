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

// Phase 3E Part 4 — Staking History Reader.
//
// Low-level, RPC-facing module that reads a wallet's Staked / Unstaked /
// RewardPaid events directly from Base Mainnet via eth_getLogs, chunked
// the same way lib/token/transfer-event-reader.ts chunks its scans
// (public RPC endpoints commonly cap the width of a single getLogs
// call). Pure RPC I/O — no caching, no event-bus emission;
// staking-history-service.ts owns caching and dedup, exactly the way
// transaction-history-service.ts sits on top of transfer-event-reader.ts.

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

// Same block -> timestamp(ms) cache pattern as transfer-event-reader.ts,
// kept as its own map since it's keyed by blocks touched by staking
// events specifically, not token transfers.
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

// Scans a single event kind for `walletAddress` across [fromBlock,
// toBlock], chunked so no single getLogs call spans more than
// historyChunkSize blocks. A failed chunk is logged and skipped rather
// than aborting the whole scan, matching transfer-event-reader.ts's
// resilience.
async function scanEventKind(
  walletAddress: Address,
  kind: StakingHistoryEventKind,
  item: AbiEvent,
  fromBlock: bigint,
  toBlock: bigint
): Promise<DecodedStakingLog[]> {
  const client = getViemClient();
  const chunkSize = BigInt(MPGR_STAKING_CONFIG.historyChunkSize);
  const results: DecodedStakingLog[] = [];

  let chunkStart = fromBlock;
  while (chunkStart <= toBlock) {
    const chunkEnd = chunkStart + chunkSize - 1n > toBlock ? toBlock : chunkStart + chunkSize - 1n;

    try {
      const logs = await withRetry(
        `stakingHistoryReader.getLogs:${kind}:${chunkStart}-${chunkEnd}`,
        () =>
          getLogs(client, {
            address: MPGR_STAKING_CONFIG.address,
            event: item,
            args: { user: walletAddress },
            fromBlock: chunkStart,
            toBlock: chunkEnd,
          }),
        MPGR_STAKING_CONFIG.retry
      );
      results.push(...(logs as DecodedStakingLog[]));
    } catch (err) {
      logger.error("stakingHistoryReader.scanEventKind chunk failed, skipping chunk", {
        kind,
        chunkStart: chunkStart.toString(),
        chunkEnd: chunkEnd.toString(),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    chunkStart = chunkEnd + 1n;
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
  // Returns the current chain tip. Used by staking-history-service to
  // know how far forward it needs to scan on an incremental refresh.
  async getLatestBlockNumber(): Promise<bigint> {
    const client = getViemClient();
    return withRetry(
      "stakingHistoryReader.getLatestBlockNumber",
      () => getBlockNumber(client, {}),
      MPGR_STAKING_CONFIG.retry
    );
  },

  // Fetches every Staked / Unstaked / RewardPaid event for
  // `walletAddress` between fromBlock and toBlock (inclusive), deduped
  // and sorted oldest-first. Never throws — a scan that fails entirely
  // (e.g. RPC totally unreachable) returns an empty array so callers can
  // fall back to whatever's cached.
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
