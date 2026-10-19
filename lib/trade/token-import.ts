// UI metadata only. /api/trade/quote independently resolves the contract again;
// this response never authorizes execution or supplies trusted calldata/decimals.
import { isAddress } from "viem";
import type { TradeTokenRef } from "./trade-types";
export class TokenImportError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function importBaseToken(address: string, signal?: AbortSignal): Promise<TradeTokenRef> {
  if (!isAddress(address, { strict: false })) throw new Error("Enter an exact Base contract address (0x and 40 hexadecimal characters).");
  const response = await fetch("/api/trade/token", { method: "POST", credentials: "include", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ address, chainId: 8453 }) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new TokenImportError(response.status, typeof payload?.error === "string" ? payload.error : `Token validation failed (HTTP ${response.status}). Try again.`);
  const t = payload?.token;
  if (payload?.chainId !== 8453 || !t || typeof t.address !== "string" || t.address.toLowerCase() !== address.toLowerCase() ||
      !Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 255 || typeof t.symbol !== "string" || !/^[a-zA-Z0-9._-]{1,32}$/.test(t.symbol) ||
      typeof t.name !== "string" || t.name.length > 128 || !["erc20", "native", "b20-tokenized-stock"].includes(t.kind) || typeof t.verified !== "boolean") {
    throw new Error("Token validation returned invalid metadata. Nothing was imported.");
  }
  return t;
}
