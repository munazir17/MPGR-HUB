// lib/trade/transfer-basename.ts
//
// Recipient resolution for the Base "send" feature: either a raw 0x
// address, or a Basename (e.g. "jesse.base.eth").
//
// IMPORTANT — why this reads from Ethereum Mainnet, not Base:
// Basenames are ENS names under the base.eth namespace. Base's own
// integration guide documents resolving them through the standard ENS
// Universal Resolver on MAINNET using CCIP-Read (ENSIP-10 / EIP-3668):
// the base.eth wildcard resolver forwards the query off-chain to Base's
// L2 name registry and returns a verified result. viem's public actions
// implement CCIP-Read transparently, so `getEnsAddress` / `getEnsName`
// against a MAINNET client resolve Basenames correctly without any
// custom gateway code here. This is the same mechanism `viem/ens` docs
// and Base's basenames docs both describe — not a local name->address
// database, and not a Base-RPC contract call.
//
// Fails closed: if resolution errors, returns null, or resolves to the
// zero address, the caller must refuse to execute (per transfer-proposal.ts
// / transfer-request.ts) rather than guess.

import "server-only";

import { createPublicClient, fallback, http, isAddress, getAddress, zeroAddress, type Address } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";

const ZERO_ADDRESS_LOWER = zeroAddress.toLowerCase();

function mainnetRpcUrls(): string[] {
  const urls = [
    process.env.MAINNET_RPC_URL?.trim(),
    process.env.NEXT_PUBLIC_MAINNET_RPC_URL?.trim(),
    "https://ethereum.publicnode.com",
    "https://1rpc.io/eth",
  ].filter((url): url is string => !!url && url.length > 0);
  return [...new Set(urls)];
}

let cachedClient: ReturnType<typeof createPublicClient> | null = null;

/** Server-safe viem Mainnet client, used ONLY for ENS/Basename resolution — never for balances or transactions, which stay on Base. */
export function getMainnetEnsClient() {
  if (cachedClient) return cachedClient;
  const urls = mainnetRpcUrls();
  cachedClient = createPublicClient({
    chain: mainnet,
    transport: fallback(
      urls.map((url) => http(url, { timeout: 12_000 }))
    ),
  });
  return cachedClient;
}

export function isLikelyBasename(input: string): boolean {
  const trimmed = input.trim().toLowerCase();
  return trimmed.length > ".base.eth".length && trimmed.endsWith(".base.eth");
}

export type ResolveRecipientResult =
  | { ok: true; address: Address; inputKind: "address"; basename: null }
  | { ok: true; address: Address; inputKind: "basename"; basename: string }
  | { ok: false; message: string };

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

  if (isAddress(trimmed)) {
    const address = getAddress(trimmed);
    if (address.toLowerCase() === ZERO_ADDRESS_LOWER) {
      return { ok: false, message: "Refusing to send to the zero address." };
    }
    return { ok: true, address, inputKind: "address", basename: null };
  }

  if (!isLikelyBasename(trimmed)) {
    return {
      ok: false,
      message: `"${trimmed}" is not a valid Base address (0x...) or a Basename (name.base.eth). Refusing to guess a recipient.`,
    };
  }

  let normalized: string;
  try {
    normalized = normalize(trimmed.toLowerCase());
  } catch {
    return { ok: false, message: `"${trimmed}" is not a validly formatted Basename.` };
  }

  try {
    const client = getMainnetEnsClient();
    const resolved = await client.getEnsAddress({ name: normalized });
    if (!resolved || !isAddress(resolved) || resolved.toLowerCase() === ZERO_ADDRESS_LOWER) {
      return {
        ok: false,
        message: `Could not resolve "${trimmed}" to an address. Nothing will be sent.`,
      };
    }
    return { ok: true, address: getAddress(resolved), inputKind: "basename", basename: normalized };
  } catch {
    return {
      ok: false,
      message: `Basename resolution failed for "${trimmed}". Nothing will be sent — try again or use the 0x address directly.`,
    };
  }
}
