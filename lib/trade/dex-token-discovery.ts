// Base ticker discovery for chat swaps. Evidence of a live pool, not a
// catalog entry and not a safety audit. The host is fixed. The query is
// only a `q` parameter. No signing, no autonomous allowlist changes.
import { getAddress, isAddress, type Address } from "viem";

export const DEX_SEARCH_URL = "https://api.dexscreener.com/latest/dex/search";
/** Dust pools are not a trade. Below this, chat refuses to pick a contract. */
export const DEX_MIN_LIQUIDITY_USD = 25_000;
/** Auto-pick only when the deepest pool is at least this multiple of the next. */
export const DEX_LIQUIDITY_DOMINANCE = 5;
const TTL_MS = 60_000;
const MAX_BYTES = 1_000_000;
const SYMBOL_RE = /^[a-zA-Z0-9 ._-]{2,32}$/;

export interface DexCandidate {
  address: Address;
  symbol: string;
  liquidityUsd: number;
}

export type DexDiscovery =
  | { status: "miss" }
  | { status: "thin"; bestUsd: number }
  | { status: "ambiguous"; matches: DexCandidate[] }
  | { status: "unique"; match: DexCandidate }
  | { status: "unavailable" };

let cached = new Map<string, { at: number; value: DexDiscovery }>();
let pending = new Map<string, Promise<DexDiscovery>>();

export function resetDexDiscoveryCache(): void {
  cached = new Map();
  pending = new Map();
}

export function selectDexMatches(pairs: unknown[], query: string): DexDiscovery {
  const needle = query.trim().toLowerCase();
  const byAddress = new Map<string, DexCandidate>();
  for (const row of pairs) {
    if (!row || typeof row !== "object") continue;
    const pair = row as Record<string, unknown>;
    if (pair.chainId !== "base") continue;
    const base = pair.baseToken;
    if (!base || typeof base !== "object") continue;
    const token = base as Record<string, unknown>;
    if (typeof token.address !== "string" || !isAddress(token.address, { strict: false })) continue;
    const symbol = typeof token.symbol === "string" ? token.symbol : "";
    const name = typeof token.name === "string" ? token.name : "";
    if (symbol.toLowerCase() !== needle && name.toLowerCase() !== needle) continue;
    if (!/^[a-zA-Z0-9._-]{1,32}$/.test(symbol)) continue;
    const liquidity = pair.liquidity;
    const usd = liquidity && typeof liquidity === "object" ? (liquidity as { usd?: unknown }).usd : undefined;
    const liquidityUsd = typeof usd === "number" && Number.isFinite(usd) && usd > 0 ? usd : 0;
    const address = getAddress(token.address.toLowerCase());
    const prev = byAddress.get(address.toLowerCase());
    if (!prev || liquidityUsd > prev.liquidityUsd) byAddress.set(address.toLowerCase(), { address, symbol, liquidityUsd });
  }
  const ranked = [...byAddress.values()].sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  const liquid = ranked.filter((token) => token.liquidityUsd >= DEX_MIN_LIQUIDITY_USD);
  if (!liquid.length) {
    const bestUsd = ranked[0]?.liquidityUsd ?? 0;
    return bestUsd > 0 ? { status: "thin", bestUsd } : { status: "miss" };
  }
  const second = liquid[1];
  if (!second || liquid[0].liquidityUsd >= second.liquidityUsd * DEX_LIQUIDITY_DOMINANCE) {
    return { status: "unique", match: liquid[0] };
  }
  return { status: "ambiguous", matches: liquid.slice(0, 8) };
}

async function loadDex(query: string): Promise<DexDiscovery> {
  const url = `${DEX_SEARCH_URL}?q=${encodeURIComponent(query.trim())}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000), redirect: "error", cache: "no-store" });
  if (!response.ok || !response.body) return { status: "unavailable" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) return { status: "unavailable" };
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { status: "miss" };
  }
  if (!payload || typeof payload !== "object" || !("pairs" in payload)) return { status: "miss" };
  const pairs = (payload as { pairs: unknown }).pairs;
  if (pairs === null) return { status: "miss" };
  if (!Array.isArray(pairs)) return { status: "miss" };
  return selectDexMatches(pairs, query);
}

export async function discoverDexBaseTokens(query: string): Promise<DexDiscovery> {
  const needle = query.trim();
  if (!SYMBOL_RE.test(needle)) return { status: "miss" };
  const key = needle.toLowerCase();
  const hit = cached.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const existing = pending.get(key);
  if (existing) return existing;
  const request = loadDex(needle)
    .then((value) => {
      if (value.status !== "unavailable") cached.set(key, { at: Date.now(), value });
      return value;
    })
    .catch(() => ({ status: "unavailable" as const }))
    .finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
