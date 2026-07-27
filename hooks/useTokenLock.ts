"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import {
  LOCK_DURATION_OPTIONS,
  EARLY_UNLOCK_PENALTY_PERCENT,
  createLock as createLockAction,
  earlyUnlockLock as earlyUnlockAction,
  estimateLockBonus,
  getAvailableBalance,
  getTokenLockLifetimeStats,
  getTokenLockPositions,
  getTokenLockState,
  getTokenLockSummary,
  releaseLock as releaseLockAction,
  type LockPeriodDays,
  type TokenLockActionResult,
  type TokenLockPositionView,
  type TokenLockTransaction,
} from "@/lib/token-lock-engine";

interface LockEvent {
  amount: number;
  id: number;
}

export function useTokenLock() {
  const { address, isConnected } = useAccount();
  const [positions, setPositions] = useState<TokenLockPositionView[]>([]);
  const [transactions, setTransactions] = useState<TokenLockTransaction[]>([]);
  const [availableBalance, setAvailableBalance] = useState(0);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<LockEvent | null>(null);

  const refresh = useCallback(() => {
    if (!address) return;
    setPositions(getTokenLockPositions(address));
    setAvailableBalance(getAvailableBalance(address));
    setTransactions(
      [...getTokenLockState(address).transactions].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      )
    );
  }, [address]);

  useEffect(() => {
    if (!isConnected || !address) {
      setPositions([]);
      setTransactions([]);
      setAvailableBalance(0);
      setHasLoaded(false);
      return;
    }
    refresh();
    setHasLoaded(true);
  }, [address, isConnected, refresh]);

  // Lock status (locked / unlocking soon / unlocked) is time-based, so
  // periodically recompute the derived views even without a user action.
  useEffect(() => {
    if (!isConnected || !address) return;
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [address, isConnected, refresh]);

  const summary = getTokenLockSummary(positions);
  const lifetimeStats = getTokenLockLifetimeStats(positions);

  const createLock = useCallback(
    // Phase 2B swap point: once the lock contract exists on Base, this
    // becomes `await writeContractAsync({ ...lockCall })`.
    (amount: number, lockPeriodDays: LockPeriodDays): TokenLockActionResult => {
      if (!address) {
        return {
          success: false,
          error: "Connect your wallet to create a lock.",
          state: { address: "", positions: [], transactions: [] },
        };
      }
      setError(null);
      const result = createLockAction(address, amount, lockPeriodDays);
      if (!result.success) {
        setError(result.error ?? "Unable to create lock right now.");
      } else {
        refresh();
        if (result.amount) setLastEvent({ amount: result.amount, id: Date.now() });
      }
      return result;
    },
    [address, refresh]
  );

  const releaseLock = useCallback(
    (lockId: string): TokenLockActionResult => {
      if (!address) {
        return {
          success: false,
          error: "Connect your wallet.",
          state: { address: "", positions: [], transactions: [] },
        };
      }
      setError(null);
      const result = releaseLockAction(address, lockId);
      if (!result.success) {
        setError(result.error ?? "Unable to release this lock right now.");
      } else {
        refresh();
        if (result.amount) setLastEvent({ amount: result.amount, id: Date.now() });
      }
      return result;
    },
    [address, refresh]
  );

  const earlyUnlock = useCallback(
    // Phase 2B swap point: replace with an awaited early-exit contract call.
    (lockId: string): TokenLockActionResult => {
      if (!address) {
        return {
          success: false,
          error: "Connect your wallet.",
          state: { address: "", positions: [], transactions: [] },
        };
      }
      setError(null);
      const result = earlyUnlockAction(address, lockId);
      if (!result.success) {
        setError(result.error ?? "Unable to process early unlock right now.");
      } else {
        refresh();
        if (result.amount) setLastEvent({ amount: result.amount, id: Date.now() });
      }
      return result;
    },
    [address, refresh]
  );

  const dismissError = useCallback(() => setError(null), []);
  const dismissEvent = useCallback(() => setLastEvent(null), []);

  return {
    lockDurationOptions: LOCK_DURATION_OPTIONS,
    earlyUnlockPenaltyPercent: EARLY_UNLOCK_PENALTY_PERCENT,
    estimateLockBonus,
    positions,
    transactions,
    availableBalance,
    totalLocked: summary.totalLocked,
    activeLocksCount: summary.activeLocksCount,
    unlockingSoonCount: summary.unlockingSoonCount,
    averageLockPeriodDays: summary.averageLockPeriodDays,
    longestLockDays: summary.longestLockDays,
    upcomingUnlockAt: summary.upcomingUnlockAt,
    lifetimeBonusEarned: lifetimeStats.lifetimeBonusEarned,
    locksReleasedCount: lifetimeStats.locksReleasedCount,
    earlyUnlocksCount: lifetimeStats.earlyUnlocksCount,
    error,
    lastEvent,
    createLock,
    releaseLock,
    earlyUnlock,
    dismissError,
    dismissEvent,
    loading: isConnected && !hasLoaded,
  };
}
