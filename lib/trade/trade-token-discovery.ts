// Uniswap Labs' published list is discovery evidence, NOT proof of safety,
// authenticity or executable liquidity. RPC metadata and live quotes decide those
// separate questions. Fixed URL only: no user/model-controlled outbound host.
import { getAddress, isAddress, type Address } from "viem";

export interface DiscoveredToken { address: Address; symbol: string; name: string }
const LIST_URL = "https://tokens.uniswap.org";
const TTL_MS = 300_000;
const MAX_BYTES = 2_000_000;
let cached: { at: number; tokens: DiscoveredToken[] } | undefined;
let pending: Promise<DiscoveredToken[]> | undefined;

export function resetTokenDiscoveryCache(): void { cached = undefined; pending = undefined; }

async function loadList(): Promise<DiscoveredToken[]> {
  const response = await fetch(LIST_URL, { signal: AbortSignal.timeout(8_000), redirect: "error", cache: "no-store" });
  if (!response.ok || !response.body) throw new Error("Token discovery unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("Token list exceeds limit");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!payload || typeof payload !== "object" || !("tokens" in payload) || !Array.isArray(payload.tokens)) throw new Error("Invalid token list");
  const tokens: DiscoveredToken[] = [];
  for (const row of payload.tokens) {
    if (!row || row.chainId !== 8453 || typeof row.address !== "string" || !isAddress(row.address, { strict: false })) continue;
    if (typeof row.symbol !== "string" || !/^[a-zA-Z0-9._-]{1,32}$/.test(row.symbol)) continue;
    if (typeof row.name !== "string" || row.name.length > 128) continue;
    tokens.push({ address: getAddress(row.address.toLowerCase()), symbol: row.symbol, name: row.name });
  }
  return tokens;
}

export async function discoverBaseTokens(query: string): Promise<DiscoveredToken[]> {
  if (!cached || Date.now() - cached.at >= TTL_MS) {
    pending ??= loadList().then(tokens => { cached = { at: Date.now(), tokens }; return tokens; }).finally(() => { pending = undefined; });
    await pending;
  }
  const needle = query.trim().toLowerCase();
  return [...new Map(cached!.tokens.filter(t => t.symbol.toLowerCase() === needle || t.name.toLowerCase() === needle).map(t => [t.address.toLowerCase(), t])).values()];
}
