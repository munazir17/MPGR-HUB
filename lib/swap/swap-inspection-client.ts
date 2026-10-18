// Display-only requests. No transaction, execution-ready flag or permissions can be imported.
import { isAddress } from "viem";
import { TokenImportError } from "@/lib/trade/token-import";
import type { TradeTokenRef } from "@/lib/trade/trade-types";
import type { SwapLiquidityResult } from "./swap-liquidity";
import { safeSwapTokenText } from "./swap-token-text";
async function read(path: string, body: object, signal?: AbortSignal) {
  const response = await fetch(path, { method: "POST", credentials: "include", cache: "no-store", signal, headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ ...body, chainId: 8453 }) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new TokenImportError(response.status, typeof payload?.error === "string" ? payload.error : "Base inspection is temporarily unavailable. Retry.");
  if (payload?.chainId !== 8453 || payload.executionAuthorized !== false) throw new Error("Invalid read-only Base inspection response.");
  return payload;
}
export async function importSwapToken(address: string, signal?: AbortSignal): Promise<TradeTokenRef> {
  if (!isAddress(address, { strict: false })) throw new Error("Enter an exact Base contract address.");
  const payload = await read("/api/swap/token", { address }, signal); const t = payload.token;
  if (!t || typeof t.address !== "string" || t.address.toLowerCase() !== address.toLowerCase() || !Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 255 || !safeSwapTokenText(t.symbol, 32) || !safeSwapTokenText(t.name, 128) || !["erc20", "b20-tokenized-stock"].includes(t.kind) || typeof t.verified !== "boolean") throw new Error("Invalid Base token metadata. Nothing was imported.");
  return { address: t.address, decimals: t.decimals, symbol: t.symbol, name: t.name, kind: t.kind, verified: t.verified };
}
export async function inspectSwapLiquidity(fromToken: string, toToken: string, signal?: AbortSignal): Promise<SwapLiquidityResult> {
  const data = await read("/api/swap/liquidity", { fromToken, toToken }, signal);
  if (data.feeExecution !== "IMMUTABLE_FEE_EXECUTOR_REQUIRED" || !Array.isArray(data.observations) || data.observations.length > 40 || !Array.isArray(data.paths) || data.paths.length > 3 || !data.snapshot || !/^\d+$/.test(data.snapshot.blockNumber) || !/^0x[0-9a-f]{64}$/i.test(data.snapshot.blockHash) || !Number.isSafeInteger(data.snapshot.expiresAt) || data.snapshot.expiresAt <= Date.now()) throw new Error("Invalid or expired liquidity inspection. Retry.");
  if (typeof data.partial !== "boolean" || !safeSwapTokenText(data.scope, 1024)) throw new Error("Invalid liquidity inspection details.");
  const address = (v: unknown) => typeof v === "string" && isAddress(v, { strict: false });
  for (const o of data.observations) {
    if (!o || !["uniswap-v3", "slipstream", "uniswap-v2", "aerodrome-classic"].includes(o.venue) || !address(o.factory) || !address(o.tokenA) || !address(o.tokenB) || (o.pool !== null && !address(o.pool)) || !["not-found", "active-liquidity", "no-active-liquidity", "identity-mismatch", "provider-unavailable"].includes(o.status) || !(typeof o.key === "boolean" || Number.isInteger(o.key))) throw new Error("Invalid liquidity source response.");
  }
  for (const p of data.paths) {
    if (!p || p.executionSupported !== false || !Array.isArray(p.tokens) || p.tokens.length < 2 || p.tokens.length > 3 || !p.tokens.every(address) || !Array.isArray(p.poolsPerHop) || p.poolsPerHop.length !== p.tokens.length - 1 || !p.poolsPerHop.every((h: unknown) => Array.isArray(h) && h.length > 0 && h.length <= 8 && h.every(address))) throw new Error("Invalid read-only path response.");
  }
  return data as SwapLiquidityResult; // display only; never passed to quote or wallet APIs
}
