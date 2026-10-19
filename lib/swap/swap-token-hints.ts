import { getAddress, isAddress } from "viem";
import { TokenImportError } from "@/lib/trade/token-import";
import type { SwapTokenHint } from "./swap-token-discovery";
export async function fetchSwapTokenHints(query: string, signal?: AbortSignal): Promise<SwapTokenHint[]> {
  const response = await fetch("/api/swap/tokens", { method: "POST", credentials: "include", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ query, chainId: 8453 }) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new TokenImportError(response.status, typeof data?.error === "string" ? data.error : "Token search is temporarily unavailable. Retry or paste a Base contract.");
  if (data?.chainId !== 8453 || !Array.isArray(data.tokens) || data.tokens.length > 20) throw new Error("Invalid token search response. No token was imported.");
  return data.tokens.map((t: SwapTokenHint) => {
    if (!t || !isAddress(t.address, { strict: false }) || typeof t.symbol !== "string" || !/^[a-zA-Z0-9._-]{1,32}$/.test(t.symbol) ||
        typeof t.name !== "string" || !t.name.trim() || t.name.length > 128 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(t.name)) throw new Error("Invalid token search response. No token was imported.");
    return { address: getAddress(t.address.toLowerCase()), symbol: t.symbol, name: t.name };
  });
}
