import { base } from "wagmi/chains";
import type { Address } from "viem";

/**
 * Typed Base Mainnet registry.
 *
 * Domain modules (token, staking, auth, tools) must import chain ID,
 * explorer, RPC fallbacks, and contract addresses from here instead of
 * repeating `8453` or checksum-inconsistent literals.
 *
 * Address literals are the exact on-chain values already used by the
 * live configs. Token-lock stays lowercase because its stored checksum
 * casing is invalid for viem's getAddress().
 */
export const CHAIN = base;
export const CHAIN_ID = base.id as 8453;
export const CHAIN_NAME = "Base";
export const CHAIN_EXPLORER_URL = "https://basescan.org";
export const DEFAULT_PUBLIC_RPC_URL = "https://mainnet.base.org";

export const MPGR_TOKEN_ADDRESS =
  "0xB2000000000000000000008d204203177a78AF01" as Address;
export const MPGR_STAKING_ADDRESS =
  "0x1690C7b6d312284e30434d93498e56eE09fFa12c" as Address;
export const MPGR_TOKEN_LOCK_ADDRESS =
  "0x0cb910b19b9d0ab772375a0b2e49b84ccdd51550" as Address;
export const MPGR_REWARD_VAULT_ADDRESS =
  "0xbe4B0e8692670229129562a50A62f5173E30937C" as Address;

export function explorerAddressUrl(address: string): string {
  return `${CHAIN_EXPLORER_URL}/address/${address}`;
}

export function explorerTxUrl(hash: string): string {
  return `${CHAIN_EXPLORER_URL}/tx/${hash}`;
}
