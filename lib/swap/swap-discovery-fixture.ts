// Deterministic read-only test fixture; no public RPC or execution evidence.
import { vi } from "vitest";
import { zeroAddress } from "viem";
import { findKnownTradeToken } from "@/lib/trade/trade-tokens";
import { SWAP_LIQUIDITY_SOURCES } from "./swap-liquidity";
import type { SwapDiscoveryClient } from "./swap-discovery-read";
export const IMPORTED = "0x1234567890abcdef1234567890abcdef12345678";
export const OTHER = "0x2234567890abcdef1234567890abcdef12345678";
export const BLOCK_HASH = `0x${"ab".repeat(32)}`;
export function discoveryFixture(active = false) {
  const pools = new Map<string, { factory: string; a: string; b: string; key: number | boolean; venue: string }>();
  const block = { number: 123n, hash: BLOCK_HASH, timestamp: BigInt(Math.floor(Date.now() / 1000)) };
  const client = { getChainId: vi.fn().mockResolvedValue(8453), getBlockNumber: vi.fn().mockResolvedValue(123n), getBlock: vi.fn().mockResolvedValue(block), getCode: vi.fn().mockResolvedValue("0x6000"), readContract: vi.fn() };
  const read = async ({ address, functionName: fn, args = [] }: { address: string; functionName: string; args?: readonly unknown[] }) => {
    const known = findKnownTradeToken(address);
    if (fn === "decimals") return known?.decimals ?? 18;
    if (fn === "totalSupply" || fn === "balanceOf") return 1_000_000n;
    if (fn === "symbol") return known?.symbol ?? "新🦄";
    if (fn === "name") return known?.name ?? "Arbitrary token";
    if (fn === "getPool" || fn === "getPair") {
      if (!active) return zeroAddress;
      const source = SWAP_LIQUIDITY_SOURCES.find(s => s.factory.toLowerCase() === address.toLowerCase() && (s.venue === "uniswap-v2" || s.key === args[2]))!;
      const pool = `0x${(4096 + pools.size).toString(16).padStart(40, "0")}`;
      pools.set(pool, { factory: address, a: String(args[0]), b: String(args[1]), key: source.key, venue: source.venue }); return pool;
    }
    const p = pools.get(address.toLowerCase())!;
    if (fn === "factory") return p.factory;
    if (fn === "token0") return p.a;
    if (fn === "token1") return p.b;
    if (fn === "fee" || fn === "tickSpacing" || fn === "stable") return p.key;
    if (fn === "liquidity") return 1_000_000n;
    if (fn === "getReserves") return p.venue === "uniswap-v2" ? [1_000n, 2_000n, 1] : [1_000n, 2_000n, 1n];
    throw new Error("Unexpected fixture read");
  };
  client.readContract.mockImplementation(read);
  return { client, reader: client as unknown as SwapDiscoveryClient, read, block, pools };
}
