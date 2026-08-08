"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useChainId, useSwitchChain, useWatchContractEvent } from "wagmi";
import { base } from "wagmi/chains";
import { formatUnits } from "viem";
import type { Hash } from "viem";
import { stakingClient } from "@/lib/staking/staking-client";
import { stakingService } from "@/lib/staking/staking-service";
import { STAKING_ABI } from "@/lib/staking/staking-abi";
import { MPGR_STAKING_CONFIG } from "@/lib/staking/staking-config";
import { refreshManager } from "@/lib/token/refresh-manager";
import { agentEventBus } from "@/lib/architecture/core/event-bus";
import { logger } from "@/lib/architecture/core/logger";
import { tokenUtils } from "@/lib/token/token-utils";
import { MPGR_TOKEN_CONFIG } from "@/lib/token/token-config";
import { useMPGRBalance } from "@/hooks/useMPGRBalance";
import * as rewardMath from "@/lib/staking/reward-math";
import {
  idleActionState,
  type StakingActionState,
  type StakingGlobalState,
  type StakingLiveActivityEntry,
  type StakingWalletState,
} from "@/lib/staking/staking-types";

interface StakeEvent {
  amount: number;
  id: number;
}

export function useStaking() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync, isPending: isSwitchingChain } = useSwitchChain();

  const [globalState, setGlobalState] = useState<StakingGlobalState | null>(null);
  const [walletState, setWalletState] = useState<StakingWalletState | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<StakeEvent | null>(null);
  const [liveActivity, setLiveActivity] = useState<StakingLiveActivityEntry[]>([]);

  const [approveState, setApproveState] = useState<StakingActionState>(idleActionState());
  const [stakeState, setStakeState] = useState<StakingActionState>(idleActionState());
  const [unstakeState, setUnstakeState] = useState<StakingActionState>(idleActionState());
  const [claimState, setClaimState] = useState<StakingActionState>(idleActionState());
  const [exitState, setExitState] = useState<StakingActionState>(idleActionState());

  const { formatted: walletBalanceFormatted, raw: walletBalanceRaw, refresh: refreshWalletBalance } =
    useMPGRBalance();

  const isWrongNetwork = isConnected && chainId !== base.id;

  const decimals = MPGR_TOKEN_CONFIG.decimals;

  const loadGlobalState = useCallback(async () => {
    try {
      const state = await stakingService.getGlobalState();
      setGlobalState(state);
      setReadError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load staking pool data.";
      setReadError(message);
      logger.error("useStaking.loadGlobalState failed", { error: message });
    }
  }, []);

  const loadWalletState = useCallback(async (walletAddress: `0x${string}`) => {
    try {
      const state = await stakingService.getWalletState(walletAddress);
      setWalletState(state);
      setReadError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load your staking position.";
      setReadError(message);
      logger.error("useStaking.loadWalletState failed", { error: message });
    }
  }, []);

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      if (address) {
        await refreshManager.refreshStaking(address);
        await refreshWalletBalance();
      }
      await Promise.all([loadGlobalState(), address ? loadWalletState(address) : Promise.resolve()]);
    } finally {
      setIsRefreshing(false);
    }
  }, [address, loadGlobalState, loadWalletState, refreshWalletBalance]);

  useEffect(() => {
    setHasLoaded(false);
    loadGlobalState().finally(() => {
      if (!address) setHasLoaded(true);
    });
  }, [loadGlobalState, address]);

  useEffect(() => {
    if (!isConnected || !address) {
      setWalletState(null);
      return;
    }
    loadWalletState(address).finally(() => setHasLoaded(true));
  }, [address, isConnected, loadWalletState]);

  useEffect(() => {
    if (!isConnected || !address) return;
    const id = setInterval(() => {
      loadGlobalState();
      loadWalletState(address);
    }, MPGR_STAKING_CONFIG.liveReadPollingIntervalMs);
    return () => clearInterval(id);
  }, [address, isConnected, loadGlobalState, loadWalletState]);

  useEffect(() => {
    const unsubscribe = agentEventBus.on("staking_changed", (payload) => {
      if (payload.address !== address) return;
      loadGlobalState();
      loadWalletState(payload.address as `0x${string}`);
    });
    return unsubscribe;
  }, [address, loadGlobalState, loadWalletState]);

  const pushActivity = useCallback((entry: StakingLiveActivityEntry) => {
    setLiveActivity((prev) => [entry, ...prev].slice(0, 20));
  }, []);

  useWatchContractEvent({
    address: MPGR_STAKING_CONFIG.address,
    abi: STAKING_ABI,
    eventName: "Staked",
    chainId: MPGR_STAKING_CONFIG.chainId,
    enabled: isConnected && !!address,
    onLogs(logs) {
      for (const log of logs) {
        const { user, amount } = log.args as { user?: `0x${string}`; amount?: bigint };
        if (!user || address?.toLowerCase() !== user.toLowerCase() || amount === undefined) continue;
        pushActivity({ id: `${log.transactionHash}-${log.logIndex}`, kind: "Staked", amount, txHash: log.transactionHash!, observedAt: new Date().toISOString() });
        refresh();
      }
    },
  });

  useWatchContractEvent({
    address: MPGR_STAKING_CONFIG.address,
    abi: STAKING_ABI,
    eventName: "Unstaked",
    chainId: MPGR_STAKING_CONFIG.chainId,
    enabled: isConnected && !!address,
    onLogs(logs) {
      for (const log of logs) {
        const { user, amount } = log.args as { user?: `0x${string}`; amount?: bigint };
        if (!user || address?.toLowerCase() !== user.toLowerCase() || amount === undefined) continue;
        pushActivity({ id: `${log.transactionHash}-${log.logIndex}`, kind: "Unstaked", amount, txHash: log.transactionHash!, observedAt: new Date().toISOString() });
        refresh();
      }
    },
  });

  useWatchContractEvent({
    address: MPGR_STAKING_CONFIG.address,
    abi: STAKING_ABI,
    eventName: "RewardPaid",
    chainId: MPGR_STAKING_CONFIG.chainId,
    enabled: isConnected && !!address,
    onLogs(logs) {
      for (const log of logs) {
        const { user, reward } = log.args as { user?: `0x${string}`; reward?: bigint };
        if (!user || address?.toLowerCase() !== user.toLowerCase() || reward === undefined) continue;
        pushActivity({ id: `${log.transactionHash}-${log.logIndex}`, kind: "RewardPaid", amount: reward, txHash: log.transactionHash!, observedAt: new Date().toISOString() });
        refresh();
      }
    },
  });

  const runAction = useCallback(
    async (
      setState: (updater: (prev: StakingActionState) => StakingActionState) => void,
      submit: () => Promise<Hash>,
      onSuccess?: (hash: Hash) => void
    ) => {
      if (!address) return;
      setState(() => ({ phase: "simulating", hash: null, error: null }));
      try {
        const hash = await submit();
        setState(() => ({ phase: "pending", hash, error: null }));
        setState((prev) => ({ ...prev, phase: "confirming" }));
        const receipt = await stakingClient.waitForReceipt(hash);
        if (receipt.status !== "success") {
          throw new Error("Transaction reverted on-chain.");
        }
        setState(() => ({ phase: "success", hash, error: null }));
        await refresh();
        onSuccess?.(hash);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Transaction failed.";
        setState(() => ({ phase: "error", hash: null, error: message }));
        logger.error("useStaking.runAction failed", { error: message });
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
      logger.error("useStaking.ensureBaseNetwork failed", { error: err });
      return false;
    }
  }, [isWrongNetwork, switchChainAsync]);

  const approve = useCallback(
    async (amountRaw: bigint) => {
      if (!(await ensureBaseNetwork())) return;
      await runAction(setApproveState, () => stakingClient.approve(amountRaw));
    },
    [ensureBaseNetwork, runAction]
  );

  const stake = useCallback(
    async (amountRaw: bigint) => {
      if (!(await ensureBaseNetwork())) return;
      await runAction(setStakeState, () => stakingClient.stake(amountRaw), () => {
        const amount = parseFloat(formatUnits(amountRaw, decimals));
        setLastEvent({ amount, id: Date.now() });
      });
    },
    [decimals, ensureBaseNetwork, runAction]
  );

  const unstake = useCallback(
    async (amountRaw: bigint) => {
      if (!(await ensureBaseNetwork())) return;
      await runAction(setUnstakeState, () => stakingClient.unstake(amountRaw), () => {
        const amount = parseFloat(formatUnits(amountRaw, decimals));
        setLastEvent({ amount, id: Date.now() });
      });
    },
    [decimals, ensureBaseNetwork, runAction]
  );

  const claimRewards = useCallback(async () => {
    if (!(await ensureBaseNetwork())) return;
    const earnedAtSubmit = walletState?.earnedRewards ?? 0n;
    await runAction(setClaimState, () => stakingClient.claimRewards(), () => {
      const amount = parseFloat(formatUnits(earnedAtSubmit, decimals));
      setLastEvent({ amount, id: Date.now() });
    });
  }, [decimals, ensureBaseNetwork, runAction, walletState?.earnedRewards]);

  const exitStaking = useCallback(async () => {
    if (!(await ensureBaseNetwork())) return;
    const payoutAtSubmit = (walletState?.stakedBalance ?? 0n) + (walletState?.earnedRewards ?? 0n);
    await runAction(setExitState, () => stakingClient.exit(), () => {
      const amount = parseFloat(formatUnits(payoutAtSubmit, decimals));
      setLastEvent({ amount, id: Date.now() });
    });
  }, [decimals, ensureBaseNetwork, runAction, walletState?.earnedRewards, walletState?.stakedBalance]);

  const resetActionState = useCallback((kind: "approve" | "stake" | "unstake" | "claim" | "exit") => {
    if (kind === "approve") setApproveState(idleActionState());
    if (kind === "stake") setStakeState(idleActionState());
    if (kind === "unstake") setUnstakeState(idleActionState());
    if (kind === "claim") setClaimState(idleActionState());
    if (kind === "exit") setExitState(idleActionState());
  }, []);

  const dismissEvent = useCallback(() => setLastEvent(null), []);

  const [nowSeconds, setNowSeconds] = useState<bigint>(() => BigInt(Math.floor(Date.now() / 1000)));

  useEffect(() => {
    if (!isConnected || !address || !globalState || !walletState) return;
    const id = setInterval(() => {
      setNowSeconds(BigInt(Math.floor(Date.now() / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [isConnected, address, globalState, walletState]);

  const liveEarnedRewardsRaw = useMemo(() => {
    if (!globalState || !walletState) return 0n;

    const lastApplicableTime = rewardMath.lastTimeRewardApplicable(globalState.periodFinish, nowSeconds);
    const currentRewardPerToken = rewardMath.rewardPerToken(
      globalState.rewardPerTokenStored,
      globalState.lastUpdateTime,
      lastApplicableTime,
      globalState.rewardRate,
      globalState.totalStaked
    );
    return rewardMath.earned(
      walletState.stakedBalance,
      currentRewardPerToken,
      walletState.userRewardPerTokenPaid,
      walletState.accruedRewards
    );
  }, [globalState, walletState, nowSeconds]);

  const minimumStakeRaw = globalState?.minimumStake ?? tokenUtils.parseTokenAmount("100", decimals);
  const allowanceRaw = walletState?.allowance ?? 0n;

  const needsApproval = useCallback(
    (amountRaw: bigint) => amountRaw > allowanceRaw,
    [allowanceRaw]
  );

  const currentAPRPercent = useMemo(() => {
    if (!globalState || globalState.currentAPRBps === 0n) return null;
    return Number(globalState.currentAPRBps) / 100;
  }, [globalState]);

  return {
    isConnected,
    address,
    isWrongNetwork,
    isSwitchingChain,
    switchToBase: ensureBaseNetwork,

    loading: isConnected ? !hasLoaded : !globalState,
    isRefreshing,
    readError,

    walletBalanceRaw: walletBalanceRaw ?? 0n,
    walletBalanceFormatted,

    stakedBalanceRaw: walletState?.stakedBalance ?? 0n,
    earnedRewardsRaw: walletState?.earnedRewards ?? 0n,
    allowanceRaw,
    needsApproval,

    totalStakedRaw: globalState?.totalStaked ?? 0n,
    rewardPoolBalanceRaw: globalState?.rewardPoolBalance ?? 0n,
    rewardRatePerSecondRaw: globalState?.rewardRate ?? 0n,
    currentAPRPercent,
    isPoolPaused: globalState?.isPaused ?? false,
    minimumStakeRaw,
    decimals,

    liveActivity,
    lastEvent,
    dismissEvent,

    approveState,
    stakeState,
    unstakeState,
    claimState,
    exitState,
    resetActionState,

    approve,
    stake,
    unstake,
    claimRewards,
    exit: exitStaking,

    refresh,

    liveEarnedRewardsRaw,
  };
}
