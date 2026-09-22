"use client";

import { useEffect, useState, useCallback } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { motion } from "framer-motion";
import {
  Copy,
  Share2,
  Activity,
  PiggyBank,
  Vault,
  Trophy,
  Flame,
  Medal,
  Gamepad2,
  Wallet,
  Shield,
  Settings,
  LifeBuoy,
  LogOut,
  ChevronRight,
  BookOpen,
} from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { PageContainer } from "@/components/layout/PageContainer";
import { GlassCard } from "@/components/ui/GlassCard";
import { AchievementCard } from "@/components/ui/AchievementCard";
import { ActivityTimeline } from "@/components/ui/ActivityTimeline";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { AddressAvatar } from "@/components/AddressAvatar";
import { SeasonProgressCard } from "@/components/features/season-pass/SeasonProgressCard";
import { HolderTierCard } from "@/components/features/holder-tier/HolderTierCard";
import { useXP } from "@/hooks/useXP";
import { useReferralCount } from "@/hooks/useReferralCount";
import { useSeasonPass } from "@/hooks/useSeasonPass";
import { useWalletAuth } from "@/hooks/useWalletAuth";
import { useHolderTier } from "@/lib/useHolderTier";
import { getLevelProgress, getAchievements } from "@/lib/xp-engine";
import { formatAddress, formatCompactNumber } from "@/lib/format";
import Link from "next/link";

const ECOSYSTEM_LINKS = [
  { href: "/staking", label: "Staking", icon: PiggyBank },
  { href: "/app/token-lock", label: "Token Lock", icon: Vault },
  { href: "/season", label: "Season", icon: Flame },
  { href: "/season-pass", label: "Season Pass", icon: Trophy },
  { href: "/leaderboard", label: "Leaderboard", icon: Medal },
  { href: "/games/mpgr-run", label: "MPGR Run", icon: Gamepad2 },
];

export default function ProfilePage() {
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);
  const [checkInMessage, setCheckInMessage] = useState<string | null>(null);
  const { address, isConnected, chain } = useAccount();
  const { disconnect } = useDisconnect();
  const { authenticated, authenticating, authenticate } = useWalletAuth();
  const { record, claim, checkIn } = useXP();
  const { status: seasonPassStatus } = useSeasonPass();
  const { status: holderTierStatus } = useHolderTier();
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
        // user cancelled share sheet
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

  const handleCheckIn = useCallback(() => {
    const result = checkIn();
    if (!result) return;
    setCheckInMessage(
      result.alreadyCheckedIn
        ? "Already checked in today"
        : `+${result.xpGained} XP — streak: ${result.record.streak} days`
    );
    setTimeout(() => setCheckInMessage(null), 3000);
  }, [checkIn]);

  const handleSignOut = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      // cookie clear is best-effort
    }
    disconnect();
  }, [disconnect]);

  return (
    <>
      <Navbar />
      <PageContainer>
        {!mounted ? null : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
            <div>
              <p className="eyebrow">Account</p>
              <h1 className="display-l mt-3 text-[28px] text-white md:text-4xl md:leading-[44px]">Profile</h1>
              <p className="mt-2 text-sm text-muted md:text-[15px]">Your account and preferences.</p>
            </div>

            {!isConnected && (
              <EmptyState
                icon={Activity}
                title="Connect your wallet"
                description="Connect to view your profile, XP, and achievements."
              />
            )}

            {/* Desktop: two balanced columns (identity/rewards left,
                account/ecosystem right). Mobile: natural stacking. */}
            <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
              <div className="space-y-6">
                <GlassCard className="p-5">
                  <div className="flex min-h-[72px] items-center gap-4">
                    <AddressAvatar address={address ?? ""} size={64} />
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate font-mono text-lg font-semibold text-white">
                        {address ? formatAddress(address, 6) : "Not connected"}
                      </h2>
                      <p className="mt-0.5 text-xs text-muted">
                        {isConnected ? "Wallet connected on Base" : "Connect from the header"}
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2">
                    <div className="min-w-0 rounded-xl border border-white/[0.06] bg-background/40 px-3 py-3 text-center">
                      <p className="text-[10px] uppercase tracking-wider text-muted">Level</p>
                      <p className="mt-1 truncate text-lg font-semibold text-white">{levelInfo?.level ?? 1}</p>
                    </div>
                    <div className="min-w-0 rounded-xl border border-white/[0.06] bg-background/40 px-3 py-3 text-center">
                      <p className="text-[10px] uppercase tracking-wider text-muted">Total XP</p>
                      <p className="mt-1 truncate text-lg font-semibold text-white">{formatCompactNumber(record?.xp ?? 0)}</p>
                    </div>
                    <div className="min-w-0 rounded-xl border border-white/[0.06] bg-background/40 px-3 py-3 text-center">
                      <p className="text-[10px] uppercase tracking-wider text-muted">Streak</p>
                      <p className="mt-1 truncate text-lg font-semibold text-white">{record?.streak ?? 0}d</p>
                    </div>
                  </div>
                </GlassCard>

                <GlassCard className="p-5">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-sm font-medium text-white">Referral</p>
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
                    className="mt-3 flex min-h-[40px] w-full items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-background disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Share2 className="h-4 w-4" aria-hidden="true" />
                    Share
                  </button>
                  {copied && <p className="mt-2 text-xs text-gold">Copied to clipboard</p>}
                </GlassCard>

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
                      className="mt-3 flex min-h-[40px] w-full items-center justify-center rounded-xl border border-white/10 bg-surface text-xs font-semibold text-white hover:bg-surface-2"
                    >
                      View Season {seasonPassStatus.seasonNumber} Pass
                    </Link>
                  </div>
                )}
              </div>

              <div className="space-y-6">
                <GlassCard className="divide-y divide-white/[0.06] overflow-hidden p-0">
              <div className="flex items-start gap-3 p-4">
                <Wallet className="mt-0.5 h-4 w-4 text-primary" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white">Wallet & Accounts</p>
                  <p className="mt-1 truncate font-mono text-xs text-muted">{address ?? "Not connected"}</p>
                  <p className="mt-1 text-xs text-muted">
                    Network: {chain?.name ?? "Base"} · chain ID {chain?.id ?? 8453}
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 p-4">
                <Shield className="mt-0.5 h-4 w-4 text-primary" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white">Security</p>
                  <p className="mt-1 text-xs text-muted">
                    {authenticated ? "SIWE session active" : isConnected ? "No active session" : "Wallet required"}
                  </p>
                  {isConnected && !authenticated && (
                    <button
                      type="button"
                      onClick={() => void authenticate()}
                      disabled={authenticating}
                      className="mt-3 flex min-h-[40px] w-full items-center justify-center rounded-xl border border-white/10 bg-background/40 text-sm font-semibold text-white hover:bg-surface-2 disabled:opacity-50"
                    >
                      {authenticating ? "Waiting for signature…" : "Sign in with wallet"}
                    </button>
                  )}
                </div>
              </div>

              <div className="flex items-start gap-3 p-4">
                <Settings className="mt-0.5 h-4 w-4 text-primary" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white">Preferences</p>
                  <p className="mt-1 text-xs text-muted">
                    Base mainnet only. Daily check-in keeps your XP streak.
                  </p>
                  <button
                    type="button"
                    onClick={handleCheckIn}
                    disabled={!isConnected}
                    className="mt-3 flex min-h-[40px] w-full items-center justify-center rounded-xl bg-primary text-sm font-semibold text-background disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Daily Check-In
                  </button>
                  {checkInMessage && <p className="mt-2 text-xs text-gold">{checkInMessage}</p>}
                </div>
              </div>

              <Link href="#activity" className="flex items-center gap-3 p-4 hover:bg-white/[0.02]">
                <Activity className="h-4 w-4 text-primary" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white">Your Activity</p>
                  <p className="mt-0.5 text-xs text-muted">Trades, games, rewards, history</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted" aria-hidden="true" />
              </Link>

              <Link href="/support" className="flex items-center gap-3 p-4 hover:bg-white/[0.02]">
                <LifeBuoy className="h-4 w-4 text-primary" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white">Help & Support</p>
                  <p className="mt-0.5 text-xs text-muted">FAQs and contact</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted" aria-hidden="true" />
              </Link>

              <Link href="/docs" className="flex items-center gap-3 p-4 hover:bg-white/[0.02]">
                <BookOpen className="h-4 w-4 text-primary" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white">Docs</p>
                  <p className="mt-0.5 text-xs text-muted">How MPGR HUB works</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted" aria-hidden="true" />
              </Link>
            </GlassCard>

            <div>
              <SectionHeader title="Ecosystem" subtitle="Staking, locks, seasons, and more" />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {ECOSYSTEM_LINKS.map((link) => {
                  const Icon = link.icon;
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      className="flex min-h-[44px] items-center gap-2 rounded-xl border border-white/[0.07] bg-surface px-3.5 py-3 text-sm font-medium text-white transition-colors hover:bg-surface-2"
                    >
                      <Icon className="h-4 w-4 text-muted" aria-hidden="true" />
                      {link.label}
                    </Link>
                  );
                })}
              </div>
            </div>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
              <div>
                <SectionHeader title="Achievements" />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {achievements.map((achievement) => (
                    <AchievementCard key={achievement.id} achievement={achievement} onClaim={() => claim(achievement.id)} />
                  ))}
                </div>
              </div>

              <div id="activity">
                <SectionHeader title="Activity" subtitle="Recent XP history" />
                {record && record.history.length > 0 ? (
                  <ActivityTimeline entries={record.history} limit={10} />
                ) : (
                  <EmptyState icon={Activity} title="No activity yet" description="Your XP history will appear here." />
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => void handleSignOut()}
              disabled={!isConnected}
              className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl border border-red-400/20 bg-red-500/10 text-sm font-semibold text-red-300 hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-40 lg:mx-auto lg:max-w-md"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              Sign Out
            </button>
          </motion.div>
        )}
      </PageContainer>
    </>
  );
}
