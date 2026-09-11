import { CHAIN_ID } from "@/lib/chain/base";
import { getMemoryProvider } from "./memory-provider-registry";

export type MemoryScope =
  | "user-memory"
  | "wallet-memory"
  | "conversation-memory"
  | "agent"
  | "agent-action-history";

export function memoryKey(scope: MemoryScope, address: string, chainId = CHAIN_ID): string {
  return `mpgr-hub:${chainId}:${scope}:${address.toLowerCase()}`;
}

export function legacyMemoryKey(scope: MemoryScope, address: string): string {
  return `mpgr-hub:${scope}:${address.toLowerCase()}`;
}

export async function readMigratedMemory<T extends object>(
  scope: MemoryScope,
  address: string,
  fallback: T,
): Promise<T> {
  const provider = getMemoryProvider();
  const namespaced = memoryKey(scope, address);
  if (await provider.has(namespaced)) {
    return provider.get<T>(namespaced, fallback);
  }
  const legacy = legacyMemoryKey(scope, address);
  if (await provider.has(legacy)) {
    const value = await provider.get<T>(legacy, fallback);
    await provider.set(namespaced, value);
    return value;
  }
  return fallback;
}

export async function writeMemory<T>(
  scope: MemoryScope,
  address: string,
  value: T,
): Promise<void> {
  await getMemoryProvider().set(memoryKey(scope, address), value);
}

export async function clearMemory(scope: MemoryScope, address: string): Promise<void> {
  const provider = getMemoryProvider();
  await provider.remove(memoryKey(scope, address));
  await provider.remove(legacyMemoryKey(scope, address));
}
