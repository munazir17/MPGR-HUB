"use client";

// Profile Page v1.1 - Updated for Production

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { motion } from "framer-motion";
import { Copy } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { GlassCard } from "@/components/ui/GlassCard";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { AddressAvatar } from "@/components/AddressAvatar";
import { useXP } from "@/hooks/useXP";
import { getLevelProgress, getAchievements } from "@/lib/xp-engine";
import { formatAddress } from "@/lib/format";

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://mpgr-hub-zeta.vercel.app";

export default function ProfilePage() {
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);

  const { address, isConnected } = useAccount();
  const { record } = useXP();

  useEffect(() => {
    setMounted(true);
  }, []);

  const levelInfo = record ? getLevelProgress(record.xp) : null;
  const achievements = record ? getAchievements(record) : [];

  const referralLink = address
    ? `${APP_URL}/?ref=${address}`
    : "";

  const copyReferralLink = async () => {
    if (!referralLink) return;

    await navigator.clipboard.writeText(referralLink);

    setCopied(true);

    setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  return (
    <>
      <Navbar />

      <main className="mx-auto max-w-3xl px-4 py-10">

        {!mounted || !isConnected || !address ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-10 text-center text-muted">
            Connect your wallet to view your profile.
          </div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
          >

            <GlassCard className="flex items-center gap-4 p-6">

              <AddressAvatar
                address={address}
                size={72}
              />

              <div>

                <h1 className="text-xl font-semibold text-white">
                  {formatAddress(address, 6)}
                </h1>

                {levelInfo && (
                  <p className="mt-1 text-sm text-muted">
                    Level {levelInfo.level} · {record?.xp ?? 0} XP Total
                  </p>
                )}

              </div>

            </GlassCard>

            {levelInfo && (
              <GlassCard className="mt-4 p-5">

                <ProgressBar
                  progress={levelInfo.progress}
                  label={`Level ${levelInfo.level} Progress`}
                />

              </GlassCard>
            )}

            <GlassCard className="mt-4 p-5">

              <p className="mb-2 text-sm font-medium text-white">
                Referral Link
              </p>

              <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-background/50 px-3 py-2">

                <span className="flex-1 truncate text-xs text-muted">
                  {referralLink}
                </span>

                <button
                  onClick={copyReferralLink}
                  className="text-primary"
                >
                  <Copy className="h-4 w-4" />
                </button>

              </div>

              {copied && (
                <p className="mt-2 text-xs text-gold">
                  Copied to clipboard
                </p>
              )}

            </GlassCard>

            <h2 className="mt-6 mb-3 text-sm font-medium text-white">
              Achievements
            </h2>

            <div className="grid grid-cols-2 gap-3">

              {achievements.map((achievement) => (

                <GlassCard
                  key={achievement.id}
                  className={`p-4 ${
                    achievement.unlocked ? "" : "opacity-40"
                  }`}
                >

                  <p className="text-sm font-medium text-white">
                    {achievement.label}
                  </p>

                  <p className="mt-1 text-xs text-muted">
                    {achievement.description}
                  </p>

                </GlassCard>

              ))}

            </div>

            <h2 className="mt-6 mb-3 text-sm font-medium text-white">
              Recent Activity
            </h2>

            <div className="space-y-2">

              {record && record.history.length > 0 ? (

                [...record.history]
                  .reverse()
                  .slice(0, 10)
                  .map((entry, i) => (

                    <GlassCard
                      key={i}
                      className="flex items-center justify-between p-3"
                    >

                      <span className="text-sm text-white">
                        {entry.action.replace(/_/g, " ")}
                      </span>

                      <span className="text-sm text-gold">
                        +{entry.xp} XP
                      </span>

                    </GlassCard>

                  ))

              ) : (

                <p className="text-sm text-muted">
                  No activity yet.
                </p>

              )}

            </div>

          </motion.div>
        )}

      </main>
    </>
  );
}
