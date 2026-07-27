"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { motion } from "framer-motion";
import { Vault, History } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { GlassCard } from "@/components/ui/GlassCard";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonCard } from "@/components/ui/SkeletonCard";
import { FloatingXP } from "@/components/ui/FloatingXP";
import { CountdownCard } from "@/components/ui/CountdownCard";
import { LockStats } from "@/components/features/token-lock/LockStats";
import { LockSummaryCards } from "@/components/features/token-lock/LockSummaryCards";
import { CreateLockCard } from "@/components/features/token-lock/CreateLockCard";
import { LockCard } from "@/components/features/token-lock/LockCard";
import { EarlyUnlockModal } from "@/components/features/token-lock/EarlyUnlockModal";
import { LockHistoryTimeline } from "@/components/features/token-lock/LockHistoryTimeline";
import { useTokenLock } from "@/hooks/useTokenLock";
import type { TokenLockPositionView } from "@/lib/token-lock-engine";

export default function TokenLockPage() {
  const [mounted, setMounted] = useState(false);
  const { isConnected } = useAccount();
  const {
    lockDurationOptions,
    earlyUnlockPenaltyPercent,
    estimateLockBonus,
    positions,
    availableBalance,
    totalLocked,
    activeLocksCount,
    unlockingSoonCount,
    averageLockPeriodDays,
    longestLockDays,
    upcomingUnlockAt,
    lifetimeBonusEarned,
    locksReleasedCount,
    earlyUnlocksCount,
    lastEvent,
    createLock,
    releaseLock,
    earlyUnlock,
    dismissEvent,
    loading,
  } = useTokenLock();

  const [earlyUnlockTarget, setEarlyUnlockTarget] = useState<TokenLockPositionView | null>(null);

  useEffect(() => setMounted(true), []);

  const activePositions = positions.filter((p) => p.status !== "released");
  const releasedPositions = positions.filter((p) => p.status === "released");

  return (
    <>
      <Navbar />
      <FloatingXP amount={lastEvent?.amount ?? null} onComplete={dismissEvent} unit="MPGR" />

      <EarlyUnlockModal
        open={earlyUnlockTarget !== null}
        onClose={() => setEarlyUnlockTarget(null)}
        position={earlyUnlockTarget}
        penaltyPercent={earlyUnlockPenaltyPercent}
        onConfirm={(lockId) => earlyUnlock(lockId)}
      />

      <main className="mx-auto max-w-6xl px-4 py-8 sm:py-12">
        {!mounted || !isConnected ? (
          <EmptyState
            icon={Vault}
            title="Connect your wallet"
            description="Connect to lock MPGR and earn a maturity bonus."
          />
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-10 sm:space-y-12"
          >
            {/* Hero */}
            <div className="relative overflow-hidden rounded-3xl border border-white/[0.08] bg-white/[0.03] p-5 backdrop-blur-xl shadow-glow sm:p-7">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -left-16 -top-20 h-64 w-64 rounded-full bg-gradient-premium opacity-20 blur-3xl"
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -bottom-24 -right-16 h-56 w-56 rounded-full bg-gradient-gold opacity-10 blur-3xl"
              />

              <div className="relative flex items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-premium shadow-glow-gold">
                  <Vault className="h-5 w-5 text-white" aria-hidden="true" />
                </div>
                <div>
                  <h1 className="text-xl font-bold tracking-tight text-white sm:text-2xl">Token Lock</h1>
                  <p className="text-sm text-muted">
                    Lock claimed MPGR for a fixed term to earn a maturity bonus at unlock.
                  </p>
                </div>
              </div>

              <div className="relative mt-6">
                <LockStats
                  totalLocked={totalLocked}
                  activeLocksCount={activeLocksCount}
                  unlockingSoonCount={unlockingSoonCount}
                  averageLockPeriodDays={averageLockPeriodDays}
                  loading={loading}
                />
              </div>
            </div>

            {/* Create Lock + Next Unlock countdown */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <SectionHeader title="Create Lock" subtitle="Choose a term and lock in your bonus rate" />
                <CreateLockCard
                  availableBalance={availableBalance}
                  lockDurationOptions={lockDurationOptions}
                  estimateLockBonus={estimateLockBonus}
                  onCreateLock={createLock}
                  loading={loading}
                />
              </div>
              <div>
                <SectionHeader title="Next Unlock" subtitle="Countdown to your soonest lock maturity" />
                {upcomingUnlockAt ? (
                  <CountdownCard target={new Date(upcomingUnlockAt)} label="Time until unlock" />
                ) : (
                  <GlassCard className="flex h-full flex-col items-center justify-center p-5 text-center">
                    <p className="text-sm font-medium text-white">No upcoming unlocks</p>
                    <p className="mt-1 text-xs text-muted">Create a lock to start a countdown here.</p>
                  </GlassCard>
                )}
              </div>
            </div>

            {/* Active Locks */}
            <div>
              <SectionHeader title="Active Locks" subtitle="Your current fixed-term MPGR locks" />
              {loading ? (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                  <SkeletonCard lines={3} />
                  <SkeletonCard lines={3} />
                  <SkeletonCard lines={3} />
                </div>
              ) : activePositions.length === 0 ? (
                <EmptyState
                  icon={Vault}
                  title="No active locks"
                  description="Create your first lock above to start earning a maturity bonus."
                />
              ) : (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                  {activePositions.map((position) => (
                    <LockCard
                      key={position.id}
                      position={position}
                      onRelease={() => releaseLock(position.id)}
                      onEarlyUnlock={() => setEarlyUnlockTarget(position)}
                    />
                  ))}
                </div>
              )}
            </div>

            {releasedPositions.length > 0 && (
              <div>
                <SectionHeader title="Past Locks" />
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                  {releasedPositions.map((position) => (
                    <LockCard
                      key={position.id}
                      position={position}
                      onRelease={() => releaseLock(position.id)}
                      onEarlyUnlock={() => setEarlyUnlockTarget(position)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Summary Cards */}
            <div>
              <SectionHeader title="Lock Summary" subtitle="Your lifetime locking activity" />
              <LockSummaryCards
                lifetimeBonusEarned={lifetimeBonusEarned}
                locksReleasedCount={locksReleasedCount}
                earlyUnlocksCount={earlyUnlocksCount}
                longestLockDays={longestLockDays}
                loading={loading}
              />
            </div>

            {/* Lock History */}
            <div>
              <SectionHeader title="Lock History" subtitle="Newest first" />
              {loading ? (
                <SkeletonCard lines={3} />
              ) : positions.length === 0 ? (
                <EmptyState
                  icon={History}
                  title="No lock history yet"
                  description="Your lock, release, and early-unlock activity will show up here."
                />
              ) : (
                <LockHistoryTimeline positions={positions} />
              )}
            </div>
          </motion.div>
        )}
      </main>
    </>
  );
}
