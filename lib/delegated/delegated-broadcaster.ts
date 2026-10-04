import "server-only";

// lib/delegated/delegated-broadcaster.ts
//
// The AUTONOMOUS BROADCASTER. An OPERATOR-controlled server key that can ONLY
// broadcast transactions the USER pre-authorized with a bounded Permit2
// witness permit (single-use nonce, exact amount, minOut, deadline,
// policyHash). It is NOT user key custody: the user's key never touches the
// server; the broadcaster key is the operator's own gas payer, managed exactly
// like the existing REWARD_MANAGER_PRIVATE_KEY seam.
//
// TWO INDEPENDENT BROADCASTERS, TWO INDEPENDENT KEYS (audit MC-2 remediation):
//
//   MPGR_BROADCASTER_PRIVATE_KEY         -> Base Sepolia (84532), testnet
//   MPGR_MAINNET_BROADCASTER_PRIVATE_KEY -> Base mainnet (8453), production
//
// A separate key per chain is deliberate: a compromised or misconfigured
// testnet key must never gain mainnet reach, and the operator can rotate or
// disable one chain without touching the other. Neither key is ever logged,
// returned by an API, or used for anything but gas on its own chain.
//
// HARD CANARY SEPARATION: the mainnet broadcaster REFUSES the existing
// canary key and the canary address. The canary is a one-shot, deliberately
// armed test path (lib/trade/__tests__/mainnet-canary.execution.test.ts,
// guarded by MPGR_MAINNET_CANARY_ARMED); turning it into production
// infrastructure is explicitly out of scope, so this module makes it
// structurally impossible.
//
// Fail-closed: without the env key there is no broadcaster for that chain and
// every delegated execution on it refuses.

import { createPublicClient, createWalletClient, http, type Address, type Chain, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

import {
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
} from "@/lib/executor/executor-config";
import { isDelegatedChainId } from "@/lib/executor/delegated-executor";

/** Env var names. Exported so a source-boundary test can pin them. */
export const SEPOLIA_BROADCASTER_PRIVATE_KEY_ENV = "MPGR_BROADCASTER_PRIVATE_KEY";
export const MAINNET_BROADCASTER_PRIVATE_KEY_ENV = "MPGR_MAINNET_BROADCASTER_PRIVATE_KEY";

/**
 * The Phase 5 mainnet canary. The production mainnet broadcaster must never be
 * this key or this account — see the header note.
 */
export const CANARY_WALLET: Address = "0xBF6c574b9543967f0D528ae49603b0A7574a280b";

let cachedAccount: ReturnType<typeof privateKeyToAccount> | null = null;
let cachedMainnetAccount: ReturnType<typeof privateKeyToAccount> | null = null;

function normalizeKey(raw: string | undefined): Hex | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const normalized = (/^0x/i.test(trimmed) ? trimmed : `0x${trimmed}`) as Hex;
  return /^0x[0-9a-fA-F]{64}$/.test(normalized) ? (normalized as Hex) : null;
}

function configuredKey(): Hex | null {
  return normalizeKey(process.env[SEPOLIA_BROADCASTER_PRIVATE_KEY_ENV]);
}

/** The Base Sepolia broadcaster account, or null when unconfigured (fail-closed). */
export function delegatedBroadcasterAddress(): Address | null {
  if (cachedAccount) return cachedAccount.address;
  const key = configuredKey();
  if (!key) return null;
  cachedAccount = privateKeyToAccount(key);
  return cachedAccount.address;
}

/**
 * The Base MAINNET broadcaster account, or null when unconfigured.
 *
 * Returns null (never throws) when the configured key is the canary key or
 * derives to the canary address: mainnet delegated execution then simply
 * reports itself unavailable, which is the correct fail-closed behaviour.
 */
export function mainnetBroadcasterAddress(): Address | null {
  if (cachedMainnetAccount) return cachedMainnetAccount.address;
  const key = mainnetBroadcasterKey();
  if (!key) return null;
  const account = privateKeyToAccount(key);
  if (isCanaryAccount(account.address)) return null;
  cachedMainnetAccount = account;
  return account.address;
}

/** The mainnet key, or null when unset/invalid/forbidden (the canary). */
function mainnetBroadcasterKey(): Hex | null {
  const key = normalizeKey(process.env[MAINNET_BROADCASTER_PRIVATE_KEY_ENV]);
  if (!key) return null;
  // Never let the canary key double as the production broadcaster.
  if (process.env.MPGR_MAINNET_CANARY_PRIVATE_KEY?.trim() && key.toLowerCase() === normalizeKey(process.env.MPGR_MAINNET_CANARY_PRIVATE_KEY)?.toLowerCase()) {
    return null;
  }
  try {
    if (isCanaryAccount(privateKeyToAccount(key).address)) return null;
  } catch {
    return null;
  }
  return key;
}

function isCanaryAccount(address: Address): boolean {
  return address.toLowerCase() === CANARY_WALLET.toLowerCase();
}

/** The broadcaster account that would serve a chain, or null. */
export function delegatedBroadcasterAddressFor(chainId: number): Address | null {
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return delegatedBroadcasterAddress();
  if (chainId === BASE_MAINNET_CHAIN_ID) return mainnetBroadcasterAddress();
  return null;
}

function baseSepoliaRpcUrl(): string {
  return process.env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org";
}

function baseMainnetRpcUrl(): string {
  return process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org";
}

/** Broadcast an already-validated executor call. Testable via injected sender. */
export type DelegatedBroadcastFn = (tx: { to: Address; data: Hex; chainId: number; value?: bigint }) => Promise<Hash>;

async function unavailable(message: string): Promise<Hash> {
  throw new Error(message);
}

const SEPOLIA_UNAVAILABLE = `${SEPOLIA_BROADCASTER_PRIVATE_KEY_ENV} is not configured on the server. Delegated execution is unavailable on Base Sepolia (fail-closed).`;
const MAINNET_UNAVAILABLE = `${MAINNET_BROADCASTER_PRIVATE_KEY_ENV} is not configured on the server (or is the forbidden canary key). Delegated execution is unavailable on Base mainnet (fail-closed).`;

/** Base Sepolia broadcaster — the original Phase 2 path, unchanged. */
export function createDelegatedBroadcaster(): { broadcast: DelegatedBroadcastFn; address: Address | null } {
  const key = configuredKey();
  if (!key) return { broadcast: () => unavailable(SEPOLIA_UNAVAILABLE), address: null };
  const account = privateKeyToAccount(key);
  const chain = baseSepolia as Chain;
  const client = createWalletClient({ account, chain, transport: http(baseSepoliaRpcUrl()) });
  return {
    address: account.address,
    broadcast: async (tx) => {
      if (tx.chainId !== BASE_SEPOLIA_CHAIN_ID) throw new Error(`broadcaster: refusing chain ${tx.chainId} (Base Sepolia only)`);
      return client.sendTransaction({ to: tx.to, data: tx.data, chain: client.chain, kzg: undefined });
    },
  };
}

/** Base MAINNET broadcaster — refuses the canary key and any non-8453 chain. */
export function createMainnetDelegatedBroadcaster(): { broadcast: DelegatedBroadcastFn; address: Address | null } {
  const key = mainnetBroadcasterKey();
  if (!key) return { broadcast: () => unavailable(MAINNET_UNAVAILABLE), address: null };
  const account = privateKeyToAccount(key);
  if (isCanaryAccount(account.address)) return { broadcast: () => unavailable(MAINNET_UNAVAILABLE), address: null };
  const client = createWalletClient({ account, chain: base as Chain, transport: http(baseMainnetRpcUrl()) });
  return {
    address: account.address,
    broadcast: async (tx) => {
      if (tx.chainId !== BASE_MAINNET_CHAIN_ID) throw new Error(`broadcaster: refusing chain ${tx.chainId} (Base mainnet only)`);
      const value = tx.value ?? 0n;
      if (value !== 0n) throw new Error("broadcaster: refusing native value on a delegated mainnet execution");
      return client.sendTransaction({ to: tx.to, data: tx.data, chain: client.chain, kzg: undefined });
    },
  };
}

/** The broadcaster for a chain. Unlisted chains get a refusing stub. */
export function createDelegatedBroadcasterFor(chainId: number): { broadcast: DelegatedBroadcastFn; address: Address | null } {
  if (!isDelegatedChainId(chainId)) {
    return { broadcast: () => unavailable(`broadcaster: refusing chain ${chainId} (not a delegated execution chain)`), address: null };
  }
  return chainId === BASE_MAINNET_CHAIN_ID ? createMainnetDelegatedBroadcaster() : createDelegatedBroadcaster();
}

/** Read-only chain view for Base Sepolia (bytecode/config checks). */
export function delegatedChainView() {
  return createChainView(baseSepolia, baseSepoliaRpcUrl());
}

/** Read-only chain view for Base mainnet (posture bootstrap + verification). */
export function mainnetDelegatedChainView() {
  return createChainView(base, baseMainnetRpcUrl());
}

/** Read-only chain view for a delegated chain, or null when unsupported. */
export function delegatedChainViewFor(chainId: number) {
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return delegatedChainView();
  if (chainId === BASE_MAINNET_CHAIN_ID) return mainnetDelegatedChainView();
  return null;
}

function createChainView(chain: Chain, rpcUrl: string) {
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  return {
    getBytecode: (address: Address) => client.getBytecode({ address }),
    readContract: <T>(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) =>
      client.readContract(args as never) as Promise<T>,
  };
}
