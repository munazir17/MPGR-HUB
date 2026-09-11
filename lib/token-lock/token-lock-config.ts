// lib/token-lock/token-lock-config.ts
import { CHAIN, CHAIN_ID, MPGR_TOKEN_ADDRESS, MPGR_TOKEN_LOCK_ADDRESS } from "@/lib/chain/base";

// Wiring config for the already-deployed, immutable MPGRTokenLock V1
// contract on Base Mainnet. Mirrors the shape of
// lib/staking/staking-config.ts and lib/token/token-config.ts so all three
// live-infrastructure domains (token, staking, token lock) stay consistent
// to read. This contract is FINAL — no functional changes are possible
// post-deployment; only the frontend wiring lives here.

export const MPGR_TOKEN_LOCK_CONFIG = {
  // Deployed MPGRTokenLock V1 address on Base Mainnet. Immutable — never
  // redeploy against this key without renaming it.
  address: MPGR_TOKEN_LOCK_ADDRESS,

  // MPGR (B20) token address — the asset createLock()/withdraw()/
  // earlyUnlock() move.
  mpgrTokenAddress: MPGR_TOKEN_ADDRESS,

  // Chain the Token Lock contract lives on. Base only.
  chain: CHAIN,
  chainId: CHAIN_ID,

  // MPGR uses 18 decimals (see lib/token/token-config.ts).
  decimals: 18,

  // The contract's early-unlock penalty is a fixed on-chain constant
  // (EARLY_UNLOCK_PENALTY_BPS = 1000 in MPGRTokenLock.sol, i.e. 10%) that
  // is NOT exposed as a public getter and is therefore not part of
  // TOKEN_LOCK_ABI. This value is used ONLY to render a preview figure in
  // EarlyUnlockModal before the user signs — the actual split (90%
  // returned / 10% to penaltyRecipient) is computed and executed entirely
  // on-chain inside earlyUnlock(); the frontend never decides or moves
  // that split itself.
  earlyUnlockPenaltyBps: 1000,
  bpsDenominator: 10_000,

  // Client-side-only threshold for the "Unlocking Soon" status badge —
  // has no on-chain counterpart (getLockStatus() only returns "Locked" /
  // "Unlocked" / "Withdrawn"). Mirrors
  // token-lock-engine.ts's former UNLOCKING_SOON_THRESHOLD_DAYS.
  unlockingSoonThresholdDays: 3,

  // Live-read polling cadence, matching MPGR_STAKING_CONFIG's pattern.
  liveReadPollingIntervalMs: 15 * 1000,

  // Transaction confirmation timeout (informational — waitForReceipt
  // itself has no built-in timeout; kept for parity with staking config
  // for any UI copy that references it).
  transactionConfirmationTimeoutMs: 90 * 1000,
} as const;

export type MPGRTokenLockConfig = typeof MPGR_TOKEN_LOCK_CONFIG;
