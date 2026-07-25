// ============================================================================
// MPGR HUB — Phase 2B Part 1 — Hooks
//
// Note: your project may already have a generic useAsync / useTransaction
// hook. I don't have visibility into your hooks folder, so these are
// written standalone. If you point me to an existing equivalent, I'll
// refactor these three to use it instead of duplicating the pattern.
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import {
  rewardService,
  stakingService,
  tokenLockService,
} from "./services";
import type {
  LockDurationDays,
  RewardClaimSnapshot,
  StakingSnapshot,
  TokenLockSnapshot,
  TxState,
} from "./types";

// ---------------------------------------------------------------------------
// useRewardClaim
// ---------------------------------------------------------------------------

export function useRewardClaim() {
  const [data, setData] = useState<RewardClaimSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [txState, setTxState] = useState<TxState>("idle");
  const [txError, setTxError] = useState<string | null>(null);
  const [lastTxHash, setLastTxHash] = useState<`0x${string}` | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const snapshot = await rewardService.getSnapshot();
      setData(snapshot);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load rewards.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const claim = useCallback(
    async (rewardIds: string[]) => {
      setTxError(null);
      setTxState("pending");
      try {
        setTxState("confirming");
        const result = await rewardService.claim(rewardIds);
        setLastTxHash(result.txHash);
        setTxState("success");
        await refresh();
      } catch (e) {
        setTxState("error");
        setTxError(e instanceof Error ? e.message : "Claim failed.");
      }
    },
    [refresh]
  );

  const resetTx = useCallback(() => {
    setTxState("idle");
    setTxError(null);
    setLastTxHash(null);
  }, []);

  return { data, isLoading, loadError, txState, txError, lastTxHash, claim, resetTx, refresh };
}

// ---------------------------------------------------------------------------
// useStaking
// ---------------------------------------------------------------------------

export function useStaking() {
  const [data, setData] = useState<StakingSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [txState, setTxState] = useState<TxState>("idle");
  const [txError, setTxError] = useState<string | null>(null);
  const [lastTxHash, setLastTxHash] = useState<`0x${string}` | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const snapshot = await stakingService.getSnapshot();
      setData(snapshot);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load staking data.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const runTx = useCallback(
    async (fn: () => Promise<{ txHash: `0x${string}` }>) => {
      setTxError(null);
      setTxState("pending");
      try {
        setTxState("confirming");
        const result = await fn();
        setLastTxHash(result.txHash);
        setTxState("success");
        await refresh();
      } catch (e) {
        setTxState("error");
        setTxError(e instanceof Error ? e.message : "Transaction failed.");
      }
    },
    [refresh]
  );

  const stake = useCallback((poolId: string, amount: number) => runTx(() => stakingService.stake(poolId, amount)), [runTx]);
  const unstake = useCallback((poolId: string, amount: number) => runTx(() => stakingService.unstake(poolId, amount)), [runTx]);
  const claimRewards = useCallback((poolId: string) => runTx(() => stakingService.claimRewards(poolId)), [runTx]);

  const resetTx = useCallback(() => {
    setTxState("idle");
    setTxError(null);
    setLastTxHash(null);
  }, []);

  return { data, isLoading, loadError, txState, txError, lastTxHash, stake, unstake, claimRewards, resetTx, refresh };
}

// ---------------------------------------------------------------------------
// useTokenLock
// ---------------------------------------------------------------------------

export function useTokenLock() {
  const [data, setData] = useState<TokenLockSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [txState, setTxState] = useState<TxState>("idle");
  const [txError, setTxError] = useState<string | null>(null);
  const [lastTxHash, setLastTxHash] = useState<`0x${string}` | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const snapshot = await tokenLockService.getSnapshot();
      setData(snapshot);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load lock data.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createLock = useCallback(
    async (amount: number, durationDays: LockDurationDays) => {
      setTxError(null);
      setTxState("pending");
      try {
        setTxState("confirming");
        const result = await tokenLockService.createLock(amount, durationDays);
        setLastTxHash(result.txHash);
        setTxState("success");
        await refresh();
      } catch (e) {
        setTxState("error");
        setTxError(e instanceof Error ? e.message : "Lock creation failed.");
      }
    },
    [refresh]
  );

  const withdrawLock = useCallback(
    async (lockId: string) => {
      setTxError(null);
      setTxState("pending");
      try {
        setTxState("confirming");
        const result = await tokenLockService.withdrawLock(lockId);
        setLastTxHash(result.txHash);
        setTxState("success");
        await refresh();
      } catch (e) {
        setTxState("error");
        setTxError(e instanceof Error ? e.message : "Withdrawal failed.");
      }
    },
    [refresh]
  );

  const resetTx = useCallback(() => {
    setTxState("idle");
    setTxError(null);
    setLastTxHash(null);
  }, []);

  return { data, isLoading, loadError, txState, txError, lastTxHash, createLock, withdrawLock, resetTx, refresh };
}
