import { verifyMessage, type Address } from "viem";
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

export async function verifySiweSignature(message: string, signature: `0x${string}`, expected: AuthMessage): Promise<boolean> {
  const parsed = parseSiweMessage(message);
  if (!parsed) return false;
  if (parsed.domain !== expected.domain || parsed.address.toLowerCase() !== expected.address.toLowerCase()) return false;
  if (parsed.uri !== expected.uri || parsed.nonce !== expected.nonce || parsed.chainId !== expected.chainId) return false;
  if (parsed.issuedAt !== expected.issuedAt || parsed.expirationTime !== expected.expirationTime) return false;
  const now = Date.now();
  const issued = Date.parse(parsed.issuedAt);
  const expires = Date.parse(parsed.expirationTime);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now + 30_000 || expires <= now) return false;
  return verifyMessage({ address: parsed.address, message, signature });
}
