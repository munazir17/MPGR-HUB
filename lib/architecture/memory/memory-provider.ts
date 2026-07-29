// Phase 3A.5 — MemoryProvider abstraction (objective 1).
//
// The AI stack must never call localStorage / lib/storage.ts directly.
// Every read/write of conversation (or, later, any other AI-owned) state
// goes through this interface. LocalMemoryProvider is the ONLY
// implementation today; PersistentMemoryProvider (server-backed) and
// HybridMemoryProvider (local + remote, e.g. wallet-linked memory synced
// to a backend) implement the exact same interface and are swapped in at
// a single composition root (memory-provider-registry.ts) — nothing that
// calls get/set needs to know or care which provider is active.
export interface MemoryProvider {
  // `key` uses the same fully-qualified string keys already in use today
  // (e.g. "mpgr-hub:agent:<address>") — this interface doesn't impose a
  // new key scheme, so migrating an existing provider's data to a new
  // provider is a data-copy problem, not a code-shape problem.
  get<T extends object>(key: string, fallback: T): Promise<T>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  has(key: string): Promise<boolean>;

  // Phase 3A.5 (final) — transaction boundary, in preparation for AI
  // Trading and the Hybrid Memory provider (Phase 3B), where a set of
  // writes (e.g. "record trade" + "update portfolio memory") must either
  // all land or all be discarded together. No existing caller uses these
  // today, so no existing behavior changes — see LocalMemoryProvider for
  // why a safe no-op is the correct implementation for local storage.
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
