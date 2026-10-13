// lib/delegated/rpc-bounds.ts
//
// Explicit bounds for every Base MAINNET RPC call on the delegated execution
// path: the posture reads (verifyOnChain), the quote/route chain reader, and the
// operator broadcaster (estimateGas + sendRawTransaction inside sendTransaction).
//
// Why these numbers. viem's http transport defaults to a 10 s attempt timeout
// with 3 retries, and it retries timeouts. One dead RPC therefore costs ~40 s
// per call, and verifyOnChain runs several sequential rounds. That is what
// pushed a tick past its 60 s maxDuration. An 8 s attempt timeout with ONE retry
// bounds a dead call at ~17 s, and a timeout surfaces as RPC_ERROR instead of a
// hang.
//
// This is a dependency-free module on purpose: lib/executor and lib/delegated
// both import it, and it must not create an import cycle between them.

/** Per-attempt HTTP timeout for mainnet delegated RPC. Must stay <= 10 s. */
export const DELEGATED_MAINNET_RPC_TIMEOUT_MS = 8_000;

/** Retry cap per RPC call (viem retries timeouts and 5xx). Keep small. */
export const DELEGATED_MAINNET_RPC_RETRY_COUNT = 1;

export interface DelegatedRpcBounds {
  timeoutMs: number;
  retryCount: number;
}

export const DELEGATED_MAINNET_RPC_BOUNDS: DelegatedRpcBounds = {
  timeoutMs: DELEGATED_MAINNET_RPC_TIMEOUT_MS,
  retryCount: DELEGATED_MAINNET_RPC_RETRY_COUNT,
};
