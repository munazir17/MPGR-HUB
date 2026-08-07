// lib/staking/staking-events-abi.ts

import { parseAbiItem } from "viem";

// Phase 3E Part 4 — Staking Event ABI.
//
// Standalone event fragments for the three MPGRStaking events the
// activity/analytics history reader scans (Staked, Unstaked, RewardPaid).
// Kept separate from staking-abi.ts (the full contract ABI, used for
// reads/writes/live watching via useWatchContractEvent in
// hooks/useStaking.ts) so the log-scanning path has exactly the typed
// fragments it needs for eth_getLogs — the same split
// lib/token/transfer-events-abi.ts uses for the token module. Never
// modifies or duplicates staking-abi.ts.

export const stakedEventAbiItem = parseAbiItem(
  "event Staked(address indexed user, uint256 amount)"
);

export const unstakedEventAbiItem = parseAbiItem(
  "event Unstaked(address indexed user, uint256 amount)"
);

export const rewardPaidEventAbiItem = parseAbiItem(
  "event RewardPaid(address indexed user, uint256 reward)"
);
