"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { AnimatePresence, motion } from "framer-motion";
import { Lock, Activity, ArrowUpCircle, ArrowDownCircle, Coins, X, AlertCircle } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { GlassCard } from "@/components/ui/GlassCard";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { FloatingXP } from "@/components/ui/FloatingXP";
import { StakingStats } from "@/components/ui/StakingStats";
import { StakingCard } from "@/components/ui/StakingCard";
import { StakeModal } from "@/components/ui/StakeModal";
import { UnstakeModal } from "@/components/ui/UnstakeModal";
import { ExitModal } from "@/components/ui/ExitModal";
import { useStaking } from "@/hooks/useStaking";
import { formatTokenBalance, formatRelativeTime } from "@/lib/format";
import type { StakingLiveActivityEntry } from "@/lib/staking/staking-types";

// Phase 3E Part 3 — Live Staking & Rewards.
//
// Rebuilt against the deployed MPGRStaking contract: one continuous
// staked balance and one earned-reward amount per wallet, a single global
// APR, and no lock terms — so there's no "positions" grid or lock
// countdown UI anymore. "Live Activity" below replaces the old local
// "Transaction History": it shows only Staked/Unstaked/RewardPaid events
// actually observed live via useWatchContractEvent while this page has
// been open this session — never a fabricated or backfilled history,
// since this app has no indexer for the staking contract.

const ACTIVITY_LABEL: Record<StakingLiveActivityEntry["kind"], string> = {
  Staked: "Staked",
  Unstaked: "Unstaked",
  RewardPaid: "Claimed reward",
};

const ACTIVITY_ICON: Record<StakingLiveActivityEntry["kind"], typeof ArrowUpCircle> = {
  Staked: ArrowUpCircle,
  Unstaked: ArrowDownCircle,
  RewardPaid: Coins,
};

export default function StakingPage() {
  const [mounted, setMounted] = useState(false);
  const { isConnected } = useAccount();
  const {
    walletBalanceRaw,
    stakedBalanceRaw,
    earnedRewardsRaw,
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
        {!mounted || !isConnected ? (
          <EmptyState
            icon={Lock}
            title="Connect your wallet"
            description="Connect to stake MPGR and start earning rewards."
          />
        ) : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
            <SectionHeader
              title="MPGR Staking"
              subtitle="Stake MPGR to earn yield — claim or unstake any time, no lock period"
            />

            <AnimatePresence>
              {readError && !dismissedError && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                >
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
            </AnimatePresence>

            <StakingStats
              walletBalanceRaw={walletBalanceRaw}
              stakedBalanceRaw={stakedBalanceRaw}
              earnedRewardsRaw={earnedRewardsRaw}
              rewardPoolBalanceRaw={rewardPoolBalanceRaw}
              currentAPRPercent={currentAPRPercent}
              decimals={decimals}
              loading={loading}
            />

            <StakingCard
              walletBalanceRaw={walletBalanceRaw}
              stakedBalanceRaw={stakedBalanceRaw}
              earnedRewardsRaw={earnedRewardsRaw}
              decimals={decimals}
              isPoolPaused={isPoolPaused}
              isWrongNetwork={isWrongNetwork}
              loading={loading}
              claimState={claimState}
              onOpenStake={() => setStakeModalOpen(true)}
              onOpenUnstake={() => setUnstakeModalOpen(true)}
              onOpenExit={() => setExitModalOpen(true)}
              onClaim={claimRewards}
              onSwitchNetwork={switchToBase}
            />

            <div className="flex items-center justify-between rounded-2xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-xs text-muted">
              <span>Total staked pool-wide</span>
              <span className="font-semibold text-white">
                {formatTokenBalance(totalStakedRaw, decimals)} MPGR
              </span>
            </div>

            <SectionHeader title="Live Activity" subtitle="Staked / Unstaked / Claimed events for your wallet, observed live" />
            {liveActivity.length === 0 ? (
              <EmptyState
                icon={Activity}
                title="No activity yet this session"
                description="Stake, unstake, or claim rewards and it will show up here in real time."
              />
            ) : (
              <div className="space-y-2">
                {liveActivity.map((entry, i) => {
                  const Icon = ACTIVITY_ICON[entry.kind];
                  return (
                    <motion.div
                      key={entry.id}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: Math.min(i, 8) * 0.03 }}
                    >
                      <a
                        href={`https://basescan.org/tx/${entry.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block"
                      >
                        <GlassCard className="flex items-center gap-3 p-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
                            <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm text-white">{ACTIVITY_LABEL[entry.kind]}</p>
                            <p className="text-[11px] text-muted">{formatRelativeTime(entry.observedAt)}</p>
                          </div>
                          <span className="shrink-0 text-sm font-semibold text-gold">
                            {entry.kind === "Staked" ? "-" : "+"}
                            {formatTokenBalance(entry.amount, decimals)} MPGR
                          </span>
                        </GlassCard>
                      </a>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </motion.div>
        )}
      </main>
    </>
  );
}
