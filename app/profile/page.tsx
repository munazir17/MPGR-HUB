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
} from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { GlassCard } from "@/components/ui/GlassCard";
import { AchievementCard } from "@/components/ui/AchievementCard";
import { ActivityTimeline } from "@/components/ui/ActivityTimeline";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { AddressAvatar } from "@/components/AddressAvatar";
import { CommunitySocialLinks } from "@/components/ui/CommunitySocialLinks";
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
  { href: "/games", label: "Games", icon: Gamepad2 },
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
      // cookie clear is best-effort — still disconnect the wallet
    }
    disconnect();
  }, [disconnect]);

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-3xl px-4 py-10">
        {!mounted ? null : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-8">
            {!isConnected && (
              <EmptyState
                icon={Activity}
                title="Connect your wallet"
                description="Connect to view your profile, XP, and achievements."
              />
            )}

            <section>
              <SectionHeader title="Profile" subtitle="Your identity on MPGR HUB" />
              <GlassCard className="flex items-center gap-4 p-6">
                <div className="shrink-0 rounded-full">
                  <AddressAvatar address={address ?? ""} size={72} />
                </div>
                <div className="min-w-0">
                  <h1 className="truncate text-xl font-semibold text-white">
                    {address ? formatAddress(address, 6) : "Not connected"}
                  </h1>
                  {levelInfo && (
                    <p className="mt-1 text-sm text-muted">
                      Level {levelInfo.level} · {formatCompactNumber(record?.xp ?? 0)} XP total
                      {record ? ` · ${record.streak} day streak` : ""}
                    </p>
                  )}
                </div>
              </GlassCard>
            </section>

            <section>
              <SectionHeader title="Wallet & Accounts" subtitle="Connected wallet on Base" />
              <GlassCard className="space-y-3 p-5">
                <div className="flex items-start gap-3">
                  <Wallet className="mt-0.5 h-4 w-4 text-muted" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-white">
                      {isConnected ? "Wallet connected" : "No wallet connected"}
                    </p>
                    <p className="mt-1 truncate font-mono text-xs text-muted">
                      {address ?? "Connect from the header to manage your account."}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      Network: {chain?.name ?? "Base"} · chain ID {chain?.id ?? 8453}
                    </p>
                  </div>
                </div>
              </GlassCard>
            </section>

            <section>
              <SectionHeader title="Social connections" subtitle="Community and referral" />
              <CommunitySocialLinks />
              <GlassCard className="mt-3 p-5">
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
                  className="mt-3 flex min-h-[40px] w-full items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-white transition-transform active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Share2 className="h-4 w-4" aria-hidden="true" />
                  Share
                </button>
                {copied && <p className="mt-2 text-xs text-gold">Copied to clipboard</p>}
              </GlassCard>
            </section>

            <section>
              <SectionHeader title="Security & sessions" subtitle="Sign-in with Ethereum session" />
              <GlassCard className="space-y-3 p-5">
                <div className="flex items-start gap-3">
                  <Shield className="mt-0.5 h-4 w-4 text-muted" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-white">
                      {authenticated ? "Session active" : isConnected ? "No active session" : "Wallet required"}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-muted">
                      Protected actions use a server-verified SIWE session. Nothing is signed without your wallet prompt.
                    </p>
                  </div>
                </div>
                {isConnected && !authenticated && (
                  <button
                    type="button"
                    onClick={() => void authenticate()}
                    disabled={authenticating}
                    className="flex min-h-[40px] w-full items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-sm font-semibold text-white hover:bg-white/[0.06] disabled:opacity-50"
                  >
                    {authenticating ? "Waiting for signature…" : "Sign in with wallet"}
                  </button>
                )}
              </GlassCard>
            </section>

            <section>
              <SectionHeader title="Preferences" subtitle="Daily loop and network defaults" />
              <GlassCard className="space-y-3 p-5">
                <div className="flex items-start gap-3">
                  <Settings className="mt-0.5 h-4 w-4 text-muted" aria-hidden="true" />
                  <p className="text-xs leading-relaxed text-muted">
                    MPGR HUB runs on Base mainnet only. Daily check-in is the existing XP streak — no extra preference store.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleCheckIn}
                  disabled={!isConnected}
                  className="flex min-h-[40px] w-full items-center justify-center rounded-xl bg-primary text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Daily Check-In
                </button>
                {checkInMessage && <p className="text-xs text-gold">{checkInMessage}</p>}
              </GlassCard>
            </section>

            <div>
              <SectionHeader title="Ecosystem" subtitle="Staking, locks, seasons, and more" />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {ECOSYSTEM_LINKS.map((link) => {
                  const Icon = link.icon;
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      className="flex min-h-[44px] items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3 text-sm font-medium text-white transition-colors hover:bg-white/[0.06]"
                    >
                      <Icon className="h-4 w-4 text-muted" aria-hidden="true" />
                      {link.label}
                    </Link>
                  );
                })}
              </div>
            </div>

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

            <div>
              <SectionHeader title="Achievements" />
              <div className="grid grid-cols-2 gap-3">
                {achievements.map((achievement) => (
                  <AchievementCard key={achievement.id} achievement={achievement} onClaim={() => claim(achievement.id)} />
                ))}
              </div>
            </div>

            <div>
              <SectionHeader title="Activity" subtitle="Recent XP history" />
              {record && record.history.length > 0 ? (
                <ActivityTimeline entries={record.history} limit={10} />
              ) : (
                <EmptyState icon={Activity} title="No activity yet" description="Your XP history will appear here." />
              )}
            </div>

            <section>
              <SectionHeader title="Help & Support" />
              <div className="grid grid-cols-2 gap-3">
                <Link
                  href="/support"
                  className="flex min-h-[44px] items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3 text-sm font-medium text-white hover:bg-white/[0.06]"
                >
                  <LifeBuoy className="h-4 w-4 text-muted" aria-hidden="true" />
                  Support
                </Link>
                <Link
                  href="/docs"
                  className="flex min-h-[44px] items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3 text-sm font-medium text-white hover:bg-white/[0.06]"
                >
                  Docs
                </Link>
              </div>
            </section>

            <section>
              <SectionHeader title="Sign out" />
              <button
                type="button"
                onClick={() => void handleSignOut()}
                disabled={!isConnected}
                className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] text-sm font-semibold text-white hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                Disconnect wallet
              </button>
            </section>
          </motion.div>
        )}
      </main>
    </>
  );
}
