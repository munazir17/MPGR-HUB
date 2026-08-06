// lib/staking/staking-abi.ts

// Phase 3E Part 3 — Deployed Staking Contract ABI.
//
// Generated from the final Milestone 1C MPGRStaking.sol / IMPGRStaking.sol
// source (contracts/MPGRStaking.sol, contracts/interfaces/IMPGRStaking.sol)
// — the exact contract deployed to Base Mainnet at
// MPGR_STAKING_CONFIG.address. No functional changes occurred between that
// source and deployment; this ABI is hand-derived from it 1:1, matching
// what `out/MPGRStaking.sol/MPGRStaking.json` contains. Includes public
// state-variable getters (Solidity auto-generates one per `public`
// variable), inherited Ownable/Pausable/ReentrancyGuard events and errors,
// and every custom error IMPGRStaking.sol declares — so viem can decode
// revert reasons automatically on every read and write in this module.

export const STAKING_ABI = [
  // --- Constructor -----------------------------------------------------
  {
    type: "constructor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_mpgrToken", type: "address" },
      { name: "_initialOwner", type: "address" },
    ],
  },

  // --- View / public state-variable getters -------------------------------
  {
    type: "function",
    name: "stakingToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "rewardsToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
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
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "MINIMUM_STAKE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "REWARDS_DURATION",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "REWARD_POOL",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "INITIAL_APR_BPS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "MIN_APR_BPS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "MAX_APR_BPS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "currentAPRBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalStaked",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "rewardPoolBalance",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "rewardState",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "rewardRate", type: "uint256" },
      { name: "periodFinish", type: "uint256" },
      { name: "lastUpdateTime", type: "uint256" },
      { name: "rewardPerTokenStored", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "userRewardPerTokenPaid",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "rewards",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "lastTimeRewardApplicable",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "rewardPerToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "earned",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },

  // --- Mutating functions --------------------------------------------------
  {
    type: "function",
    name: "stake",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "unstake",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claimRewards",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "exit",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "depositRewards",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setAPR",
    stateMutability: "nonpayable",
    inputs: [{ name: "newAPRBps", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "extendRewardSchedule",
    stateMutability: "nonpayable",
    inputs: [
      { name: "additionalReward", type: "uint256" },
      { name: "additionalDuration", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "recoverERC20",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "pause",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "unpause",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },

  // --- Events (IMPGRStaking) -----------------------------------------------
  {
    type: "event",
    name: "Staked",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Unstaked",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RewardPaid",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "reward", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RewardAdded",
    inputs: [
      { name: "rewardPool", type: "uint256", indexed: false },
      { name: "rewardRate", type: "uint256", indexed: false },
      { name: "periodFinish", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RewardsDeposited",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "APRUpdated",
    inputs: [
      { name: "oldAPRBps", type: "uint256", indexed: false },
      { name: "newAPRBps", type: "uint256", indexed: false },
      { name: "newRewardRate", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RewardScheduleExtended",
    inputs: [
      { name: "additionalReward", type: "uint256", indexed: false },
      { name: "newRewardRate", type: "uint256", indexed: false },
      { name: "newPeriodFinish", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TokenRecovered",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },

  // --- Events (Ownable / Pausable, inherited) -------------------------------
  {
    type: "event",
    name: "OwnershipTransferred",
    inputs: [
      { name: "previousOwner", type: "address", indexed: true },
      { name: "newOwner", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "Paused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },
  {
    type: "event",
    name: "Unpaused",
    inputs: [{ name: "account", type: "address", indexed: false }],
  },

  // --- Custom errors (IMPGRStaking) -----------------------------------------
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  {
    type: "error",
    name: "BelowMinimumStake",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "minimum", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "InsufficientRewardBalance",
    inputs: [
      { name: "requested", type: "uint256" },
      { name: "available", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "RewardPeriodNotFinished",
    inputs: [{ name: "periodFinish", type: "uint256" }],
  },
  {
    type: "error",
    name: "InsufficientStakedBalance",
    inputs: [
      { name: "requested", type: "uint256" },
      { name: "available", type: "uint256" },
    ],
  },
  { type: "error", name: "NothingStaked", inputs: [] },
  { type: "error", name: "NoRewardToClaim", inputs: [] },
  {
    type: "error",
    name: "InvalidAPR",
    inputs: [
      { name: "requested", type: "uint256" },
      { name: "minAllowed", type: "uint256" },
      { name: "maxAllowed", type: "uint256" },
    ],
  },
  { type: "error", name: "ZeroDuration", inputs: [] },
  { type: "error", name: "ZeroRewardRate", inputs: [] },
  {
    type: "error",
    name: "RewardScheduleWouldShrink",
    inputs: [
      { name: "attemptedPeriodFinish", type: "uint256" },
      { name: "currentPeriodFinish", type: "uint256" },
    ],
  },
  { type: "error", name: "CannotRecoverStakingToken", inputs: [] },

  // --- Custom errors (Ownable / Pausable / ReentrancyGuard, inherited) -------
  {
    type: "error",
    name: "OwnableUnauthorizedAccount",
    inputs: [{ name: "account", type: "address" }],
  },
  {
    type: "error",
    name: "OwnableInvalidOwner",
    inputs: [{ name: "owner", type: "address" }],
  },
  { type: "error", name: "EnforcedPause", inputs: [] },
  { type: "error", name: "ExpectedPause", inputs: [] },
  { type: "error", name: "ReentrancyGuardReentrantCall", inputs: [] },
] as const;
