// lib/reward-vault/reward-vault-admin-abi.ts
//
// SERVER-ONLY. Admin ABI for the deployed MPGRRewardVault
// (0xbe4B0e8692670229129562a50A62f5173E30937C, Base Mainnet), covering
// only the rewardManager/owner-authorized functions the future weekly
// settlement job will need, plus the read functions settlement safety
// checks (H.6/H.7 in the architecture) depend on.
//
// This is copied verbatim (function/event/error shapes) from the
// authoritative ABI supplied for this task — not reconstructed from
// memory or guessed.
//
// !! MUST NEVER BE IMPORTED BY ANY "use client" FILE OR ANY MODULE THAT
// !! ENDS UP IN A CLIENT BUNDLE. This is exactly why it's a separate file
// !! from lib/reward-vault/reward-vault-abi.ts (the existing client-safe
// !! ABI used by reward-vault-client.ts / useRewardClaim.ts), which
// !! intentionally excludes every function below — do not merge these
// !! two files or re-export this one from anywhere client-reachable.
//
// Nothing in this repo currently imports this file — no signer, no
// createWalletClient, no allocateReward call exists yet. It exists so a
// future server-only admin client module has a verified ABI to import
// once F (Reward Manager signer) and the other blockers are resolved.

export const REWARD_VAULT_ADMIN_ABI = [
  // --- Admin writes (rewardManager-authorized) ----------------------------

  {
    type: "function",
    name: "allocateReward",
    stateMutability: "nonpayable",
    inputs: [
      { name: "seasonId", type: "uint256" },
      { name: "user", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "rewardType", type: "uint8" },
    ],
    outputs: [{ name: "rewardId", type: "uint256" }],
  },
  {
    type: "function",
    name: "allocateRewardsBatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "seasonId", type: "uint256" },
      { name: "users", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "rewardTypes", type: "uint8[]" },
    ],
    outputs: [{ name: "firstRewardId", type: "uint256" }],
  },

  // --- Admin writes (owner-only) -------------------------------------------

  {
    type: "function",
    name: "createSeason",
    stateMutability: "nonpayable",
    inputs: [
      { name: "seasonId", type: "uint256" },
      { name: "startTime", type: "uint256" },
      { name: "endTime", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "finalizeSeason",
    stateMutability: "nonpayable",
    inputs: [{ name: "seasonId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "fund",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setRewardManager",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "enabled", type: "bool" },
    ],
    outputs: [],
  },

  // --- Reads needed by settlement safety checks (H.6 / H.7 / D) ---------

  {
    type: "function",
    name: "availableBalance",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "vaultBalance",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalReserved",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalFunded",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "rewardManager",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "seasonExists",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getSeason",
    stateMutability: "view",
    inputs: [{ name: "seasonId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "seasonId", type: "uint256" },
          { name: "startTime", type: "uint256" },
          { name: "endTime", type: "uint256" },
          { name: "totalAllocated", type: "uint256" },
          { name: "totalClaimed", type: "uint256" },
          { name: "finalized", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getSeasonRewardIds",
    stateMutability: "view",
    inputs: [{ name: "seasonId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "getUserRewardIds",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "getReward",
    stateMutability: "view",
    inputs: [{ name: "rewardId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "rewardId", type: "uint256" },
          { name: "seasonId", type: "uint256" },
          { name: "user", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "rewardType", type: "uint8" },
          { name: "status", type: "uint8" },
        ],
      },
    ],
  },

  // --- Events --------------------------------------------------------------

  {
    type: "event",
    name: "RewardAllocated",
    inputs: [
      { name: "rewardId", type: "uint256", indexed: true },
      { name: "seasonId", type: "uint256", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "rewardType", type: "uint8", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "RewardClaimed",
    inputs: [
      { name: "rewardId", type: "uint256", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "SeasonCreated",
    inputs: [
      { name: "seasonId", type: "uint256", indexed: true },
      { name: "startTime", type: "uint256", indexed: false },
      { name: "endTime", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "SeasonFinalized",
    inputs: [
      { name: "seasonId", type: "uint256", indexed: true },
      { name: "recycledAmount", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "TreasuryFunded",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "RewardManagerUpdated",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "enabled", type: "bool", indexed: false },
    ],
    anonymous: false,
  },

  // --- Errors (for decoded revert reasons in settlement logging) --------

  { type: "error", name: "NotOwner", inputs: [] },
  { type: "error", name: "NotRewardManager", inputs: [] },
  { type: "error", name: "SeasonAlreadyExists", inputs: [] },
  { type: "error", name: "SeasonAlreadyFinalized", inputs: [] },
  { type: "error", name: "SeasonNotActive", inputs: [] },
  { type: "error", name: "SeasonNotFound", inputs: [] },
  { type: "error", name: "SeasonStillActive", inputs: [] },
  { type: "error", name: "InvalidSeasonTime", inputs: [] },
  { type: "error", name: "InsufficientVaultBalance", inputs: [] },
  { type: "error", name: "LengthMismatch", inputs: [] },
  { type: "error", name: "EmptyBatch", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "Reentrancy", inputs: [] },
  { type: "error", name: "RewardNotFound", inputs: [] },
  { type: "error", name: "NotRewardOwner", inputs: [] },
  { type: "error", name: "RewardNotClaimable", inputs: [] },
  { type: "error", name: "TransferFailed", inputs: [] },
] as const;
