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
//
// Phase 3G addendum — Alchemy Free-tier compatibility. historyChunkSize is
// now 10 (Alchemy's Base free-tier eth_getLogs range cap), and
// historyChunkConcurrency is 4. Neither the request-building loop above
// nor the per-chunk logic below changed for this — both already derived
// entirely from MPGR_STAKING_CONFIG. What's new is the CU-budget pacing
// sleep at the end of each batch (see below), added because 10-block
// chunks mean many more requests than before, and a fast network could
// otherwise submit them faster than the account's real throughput budget
// allows. staking-history-service.ts also changed, to call this function
// with progressively larger ranges (an initial window, then backward
// backfill steps) instead of the full historyLookbackBlocks span in one
// call — this file's scanning logic itself is unaware of that; it always
// just scans whatever [fromBlock, toBlock] it's given.
//
// Phase 3H — completeness signal (correctness fix). scanAllEvents() and
// fetchHistory() now return { events, complete } instead of a bare array.
// A chunk that exhausts withRetry, or a per-block timestamp lookup that
// exhausts withRetry, no longer silently resolves to "zero events for
// that piece" indistinguishable from a genuinely empty range — it flips
// `complete` to false while still returning everything that DID succeed.
// staking-history-service.ts uses this to decide whether it's safe to
// advance lastBlockScanned/earliestBlockScanned; see that file's
// scanAndCache for the consuming logic. No change to which events get
// returned on success, no change to retry behavior (still the single
// withRetry authority), no change to chunk size/concurrency/pacing.

interface ScannedStakingEvent {
  kind: StakingHistoryEventKind;
  amount: bigint;
  txHash: `0x${string}`;
  blockNumber: bigint;
  logIndex: number;
}

// Phase 3G — CU-budget batch pacing. Self-contained (not imported from
// rpc-retry.ts) since this paces the scan's request-submission rate, a
// different concern from that file's per-call retry/backoff.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
// Phase 3H — result shape for scanAllEvents/fetchHistory. `complete: false`
// means at least one chunk (or, in fetchHistory, a block timestamp lookup)
// failed after exhausting withRetry's attempts. `events` still contains
// everything that DID succeed — never discarded — but callers in
// staking-history-service.ts must not advance a scan-boundary pointer
// across an incomplete range. See that file's scanAndCache for how this
// is used.
interface ScanResult<T> {
  events: T[];
  complete: boolean;
}

async function scanAllEvents(
  walletAddress: Address,
  fromBlock: bigint,
  toBlock: bigint
): Promise<ScanResult<ScannedStakingEvent>> {
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
  // Phase 3H — starts true; any chunk that exhausts withRetry and lands
  // in the catch below flips it to false and stays false for the rest of
  // this call. Never flipped back to true.
  let complete = true;

  for (let i = 0; i < ranges.length; i += concurrency) {
    const batch = ranges.slice(i, i + concurrency);
    const batchIndex = i / concurrency;
    // TEMPORARY — Phase 3F diagnostic trace only.
    const batchStarted = trace.start(`combined scan batch ${batchIndex}`, { chunksInBatch: batch.length });
    const batchWallStart = Date.now();
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
          logger.error("stakingHistoryReader.scanAllEvents chunk failed after retries, marking range incomplete", {
            chunkStart: batchChunkStart.toString(),
            chunkEnd: batchChunkEnd.toString(),
            error: err instanceof Error ? err.message : String(err),
          });
          // Phase 3H — this chunk's range is NOT confirmed scanned. Return
          // no events for it (never fabricate what it might have
          // contained), but the caller must not treat the requested
          // [fromBlock, toBlock] as fully covered because of this.
          complete = false;
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

    // Phase 3G — CU-budget pacing. Alchemy Free tier's account-wide
    // throughput cap is historyMaxCuPerSecond (see staking-config.ts);
    // eth_getLogs costs historyGetLogsCuCostEstimate CU each. Without
    // this, a fast network (low round-trip time) would submit batches
    // faster than the account's real throughput budget and trigger
    // avoidable 429 throttling — the retry layer would then mask it,
    // but at the cost of extra wall-clock time and requests. This makes
    // the scan self-limiting instead: if a batch's own round trip
    // already took longer than the budget requires, no extra wait is
    // added; only the shortfall is slept.
    const minBatchIntervalMs = Math.ceil(
      (batch.length * MPGR_STAKING_CONFIG.historyGetLogsCuCostEstimate /
        MPGR_STAKING_CONFIG.historyMaxCuPerSecond) *
        1000
    );
    const batchElapsedMs = Date.now() - batchWallStart;
    if (batchElapsedMs < minBatchIntervalMs) {
      await sleep(minBatchIntervalMs - batchElapsedMs);
    }
  }

  // TEMPORARY — Phase 3F diagnostic trace only.
  trace.end("combined scan (Staked+Unstaked+RewardPaid, single getLogs per chunk)", scanStarted, {
    logs: results.length,
    staked: results.filter((e) => e.kind === "Staked").length,
    unstaked: results.filter((e) => e.kind === "Unstaked").length,
    rewardPaid: results.filter((e) => e.kind === "RewardPaid").length,
    getLogsCallCount,
    complete,
  });

  return { events: results, complete };
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
  ): Promise<ScanResult<StakingHistoryEvent>> {
    if (fromBlock > toBlock) return { events: [], complete: true };

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
      const scanResult = await scanAllEvents(walletAddress, fromBlock, toBlock);
      const scanned = scanResult.events;
      // Phase 3H — overall completeness for this fetchHistory call. Starts
      // from scanAllEvents' getLogs-chunk result; the timestamp phase
      // below can additionally flip it to false, but never back to true.
      let complete = scanResult.complete;
      trace.end("combined scanAllEvents", scansStarted, { logs: scanned.length, complete });
      trace.rpcSnapshot("fetchHistory internal AFTER scans, BEFORE timestamp phase");

      const uniqueBlocks = [...new Set(scanned.map((e) => e.blockNumber))];

      // Timestamp fan-out — measured at ~400ms with 3 unique blocks on the
      // last cold load, not a meaningful contributor to the ~40-55s total.
      // Left as-is (still bounded per-batch below), unchanged from the
      // prior diagnostic pass.
      //
      // Phase 3H — each lookup is now individually caught. Previously an
      // exhausted-retries failure here was UNCAUGHT: it propagated out of
      // Promise.all, was caught by this function's outer try/catch below,
      // and that catch returned an empty result — discarding every event
      // scanAllEvents had already successfully found, not just the one
      // block's timestamp. Now a failed lookup is logged, marks the whole
      // call incomplete (so staking-history-service retries the range),
      // and simply leaves that block out of timestampsByBlock — the
      // existing `?? Date.now()` fallback below already handles a missing
      // entry, so the affected event still renders with an approximate
      // timestamp rather than vanishing.
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
          batch.map(async (blockNumber) => {
            try {
              const timestampMs = await getBlockTimestampMs(blockNumber);
              return { blockNumber, timestampMs: timestampMs as number | undefined };
            } catch (err) {
              logger.error("stakingHistoryReader.fetchHistory timestamp lookup failed after retries, marking range incomplete", {
                blockNumber: blockNumber.toString(),
                error: err instanceof Error ? err.message : String(err),
              });
              complete = false;
              return { blockNumber, timestampMs: undefined as number | undefined };
            }
          })
        );
        // TEMPORARY — Phase 3F diagnostic trace only.
        trace.end(`timestamp phase batch ${batchIndex}`, batchStarted);
        for (const r of batchResults) {
          if (r.timestampMs !== undefined) {
            timestampEntries.push([r.blockNumber, r.timestampMs] as const);
          }
        }
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
        complete,
      });
      return { events: deduped, complete };
    } catch (err) {
      logger.error("stakingHistoryReader.fetchHistory failed", {
        walletAddress,
        fromBlock: fromBlock.toString(),
        toBlock: toBlock.toString(),
        error: err instanceof Error ? err.message : String(err),
      });
      // TEMPORARY — Phase 3F diagnostic trace only.
      trace.end("fetchHistory internal", fetchStarted, { failed: true });
      // Phase 3H — this path is now only reached by a genuinely
      // unexpected error outside the per-chunk/per-timestamp handling
      // above (e.g. getViemClient() itself failing). Always incomplete —
      // never claim a range was scanned when this branch runs.
      return { events: [], complete: false };
    }
  },
} as const;
