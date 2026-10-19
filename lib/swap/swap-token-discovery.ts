// Swap-only discovery. Published membership is a hint, not verified metadata,
// permission, liquidity, logo provenance or execution authorization.
import { getAddress, isAddress, type Address } from "viem";
export const SWAP_TOKEN_LIST_URL = "https://api.github.com/repos/Uniswap/default-token-list/contents/src/tokens/base.json";
export interface SwapTokenHint { address: Address; symbol: string; name: string }
let cache: { at: number; rows: SwapTokenHint[] } | undefined;
let pending: Promise<SwapTokenHint[]> | undefined;
export function resetSwapTokenHints() { cache = undefined; pending = undefined; }
async function load(): Promise<SwapTokenHint[]> {
  const response = await fetch(SWAP_TOKEN_LIST_URL, { headers: { Accept: "application/vnd.github.raw+json" }, signal: AbortSignal.timeout(8000), redirect: "error", cache: "no-store" });
  if (!response.ok || !response.body) throw new Error("Base token list temporarily unavailable. Retry or paste an exact Base contract.");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 2_000_000) throw new Error("Token list size limit exceeded"); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(payload)) throw new Error("Invalid token list");
  const rows = new Map<string, SwapTokenHint>();
  for (const row of payload) {
    if (!row || row.chainId !== 8453 || typeof row.address !== "string" || !isAddress(row.address, { strict: false }) ||
        typeof row.symbol !== "string" || !/^[a-zA-Z0-9._-]{1,32}$/.test(row.symbol) || typeof row.name !== "string" || !row.name.trim() || row.name.length > 128 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(row.name)) continue;
    rows.set(row.address.toLowerCase(), { address: getAddress(row.address.toLowerCase()), symbol: row.symbol, name: row.name });
  }
  return [...rows.values()];
}
export async function searchSwapTokenHints(query: string): Promise<SwapTokenHint[]> {
  const q = query.trim().toLowerCase(); if (q.length < 2 || q.length > 64) return [];
  if (!cache || Date.now() - cache.at > 300_000) {
    pending ??= load().then(rows => { cache = { at: Date.now(), rows }; return rows; }).finally(() => { pending = undefined; });
    await pending;
  }
  return cache!.rows.filter(t => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
    .sort((a, b) => Number(b.symbol.toLowerCase() === q) - Number(a.symbol.toLowerCase() === q) || a.symbol.localeCompare(b.symbol) || a.address.localeCompare(b.address)).slice(0, 20);
}
