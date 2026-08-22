"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { motion } from "framer-motion";
import { Copy, Share2, Activity } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { GlassCard } from "@/components/ui/GlassCard";
import { AchievementCard } from "@/components/ui/AchievementCard";
import { ActivityTimeline } from "@/components/ui/ActivityTimeline";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { AddressAvatar } from "@/components/AddressAvatar";
import { PremiumBadge } from "@/components/ui/PremiumBadge";
import { PremiumStatusCard } from "@/components/features/premium/PremiumStatusCard";
import { SeasonProgressCard } from "@/components/features/season-pass/SeasonProgressCard";
import { HolderTierCard } from "@/components/features/holder-tier/HolderTierCard";
import { useXP } from "@/hooks/useXP";
import { usePremium } from "@/hooks/usePremium";
import { useReferralCount } from "@/hooks/useReferralCount";
import { useSeasonPass } from "@/hooks/useSeasonPass";
import { useHolderTier } from "@/lib/useHolderTier";
import { getLevelProgress, getAchievements } from "@/lib/xp-engine";
import { formatAddress, formatCompactNumber } from "@/lib/format";
import { clsx } from "clsx";
import Link from "next/link";

export default function ProfilePage() {
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);
  const { address, isConnected } = useAccount();
  const { record, claim } = useXP();
  const { status: premiumStatus, cosmetics: premiumCosmetics } = usePremium();
  const { status: seasonPassStatus } = useSeasonPass();
  const { status: holderTierStatus } = useHolderTier();
  // Bug fix — persistent referral attribution: this is the real,
  // server-side count (lib/referral/referral-store.ts), tied to the
  // wallet rather than the browser/device.
  const { count: referralCount } = useReferralCount(address);

  useEffect(() => setMounted(true), []);

  const levelInfo = record ? getLevelProgress(record.xp) : null;
  const achievements = record ? getAchievements(record) : [];
  const referralLink = address ? `https://mpgrhub.xyz/?ref=${address}` : "";

  const shareReferralLink = async () => {
    if (!referralLink) return;
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: "MPGR HUB", text: "Join me on MPGR HUB", url: referralLink });
        return;
      } catch {
        // user cancelled share sheet — fall through to copy as a safe fallback
      }
    }
    await navigator.clipboard.writeText(referralLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copyReferralLink = async () => {
    if (!referralLink) return;
    await navigator.clipboard.writeText(referralLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-3xl px-4 py-10">
        {!mounted ? null : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
            {!isConnected && (
              <EmptyState
                icon={Activity}
                title="Connect your wallet"
                description="Connect to view your profile, XP, and achievements."
              />
            )}

            <GlassCard className="flex items-center gap-4 p-6">
              <div className={clsx("shrink-0 rounded-full", premiumCosmetics?.frameClass)}>
                <AddressAvatar address={address ?? ""} size={72} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="truncate text-xl font-semibold text-white">
                    {address ? formatAddress(address, 6) : "Not connected"}
                  </h1>
                  {premiumStatus && <PremiumBadge tier={premiumStatus.tier} size="sm" />}
                </div>
                {levelInfo && (
                  <p className="mt-1 text-sm text-muted">
                    Level {levelInfo.level} · {formatCompactNumber(record?.xp ?? 0)} XP total
                  </p>
                )}
              </div>
            </GlassCard>

            {premiumStatus && <PremiumStatusCard status={premiumStatus} />}

            {holderTierStatus && (
              <div>
                <SectionHeader title="Current Holder Tier" subtitle="Your MPGR Holder Score & tier" />
                <HolderTierCard status={holderTierStatus} />
              </div>
            )}

            {seasonPassStatus && (
              <div>
                <SeasonProgressCard
                  levelProgress={seasonPassStatus.levelProgress}
                  seasonPoints={seasonPassStatus.seasonPoints}
                />
                <Link
                  href="/season-pass"
                  className="mt-3 flex min-h-[40px] w-full items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-xs font-semibold text-white transition-colors duration-200 hover:bg-white/[0.06]"
                >
                  View Season {seasonPassStatus.seasonNumber} Pass
                </Link>
              </div>
            )}

            <GlassCard className="p-5">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium text-white">Referral Link</p>
                <p className="text-xs text-muted">
                  Referrals: <span className="font-semibold text-white">{referralCount ?? 0}</span>
                </p>
              </div>
              <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-background/50 px-3 py-2">
                <span className="flex-1 truncate text-xs text-muted">
                  {referralLink || "Connect wallet to get your referral link"}
                </span>
                <button
                  onClick={copyReferralLink}
                  aria-label="Copy referral link"
                  disabled={!referralLink}
                  className="shrink-0 p-1 text-primary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Copy className="h-4 w-4" />
                </button>
              </div>
              <button
                onClick={shareReferralLink}
                aria-label="Share referral link"
                disabled={!referralLink}
                className="mt-3 flex min-h-[40px] w-full items-center justify-center gap-2 rounded-xl bg-gradient-premium text-sm font-semibold text-white transition-transform active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Share2 className="h-4 w-4" aria-hidden="true" />
                Share
              </button>
              {copied && <p className="mt-2 text-xs text-gold">Copied to clipboard</p>}
            </GlassCard>

            <div>
              <SectionHeader title="Achievements" />
              <div className="grid grid-cols-2 gap-3">
                {achievements.map((achievement) => (
                  <AchievementCard key={achievement.id} achievement={achievement} onClaim={() => claim(achievement.id)} />
                ))}
              </div>
            </div>

            <div>
              <SectionHeader title="Recent Activity" />
              {record && record.history.length > 0 ? (
                <ActivityTimeline entries={record.history} limit={10} />
              ) : (
                <EmptyState icon={Activity} title="No activity yet" description="Your XP history will appear here." />
              )}
            </div>
          </motion.div>
        )}
      </main>
    </>
  );
}
