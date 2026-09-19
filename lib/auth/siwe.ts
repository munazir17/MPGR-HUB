import { createPublicClient, http, verifyMessage, type Address } from "viem";
import { CHAIN, DEFAULT_PUBLIC_RPC_URL } from "@/lib/chain/base";
import { SUPPORTED_CHAIN_ID } from "./config";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export interface AuthMessage {
  domain: string;
  address: Address;
  uri: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  chainId: number;
}

export function buildSiweMessage(input: AuthMessage): string {
  return [
    `${input.domain} wants you to sign in with your Ethereum account:`,
    input.address,
    "",
    "Sign in to MPGR HUB.",
    "",
    `URI: ${input.uri}`,
    "Version: 1",
    `Chain ID: ${input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    `Expiration Time: ${input.expirationTime}`,
  ].join("\n");
}

export function parseSiweMessage(message: string): AuthMessage | null {
  const lines = message.split("\n");
  if (lines.length !== 11) return null;
  const address = lines[1];
  if (!ADDRESS_RE.test(address)) return null;
  const get = (prefix: string) => {
    const line = lines.find((value) => value.startsWith(prefix));
    return line ? line.slice(prefix.length).trim() : null;
  };
  const domainMatch = lines[0].match(/^(.+) wants you to sign in with your Ethereum account:$/);
  if (!domainMatch || lines[2] !== "" || lines[3] !== "Sign in to MPGR HUB." || lines[4] !== "") return null;
  const uri = get("URI:");
  const version = get("Version:");
  const chainId = get("Chain ID:");
  const nonce = get("Nonce:");
  const issuedAt = get("Issued At:");
  const expirationTime = get("Expiration Time:");
  if (!uri || version !== "1" || !chainId || !nonce || !issuedAt || !expirationTime) return null;
  const parsedChain = Number(chainId);
  if (parsedChain !== SUPPORTED_CHAIN_ID) return null;
  return {
    domain: domainMatch[1],
    address: address as Address,
    uri,
    nonce,
    issuedAt,
    expirationTime,
    chainId: parsedChain,
  };
}

function authRpcUrl(): string {
  return (
    process.env.BASE_RPC_URL?.trim() ||
    process.env.NEXT_PUBLIC_BASE_RPC_URL?.trim() ||
    DEFAULT_PUBLIC_RPC_URL
  );
}

/**
 * Local ECDSA first (EOA). If that does not recover the claimed address,
 * verify ERC-1271 on Base — Coinbase Smart Wallet / Base Account are the
 * default RainbowKit connectors and cannot be validated by ecrecover.
 *
 * Does not skip nonce, domain/URI, or expiry checks. Callers still own
 * those. This only answers "did this address authorize this message?"
 */
export const siweSignatureVerifier = {
  async eoa(address: Address, message: string, signature: `0x${string}`): Promise<boolean> {
    return verifyMessage({ address, message, signature });
  },
  async contract(address: Address, message: string, signature: `0x${string}`): Promise<boolean> {
    const client = createPublicClient({
      chain: CHAIN,
      transport: http(authRpcUrl(), { timeout: 10_000 }),
    });
    return client.verifyMessage({ address, message, signature });
  },
};

export async function verifySiweSignature(
  message: string,
  signature: `0x${string}`,
  expected: AuthMessage,
): Promise<boolean> {
  const parsed = parseSiweMessage(message);
  if (!parsed) return false;
  if (parsed.domain !== expected.domain || parsed.address.toLowerCase() !== expected.address.toLowerCase()) return false;
  if (parsed.uri !== expected.uri || parsed.nonce !== expected.nonce || parsed.chainId !== expected.chainId) return false;
  if (parsed.issuedAt !== expected.issuedAt || parsed.expirationTime !== expected.expirationTime) return false;
  const now = Date.now();
  const issued = Date.parse(parsed.issuedAt);
  const expires = Date.parse(parsed.expirationTime);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now + 30_000 || expires <= now) return false;

  try {
    if (await siweSignatureVerifier.eoa(parsed.address, message, signature)) return true;
  } catch {
    // Compact / contract signatures can throw on ecrecover — try ERC-1271.
  }
  try {
    return await siweSignatureVerifier.contract(parsed.address, message, signature);
  } catch {
    return false;
  }
}
