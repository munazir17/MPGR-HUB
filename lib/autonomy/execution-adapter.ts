// lib/autonomy/execution-adapter.ts
//
// THE AUTHORIZATION BOUNDARY (spec §6).
//
// The repo audit found NO existing delegated/session signing mechanism —
// every wallet write in MPGR today is signed by the USER in their own
// browser wallet (wagmi/RainbowKit), exactly as the non-custodial design
// requires. Per the spec, this implementation therefore ships ONLY the
// authorization/policy abstraction:
//
//   AutonomousExecutionAdapter — the interface a FUTURE safe delegation
//   mechanism (e.g. an ERC-4337 session-key module the USER controls, with
//   its own on-chain spend limits) must implement to plug into the runtime.
//
// and ONE production implementation:
//
//   NO_DELEGATION_ADAPTER — refuses every action with AUTHORIZATION_MISSING.
//   It can never sign, broadcast, or hold keys. It has no key material,
//   no provider, no RPC writer. `canDelegate` is false.
//
// Consequences (all deliberate, all fail-closed):
//   * Today, an autonomous goal can OBSERVE and PLAN and will stop at the
//     authorization check — the user is notified, nothing is signed.
//   * Tests exercise the full ACT path with an explicitly test-only adapter
//     (see __tests__) that simulates a delegation grant. Test adapters are
//     constructed in test code only; no registry here can ever return one.
//
// DO NOT add a key-file loader, env-based EOA key, or hidden signer here.
// That would violate the non-custodial security boundary.

import type { Address } from "viem";

import { DELEGATED_ADAPTER_IDS, isDelegatedAdapterId } from "./types";
import type {
  AuthorizationVerdict,
  AutonomousExecutionAdapter,
  AutonomyPolicy,
  DelegatedSwapRequest,
  DelegatedSwapResult,
} from "./types";

export const NO_DELEGATION_ADAPTER_ID = "none";

export const NO_DELEGATION_REASON = "NO_DELEGATION_MECHANISM";

/**
 * The default and, for now, the ONLY production adapter. Every call is
 * refused BEFORE any quote can be executed and BEFORE any transaction is
 * built for broadcast.
 */
export const noDelegationAdapter: AutonomousExecutionAdapter = {
  id: NO_DELEGATION_ADAPTER_ID,
  canDelegate: false,
  checkAuthorization(_wallet: Address, _policy: AutonomyPolicy): AuthorizationVerdict {
    return { authorized: false, reason: NO_DELEGATION_REASON };
  },
  async executeSwap(_request: DelegatedSwapRequest): Promise<DelegatedSwapResult> {
    return {
      ok: false,
      code: "AUTHORIZATION_MISSING",
      message:
        "No delegation mechanism is configured. MPGR never signs for users; authorize an autonomous policy and connect a user-controlled session-key wallet (future) to enable autonomous execution.",
    };
  },
};

/**
 * Adapter registry. Deliberately tiny and fail-closed:
 *   env unset / "none"  -> noDelegationAdapter
 *   anything else       -> THROWS (an unknown adapter id must never
 *                          silently resolve to something permissive)
 *
 * When a safe delegation mechanism ships (its own reviewed module, its own
 * tests, its own feature gate), it registers here — this file stays the
 * single, auditable chokepoint.
 */
/**
 * Phase 2: a server module (delegated-adapter-production.ts) may install the
 * real delegated adapter here before the runtime is constructed; tests may
 * install explicit test adapters. Nothing else can ever resolve permissively.
 */
let installedDelegatedAdapter: AutonomousExecutionAdapter | null = null;

export function installAutonomousExecutionAdapter(adapter: AutonomousExecutionAdapter): void {
  // Both delegated adapters are installable: the Base Sepolia one (the original
  // Phase 2 path) and the Base mainnet one added by the MC-2 remediation. They
  // share one class and one safety machinery, differ only by chain. Anything
  // else still throws — an unknown id must never resolve permissively.
  if (!isDelegatedAdapterId(adapter.id)) {
    throw new Error(`Only a delegated adapter (${DELEGATED_ADAPTER_IDS.join(" | ")}) can be installed; got "${adapter.id}".`);
  }
  if (installedDelegatedAdapter && installedDelegatedAdapter.id !== adapter.id) {
    throw new Error(
      `A different delegated adapter ("${installedDelegatedAdapter.id}") is already installed; refusing to overwrite it with "${adapter.id}".`,
    );
  }
  installedDelegatedAdapter = adapter;
}

export function clearInstalledAutonomousExecutionAdapter(): void {
  installedDelegatedAdapter = null;
}

/**
 * Read the installed adapter WITHOUT resolving or throwing — the idempotency
 * probe for ensureAutonomousExecutionAdapterInstalled() (lib/autonomy/index.ts).
 * Returns null when nothing is installed; never throws, never signs.
 */
export function peekInstalledAutonomousExecutionAdapter(): AutonomousExecutionAdapter | null {
  return installedDelegatedAdapter;
}

export function getAutonomousExecutionAdapter(): AutonomousExecutionAdapter {
  const configured = process.env.MPGR_AUTONOMOUS_EXECUTION_ADAPTER?.trim();
  if (!configured || configured === NO_DELEGATION_ADAPTER_ID) return noDelegationAdapter;
  if (isDelegatedAdapterId(configured)) {
    if (!installedDelegatedAdapter) {
      throw new Error(
        `Delegated adapter "${configured}" is configured but not installed (server wiring missing) — refusing (fail-closed).`,
      );
    }
    // The configured id must match the INSTALLED adapter's id exactly. This
    // stops an operator from selecting the mainnet adapter while the Sepolia
    // one is wired (or vice versa) and silently executing on the wrong chain.
    if (installedDelegatedAdapter.id !== configured) {
      throw new Error(
        `Delegated adapter "${configured}" is configured but "${installedDelegatedAdapter.id}" is installed — refusing (fail-closed).`,
      );
    }
    return installedDelegatedAdapter;
  }
  throw new Error(`Unknown autonomous execution adapter: "${configured}". No adapter is registered — refusing (fail-closed).`);
}

/** True when the runtime may even ATTEMPT executions (never true today). */
export function delegatedExecutionAvailable(): boolean {
  return getAutonomousExecutionAdapter().canDelegate;
}
