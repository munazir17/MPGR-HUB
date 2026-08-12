"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useChainId, useSwitchChain, useWatchContractEvent } from "wagmi";
import { base } from "wagmi/chains";
import { formatUnits, parseUnits } from "viem";
import type { Address, Hash } from "viem";
import { tokenLockClient } from "@/lib/token-lock/token-lock-client";
import { TOKEN_LOCK_ABI } from "@/lib/token-lock/token-lock-abi";
import { MPGR_TOKEN_LOCK_CONFIG } from "@/lib/token-lock/token-lock-config";
import { useMPGRBalance } from "@/hooks/useMPGRBalance";
import {
  idleActionState,
  type TokenLockActionState,
  type TokenLockLiveActivityEntry,
  type TokenLockPosition,
  type TokenLockPositionView,
} from "@/lib/token-lock/token-lock-types";

// Real on-chain Token Lock integration, wired to the deployed, immutable
// MPGRTokenLock V1 contract (MPGR_TOKEN_LOCK_CONFIG.address). Replaces the
// former lib/token-lock-engine.ts localStorage mock entirely — no
// setTimeout confirmation delays, no fabricated transaction hashes, no
// localStorage used as transaction state. Structured the same way
// hooks/useStaking.ts is: per-action state machines (idle -> simulating ->
// pending -> confirming -> success/error), simulateContract -> writeContract
// -> waitForTransactionReceipt for every write, and live event watching
// for in-session activity.
//
// Note on shape changes from the old mock hook (see chat for full
// rationale): the deployed contract has no bonus/APY mechanism and no
// per-lock creation timestamp, so `lockDurationOptions`/`estimateLockBonus`
// /`lifetimeBonusEarned`/`earlyUnlocksCount` -- all of which depended on
// data the contract does not store or emit in queryable form -- are gone.
// Everything this hook now returns is either read directly from the
// contract or derived from fields the contract actually exposes.

export const LOCK_DURATION_PRESETS_DAYS = [30, 90, 180, 365] as const;
export type LockDurationDays = (typeof LOCK_DURATION_PRESETS_DAYS)[number];

interface LockEvent {
  amount: number;
  id: number;
}

const DECIMALS = MPGR_TOKEN_LOCK_CONFIG.decimals;

function toView(position: TokenLockPosition, now: number): TokenLockPositionView {
  const unlockMs = Number(position.unlockTime) * 1000;
  const daysRemaining = Math.max(0, Math.ceil((unlockMs - now) / 86_400_000));
  const isUnlocked = position.withdrawn || now >= unlockMs;
  const isUnlockingSoon =
    !position.withdrawn && !isUnlocked && daysRemaining <= MPGR_TOKEN_LOCK_CONFIG.unlockingSoonThresholdDays;

  const status: TokenLockPositionView["status"] = position.withdrawn
    ? "withdrawn"
    : isUnlocked
      ? "unlocked"
      : isUnlockingSoon
        ? "unlocking_soon"
        : "locked";

  const amountFormatted = Number(formatUnits(position.amount, DECIMALS));

  // Preview only -- see token-lock-config.ts's comment on
  // earlyUnlockPenaltyBps. The contract alone executes the real split.
  const earlyUnlockPenaltyPreview =
    (amountFormatted * MPGR_TOKEN_LOCK_CONFIG.earlyUnlockPenaltyBps) / MPGR_TOKEN_LOCK_CONFIG.bpsDenominator;
  const earlyUnlockPayoutPreview = amountFormatted - earlyUnlockPenaltyPreview;

  return {
    ...position,
    status,
    daysRemaining,
    isUnlocked,
    isUnlockingSoon,
    amountFormatted,
    earlyUnlockPenaltyPreview,
    earlyUnlockPayoutPreview,
  };
}

export function useTokenLock() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();

  const [positions, setPositions] = useState<TokenLockPositionView[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<LockEvent | null>(null);
  const [liveActivity, setLiveActivity] = useState<TokenLockLiveActivityEntry[]>([]);

  const [approveState, setApproveState] = useState<TokenLockActionState>(idleActionState());
  const [createLockState, setCreateLockState] = useState<TokenLockActionState>(idleActionState());
  const [withdrawState, setWithdrawState] = useState<TokenLockActionState>(idleActionState());
  const [earlyUnlockState, setEarlyUnlockState] = useState<TokenLockActionState>(idleActionState());
  // Which lockId a withdraw/earlyUnlock action is currently targeting, so
  // the UI can disable only the specific LockCard in flight rather than
  // every card on the page.
  const [pendingLockId, setPendingLockId] = useState<bigint | null>(null);

  const { raw: walletBalanceRaw, formatted: walletBalanceFormatted, refresh: refreshWalletBalance } =
    useMPGRBalance();

  const isWrongNetwork = isConnected && chainId !== base.id;

  const loadPositions = useCallback(async (walletAddress: Address) => {
    try {
      const ids = await tokenLockClient.getUserLockIds(walletAddress);
      const locks = await Promise.all(ids.map((id) => tokenLockClient.getLock(id)));
      const now = Date.now();
      const views = ids
        .map((id, i) => {
          const l = locks[i];
          const position: TokenLockPosition = {
            id,
            amount: l.amount,
            unlockTime: l.unlockTime,
            withdrawn: l.withdrawn,
            owner: l.user,
          };
          return toView(position, now);
        })
        // Newest first -- lockId is assigned by the contract's
        // monotonically increasing nextLockId counter, so id desc is
        // exact creation order (no per-lock timestamp exists to sort by
        // instead).
        .sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0));
      setPositions(views);
      setReadError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load your locks.";
      setReadError(message);
      console.error("useTokenLock.loadPositions failed", { error: message });
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!address) return;
    setIsRefreshing(true);
    try {
      await Promise.all([loadPositions(address), refreshWalletBalance()]);
    } finally {
      setIsRefreshing(false);
    }
  }, [address, loadPositions, refreshWalletBalance]);

  useEffect(() => {
    if (!isConnected || !address) {
      setPositions([]);
      setHasLoaded(false);
      return;
    }
    setHasLoaded(false);
    loadPositions(address).finally(() => setHasLoaded(true));
  }, [address, isConnected, loadPositions]);

  useEffect(() => {
    if (!isConnected || !address) return;
    const id = setInterval(() => loadPositions(address), MPGR_TOKEN_LOCK_CONFIG.liveReadPollingIntervalMs);
    return () => clearInterval(id);
  }, [address, isConnected, loadPositions]);

  const pushActivity = useCallback((entry: TokenLockLiveActivityEntry) => {
    setLiveActivity((prev) => [entry, ...prev].slice(0, 20));
  }, []);

  useWatchContractEvent({
    address: MPGR_TOKEN_LOCK_CONFIG.address,
    abi: TOKEN_LOCK_ABI,
    eventName: "LockCreated",
    chainId: MPGR_TOKEN_LOCK_CONFIG.chainId,
    enabled: isConnected && !!address,
    onLogs(logs) {
      for (const log of logs) {
        const { user, amount } = log.args as { user?: Address; amount?: bigint };
        if (!user || address?.toLowerCase() !== user.toLowerCase() || amount === undefined) continue;
        pushActivity({
          id: `${log.transactionHash}-${log.logIndex}`,
          kind: "LockCreated",
          amount,
          txHash: log.transactionHash!,
          observedAt: new Date().toISOString(),
        });
        refresh();
      }
    },
  });

  useWatchContractEvent({
    address: MPGR_TOKEN_LOCK_CONFIG.address,
    abi: TOKEN_LOCK_ABI,
    eventName: "LockWithdrawn",
    chainId: MPGR_TOKEN_LOCK_CONFIG.chainId,
    enabled: isConnected && !!address,
    onLogs(logs) {
      for (const log of logs) {
        const { user, amount } = log.args as { user?: Address; amount?: bigint };
        if (!user || address?.toLowerCase() !== user.toLowerCase() || amount === undefined) continue;
        pushActivity({
          id: `${log.transactionHash}-${log.logIndex}`,
          kind: "LockWithdrawn",
          amount,
          txHash: log.transactionHash!,
          observedAt: new Date().toISOString(),
        });
        refresh();
      }
    },
  });

  useWatchContractEvent({
    address: MPGR_TOKEN_LOCK_CONFIG.address,
    abi: TOKEN_LOCK_ABI,
    eventName: "EarlyUnlocked",
    chainId: MPGR_TOKEN_LOCK_CONFIG.chainId,
    enabled: isConnected && !!address,
    onLogs(logs) {
      for (const log of logs) {
        const { user, amountReturned } = log.args as { user?: Address; amountReturned?: bigint };
        if (!user || address?.toLowerCase() !== user.toLowerCase() || amountReturned === undefined) continue;
        pushActivity({
          id: `${log.transactionHash}-${log.logIndex}`,
          kind: "EarlyUnlocked",
          amount: amountReturned,
          txHash: log.transactionHash!,
          observedAt: new Date().toISOString(),
        });
        refresh();
      }
    },
  });

  const runAction = useCallback(
    async (
      setState: (updater: (prev: TokenLockActionState) => TokenLockActionState) => void,
      submit: () => Promise<Hash>,
      onSuccess?: (hash: Hash) => void
    ) => {
      if (!address) return;
      setState(() => ({ phase: "simulating", hash: null, error: null }));
      try {
        const hash = await submit();
        setState(() => ({ phase: "pending", hash, error: null }));
        setState((prev) => ({ ...prev, phase: "confirming" }));
        const receipt = await tokenLockClient.waitForReceipt(hash);
        if (receipt.status !== "success") {
          throw new Error("Transaction reverted on-chain.");
        }
        setState(() => ({ phase: "success", hash, error: null }));
        await refresh();
        onSuccess?.(hash);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Transaction failed.";
        setState(() => ({ phase: "error", hash: null, error: message }));
        console.error("useTokenLock.runAction failed", { error: message });
      }
    },
    [address, refresh]
  );

  const ensureBaseNetwork = useCallback(async (): Promise<boolean> => {
    if (!isWrongNetwork) return true;
    try {
      await switchChainAsync({ chainId: base.id });
      return true;
    } catch (err) {
      console.error("useTokenLock.ensureBaseNetwork failed", { error: err });
      return false;
    }
  }, [isWrongNetwork, switchChainAsync]);

  // approve(TokenLockV1, amount) -> createLock(amount, unlockTime).
  // amountInput is a human-readable MPGR amount (e.g. "1000"); durationDays
  // is one of the fixed presets, converted client-side to an absolute
  // unlockTime -- the contract itself accepts any future timestamp, the
  // presets are purely a frontend convenience.
  const createLock = useCallback(
    async (amountInput: number, durationDays: LockDurationDays) => {
      if (!address || !Number.isFinite(amountInput) || amountInput <= 0) return;
      if (!(await ensureBaseNetwork())) return;

      const amountRaw = parseUnits(amountInput.toString(), DECIMALS);
      const unlockTime = BigInt(Math.floor(Date.now() / 1000) + durationDays * 86_400);

      await runAction(setApproveState, () => tokenLockClient.approve(amountRaw));
      await runAction(setCreateLockState, () => tokenLockClient.createLock(amountRaw, unlockTime), () => {
        setLastEvent({ amount: amountInput, id: Date.now() });
      });
    },
    [address, ensureBaseNetwork, runAction]
  );

  const withdraw = useCallback(
    async (lockId: bigint) => {
      if (!(await ensureBaseNetwork())) return;
      const position = positions.find((p) => p.id === lockId);
      setPendingLockId(lockId);
      await runAction(setWithdrawState, () => tokenLockClient.withdraw(lockId), () => {
        if (position) setLastEvent({ amount: position.amountFormatted, id: Date.now() });
      });
      setPendingLockId(null);
    },
    [ensureBaseNetwork, positions, runAction]
  );

  const earlyUnlock = useCallback(
    async (lockId: bigint) => {
      if (!(await ensureBaseNetwork())) return;
      const position = positions.find((p) => p.id === lockId);
      setPendingLockId(lockId);
      await runAction(setEarlyUnlockState, () => tokenLockClient.earlyUnlock(lockId), () => {
        if (position) setLastEvent({ amount: position.earlyUnlockPayoutPreview, id: Date.now() });
      });
      setPendingLockId(null);
    },
    [ensureBaseNetwork, positions, runAction]
  );

  const dismissEvent = useCallback(() => setLastEvent(null), []);
  const dismissError = useCallback(() => setReadError(null), []);
  const resetActionState = useCallback((kind: "approve" | "createLock" | "withdraw" | "earlyUnlock") => {
    if (kind === "approve") setApproveState(idleActionState());
    if (kind === "createLock") setCreateLockState(idleActionState());
    if (kind === "withdraw") setWithdrawState(idleActionState());
    if (kind === "earlyUnlock") setEarlyUnlockState(idleActionState());
  }, []);

  const summary = useMemo(() => {
    const active = positions.filter((p) => p.status !== "withdrawn");
    const totalLocked = active.reduce((sum, p) => sum + p.amountFormatted, 0);
    const unlockingSoonCount = positions.filter((p) => p.status === "unlocking_soon").length;
    const withdrawnCount = positions.filter((p) => p.status === "withdrawn").length;

    const averageLockDaysRemaining =
      active.length === 0 ? 0 : Math.round(active.reduce((sum, p) => sum + p.daysRemaining, 0) / active.length);

    const longestActiveLockDaysRemaining = active.reduce((max, p) => Math.max(max, p.daysRemaining), 0);

    const upcoming = active
      .filter((p) => p.status === "locked" || p.status === "unlocking_soon")
      .sort((a, b) => Number(a.unlockTime - b.unlockTime))[0];

    return {
      totalLocked,
      activeLocksCount: active.length,
      unlockingSoonCount,
      withdrawnCount,
      averageLockDaysRemaining,
      longestActiveLockDaysRemaining,
      upcomingUnlockAt: upcoming ? new Date(Number(upcoming.unlockTime) * 1000).toISOString() : null,
    };
  }, [positions]);

  return {
    lockDurationPresetsDays: LOCK_DURATION_PRESETS_DAYS,
    earlyUnlockPenaltyPercent: MPGR_TOKEN_LOCK_CONFIG.earlyUnlockPenaltyBps / 100,

    positions,
    availableBalanceRaw: walletBalanceRaw ?? 0n,
    availableBalance: parseFloat(walletBalanceFormatted || "0"),
    totalLocked: summary.totalLocked,
    activeLocksCount: summary.activeLocksCount,
    unlockingSoonCount: summary.unlockingSoonCount,
    withdrawnCount: summary.withdrawnCount,
    averageLockDaysRemaining: summary.averageLockDaysRemaining,
    longestActiveLockDaysRemaining: summary.longestActiveLockDaysRemaining,
    upcomingUnlockAt: summary.upcomingUnlockAt,

    liveActivity,
    lastEvent,
    readError,

    approveState,
    createLockState,
    withdrawState,
    earlyUnlockState,
    pendingLockId,
    resetActionState,

    createLock,
    withdraw,
    earlyUnlock,
    dismissEvent,
    dismissError,
    refresh,

    isWrongNetwork,
    loading: isConnected && !hasLoaded,
    isRefreshing,
  };
}
