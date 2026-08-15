// lib/reward-vault/reward-vault-abi.ts

// Reward Vault Integration — real deployed MPGRRewardVault contract.
//
// Minimal ABI covering only the functions and events the Reward Claim UI
// needs, matching the deployed contract source exactly (see the vault
// Solidity source provided for this task). No admin-only functions
// (createSeason, finalizeSeason, allocateReward, allocateRewardsBatch,
// fund, setRewardManager, transferOwnership) are included — those are
// intentionally out of scope for the normal-user claim path and must
// never be exposed as user actions.

export const REWARD_VAULT_ABI = [
  // --- Views ---------------------------------------------------------

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
    name: "totalFunded",
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
    name: "totalClaimed",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalRecycled",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "nextRewardId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
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
    name: "getUserRewardIds",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
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
    name: "isRewardClaimable",
    stateMutability: "view",
    inputs: [{ name: "rewardId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },

  // --- Writes ----------------------------------------------------------

  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ name: "rewardId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claimMultiple",
    stateMutability: "nonpayable",
    inputs: [{ name: "rewardIds", type: "uint256[]" }],
    outputs: [],
  },

  // --- Events ------------------------------------------------------------

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

  // --- Errors (for decoded revert reasons in the UI) ----------------------

  { type: "error", name: "RewardNotFound", inputs: [] },
  { type: "error", name: "NotRewardOwner", inputs: [] },
  { type: "error", name: "RewardNotClaimable", inputs: [] },
  { type: "error", name: "TransferFailed", inputs: [] },
  { type: "error", name: "EmptyBatch", inputs: [] },
] as const;
