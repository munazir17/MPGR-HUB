"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { motion } from "framer-motion";
import { Copy, Activity } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { GlassCard } from "@/components/ui/GlassCard";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { AchievementCard } from "@/components/ui/AchievementCard";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { AddressAvatar } from "@/components/AddressAvatar";
import { useXP } from "@/hooks/useXP";
import { getLevelProgress, getAchievements } from "@/lib/xp-engine";
import { formatAddress, formatCompactNumber } from "@/lib/format";

export default function ProfilePage() {
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);
  const { address, isConnected } = useAccount();
  const { record, claim } = useXP();

  useEffect(() => setMounted(true), []);

  const levelInfo = record ? getLevelProgress(record.xp) : null;
  const achievements = record ? getAchievements(record) : [];
  const referralLink = address ? `https://mpgr-hub-1v1x.vercel.app/?ref=${address}` : "";

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
        {!mounted || !isConnected || !address ? (
          <EmptyState
            icon={Activity}
            title="Connect your wallet"
            description="Connect to view your profile, XP, and achievements."
          />
        ) : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
            <GlassCard className="flex items-center gap-4 p-6">
              <AddressAvatar address={address} size={72} />
              <div className="min-w-0">
                <h1 className="truncate text-xl font-semibold text-white">{formatAddress(address, 6)}</h1>
                {levelInfo && (
                  <p className="mt-1 text-sm text-muted">
                    Level {levelInfo.level} · {formatCompactNumber(record?.xp ?? 0)} XP total
                  </p>
                )}
              </div>
            </GlassCard>

            {levelInfo && (
              <GlassCard className="mt-4 p-5">
                <ProgressBar progress={levelInfo.progress} label={`Level ${levelInfo.level} progress`} />
              </GlassCard>
            )}

            <GlassCard className="mt-4 p-5">
              <p className="mb-2 text-sm font-medium text-white">Referral Link</p>
              <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-background/50 px-3 py-2">
                <span className="flex-1 truncate text-xs text-muted">{referralLink}</span>
                <button onClick={copyReferralLink} className="shrink-0 text-primary">
                  <Copy className="h-4 w-4" />
                </button>
              </div>
              {copied && <p className="mt-2 text-xs text-gold">Copied to clipboard</p>}
            </GlassCard>

            <SectionHeader title="Achievements" />
            <div className="grid grid-cols-2 gap-3">
              {achievements.map((achievement) => (
                <AchievementCard key={achievement.id} achievement={achievement} onClaim={() => claim(achievement.id)} />
              ))}
            </div>

            <SectionHeader title="Recent Activity" />
            <div className="space-y-2">
              {record && record.history.length > 0 ? (
                [...record.history]
                  .reverse()
                  .slice(0, 10)
                  .map((entry, i) => (
                    <GlassCard key={i} className="flex items-center justify-between p-3">
                      <span className="text-sm text-white">{entry.action.replace(/_/g, " ")}</span>
                      <span className="text-sm text-gold">+{entry.xp} XP</span>
                    </GlassCard>
                  ))
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
