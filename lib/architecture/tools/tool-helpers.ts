// lib/architecture/tools/tool-helpers.ts
//
// P0.2 — small, dependency-free helpers shared by every read-only tool in
// tool-definitions.ts. Nothing here fetches data; this is purely input
// validation (address shape, chain id) so each tool's execute() doesn't
// duplicate the same five lines.

import { getAddress, type Address } from "viem";
import { base } from "wagmi/chains";
import { tokenUtils } from "@/lib/token/token-utils";
import type { AgentToolError } from "./agent-tool-result";

// Every P0.2 tool is Base-Mainnet-only — this app's wagmi config
// (lib/wagmi.ts) only ever configures `chains: [base]`, so this is the
// only chain any of these tools' RPC calls can ever legitimately target.
export const TOOL_CHAIN_ID = base.id;

export type AddressValidationResult =
  | { ok: true; address: Address }
  | { ok: false; error: AgentToolError };

// Validates the 0x-prefixed/40-hex shape (reusing tokenUtils, not a new
// regex), then attempts an EIP-55 checksum via viem's getAddress().
//
// Falls back to the lowercased, as-given form on a checksum mismatch
// rather than rejecting the input — MPGR's own on-chain address is
// itself stored lowercase in this codebase (see
// lib/token-lock/token-lock-config.ts's comment: viem's getAddress()
// rejects it because its mixed-case bytes don't satisfy EIP-55, even
// though it's a structurally valid, real deployed Base address). A tool
// that hard-rejected any address failing that checksum would refuse to
// analyze the app's own token.
export function normalizeAddressInput(value: unknown): AddressValidationResult {
  if (typeof value !== "string" || !tokenUtils.isValidAddress(value)) {
    return {
      ok: false,
      error: {
        code: "INVALID_ADDRESS",
        message: "address must be a 0x-prefixed, 40-hex-character address.",
      },
    };
  }
  try {
    return { ok: true, address: getAddress(value) };
  } catch {
    return { ok: true, address: value.toLowerCase() as Address };
  }
}

// Returns an AgentToolError if the caller explicitly passed a chainId
// that isn't Base Mainnet; returns null (no error) if chainId was
// omitted entirely — every tool here only ever operates against Base
// regardless, so an absent chainId is not itself a rejection.
export function rejectUnsupportedChain(chainId: unknown): AgentToolError | null {
  if (chainId === undefined || chainId === null) return null;
  if (typeof chainId !== "number" || chainId !== TOOL_CHAIN_ID) {
    return {
      code: "CHAIN_UNSUPPORTED",
      message: `Only Base Mainnet (chainId ${TOOL_CHAIN_ID}) is supported; received ${String(chainId)}.`,
    };
  }
  return null;
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Wraps a provider/RPC call so a thrown error becomes an AgentToolError
// instead of an uncaught exception — used for the "core" read(s) each
// tool cannot produce meaningful output without (e.g. native balance for
// wallet_analyzer, bytecode/nonce for base_research). A failure here is
// the tool-level ok:false case the spec requires; it is NOT used for
// secondary/additive reads (staking, lock, rewards) where a partial
// failure should instead mark just that field unavailable — see each
// tool's own try/catch for those.
export async function readOrProviderError<T>(
  label: string,
  fn: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; error: AgentToolError }> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "PROVIDER_ERROR",
        message: `Failed to read ${label} from Base: ${toErrorMessage(err)}`,
        retryable: true,
      },
    };
  }
}

