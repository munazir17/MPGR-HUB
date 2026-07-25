// ============================================================================
// MPGR HUB — Phase 2B Part 1 — Service Layer
//
// Every service below is written against an interface so the mock
// implementation can be swapped for a viem/wagmi-backed implementation
// later without touching any component or hook code.
// ============================================================================

import type {
  ClaimHistoryItem,
  RewardClaimSnapshot,
  StakingSnapshot,
  TokenLockSnapshot,
  LockDurationDays,
} from "./types";

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

const fakeTxHash = (): `0x${string}` =>
  `0x${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;

// ---------------------------------------------------------------------------
// Reward Claim
// ---------------------------------------------------------------------------

export interface IRewardService {
  getSnapshot(): Promise<RewardClaimSnapshot>;
  claim(rewardIds: string[]): Promise<ClaimHistoryItem>;
}

export class MockRewardService implements IRewardService {
  async getSnapshot(): Promise<RewardClaimSnapshot> {
    await delay(600);
    return {
      totalClaimable: 428.5,
      rewards: [
        { id: "r1", label: "Daily check-in streak", amount: 120, source: "check-in", availableAt: new Date().toISOString() },
        { id: "r2", label: "Referral bonus", amount: 200, source: "referral", availableAt: new Date().toISOString() },
        { id: "r3", label: "Season 1 milestone", amount: 108.5, source: "season", availableAt: new Date().toISOString() },
      ],
      history: [
        { id: "h1", amount: 60, date: "2026-07-18T10:00:00Z", txHash: fakeTxHash(), status: "confirmed" },
        { id: "h2", amount: 45, date: "2026-07-11T10:00:00Z", txHash: fakeTxHash(), status: "confirmed" },
      ],
    };
  }

  async claim(rewardIds: string[]): Promise<ClaimHistoryItem> {
    await delay(1600);
    if (Math.random() < 0.06) {
      throw new Error("Transaction was rejected by the network. Please try again.");
    }
    return {
      id: `h-${Date.now()}`,
      amount: rewardIds.length * 100,
      date: new Date().toISOString(),
      txHash: fakeTxHash(),
      status: "confirmed",
    };
  }
}

// ---------------------------------------------------------------------------
// Staking
// ---------------------------------------------------------------------------

export interface IStakingService {
  getSnapshot(): Promise<StakingSnapshot>;
  stake(poolId: string, amount: number): Promise<{ txHash: `0x${string}` }>;
  unstake(poolId: string, amount: number): Promise<{ txHash: `0x${string}` }>;
  claimRewards(poolId: string): Promise<{ txHash: `0x${string}` }>;
}

export class MockStakingService implements IStakingService {
  async getSnapshot(): Promise<StakingSnapshot> {
    await delay(600);
    return {
      walletBalance: 5420.75,
      pools: [
        { id: "flex", name: "Flexible", aprPercent: 8.5, lockDays: 0, minStake: 10 },
        { id: "lock30", name: "30-Day Lock", aprPercent: 14, lockDays: 30, minStake: 50 },
        { id: "lock90", name: "90-Day Lock", aprPercent: 22, lockDays: 90, minStake: 100 },
      ],
      positions: [
        {
          poolId: "lock30",
          staked: 1200,
          pendingRewards: 18.42,
          stakedAt: "2026-07-01T00:00:00Z",
          unlocksAt: "2026-07-31T00:00:00Z",
        },
      ],
      history: [
        { date: "2026-07-01", totalStaked: 1200 },
        { date: "2026-07-08", totalStaked: 1200 },
        { date: "2026-07-15", totalStaked: 1200 },
        { date: "2026-07-22", totalStaked: 1200 },
      ],
    };
  }

  async stake(_poolId: string, _amount: number) {
    await delay(1600);
    return { txHash: fakeTxHash() };
  }

  async unstake(_poolId: string, _amount: number) {
    await delay(1600);
    return { txHash: fakeTxHash() };
  }

  async claimRewards(_poolId: string) {
    await delay(1200);
    return { txHash: fakeTxHash() };
  }
}

// ---------------------------------------------------------------------------
// Token Lock
// ---------------------------------------------------------------------------

export interface ITokenLockService {
  getSnapshot(): Promise<TokenLockSnapshot>;
  createLock(amount: number, durationDays: LockDurationDays): Promise<{ txHash: `0x${string}` }>;
  withdrawLock(lockId: string): Promise<{ txHash: `0x${string}` }>;
}

export class MockTokenLockService implements ITokenLockService {
  async getSnapshot(): Promise<TokenLockSnapshot> {
    await delay(600);
    const now = Date.now();
    return {
      walletBalance: 5420.75,
      locks: [
        {
          id: "l1",
          amount: 800,
          durationDays: 90,
          lockedAt: new Date(now - 60 * 24 * 3600 * 1000).toISOString(),
          unlocksAt: new Date(now + 30 * 24 * 3600 * 1000).toISOString(),
          status: "locked",
        },
        {
          id: "l2",
          amount: 250,
          durationDays: 30,
          lockedAt: new Date(now - 40 * 24 * 3600 * 1000).toISOString(),
          unlocksAt: new Date(now - 10 * 24 * 3600 * 1000).toISOString(),
          status: "unlockable",
        },
      ],
    };
  }

  async createLock(_amount: number, _durationDays: LockDurationDays) {
    await delay(1600);
    return { txHash: fakeTxHash() };
  }

  async withdrawLock(_lockId: string) {
    await delay(1200);
    return { txHash: fakeTxHash() };
  }
}

export const rewardService: IRewardService = new MockRewardService();
export const stakingService: IStakingService = new MockStakingService();
export const tokenLockService: ITokenLockService = new MockTokenLockService();
