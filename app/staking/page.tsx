"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { AnimatePresence, motion } from "framer-motion";
import { Lock, History, ArrowUpCircle, ArrowDownCircle, Coins, X, AlertCircle } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { GlassCard } from "@/components/ui/GlassCard";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonCard } from "@/components/ui/SkeletonCard";
import { FloatingXP } from "@/components/ui/FloatingXP";
import { StakingStats } from "@/components/ui/StakingStats";
import { StakingCard } from "@/components/ui/StakingCard";
import { StakingPositionCard } from "@/components/ui/StakingPositionCard";
import { StakeModal } from "@/components/ui/StakeModal";
import { UnstakeModal } from "@/components/ui/UnstakeModal";
import { useStaking } from "@/hooks/useStaking";
import { formatCompactNumber, formatRelativeTime } from "@/lib/format";
import type { StakingPositionView, StakingTransaction } from "@/lib/staking-engine";

const TX_LABEL: Record<StakingTransaction["type"], string> = {
  stake: "Staked",
  unstake: "Unstaked",
  claim: "Claimed reward",
};

const TX_ICON: Record<StakingTransaction["type"], typeof ArrowUpCircle> = {
  stake: ArrowUpCircle,
  unstake: ArrowDownCircle,
  claim: Coins,
};

export default function StakingPage() {
  const [mounted, setMounted] = useState(false);
  const { isConnected } = useAccount();
  const {
    lockOptions,
    estimateRewards,
    positions,
    transactions,
    availableBalance,
    totalStaked,
    totalClaimableRewards,
    activePositionsCount,
    error,
    lastEvent,
    stake,
    claimReward,
    unstake,
    dismissError,
    dismissEvent,
    loading,
  } = useStaking();

  const [stakeModalOpen, setStakeModalOpen] = useState(false);
  const [unstakeTarget, setUnstakeTarget] = useState<StakingPositionView | null>(null);

  useEffect(() => setMounted(true), []);

  const successSignal = lastEvent?.id ?? null;
  const activePositions = positions.filter((p) => p.status !== "unstaked");
  const historicalPositions = positions.filter((p) => p.status === "unstaked");

  return (
    <>
      <Navbar />
      <FloatingXP amount={lastEvent?.amount ?? null} onComplete={dismissEvent} unit="MPGR" />

      <StakeModal
        open={stakeModalOpen}
        onClose={() => setStakeModalOpen(false)}
        availableBalance={availableBalance}
        lockOptions={lockOptions}
        estimateRewards={estimateRewards}
        onConfirm={(amount, lockDurationDays) => stake(amount, lockDurationDays)}
        error={error}
        successSignal={successSignal}
      />

      <UnstakeModal
        open={unstakeTarget !== null}
        onClose={() => setUnstakeTarget(null)}
        position={unstakeTarget}
        onConfirm={(positionId) => unstake(positionId)}
        error={error}
        successSignal={successSignal}
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
              subtitle="Lock claimed MPGR to earn yield — the longer the term, the higher the APY"
            />

            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                >
                  <div className="flex items-center justify-between gap-3 rounded-2xl border border-red-500/20 bg-red-500/10 p-3.5 backdrop-blur-xl">
                    <span className="flex items-center gap-2 text-xs text-red-400">
                      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {error}
                    </span>
                    <button
                      onClick={dismissError}
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
              availableBalance={availableBalance}
              totalStaked={totalStaked}
              totalClaimableRewards={totalClaimableRewards}
              activePositionsCount={activePositionsCount}
              loading={loading}
            />

            <StakingCard
              availableBalance={availableBalance}
              lockOptions={lockOptions}
              onStake={() => setStakeModalOpen(true)}
              loading={loading}
            />

            <SectionHeader title="Active Positions" />
            {loading ? (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <SkeletonCard lines={3} />
                <SkeletonCard lines={3} />
                <SkeletonCard lines={3} />
              </div>
            ) : activePositions.length === 0 ? (
              <EmptyState
                icon={Lock}
                title="No active stakes"
                description="Stake your claimed MPGR to start earning rewards."
                ctaLabel={availableBalance > 0 ? "Stake MPGR" : undefined}
                onCta={availableBalance > 0 ? () => setStakeModalOpen(true) : undefined}
              />
            ) : (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                {activePositions.map((position) => (
                  <StakingPositionCard
                    key={position.id}
                    position={position}
                    onClaim={() => claimReward(position.id)}
                    onUnstake={() => setUnstakeTarget(position)}
                  />
                ))}
              </div>
            )}

            {historicalPositions.length > 0 && (
              <>
                <SectionHeader title="Past Positions" />
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                  {historicalPositions.map((position) => (
                    <StakingPositionCard
                      key={position.id}
                      position={position}
                      onClaim={() => claimReward(position.id)}
                      onUnstake={() => setUnstakeTarget(position)}
                    />
                  ))}
                </div>
              </>
            )}

            <SectionHeader title="Transaction History" />
            {loading ? (
              <SkeletonCard lines={3} />
            ) : transactions.length === 0 ? (
              <EmptyState
                icon={History}
                title="No transactions yet"
                description="Your stake, claim, and unstake activity will show up here."
              />
            ) : (
              <div className="space-y-2">
                {transactions.slice(0, 12).map((tx, i) => {
                  const Icon = TX_ICON[tx.type];
                  return (
                    <motion.div
                      key={tx.id}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: Math.min(i, 8) * 0.03 }}
                    >
                      <GlassCard className="flex items-center gap-3 p-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
                          <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-white">{TX_LABEL[tx.type]}</p>
                          <p className="text-[11px] text-muted">{formatRelativeTime(tx.timestamp)}</p>
                        </div>
                        <span className="shrink-0 text-sm font-semibold text-gold">
                          {tx.type === "stake" ? "-" : "+"}
                          {formatCompactNumber(tx.amount)} MPGR
                        </span>
                      </GlassCard>
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
