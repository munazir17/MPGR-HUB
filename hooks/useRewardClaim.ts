"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useChainId, useSwitchChain, useWatchContractEvent } from "wagmi";
import { base } from "wagmi/chains";
import { formatUnits } from "viem";
import type { Hash } from "viem";
import { rewardVaultClient } from "@/lib/reward-vault/reward-vault-client";
import { rewardVaultService } from "@/lib/reward-vault/reward-vault-service";
import { REWARD_VAULT_ABI } from "@/lib/reward-vault/reward-vault-abi";
import { MPGR_REWARD_VAULT_CONFIG } from "@/lib/reward-vault/reward-vault-config";
import { VaultRewardStatus, idleVaultActionState, type VaultActionState, type VaultReward } from "@/lib/reward-vault/reward-vault-types";

// Reward Vault Integration — useRewardClaim.
//
// Real on-chain Reward Claim hook, mirroring hooks/useStaking.ts's shape:
// cache-backed reads via reward-vault-service, simulate-then-write
// transactions via reward-vault-client, and a per-action lifecycle state
// (idle → simulating → pending → confirming → success/error). Nothing
// here is simulated or delayed artificially — every reward, every
// claimability check, and every transaction hash comes directly from the
// deployed MPGRRewardVault contract on Base Mainnet. A wallet's rewards
// are always discovered dynamically via getUserRewardIds(); no rewardId
// is ever hardcoded.
//
// This hook is intentionally independent of hooks/useRewards.ts (the
// existing local check-in/streak/level claim system) and of
// hooks/useRewardHub.ts (the existing read-only summary aggregator) —
// it does not read from or write into either, so it carries zero risk
// to that existing, working code path.

export function useRewardClaim() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync, isPending: isSwitchingChain } = useSwitchChain();

  const [rewards, setRewards] = useState<VaultReward[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  // Keyed by rewardId so claiming reward #4 doesn't disturb reward #7's
  // button state, and "claim all" can be tracked separately from any
  // single-reward claim.
  const [actionStates, setActionStates] = useState<Map<string, VaultActionState>>(new Map());
  const [claimingAll, setClaimingAll] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastTxHash, setLastTxHash] = useState<Hash | null>(null);

  // Race-condition fix — wallet switching. loadRewards(walletAddress) is
  // async (an RPC round trip), and this hook fires it again every time
  // `address` changes plus on an interval — so switching wallets quickly
  // (or a slow response for the PREVIOUS wallet landing after the new
  // wallet's own request already resolved) could let a stale response
  // for wallet A overwrite the already-correct state for wallet B. This
  // ref always holds the address this hook currently cares about;
  // loadRewards checks it after every await and discards the result if
  // the wallet has since changed, instead of trusting whichever request
  // happens to finish last.
  const currentAddressRef = useRef<string | null>(null);

  const isWrongNetwork = isConnected && chainId !== base.id;
  const decimals = MPGR_REWARD_VAULT_CONFIG.decimals;

  const loadRewards = useCallback(async (walletAddress: `0x${string}`) => {
    try {
      const walletRewards = await rewardVaultService.getWalletRewards(walletAddress);
      if (currentAddressRef.current !== walletAddress.toLowerCase()) return; // stale — wallet changed mid-request
      setRewards(walletRewards);
      setReadError(null);
    } catch (err) {
      if (currentAddressRef.current !== walletAddress.toLowerCase()) return; // stale — wallet changed mid-request
      // Root-cause fix — Issues 1/12 (raw RPC/contract error text shown
      // to users). reward-vault-client.ts's thrown Error.message
      // deliberately embeds the underlying viem error for logging (e.g.
      // "Failed to fetch your reward IDs: The request took too long to
      // respond" followed by viem's own multi-line "Request Arguments" /
      // "Raw Call Arguments" block). That raw text used to be stored in
      // readError and rendered directly in OnChainRewardsSection. The
      // full message is still logged below for real diagnostics; only a
      // short, normalized message reaches state/UI now.
      const raw = err instanceof Error ? err.message : String(err);
      setReadError(normalizeReadError(raw));
      console.error("useRewardClaim.loadRewards failed", { error: raw });
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!address) return;
    setIsRefreshing(true);
    try {
      rewardVaultService.clearWalletCache(address);
      await loadRewards(address);
    } finally {
      setIsRefreshing(false);
    }
  }, [address, loadRewards]);

  useEffect(() => {
    currentAddressRef.current = address ? address.toLowerCase() : null;
    if (!isConnected || !address) {
      setRewards([]);
      setHasLoaded(false);
      return;
    }
    setHasLoaded(false);
    loadRewards(address).finally(() => {
      // Only clear the loading state if this effect run is still the
      // current wallet — an outdated run's `finally` firing after a
      // switch shouldn't flip `hasLoaded` for the NEW wallet's own
      // in-flight load back to a misleading state.
      if (currentAddressRef.current === address.toLowerCase()) setHasLoaded(true);
    });
  }, [address, isConnected, loadRewards]);

  useEffect(() => {
    if (!isConnected || !address) return;
    const id = setInterval(() => {
      loadRewards(address);
    }, MPGR_REWARD_VAULT_CONFIG.liveReadPollingIntervalMs);
    return () => clearInterval(id);
  }, [address, isConnected, loadRewards]);

  // Live-refresh the moment this wallet's RewardClaimed event lands, so
  // the UI reflects a claim made from another tab/device too.
  useWatchContractEvent({
    address: MPGR_REWARD_VAULT_CONFIG.address,
    abi: REWARD_VAULT_ABI,
    eventName: "RewardClaimed",
    chainId: MPGR_REWARD_VAULT_CONFIG.chainId,
    enabled: isConnected && !!address,
    onLogs(logs) {
      for (const log of logs) {
        const { user } = log.args as { user?: `0x${string}` };
        if (!user || address?.toLowerCase() !== user.toLowerCase()) continue;
        refresh();
      }
    },
  });

  const ensureBaseNetwork = useCallback(async (): Promise<boolean> => {
    if (!isWrongNetwork) return true;
    try {
      await switchChainAsync({ chainId: base.id });
      return true;
    } catch (err) {
      console.error("useRewardClaim.ensureBaseNetwork failed", { error: err });
      return false;
    }
  }, [isWrongNetwork, switchChainAsync]);

  const setActionState = useCallback((key: string, updater: (prev: VaultActionState) => VaultActionState) => {
    setActionStates((prev) => {
      const next = new Map(prev);
      const current = next.get(key) ?? idleVaultActionState();
      next.set(key, updater(current));
      return next;
    });
  }, []);

  const getActionState = useCallback(
    (key: string): VaultActionState => actionStates.get(key) ?? idleVaultActionState(),
    [actionStates]
  );

  // Shared submit → simulate → sign → confirm → refresh lifecycle for both
  // claim() and claimMultiple(). Never fabricates a hash or a success
  // state — every phase transition is driven by a real wallet/RPC result.
  const runClaim = useCallback(
    async (stateKey: string, submit: () => Promise<Hash>) => {
      if (!address) return;
      if (!(await ensureBaseNetwork())) return;

      setLastError(null);
      setActionState(stateKey, () => ({ phase: "simulating", hash: null, error: null }));
      try {
        const hash = await submit();
        setActionState(stateKey, () => ({ phase: "pending", hash, error: null }));
        setLastTxHash(hash);
        setActionState(stateKey, (prev) => ({ ...prev, phase: "confirming" }));

        const receipt = await rewardVaultClient.waitForReceipt(hash);
        if (receipt.status !== "success") {
          throw new Error("Transaction reverted on-chain.");
        }

        setActionState(stateKey, () => ({ phase: "success", hash, error: null }));
        await refresh();
      } catch (err) {
        const message = normalizeClaimError(err);
        setActionState(stateKey, () => ({ phase: "error", hash: null, error: message }));
        setLastError(message);
        console.error("useRewardClaim.runClaim failed", { stateKey, error: message });
      }
    },
    [address, ensureBaseNetwork, refresh, setActionState]
  );

  const claim = useCallback(
    async (rewardId: bigint) => {
      await runClaim(rewardId.toString(), () => rewardVaultClient.claim(rewardId));
    },
    [runClaim]
  );

  const claimMultiple = useCallback(
    async (rewardIds: bigint[]) => {
      if (rewardIds.length === 0) return;
      setClaimingAll(true);
      try {
        await runClaim("claimMultiple", () => rewardVaultClient.claimMultiple(rewardIds));
      } finally {
        setClaimingAll(false);
      }
    },
    [runClaim]
  );

  const resetActionState = useCallback((key: string) => {
    setActionStates((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const claimableRewards = useMemo(
    () => rewards.filter((r) => r.status === VaultRewardStatus.ALLOCATED && r.isClaimable),
    [rewards]
  );

  const claimedRewards = useMemo(
    () => rewards.filter((r) => r.status === VaultRewardStatus.CLAIMED),
    [rewards]
  );

  const claimableAmountRaw = useMemo(
    () => claimableRewards.reduce((sum, r) => sum + r.amount, 0n),
    [claimableRewards]
  );

  const claimableAmount = useMemo(
    () => parseFloat(formatUnits(claimableAmountRaw, decimals)),
    [claimableAmountRaw, decimals]
  );

  const isClaiming = useMemo(
    () => claimingAll || Array.from(actionStates.values()).some((s) => s.phase === "simulating" || s.phase === "pending" || s.phase === "confirming"),
    [actionStates, claimingAll]
  );

  return {
    isConnected,
    address,
    isWrongNetwork,
    isSwitchingChain,
    switchToBase: ensureBaseNetwork,

    rewards,
    claimableRewards,
    claimedRewards,
    claimableAmountRaw,
    claimableAmount,
    decimals,

    isLoading: isConnected ? !hasLoaded : false,
    isRefreshing,
    isClaiming,
    readError,
    error: lastError,
    txHash: lastTxHash,

    claim,
    claimMultiple,
    getActionState,
    resetActionState,
    refresh,
  };
}

// Turns a raw read-side error (getUserRewardIds/getReward failures —
// RPC timeouts, dropped connections, rate limiting) into a short,
// user-facing message. The full raw error is always logged separately
// at the call site (see loadRewards above) before this runs, so nothing
// diagnostic is lost — this only controls what reaches the UI.
//
// Deliberately narrow: unlike normalizeClaimError below (which has
// specific contract revert reasons to map), read failures are almost
// always transport-level, so this collapses everything to one
// consistent "couldn't load, try again" message rather than guessing at
// causes it can't actually distinguish from the message text alone.
function normalizeReadError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("chain mismatch") || lower.includes("wrong network")) {
    return "Please switch to Base Mainnet to view your rewards.";
  }
  return "Unable to load your on-chain rewards right now.";
}

// Turns raw wallet/RPC/contract errors into short, user-facing messages
// while the original error is still logged (see console.error above the
// call site) for debugging. Falls back to the raw message rather than
// hiding genuinely new failure modes.
function normalizeClaimError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (lower.includes("user rejected") || lower.includes("user denied")) {
    return "Transaction was cancelled.";
  }
  if (lower.includes("rewardnotclaimable")) {
    return "This reward is no longer claimable — it may already be claimed or its season has ended.";
  }
  if (lower.includes("notrewardowner")) {
    return "This reward doesn't belong to the connected wallet.";
  }
  if (lower.includes("rewardnotfound")) {
    return "This reward could not be found on-chain.";
  }
  if (lower.includes("emptybatch")) {
    return "Select at least one reward to claim.";
  }
  if (lower.includes("insufficient funds") || lower.includes("insufficient gas")) {
    return "Insufficient ETH for gas on Base.";
  }
  if (lower.includes("chain mismatch") || lower.includes("wrong network")) {
    return "Please switch to Base Mainnet to claim.";
  }
  if (lower.includes("reverted")) {
    return "Transaction reverted on-chain. It may have already been claimed.";
  }

  // Issue 12 — unmapped errors used to fall through to the raw
  // wallet/RPC message verbatim (viem errors include a multi-line
  // "Request Arguments"/"Raw Call Arguments" block). The raw message is
  // already logged via console.error at the runClaim() call site above,
  // so nothing diagnostic is lost by not also rendering it to the user.
  return "Something went wrong submitting that claim. Please try again.";
}
