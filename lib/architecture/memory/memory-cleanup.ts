// Phase 3B Part 1 — Memory Cleanup.
//
// Housekeeping pass over the persisted memory stores: caps are already
// enforced on write (see user-memory-store.ts, wallet-context-memory.ts,
// conversation-memory-store.ts), so this is a second, independent sweep —
// useful as a periodic TaskQueue job (Part 1 wires it in as a one-off
// background task; a future recurring job can call the same function).

import { getMemoryProvider } from "./memory-provider-registry";
import { getUserMemory } from "./user-memory-store";
import { getWalletContextMemory } from "./wallet-context-memory";
import { getConversationMemory } from "./conversation-memory-store";

const MAX_PAGE_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const MAX_COMMAND_AGE_MS = 1000 * 60 * 60 * 24 * 30;

function userMemoryKey(address: string): string {
  return `mpgr-hub:user-memory:${address.toLowerCase()}`;
}

/**
 * Drops stale, low-value entries (old page visits / command uses) that
 * caps alone wouldn't catch for a lightly-used account. Uses the
 * MemoryProvider transaction stubs (currently no-ops for LocalMemoryProvider,
 * real for a future Hybrid/Persistent provider) so this reads as a single
 * logical unit of work regardless of which provider is active.
 */
export async function cleanupUserMemory(address: string): Promise<void> {
  const provider = getMemoryProvider();
  const memory = await getUserMemory(address);
  const now = Date.now();

  const recentPages = memory.recentPages.filter((p) => now - new Date(p.visitedAt).getTime() < MAX_PAGE_AGE_MS);
  const recentCommands = memory.recentCommands.filter(
    (c) => now - new Date(c.usedAt).getTime() < MAX_COMMAND_AGE_MS
  );

  if (recentPages.length === memory.recentPages.length && recentCommands.length === memory.recentCommands.length) {
    return; // nothing to clean
  }

  await provider.beginTransaction();
  try {
    await provider.set(userMemoryKey(address), { ...memory, recentPages, recentCommands });
    await provider.commit();
  } catch (err) {
    await provider.rollback();
    throw err;
  }
}

/**
 * Full cleanup pass for one address, safe to call as a background task —
 * every step here already caps itself on write, so this is a light,
 * idempotent sweep, not a correctness-critical operation.
 */
export async function cleanupMemory(address: string): Promise<void> {
  await cleanupUserMemory(address);
  // Wallet + conversation memory are already self-capping on every write
  // (see their store files) — reading them here is a no-op today, kept as
  // an explicit extension point for future retention rules.
  await getWalletContextMemory(address);
  await getConversationMemory(address);
}
