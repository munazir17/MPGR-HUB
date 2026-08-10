// lib/staking/staking-history-reader.ts

import { getClient } from "wagmi/actions";
import { getBlock, getBlockNumber, getLogs } from "viem/actions";
import { decodeEventLog, encodeEventTopics } from "viem";
import type { Address, Hex, Log } from "viem";
import { config } from "@/lib/wagmi";
import { MPGR_STAKING_CONFIG } from "./staking-config";
import { stakedEventAbiItem, unstakedEventAbiItem, rewardPaidEventAbiItem } from "./staking-events-abi";
import { withRetry } from "@/lib/token/rpc-retry";
import { logger } from "@/lib/architecture/core/logger";
import type { StakingHistoryEvent, StakingHistoryEventKind } from "./staking-types";
// TEMPORARY — Phase 3F diagnostic trace only. See lib/_debug/reward-hub-trace.ts.
import { trace } from "@/lib/_debug/reward-hub-trace";

// Phase 3F perf fix (measured-evidence pass, raw-topic revision).
//
// Previously this file called scanEventKind() three times — once per event
// kind, each running its own independent 100-chunk scan, all three fired
// concurrently via Promise.all(). That meant up to 8
// (historyChunkConcurrency) x 3 = 24 simultaneous getLogs requests against
// a single public RPC endpoint, and ~300 total requests for one cold load.
// Measured trace evidence showed nearly every one of those requests
// getting 429'd by mainnet.base.org, with retry/backoff consuming the
// ~40-55s cold load.
//
// A first attempt to combine the three scans used viem's getLogs()
// `events` (plural) + `args` parameters, which failed to type-check: this
// project's installed viem version (^2.21.19) can only infer the `args`
// filter shape against a single event ABI — passing multiple distinct
// AbiEvent objects via `events` collapses the allowed `args` type to
// `undefined`, even though the RPC method itself supports multi-event
// filtering fine.
//
// This revision achieves the same combined-scan result using viem's raw
// `topics` filter instead, which types unambiguously regardless of event
// count:
//   topics[0] = [topic0(Staked), topic0(Unstaked), topic0(RewardPaid)]
//     -> an array at a topic position is an OR match in eth_getLogs.
//   topics[1] = the wallet's indexed `user` topic (identical for all three
//     events, since all three declare `user` as their sole indexed
//     parameter at the same position)
//     -> a single value at a topic position is an AND match.
// Combined: "(Staked OR Unstaked OR RewardPaid) AND user == this wallet" —
// byte-identical filtering to three separate calls, server-side, in one
// request per chunk. Each topic is computed via encodeEventTopics() called
// once per event (single-event calls, so fully typed, no ambiguity) so the
// encoded address bytes are guaranteed identical to what the original
// per-event calls produced.
//
// Returned logs are undecoded (raw topics filtering doesn't auto-decode),
// so each is decoded via decodeEventLog() against all three event ABIs at
// once — viem picks the matching event by topic0 — wrapped in try/catch so
// a single bad log is skipped and logged rather than aborting the scan,
// matching the existing failed-chunk philosophy.
//
// Same lookback, same chunk size, same historyChunkConcurrency value, same
// event/block coverage, same wallet filter — only the number of RPC round
// trips changes: ~300 -> ~100 total, peak concurrent requests 24 -> 8.

const STAKING_EVENT_ABI = [stakedEventAbiItem, unstakedEventAbiItem, rewardPaidEventAbiItem] as const;

interface ScannedStakingEvent {
  kind: StakingHistoryEventKind;
  amount: bigint;
  txHash: `0x${string}`;
  blockNumber: bigint;
  logIndex: number;
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

// Decodes a single raw log against all three staking event ABIs at once
// (viem matches by topic0 internally) and extracts the amount/reward field
// per kind, exactly as the previous per-event toHistoryEvent() did. Returns
// null (rather than throwing) for a log that doesn't decode against any of
// the three — logged and skipped by the caller, scan continues.
function decodeStakingLog(log: Log): ScannedStakingEvent | null {
  if (log.blockNumber === null) return null;

  try {
    const decoded = decodeEventLog({
      abi: STAKING_EVENT_ABI,
      data: log.data,
      topics: log.topics,
    });

    const amount = decoded.eventName === "RewardPaid" ? decoded.args.reward : decoded.args.amount;

    return {
      kind: decoded.eventName,
      amount: amount ?? 0n,
      txHash: (log.transactionHash ?? "0x0") as `0x${string}`,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex ?? 0,
    };
  } catch (err) {
    logger.error("stakingHistoryReader.decodeStakingLog failed, skipping log", {
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// Phase 3F perf fix (measured-evidence pass, raw-topic revision). See the
// file-level comment above for full rationale. Same 100 chunks, same
// historyChunkConcurrency-bounded batching, same fromBlock/toBlock range,
// same per-wallet filter (now via raw topics rather than viem's `args`
// sugar, producing byte-identical filtering), same retry wrapper, same
// "failed chunk logs and contributes nothing rather than aborting the
// scan" behavior.
async function scanAllEvents(
  walletAddress: Address,
  fromBlock: bigint,
  toBlock: bigint
): Promise<ScannedStakingEvent[]> {
  const client = getViemClient();
  const chunkSize = BigInt(MPGR_STAKING_CONFIG.historyChunkSize);
  const concurrency = Math.max(1, MPGR_STAKING_CONFIG.historyChunkConcurrency);

  // Each encodeEventTopics call is single-event (fully typed, unambiguous,
  // same pattern as the original per-event scan calls) — only the raw
  // topic0/topic1 hex values are merged afterward, at the untyped hex
  // level, which is always type-safe.
  const stakedTopics = encodeEventTopics({
    abi: [stakedEventAbiItem],
    eventName: "Staked",
    args: { user: walletAddress },
  });
  const unstakedTopics = encodeEventTopics({
    abi: [unstakedEventAbiItem],
    eventName: "Unstaked",
    args: { user: walletAddress },
  });
  const rewardPaidTopics = encodeEventTopics({
    abi: [rewardPaidEventAbiItem],
    eventName: "RewardPaid",
    args: { user: walletAddress },
  });

  const stakedTopic0 = stakedTopics[0];
  const unstakedTopic0 = unstakedTopics[0];
  const rewardPaidTopic0 = rewardPaidTopics[0];
  // `user` is the sole indexed parameter on all three events at the same
  // position, so this is the same wallet topic for all of them — take it
  // from any one of the three encoded results.
  const userTopic = stakedTopics[1];

  if (!stakedTopic0 || !unstakedTopic0 || !rewardPaidTopic0 || !userTopic) {
    throw new Error("stakingHistoryReader.scanAllEvents: failed to encode event topics");
  }

  const combinedTopics: [Hex[], Hex] = [[stakedTopic0, unstakedTopic0, rewardPaidTopic0], userTopic];

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

  const results: ScannedStakingEvent[] = [];

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
                topics: combinedTopics,
                fromBlock: batchChunkStart,
                toBlock: batchChunkEnd,
              }),
            MPGR_STAKING_CONFIG.retry
          );
          return logs;
        } catch (err) {
          logger.error("stakingHistoryReader.scanAllEvents chunk failed, skipping chunk", {
            chunkStart: batchChunkStart.toString(),
            chunkEnd: batchChunkEnd.toString(),
            error: err instanceof Error ? err.message : String(err),
          });
          return [] as Log[];
        }
      })
    );
    // TEMPORARY — Phase 3F diagnostic trace only.
    trace.end(`combined scan batch ${batchIndex}`, batchStarted);

    for (const logs of batchResults) {
      for (const log of logs) {
        const decoded = decodeStakingLog(log);
        if (decoded) results.push(decoded);
      }
    }
  }

  // TEMPORARY — Phase 3F diagnostic trace only.
  trace.end("combined scan (Staked+Unstaked+RewardPaid, single getLogs per chunk)", scanStarted, {
    logs: results.length,
    staked: results.filter((e) => e.kind === "Staked").length,
    unstaked: results.filter((e) => e.kind === "Unstaked").length,
    rewardPaid: results.filter((e) => e.kind === "RewardPaid").length,
    getLogsCallCount,
  });

  return results;
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
      const scanned = await scanAllEvents(walletAddress, fromBlock, toBlock);
      trace.end("combined scanAllEvents", scansStarted, { logs: scanned.length });
      trace.rpcSnapshot("fetchHistory internal AFTER scans, BEFORE timestamp phase");

      const uniqueBlocks = [...new Set(scanned.map((e) => e.blockNumber))];

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

      const events: StakingHistoryEvent[] = scanned.map((e) => {
        const timestampMs = timestampsByBlock.get(e.blockNumber) ?? Date.now();
        return {
          id: `${e.txHash}:${e.logIndex}`,
          kind: e.kind,
          amount: e.amount,
          txHash: e.txHash,
          blockNumber: e.blockNumber,
          timestamp: new Date(timestampMs).toISOString(),
        };
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
