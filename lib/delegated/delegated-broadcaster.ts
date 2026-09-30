import "server-only";

// lib/executor/delegated-broadcaster.ts
//
// The AUTONOMOUS BROADCASTER (Phase 2). An OPERATOR-controlled server key
// that can ONLY broadcast transactions the USER pre-authorized with a
// bounded Permit2 witness permit (single-use nonce, exact amount, minOut,
// deadline, policyHash). It is NOT user key custody: the user's key never
// touches the server; the broadcaster key is the operator's own gas payer,
// managed exactly like the existing REWARD_MANAGER_PRIVATE_KEY seam.
//
// Fail-closed: without the env key there is no broadcaster and every
// delegated execution refuses. The key is never logged or returned.

import { createPublicClient, createWalletClient, http, type Address, type Chain, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import { DELEGATED_EXECUTOR_CHAIN_ID } from "@/lib/executor/delegated-executor";

let cachedAccount: ReturnType<typeof privateKeyToAccount> | null = null;

function configuredKey(): Hex | null {
  const raw = process.env.MPGR_BROADCASTER_PRIVATE_KEY?.trim();
  if (!raw) return null;
  const normalized = (/^0x/i.test(raw) ? raw : `0x${raw}`) as Hex;
  return /^0x[0-9a-fA-F]{64}$/.test(normalized) ? (normalized as Hex) : null;
}

/** The broadcaster account, or null when unconfigured (fail-closed). */
export function delegatedBroadcasterAddress(): Address | null {
  if (cachedAccount) return cachedAccount.address;
  const key = configuredKey();
  if (!key) return null;
  cachedAccount = privateKeyToAccount(key);
  return cachedAccount.address;
}

function baseSepoliaRpcUrl(): string {
  return process.env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org";
}

/** Broadcast an already-signed executor call. Testable via injected sender. */
export type DelegatedBroadcastFn = (tx: { to: Address; data: Hex; chainId: number }) => Promise<Hash>;

export function createDelegatedBroadcaster(): { broadcast: DelegatedBroadcastFn; address: Address | null } {
  const key = configuredKey();
  if (!key) return { broadcast: unavailable, address: null };
  const account = privateKeyToAccount(key);
  const chain = baseSepolia as Chain;
  const client = createWalletClient({ account, chain, transport: http(baseSepoliaRpcUrl()) });
  return {
    address: account.address,
    broadcast: async (tx) => {
      if (tx.chainId !== DELEGATED_EXECUTOR_CHAIN_ID) throw new Error(`broadcaster: refusing chain ${tx.chainId} (Base Sepolia only)`);
      return client.sendTransaction({ to: tx.to, data: tx.data, chain: client.chain, kzg: undefined });
    },
  };
}

/** Public client for read-only chain checks (bytecode/config) on Base Sepolia. */
export function delegatedChainView() {
  const client = createPublicClient({ chain: baseSepolia, transport: http(baseSepoliaRpcUrl()) });
  return {
    getBytecode: (address: Address) => client.getBytecode({ address }),
    readContract: <T>(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) =>
      client.readContract(args as never) as Promise<T>,
  };
}

async function unavailable(): Promise<Hash> {
  throw new Error("MPGR_BROADCASTER_PRIVATE_KEY is not configured on the server. Delegated execution is unavailable (fail-closed).");
}
