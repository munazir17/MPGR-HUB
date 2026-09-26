// Read-only resolution for the swap API. A catalog/discovery match never proves
// liquidity; routing remains the existing live quote path. No signing or writes.
import { erc20Abi, getAddress, isAddress, zeroAddress } from "viem";
import { discoverBaseTokens } from "./trade-token-discovery";
import { findKnownTradeToken, findKnownTradeTokenMatches, resolveTradeToken } from "./trade-tokens";
import { getTradePublicClient } from "./trade-public-client";
import { readB20Decimals } from "./tokenized-stocks-onchain";
import type { TradeError, TradeTokenRef } from "./trade-types";

type Result = { ok: true; token: TradeTokenRef } | { ok: false; error: TradeError };
const fail = (code: TradeError["code"], message: string): Result => ({ ok: false, error: { code, message } });
const inflight = new Map<string, Promise<Result>>();

function contractReadFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: string; cause?: unknown };
  return /ContractFunction(Reverted|ZeroData)Error|AbiDecoding/.test(e.name ?? "") || (!!e.cause && e.cause !== error && contractReadFailure(e.cause));
}

async function readContractToken(address: `0x${string}`): Promise<Result> {
  const client = getTradePublicClient();
  try {
    const code = await client.getCode({ address });
    if (!code || code === "0x") return fail("TOKEN_NOT_CONTRACT", "This address has no deployed contract on Base. Provide a token contract, not a wallet address.");
    const [decimals, supply, balance, symbol, name] = await Promise.allSettled([
      client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
      client.readContract({ address, abi: erc20Abi, functionName: "totalSupply" }),
      client.readContract({ address, abi: erc20Abi, functionName: "balanceOf", args: [zeroAddress] }),
      client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address, abi: erc20Abi, functionName: "name" }),
    ]);
    for (const read of [supply, balance]) {
      if (read.status === "rejected") return contractReadFailure(read.reason)
        ? fail("TOKEN_NOT_ERC20", "Contract found on Base, but it does not expose the required ERC-20 token interface.")
        : fail("PROVIDER_ERROR", "Base token validation is temporarily unavailable. Please try again.");
      if (typeof read.value !== "bigint") return fail("TOKEN_NOT_ERC20", "Contract found on Base, but it does not expose the required ERC-20 token interface.");
    }
    if (decimals.status !== "fulfilled" || !Number.isInteger(decimals.value) || decimals.value < 0 || decimals.value > 255 || symbol.status !== "fulfilled" || !/^[a-zA-Z0-9._-]{1,32}$/.test(symbol.value)) {
      return fail("TOKEN_METADATA_UNAVAILABLE", "Token contract found, but its decimals or symbol could not be read reliably. Nothing was prepared.");
    }
    const known = findKnownTradeToken(address);
    return { ok: true, token: {
      address, decimals: decimals.value, symbol: symbol.value,
      name: name.status === "fulfilled" && typeof name.value === "string" && name.value.length <= 128 ? name.value : symbol.value,
      kind: known?.kind ?? "erc20", verified: known !== null,
    } };
  } catch { return fail("PROVIDER_ERROR", "Base token validation is temporarily unavailable. Please try again."); }
}

export async function resolveSwapToken(input: unknown): Promise<Result> {
  if (typeof input !== "string" || !input.trim() || input.length > 128) return fail("INVALID_INPUT", "Provide a token name, symbol, or Base contract address.");
  const text = input.trim();
  const direct = /^0x/i.test(text);
  if (direct && !isAddress(text, { strict: false })) return fail("INVALID_ADDRESS", "Invalid token address. Use 0x followed by exactly 40 hexadecimal characters.");
  let address: `0x${string}`;
  if (direct) {
    address = getAddress(text.toLowerCase());
    const known = findKnownTradeToken(address);
    if (known?.kind === "native") {
      const resolved = resolveTradeToken(address);
      if (resolved.ok) return { ok: true, token: resolved.token };
    }
  } else {
    const local = findKnownTradeTokenMatches(text);
    if (local.length === 1) {
      const resolved = resolveTradeToken(text);
      if (!resolved.ok) return fail("UNSUPPORTED_ASSET", resolved.message);
      if (resolved.token.kind !== "b20-tokenized-stock") return { ok: true, token: resolved.token };
      const decimals = await readB20Decimals(resolved.token.address);
      return decimals === null ? fail("TOKEN_METADATA_UNAVAILABLE", "Token contract found, but its decimals could not be read reliably. Nothing was prepared.") : { ok: true, token: { ...resolved.token, decimals } };
    }
    let matches: Array<{ address: `0x${string}`; symbol: string }> = local;
    if (!matches.length) {
      try { matches = await discoverBaseTokens(text); }
      catch { return fail("PROVIDER_ERROR", "Token discovery is temporarily unavailable. Try again or provide the exact Base contract address."); }
    }
    if (!matches.length) return fail("TOKEN_NOT_FOUND", "No matching Base token was found in the discovery catalog. Provide the exact contract address to check it directly.");
    if (matches.length > 1) return fail("TOKEN_AMBIGUOUS", `Multiple Base contracts match. Repeat the swap with the exact contract you intend: ${matches.slice(0, 8).map(t => t.address).join(", ")}.`);
    address = matches[0].address;
  }
  // Concurrent requests share reads, but metadata is not retained across trades.
  const key = address.toLowerCase();
  const existing = inflight.get(key);
  if (existing) return existing;
  const pending = readContractToken(address).finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}
