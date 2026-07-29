import type { MemoryProvider } from "./memory-provider";
import { LocalMemoryProvider } from "./local-memory-provider";

// Phase 3A.5 — composition point for the MemoryProvider dependency
// (objective 9, dependency injection). Everything that needs memory calls
// this module's getMemoryProvider() instead of importing
// LocalMemoryProvider (or any concrete provider) directly.
//
// Phase 3B swap point: once PersistentMemoryProvider / HybridMemoryProvider
// exist, call setMemoryProvider(new HybridMemoryProvider(...)) once (e.g.
// in a top-level provider component, or on wallet connect) — every
// existing caller of getMemoryProvider() picks up the new provider
// automatically. No other file in the codebase needs to change.
let activeProvider: MemoryProvider = new LocalMemoryProvider();

export function getMemoryProvider(): MemoryProvider {
  return activeProvider;
}

export function setMemoryProvider(provider: MemoryProvider): void {
  activeProvider = provider;
}
