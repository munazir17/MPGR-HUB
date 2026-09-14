// lib/trade/transfer-basename.ts
//
// Recipient resolution for the Base "send" feature: either a raw 0x
// address, or a Basename (e.g. "jesse.base.eth").
//
// Resolution order (fails closed — never invents an address):
//   1. Raw 0x address (also accepts a bare 40-hex string).
//   2. Base L2 Resolver (Basenames live on Base, no CCIP-Read needed).
//   3. Ethereum Mainnet ENS Universal Resolver + CCIP-Read.
//
// Public Ethereum RPCs (publicnode / 1rpc) frequently fail CCIP-Read
// for *.base.eth, which is why "jesse.base.eth" used to throw
// "Basename resolution failed" even though the name is valid.
// Resolving on Base first avoids that entire class of failures.

import "server-only";

import {
  createPublicClient,
  fallback,
  http,
  isAddress,
  getAddress,
  zeroAddress,
  namehash,
  type Address,
} from "viem";
import { mainnet } from "viem/chains";

import { getTradePublicClient } from "./trade-public-client";

const ZERO_ADDRESS_LOWER = zeroAddress.toLowerCase();

const BASENAME_L2_RESOLVER = "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD" as const;

const L2_RESOLVER_ABI = [
  {
    type: "function",
    name: "addr",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

function mainnetRpcUrls(): string[] {
  const urls = [
    process.env.MAINNET_RPC_URL?.trim(),
    process.env.NEXT_PUBLIC_MAINNET_RPC_URL?.trim(),
    "https://ethereum.publicnode.com",
    "https://1rpc.io/eth",
    "https://eth.llamarpc.com",
    "https://rpc.ankr.com/eth",
  ].filter((url): url is string => !!url && url.length > 0);
  return [...new Set(urls)];
}

let cachedMainnetClient: ReturnType<typeof createPublicClient> | null = null;

/** Server-safe viem Mainnet client, used ONLY as a Basename fallback — never for balances or Base txs. */
export function getMainnetEnsClient() {
  if (cachedMainnetClient) return cachedMainnetClient;
  const urls = mainnetRpcUrls();
  cachedMainnetClient = createPublicClient({
    chain: mainnet,
    transport: fallback(
      urls.map((url) => http(url, { timeout: 12_000 })),
    ),
  });
  return cachedMainnetClient;
}

export function isLikelyBasename(input: string): boolean {
  const trimmed = input.trim().toLowerCase();
  return trimmed.length > ".base.eth".length && trimmed.endsWith(".base.eth");
}

const BARE_HEX_ADDRESS = /^[0-9a-fA-F]{40}$/;

function coerceAddress(input: string): Address | null {
  const trimmed = input.trim();
  if (isAddress(trimmed)) return getAddress(trimmed);
  if (BARE_HEX_ADDRESS.test(trimmed)) {
    const withPrefix = `0x${trimmed}` as Address;
    if (isAddress(withPrefix)) return getAddress(withPrefix);
  }
  return null;
}

export type ResolveRecipientResult =
  | { ok: true; address: Address; inputKind: "address"; basename: null }
  | { ok: true; address: Address; inputKind: "basename"; basename: string }
  | { ok: false; message: string };

async function resolveOnBaseL2(normalized: string): Promise<Address | null> {
  try {
    const client = getTradePublicClient();
    const resolved = await client.readContract({
      address: BASENAME_L2_RESOLVER,
      abi: L2_RESOLVER_ABI,
      functionName: "addr",
      args: [namehash(normalized)],
    });
    if (!resolved || !isAddress(resolved) || resolved.toLowerCase() === ZERO_ADDRESS_LOWER) {
      return null;
    }
    return getAddress(resolved);
  } catch (err) {
    console.error("[transfer-basename] Base L2 resolver failed", {
      name: normalized,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function resolveOnMainnetEns(normalized: string): Promise<Address | null> {
  try {
    const client = getMainnetEnsClient();
    const resolved = await client.getEnsAddress({ name: normalized });
    if (!resolved || !isAddress(resolved) || resolved.toLowerCase() === ZERO_ADDRESS_LOWER) {
      return null;
    }
    return getAddress(resolved);
  } catch (err) {
    console.error("[transfer-basename] Mainnet ENS/CCIP-Read failed", {
      name: normalized,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Resolves a user/model-supplied recipient string to a checksummed Base
 * address. Never invents an address — a Basename that fails to resolve,
 * resolves to the zero address, or looks malformed is a hard failure,
 * not a fallback to some guessed value.
 */
export async function resolveRecipient(input: unknown): Promise<ResolveRecipientResult> {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, message: "Recipient must be a Base address (0x...) or a Basename (name.base.eth)." };
  }
  const trimmed = input.trim();

  const asAddress = coerceAddress(trimmed);
  if (asAddress) {
    if (asAddress.toLowerCase() === ZERO_ADDRESS_LOWER) {
      return { ok: false, message: "Refusing to send to the zero address." };
    }
    return { ok: true, address: asAddress, inputKind: "address", basename: null };
  }

  if (!isLikelyBasename(trimmed)) {
    return {
      ok: false,
      message: `"${trimmed}" is not a valid Base address (0x...) or a Basename (name.base.eth). Refusing to guess a recipient.`,
    };
  }

  const normalized = trimmed.toLowerCase();

  const fromBase = await resolveOnBaseL2(normalized);
  if (fromBase) {
    return { ok: true, address: fromBase, inputKind: "basename", basename: normalized };
  }

  const fromMainnet = await resolveOnMainnetEns(normalized);
  if (fromMainnet) {
    return { ok: true, address: fromMainnet, inputKind: "basename", basename: normalized };
  }

  return {
    ok: false,
    message: `Could not resolve "${trimmed}" to an address. Nothing will be sent — try again or use the 0x address directly.`,
  };
}
