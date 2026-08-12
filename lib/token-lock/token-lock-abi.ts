// lib/token-lock/token-lock-abi.ts

// Hand-derived 1:1 from the deployed MPGRTokenLock.sol source — the exact
// contract deployed to Base Mainnet at MPGR_TOKEN_LOCK_CONFIG.address.
// No functional changes occurred between that source and deployment.
//
// Scope: the 12 functions explicitly requested (createLock, withdraw,
// earlyUnlock, getLock, getUserLockIds, getUserLockCount, isLockUnlocked,
// getLockStatus, mpgrToken, penaltyRecipient, totalLocked, nextLockId),
// plus the contract's real emitted events (LockCreated, LockWithdrawn,
// EarlyUnlocked) — needed by useTokenLock's useWatchContractEvent live
// -refresh, matching the pattern lib/staking/staking-abi.ts already uses.
// These are the verified real event signatures from the deployed source,
// not invented. No custom errors are declared on this contract (its
// requires are plain revert-string checks), so none are added here.

export const TOKEN_LOCK_ABI = [
  // --- View / public state-variable getters -------------------------------
  {
    type: "function",
    name: "mpgrToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "penaltyRecipient",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "totalLocked",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "nextLockId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getLock",
    stateMutability: "view",
    inputs: [{ name: "lockId", type: "uint256" }],
    outputs: [
      { name: "amount", type: "uint256" },
      { name: "unlockTime", type: "uint256" },
      { name: "withdrawn", type: "bool" },
      { name: "user", type: "address" },
    ],
  },
  {
    type: "function",
    name: "getUserLockIds",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "getUserLockCount",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "isLockUnlocked",
    stateMutability: "view",
    inputs: [{ name: "lockId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getLockStatus",
    stateMutability: "view",
    inputs: [{ name: "lockId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },

  // --- Mutating functions --------------------------------------------------
  {
    type: "function",
    name: "createLock",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "unlockTime", type: "uint256" },
    ],
    outputs: [{ name: "lockId", type: "uint256" }],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "lockId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "earlyUnlock",
    stateMutability: "nonpayable",
    inputs: [{ name: "lockId", type: "uint256" }],
    outputs: [],
  },

  // --- Events (real deployed signatures, used for live-refresh only) ------
  {
    type: "event",
    name: "LockCreated",
    inputs: [
      { name: "lockId", type: "uint256", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "unlockTime", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LockWithdrawn",
    inputs: [
      { name: "lockId", type: "uint256", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "EarlyUnlocked",
    inputs: [
      { name: "lockId", type: "uint256", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "amountReturned", type: "uint256", indexed: false },
      { name: "penaltyAmount", type: "uint256", indexed: false },
    ],
  },
] as const;
