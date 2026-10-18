// Swap-only public reads. Not used by Agent or execution admission.
import { createPublicClient, fallback, http, isAddress, type PublicClient, type Hex } from "viem";
import { base } from "viem/chains";
import { rpcUrls } from "@/lib/trade/trade-public-client";
export type SwapDiscoveryClient = Pick<PublicClient, "getChainId" | "getBlockNumber" | "readContract" | "getCode"> & { getBlock(args: { blockNumber: bigint }): Promise<{ number: bigint | null; hash: Hex | null; timestamp: bigint }> };
export class SwapDiscoveryError extends Error {
  constructor(public code: string, message: string, public status: 400 | 422 | 503 = 503) { super(message); }
}
export function swapDiscoveryClient(signal?: AbortSignal): SwapDiscoveryClient {
  const deadline = AbortSignal.timeout(10_000);
  return createPublicClient({ chain: base, batch: { multicall: false }, transport: fallback(rpcUrls().map(url => http(url, {
    timeout: 4_000, retryCount: 0, fetchOptions: { signal: signal ? AbortSignal.any([signal, deadline]) : deadline },
  })), { rank: false, retryCount: 0 }) });
}
export type SwapSnapshot = { blockNumber: bigint; blockHash: Hex; timestamp: bigint };
function fresh(timestamp: bigint) {
  const age = Date.now() - Number(timestamp) * 1000;
  if (!Number.isFinite(age) || age > 30_000 || age < -15_000) throw new SwapDiscoveryError("STALE_BLOCK", "A fresh Base snapshot is unavailable. Retry shortly.");
}
export async function startSwapSnapshot(client: SwapDiscoveryClient): Promise<SwapSnapshot> {
  if (await client.getChainId() !== 8453) throw new SwapDiscoveryError("WRONG_RPC_CHAIN", "The provider could not verify Base Mainnet (8453).");
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const block = await client.getBlock({ blockNumber });
  if (block.number !== blockNumber || !block.hash || !/^0x[0-9a-f]{64}$/i.test(block.hash)) throw new SwapDiscoveryError("INVALID_BLOCK", "The Base snapshot could not be verified.");
  fresh(block.timestamp);
  return { blockNumber, blockHash: block.hash, timestamp: block.timestamp };
}
export async function finishSwapSnapshot(client: SwapDiscoveryClient, snapshot: SwapSnapshot) {
  const block = await client.getBlock({ blockNumber: snapshot.blockNumber });
  if (block.number !== snapshot.blockNumber || block.hash !== snapshot.blockHash) throw new SwapDiscoveryError("BLOCK_CHANGED", "The Base snapshot changed. Retry the read-only check.");
  fresh(block.timestamp);
  fresh(snapshot.timestamp);
}
export function snapshotEvidence(snapshot: SwapSnapshot) {
  return { blockNumber: snapshot.blockNumber.toString(), blockHash: snapshot.blockHash, observedAt: Number(snapshot.timestamp) * 1000, expiresAt: Number(snapshot.timestamp) * 1000 + 30_000 };
}
export function exactSwapAddress(input: unknown): `0x${string}` {
  if (typeof input !== "string" || !isAddress(input, { strict: false }) || /^0x0{40}$/i.test(input)) throw new SwapDiscoveryError("INVALID_ADDRESS", "Use an exact non-zero Base contract address.", 400);
  return input.toLowerCase() as `0x${string}`;
}
export function contractInterfaceError(error: unknown): boolean {
  let cursor = error;
  for (let depth = 0; depth < 8 && cursor && typeof cursor === "object"; depth++) {
    const e = cursor as { name?: string; cause?: unknown };
    if (/ContractFunction(Reverted|ZeroData)Error|AbiDecoding/.test(e.name ?? "")) return true;
    if (e.cause === cursor) break;
    cursor = e.cause;
  }
  return false;
}
