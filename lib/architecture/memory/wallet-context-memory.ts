// Phase 3B Part 1 — Wallet Context Memory.
//
// Captures a compact, capped history of AgentContext snapshots so later
// phases can reason about change over time ("your XP is up since last
// time") without re-deriving anything already computed by
// lib/agent-context.ts. Persisted through getMemoryProvider(), same as
// every other store in this layer.

import { getMemoryProvider } from "./memory-provider-registry";
import type { AgentContext } from "@/lib/agent-context";
import type { WalletContextMemory, WalletContextSnapshot } from "./memory-types";

const MAX_SNAPSHOTS = 20;

function storageKey(address: string): string {
  return `mpgr-hub:wallet-memory:${address.toLowerCase()}`;
}

function emptyMemory(address: string): WalletContextMemory {
  return { address, snapshots: [] };
}

function toSnapshot(context: AgentContext): WalletContextSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    xp: context.xp?.xp ?? null,
    level: context.xp?.level ?? null,
    totalHoldings: context.portfolio?.totalHoldings ?? null,
    holderTierLabel: context.holderTier?.tierLabel ?? null,
    stakedBalance: context.staking?.totalStaked ?? null,
    lockedBalance: context.tokenLock?.totalLocked ?? null,
    seasonPoints: context.season?.seasonPoints ?? null,
  };
}

export async function getWalletContextMemory(address: string): Promise<WalletContextMemory> {
  return getMemoryProvider().get<WalletContextMemory>(storageKey(address), emptyMemory(address));
}

/**
 * Appends a snapshot only when it differs meaningfully from the last one
 * (avoids writing an identical entry on every render/turn when nothing in
 * the wallet actually changed).
 */
export async function captureWalletSnapshot(address: string, context: AgentContext): Promise<WalletContextMemory> {
  if (!context.isConnected) return getWalletContextMemory(address);

  const memory = await getWalletContextMemory(address);
  const next = toSnapshot(context);
  const last = memory.snapshots[memory.snapshots.length - 1];

  const unchanged =
    last &&
    last.xp === next.xp &&
    last.totalHoldings === next.totalHoldings &&
    last.holderTierLabel === next.holderTierLabel &&
    last.stakedBalance === next.stakedBalance &&
    last.lockedBalance === next.lockedBalance &&
    last.seasonPoints === next.seasonPoints;

  if (unchanged) return memory;

  const snapshots = [...memory.snapshots, next].slice(-MAX_SNAPSHOTS);
  const updated: WalletContextMemory = { ...memory, snapshots };
  await getMemoryProvider().set(storageKey(address), updated);
  return updated;
}

/** Convenience accessor for the previous snapshot, used to compute deltas. */
export function previousSnapshot(memory: WalletContextMemory): WalletContextSnapshot | null {
  if (memory.snapshots.length < 2) return null;
  return memory.snapshots[memory.snapshots.length - 2];
}

export function latestSnapshot(memory: WalletContextMemory): WalletContextSnapshot | null {
  return memory.snapshots[memory.snapshots.length - 1] ?? null;
}
