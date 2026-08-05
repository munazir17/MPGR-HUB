// lib/token/transfer-event-reader.ts

import { getClient } from "wagmi/actions";
import { getBlock, getBlockNumber, getLogs, watchContractEvent } from "viem/actions";
import type { Address, Log } from "viem";
import { config } from "@/lib/wagmi";
import { MPGR_TOKEN_CONFIG } from "./token-config";
import { transferEventAbiItem } from "./transfer-events-abi";
import { withRetry } from "./rpc-retry";
import { logger } from "@/lib/architecture/core/logger";
import type { TokenTransferEvent, TransferDirection } from "./token-types";

// Phase 3E Part 2 — Transfer Event Reader.
//
// Low-level, RPC-facing module that reads MPGR `Transfer` events directly
// from Base Mainnet via eth_getLogs, chunked into small block ranges
// (public RPC endpoints commonly cap the width of a single getLogs call)
// and wrapped in the shared retry helper. Mirrors token-client.ts's role
// for balances/metadata: pure RPC I/O, no caching, no event-bus emission
// — transaction-history-service.ts owns caching, dedup, and event
// emission, exactly the way balance-service.ts sits on top of
// token-client.ts today.

interface DecodedTransferLog extends Log {
  args: {
    from?: Address;
    to?: Address;
    value?: bigint;
  };
}

// In-memory block -> timestamp(ms) cache. A single scan often touches
// the same handful of blocks more than once (multiple transfers in one
// block, or overlap between the "in" and "out" direction scans), so this
// avoids one getBlock RPC call per transfer. Self-limiting: callers only
// ever look back MPGR_TOKEN_CONFIG.transferLogLookbackBlocks, so this
// cache never grows past that window's worth of unique blocks.
const blockTimestampCache = new Map<bigint, number>();

function getViemClient() {
  const client = getClient(config, { chainId: MPGR_TOKEN_CONFIG.chainId });
  if (!client) {
    throw new Error(`No viem client configured for chain ${MPGR_TOKEN_CONFIG.chainId}`);
  }
  return client;
}

async function getBlockTimestampMs(blockNumber: bigint): Promise<number> {
  const cached = blockTimestampCache.get(blockNumber);
  if (cached !== undefined) return cached;

  const client = getViemClient();
  const block = await withRetry(`transferEventReader.getBlock:${blockNumber}`, () =>
    getBlock(client, { blockNumber })
  );
  const timestampMs = Number(block.timestamp) * 1000;
  blockTimestampCache.set(blockNumber, timestampMs);
  return timestampMs;
}

// Scans a single direction ("in" = wallet is `to`, "out" = wallet is
// `from`) across [fromBlock, toBlock], chunked so no single getLogs call
// spans more than transferLogChunkSize blocks. A failed chunk is logged
// and skipped rather than aborting the whole scan, so a transient RPC
// blip on one chunk doesn't wipe out an otherwise-successful scan.
async function scanDirection(
  walletAddress: Address,
  direction: TransferDirection,
  fromBlock: bigint,
  toBlock: bigint
): Promise<DecodedTransferLog[]> {
  const client = getViemClient();
  const chunkSize = BigInt(MPGR_TOKEN_CONFIG.transferLogChunkSize);
  const results: DecodedTransferLog[] = [];

  let chunkStart = fromBlock;
  while (chunkStart <= toBlock) {
    const chunkEnd = chunkStart + chunkSize - 1n > toBlock ? toBlock : chunkStart + chunkSize - 1n;
    const args = direction === "in" ? { to: walletAddress } : { from: walletAddress };

    try {
      const logs = await withRetry(
        `transferEventReader.getLogs:${direction}:${chunkStart}-${chunkEnd}`,
        () =>
          getLogs(client, {
            address: MPGR_TOKEN_CONFIG.address,
            event: transferEventAbiItem,
            args,
            fromBlock: chunkStart,
            toBlock: chunkEnd,
          })
      );
      results.push(...(logs as DecodedTransferLog[]));
    } catch (err) {
      logger.error("transferEventReader.scanDirection chunk failed, skipping chunk", {
        direction,
        chunkStart: chunkStart.toString(),
        chunkEnd: chunkEnd.toString(),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    chunkStart = chunkEnd + 1n;
  }

  return results;
}

function toTransferEvent(
  log: DecodedTransferLog,
  walletAddress: Address,
  direction: TransferDirection,
  timestampMs: number
): TokenTransferEvent {
  const rawValue = log.args.value ?? 0n;
  const decimals = MPGR_TOKEN_CONFIG.decimals;
  return {
    txHash: (log.transactionHash ?? "0x0") as `0x${string}`,
    logIndex: log.logIndex ?? 0,
    blockNumber: log.blockNumber ?? 0n,
    timestamp: new Date(timestampMs).toISOString(),
    from: (log.args.from ?? "0x0000000000000000000000000000000000000000") as Address,
    to: (log.args.to ?? "0x0000000000000000000000000000000000000000") as Address,
    walletAddress,
    direction,
    amount: {
      raw: rawValue,
      formatted: rawValue.toString(),
      decimal: decimals,
    },
  };
}

export const transferEventReader = {
  // Returns the current chain tip. Used by transaction-history-service to
  // know how far forward it needs to scan on an incremental refresh.
  async getLatestBlockNumber(): Promise<bigint> {
    const client = getViemClient();
    return withRetry("transferEventReader.getLatestBlockNumber", () => getBlockNumber(client, {}));
  },

  // Fetches every incoming + outgoing MPGR transfer for `walletAddress`
  // between fromBlock and toBlock (inclusive), deduped and sorted
  // oldest-first. Never throws — a scan that fails entirely (e.g. RPC
  // totally unreachable) returns an empty array so callers can fall back
  // to whatever they already have cached.
  async fetchTransfers(
    walletAddress: Address,
    fromBlock: bigint,
    toBlock: bigint
  ): Promise<TokenTransferEvent[]> {
    if (fromBlock > toBlock) return [];

    try {
      const [incoming, outgoing] = await Promise.all([
        scanDirection(walletAddress, "in", fromBlock, toBlock),
        scanDirection(walletAddress, "out", fromBlock, toBlock),
      ]);

      const decoded = [...incoming, ...outgoing].filter((log) => log.blockNumber !== null);

      // Resolve block timestamps for every unique block touched by this
      // scan, deduped, so repeated transfers within the same block only
      // trigger one getBlock call each.
      const uniqueBlocks = [...new Set(decoded.map((log) => log.blockNumber as bigint))];
      const timestampEntries = await Promise.all(
        uniqueBlocks.map(async (blockNumber) => [blockNumber, await getBlockTimestampMs(blockNumber)] as const)
      );
      const timestampsByBlock = new Map(timestampEntries);

      const events = decoded.map((log) => {
        const direction: TransferDirection =
          (log.args.to ?? "").toLowerCase() === walletAddress.toLowerCase() ? "in" : "out";
        const timestampMs = timestampsByBlock.get(log.blockNumber as bigint) ?? Date.now();
        return toTransferEvent(log, walletAddress, direction, timestampMs);
      });

      // Dedupe by txHash+logIndex — a self-transfer (from === to === the
      // scanned wallet) would otherwise appear once from each direction
      // scan — then sort oldest -> newest.
      const seen = new Set<string>();
      const deduped: TokenTransferEvent[] = [];
      for (const event of events) {
        const key = `${event.txHash}:${event.logIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(event);
      }
      deduped.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));

      return deduped;
    } catch (err) {
      logger.error("transferEventReader.fetchTransfers failed", {
        walletAddress,
        fromBlock: fromBlock.toString(),
        toBlock: toBlock.toString(),
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  },

  // Subscribes to live Transfer events touching `walletAddress` (either
  // direction) and invokes `onTransfer` for each new one as it's
  // detected. Built directly on viem's watchContractEvent, which polls
  // under an http transport today (see lib/wagmi.ts) and would
  // transparently switch to a persistent subscription with zero code
  // changes here if the transport is ever upgraded to webSocket() — this
  // function doesn't know or care which transport is active, which is
  // exactly what makes it "future WebSocket-ready" rather than
  // WebSocket-specific. Not wired into background-sync-scheduler.ts today
  // (which uses polling via portfolio-sync-service instead) — exposed as
  // a ready-to-use building block for a future push-based sync strategy.
  // Returns an unsubscribe function.
  watchTransfers(walletAddress: Address, onTransfer: (event: TokenTransferEvent) => void): () => void {
    const client = getViemClient();

    const handleLogs = (direction: TransferDirection) => async (logs: DecodedTransferLog[]) => {
      for (const log of logs) {
        if (log.blockNumber === null) continue;
        try {
          const timestampMs = await getBlockTimestampMs(log.blockNumber);
          onTransfer(toTransferEvent(log, walletAddress, direction, timestampMs));
        } catch (err) {
          logger.error("transferEventReader.watchTransfers handler failed", {
            direction,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    let unwatchIncoming: (() => void) | undefined;
    let unwatchOutgoing: (() => void) | undefined;

    try {
      unwatchIncoming = watchContractEvent(client, {
        address: MPGR_TOKEN_CONFIG.address,
        abi: [transferEventAbiItem],
        eventName: "Transfer",
        args: { to: walletAddress },
        pollingInterval: MPGR_TOKEN_CONFIG.watchPollingIntervalMs,
        // viem's onLogs is typed (logs: Log[]) => void; our handler is
        // typed against DecodedTransferLog[] (Log narrowed to this
        // event's decoded args) so call sites get properly-typed
        // args.from/args.to/args.value. The two Log shapes don't
        // structurally overlap enough for TS to allow a direct cast, so
        // the cast is routed through `unknown` first — this is a type
        // annotation change only; the runtime value viem hands back is
        // already shaped exactly like DecodedTransferLog for a
        // single-event watch, so no behavior changes here.
        onLogs: handleLogs("in") as unknown as (logs: Log[]) => void,
        onError: (err) => logger.error("transferEventReader.watchTransfers (in) error", { error: err.message }),
      });
      unwatchOutgoing = watchContractEvent(client, {
        address: MPGR_TOKEN_CONFIG.address,
        abi: [transferEventAbiItem],
        eventName: "Transfer",
        args: { from: walletAddress },
        pollingInterval: MPGR_TOKEN_CONFIG.watchPollingIntervalMs,
        onLogs: handleLogs("out") as unknown as (logs: Log[]) => void,
        onError: (err) => logger.error("transferEventReader.watchTransfers (out) error", { error: err.message }),
      });
    } catch (err) {
      logger.error("transferEventReader.watchTransfers failed to start", {
        walletAddress,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return () => {
      unwatchIncoming?.();
      unwatchOutgoing?.();
    };
  },
} as const;
