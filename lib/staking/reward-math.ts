// lib/staking/reward-math.ts

// Phase 3E Part 4 — Reward Math (client-side port).
//
// Line-for-line TypeScript port of contracts/libraries/RewardMath.sol —
// the exact library the deployed MPGRStaking contract uses for
// rewardPerToken() and earned(). Every function signature and formula
// below matches the Solidity source exactly, with one substitution:
// `block.timestamp` becomes an explicit `nowSeconds: bigint` parameter,
// since there is no block here — the caller supplies the client's current
// wall-clock time in its place. Solidity's checked uint256 subtraction/
// division truncates toward zero for non-negative operands, which is
// exactly how JS bigint division already behaves, so no floating point
// and no rounding divergence from the contract is introduced anywhere in
// this file. This file performs NO reads — it is pure math over values
// the caller has already fetched from lib/staking/staking-client.ts.

const PRECISION = 10n ** 18n;

/// Mirrors RewardMath.lastTimeRewardApplicable(uint256 periodFinish).
/// nowSeconds stands in for block.timestamp.
export function lastTimeRewardApplicable(periodFinish: bigint, nowSeconds: bigint): bigint {
  return nowSeconds < periodFinish ? nowSeconds : periodFinish;
}

/// Mirrors RewardMath.rewardPerToken(...). If totalStaked is 0, accrual is
/// frozen — returns rewardPerTokenStored unchanged, exactly as the
/// contract does (rewards are never silently lost into a void).
export function rewardPerToken(
  rewardPerTokenStored: bigint,
  lastUpdateTime: bigint,
  lastApplicableTime: bigint,
  rewardRate: bigint,
  totalStaked: bigint
): bigint {
  if (totalStaked === 0n) return rewardPerTokenStored;

  const timeElapsed = lastApplicableTime - lastUpdateTime;
  // Defensive only: the contract's uint256 subtraction would revert here
  // rather than go negative. lastApplicableTime is derived from the
  // caller's own current time and can never legitimately precede
  // lastUpdateTime (a past on-chain checkpoint), but this guards a UI
  // read against ever computing a negative accrual if it somehow did,
  // instead of throwing mid-render.
  if (timeElapsed <= 0n) return rewardPerTokenStored;

  return rewardPerTokenStored + (timeElapsed * rewardRate * PRECISION) / totalStaked;
}

/// Mirrors RewardMath.earned(...) exactly.
export function earned(
  balance: bigint,
  currentRewardPerToken: bigint,
  userRewardPerTokenPaid: bigint,
  accruedRewards: bigint
): bigint {
  const delta = currentRewardPerToken - userRewardPerTokenPaid;
  // Defensive only, mirroring the note above: rewardPerToken() is
  // monotonically non-decreasing over real time and
  // userRewardPerTokenPaid is always a past checkpoint of it, so delta is
  // never negative in practice — this just guards against ever
  // subtracting a stale/mismatched pair of reads.
  if (delta <= 0n) return accruedRewards;

  return (balance * delta) / PRECISION + accruedRewards;
}
