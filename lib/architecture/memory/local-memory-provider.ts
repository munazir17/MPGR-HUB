import { readJSON, writeJSON } from "@/lib/storage";
import type { MemoryProvider } from "./memory-provider";

// Phase 3A.5 — the current (and, for this phase, only) MemoryProvider
// implementation. Wraps lib/storage.ts's existing readJSON/writeJSON
// exactly as lib/agent-engine.ts already used them directly — this is a
// pure indirection, NOT a behavior change. get/set are declared async to
// match the MemoryProvider interface (so a future network-backed provider
// is a drop-in replacement with no call-site changes), even though the
// underlying localStorage calls are themselves synchronous.
export class LocalMemoryProvider implements MemoryProvider {
  async get<T extends object>(key: string, fallback: T): Promise<T> {
    return readJSON<T>(key, fallback);
  }

  async set<T>(key: string, value: T): Promise<void> {
    writeJSON(key, value);
  }

  async remove(key: string): Promise<void> {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Storage unavailable — fail silently, consistent with lib/storage.ts.
    }
  }

  async has(key: string): Promise<boolean> {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(key) !== null;
    } catch {
      return false;
    }
  }
}
