"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { motion } from "framer-motion";
import { Lock, X, AlertCircle } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { FloatingXP } from "@/components/ui/FloatingXP";
import { StakingStats } from "@/components/ui/StakingStats";
import { LiveRewardCounter } from "@/components/ui/LiveRewardCounter";
import { StakingAnalyticsCards } from "@/components/ui/StakingAnalyticsCards";
import { StakingActivityTimeline } from "@/components/ui/StakingActivityTimeline";
import { StakingCard } from "@/components/ui/StakingCard";
import { StakeModal } from "@/components/ui/StakeModal";
import { UnstakeModal } from "@/components/ui/UnstakeModal";
import { ExitModal } from "@/components/ui/ExitModal";
import { useStaking } from "@/hooks/useStaking";
import { useStakingHistory } from "@/hooks/useStakingHistory";
import { formatTokenBalance } from "@/lib/format";

export default function StakingPage() {
  const [mounted, setMounted] = useState(false);
  const { isConnected } = useAccount();
  const {
    walletBalanceRaw,
    stakedBalanceRaw,
    earnedRewardsRaw,
    liveEarnedRewardsRaw,
    totalStakedRaw,
    rewardPoolBalanceRaw,
    currentAPRPercent,
    minimumStakeRaw,
    decimals,
    isPoolPaused,
    isWrongNetwork,
    switchToBase,
    needsApproval,
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
    exit,
    readError,
    loading,
  } = useStaking();

  const {
    events: historyEvents,
    isLoading: historyLoading,
    isLoadingMore: historyLoadingMore,
    error: historyError,
    hasMore: historyHasMore,
    totalRewardsClaimedRaw,
    refresh: refreshHistory,
    loadMore: loadMoreHistory,
  } = useStakingHistory();

  const [stakeModalOpen, setStakeModalOpen] = useState(false);
  const [unstakeModalOpen, setUnstakeModalOpen] = useState(false);
  const [exitModalOpen, setExitModalOpen] = useState(false);
  const [dismissedError, setDismissedError] = useState(false);

  useEffect(() => setMounted(true), []);
  useEffect(() => setDismissedError(false), [readError]);

  return (
    <>
      <Navbar />
      <FloatingXP amount={lastEvent?.amount ?? null} onComplete={dismissEvent} unit="MPGR" />

      <StakeModal
        open={stakeModalOpen}
        onClose={() => setStakeModalOpen(false)}
        walletBalanceRaw={walletBalanceRaw}
        minimumStakeRaw={minimumStakeRaw}
        decimals={decimals}
        needsApproval={needsApproval}
        approveState={approveState}
        stakeState={stakeState}
        onApprove={approve}
        onStake={stake}
        onReset={() => {
          resetActionState("approve");
          resetActionState("stake");
        }}
        isWrongNetwork={isWrongNetwork}
        onSwitchNetwork={switchToBase}
      />

      <UnstakeModal
        open={unstakeModalOpen}
        onClose={() => setUnstakeModalOpen(false)}
        stakedBalanceRaw={stakedBalanceRaw}
        decimals={decimals}
        unstakeState={unstakeState}
        onUnstake={unstake}
        onReset={() => resetActionState("unstake")}
        isWrongNetwork={isWrongNetwork}
        onSwitchNetwork={switchToBase}
      />

      <ExitModal
        open={exitModalOpen}
        onClose={() => setExitModalOpen(false)}
        stakedBalanceRaw={stakedBalanceRaw}
        earnedRewardsRaw={earnedRewardsRaw}
        decimals={decimals}
        exitState={exitState}
        onExit={exit}
        onReset={() => resetActionState("exit")}
        isWrongNetwork={isWrongNetwork}
        onSwitchNetwork={switchToBase}
      />

      <main className="mx-auto max-w-6xl px-4 py-10">
        {!mounted ? null : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
            <SectionHeader
              title="MPGR Staking"
              subtitle="Stake MPGR to earn yield — claim or unstake any time, no lock period"
            />

            {!isConnected && (
              <EmptyState
                icon={Lock}
                title="Connect your wallet"
                description="Connect to stake MPGR and start earning rewards."
              />
            )}

            {readError && !dismissedError && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}>
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-red-500/20 bg-red-500/10 p-3.5 backdrop-blur-xl">
                  <span className="flex items-center gap-2 text-xs text-red-400">
                    <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {readError}
                  </span>
                  <button
                    onClick={() => setDismissedError(true)}
                    aria-label="Dismiss error"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-red-400 hover:text-white"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </motion.div>
            )}

            <StakingStats
              walletBalanceRaw={walletBalanceRaw}
              stakedBalanceRaw={stakedBalanceRaw}
              earnedRewardsRaw={earnedRewardsRaw}
              rewardPoolBalanceRaw={rewardPoolBalanceRaw}
              currentAPRPercent={currentAPRPercent}
              decimals={decimals}
              loading={loading}
            />

            <LiveRewardCounter liveEarnedRewardsRaw={liveEarnedRewardsRaw} decimals={decimals} loading={loading} />

            <StakingCard
              walletBalanceRaw={walletBalanceRaw}
              stakedBalanceRaw={stakedBalanceRaw}
              earnedRewardsRaw={earnedRewardsRaw}
              decimals={decimals}
              isPoolPaused={isPoolPaused}
              isWrongNetwork={isWrongNetwork}
              loading={loading}
              claimState={claimState}
              onOpenStake={() => isConnected && setStakeModalOpen(true)}
              onOpenUnstake={() => isConnected && setUnstakeModalOpen(true)}
              onOpenExit={() => isConnected && setExitModalOpen(true)}
              onClaim={() => isConnected && claimRewards()}
              onSwitchNetwork={switchToBase}
            />

            <div className="flex items-center justify-between rounded-2xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-xs text-muted">
              <span>Total staked pool-wide</span>
              <span className="font-semibold text-white">{formatTokenBalance(totalStakedRaw, decimals)} MPGR</span>
            </div>

            <SectionHeader title="Analytics" subtitle="Pool and wallet analytics, read straight from the deployed contract" />
            <StakingAnalyticsCards
              totalRewardsClaimedRaw={totalRewardsClaimedRaw}
              stakedBalanceRaw={stakedBalanceRaw}
              currentAPRPercent={currentAPRPercent}
              rewardPoolBalanceRaw={rewardPoolBalanceRaw}
              totalStakedRaw={totalStakedRaw}
              decimals={decimals}
              loading={loading}
              historyLoading={historyLoading}
            />

            <SectionHeader title="Recent Activity" subtitle="Stake / Unstake / Claim history for your wallet" />
            <StakingActivityTimeline
              liveActivity={liveActivity}
              historyEvents={historyEvents}
              decimals={decimals}
              isLoading={historyLoading}
              isLoadingMore={historyLoadingMore}
              error={historyError}
              hasMore={historyHasMore}
              onLoadMore={loadMoreHistory}
              onRetry={refreshHistory}
            />
          </motion.div>
        )}
      </main>
    </>
  );
      }
