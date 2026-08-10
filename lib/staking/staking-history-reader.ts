// lib/staking/staking-history-reader.ts

import { getClient } from "wagmi/actions";
import { getBlock, getBlockNumber, getLogs } from "viem/actions";
import type { Address } from "viem";
import { config } from "@/lib/wagmi";
import { MPGR_STAKING_CONFIG } from "./staking-config";
import { stakedEventAbiItem, unstakedEventAbiItem, rewardPaidEventAbiItem } from "./staking-events-abi";
import { withRetry } from "@/lib/token/rpc-retry";
import { logger } from "@/lib/architecture/core/logger";
import type { StakingHistoryEvent, StakingHistoryEventKind } from "./staking-types";
// TEMPORARY — Phase 3F diagnostic trace only. See lib/_debug/reward-hub-trace.ts.
import { trace } from "@/lib/_debug/reward-hub-trace";

// Phase 3F perf fix (measured-evidence pass, events-without-args revision).
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
// Two combined-scan approaches were tried and rejected by this project's
// installed viem version (2.55.10) before this one:
//   1. getLogs({ events: [...], args: { user } }) — viem's typed getLogs
//      infers the `args` filter shape against a single event ABI; passing
//      multiple distinct AbiEvent objects via `events` collapses the
//      allowed `args` type to `undefined`, so `{ user: walletAddress }`
//      isn't assignable. This is a hard constraint of the `events`
//      overload in this version, not a narrow-typing gap.
//   2. getLogs({ topics: [...] }) — viem's typed getLogs action doesn't
//      expose a raw `topics` parameter at all; its parameter type is a
//      closed union of {address, event?, events?, args?, strict?}
//      variants, none of which include `topics`.
//
// This revision uses `events: [...]` WITHOUT `args` — the one combined
// shape this project's build has already proven it accepts (the very
// first build error was specifically about `args`, not about `events`
// itself being rejected). getLogs() returns logs filtered server-side by
// event signature (Staked OR Unstaked OR RewardPaid) and auto-decoded
// into `{ eventName, args }`. The wallet filter, which can no longer ride
// along as `args` on this call, is applied immediately after as a plain
// equality check on the already-decoded `args.user` — the same
// comparison `args: { user }` would have made, evaluated in-process
// instead of server-side.
//
// Tradeoff: each chunk request now returns Staked/Unstaked/RewardPaid logs
// for ALL stakers in that block range, not just this wallet, filtered down
// immediately after decode. This does not change request count (~100) or
// concurrency (8) — the measured 429 cause — only response payload size
// per chunk, which scales with total protocol-wide staking activity in
// that range rather than just this wallet's.
//
// Same lookback, same chunk size, same historyChunkConcurrency value, same
// event coverage, same wallet filtering result (server-side -> in-process
// equality check) — only the number of RPC round trips changes: ~300 ->
// ~100 total, peak concurrent requests 24 -> 8.

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

// Phase 3F perf fix (measured-evidence pass, events-without-args revision).
// See the file-level comment above for full rationale. Same 100 chunks,
// same historyChunkConcurrency-bounded batching, same fromBlock/toBlock
// range, same retry wrapper, same "failed chunk logs and contributes
// nothing rather than aborting the scan" behavior. Wallet filtering is
// applied in-process immediately after each chunk's decode (see rationale
// above) rather than as a server-side `args` filter.
async function scanAllEvents(
  walletAddress: Address,
  fromBlock: bigint,
  toBlock: bigint
): Promise<ScannedStakingEvent[]> {
  const client = getViemClient();
  const chunkSize = BigInt(MPGR_STAKING_CONFIG.historyChunkSize);
  const concurrency = Math.max(1, MPGR_STAKING_CONFIG.historyChunkConcurrency);
  const walletLower = walletAddress.toLowerCase();

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
                events: [stakedEventAbiItem, unstakedEventAbiItem, rewardPaidEventAbiItem],
                fromBlock: batchChunkStart,
                toBlock: batchChunkEnd,
              }),
            MPGR_STAKING_CONFIG.retry
          );
          // In-process wallet filter — see file-level comment for why
          // this can't ride along as a server-side `args` filter here.
          return logs.filter((log) => log.args.user?.toLowerCase() === walletLower);
        } catch (err) {
          logger.error("stakingHistoryReader.scanAllEvents chunk failed, skipping chunk", {
            chunkStart: batchChunkStart.toString(),
            chunkEnd: batchChunkEnd.toString(),
            error: err instanceof Error ? err.message : String(err),
          });
          return [];
        }
      })
    );
    // TEMPORARY — Phase 3F diagnostic trace only.
    trace.end(`combined scan batch ${batchIndex}`, batchStarted);

    for (const logs of batchResults) {
      for (const log of logs) {
        if (log.blockNumber === null) continue;
        results.push({
          kind: log.eventName,
          amount: log.eventName === "RewardPaid" ? log.args.reward ?? 0n : log.args.amount ?? 0n,
          txHash: (log.transactionHash ?? "0x0") as `0x${string}`,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex ?? 0,
        });
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
