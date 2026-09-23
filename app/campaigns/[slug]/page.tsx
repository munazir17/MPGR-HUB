"use client";

// app/campaigns/[slug]/page.tsx
//
// One campaign: banner, dates, reward, rules, your standing, earn
// actions, and the campaign leaderboard (frozen at finalization).
// Reads entirely normalized data from GET /api/campaigns/:slug — no
// campaign-specific logic lives here.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft, CalendarDays, Coins, Flag, Gift, Trophy, Users } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { PageContainer } from "@/components/layout/PageContainer";
import { GlassCard } from "@/components/ui/GlassCard";
import { StatCard } from "@/components/ui/StatCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonCard } from "@/components/ui/SkeletonCard";
import {
  campaignStatusStyles,
  formatCampaignDates,
} from "@/components/features/campaigns/CampaignCard";
import { CampaignLeaderboard } from "@/components/features/campaigns/CampaignLeaderboard";
import { CampaignActionPanel } from "@/components/features/campaigns/CampaignActionPanel";
import { useCampaign } from "@/hooks/useCampaign";
import { formatCompactNumber } from "@/lib/format";
import { useAccount } from "wagmi";

export default function CampaignDetailPage() {
  const params = useParams<{ slug?: string }>();
  const slug = typeof params?.slug === "string" ? params.slug : null;
  const [mounted, setMounted] = useState(false);
  const { address } = useAccount();
  const { campaign, leaderboard, loading, error, busy, join, track } = useCampaign(slug);

  useEffect(() => setMounted(true), []);

  const status = campaign ? campaignStatusStyles(campaign.status) : null;
  const leaderPoints = leaderboard.length > 0 ? leaderboard[0].points : 0;
  const topThree = leaderboard.slice(0, 3);

  return (
    <>
      <Navbar />
      <PageContainer>
        {!mounted ? null : loading ? (
          <div className="space-y-4">
            <SkeletonCard lines={1} />
            <SkeletonCard lines={4} />
            <SkeletonCard lines={3} />
          </div>
        ) : error === "failed" ? (
          <EmptyState
            icon={Flag}
            title="Couldn't load this campaign"
            description="Something went wrong reaching the campaigns service. Please try again shortly."
          />
        ) : error || !campaign || !status ? (
          <EmptyState
            icon={Flag}
            title="Campaign not found"
            description="This campaign may have been removed or the link is incorrect."
          />
        ) : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
            <Link
              href="/campaigns"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted transition-colors hover:text-white"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              All campaigns
            </Link>

            {/* Banner header */}
            <div className="relative overflow-hidden rounded-[14px] border border-white/[0.07]">
              <div
                aria-hidden="true"
                className="absolute inset-0 bg-gradient-to-br from-primary/25 via-surface-2 to-gold/15"
              />
              {campaign.banner && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={campaign.banner}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  aria-hidden="true"
                  className="absolute inset-0 h-full w-full object-cover"
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                  }}
                />
              )}
              <div
                aria-hidden="true"
                className="absolute inset-0 bg-gradient-to-t from-background via-background/60 to-transparent"
              />
              <div className="relative px-5 pb-5 pt-16 sm:px-6 sm:pt-20">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${status.className}`}
                  >
                    {status.label}
                  </span>
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
                    {campaign.eventType}
                  </span>
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
                    Tracks {campaign.trackingMetric}
                  </span>
                </div>
                <h1 className="display-l mt-3 text-[26px] text-white md:text-4xl">{campaign.title}</h1>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{campaign.description}</p>
                <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-muted">
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                    {formatCampaignDates(campaign.startAt, campaign.endAt)}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <Users className="h-3.5 w-3.5" aria-hidden="true" />
                    {formatCompactNumber(campaign.participantCount)} participants
                  </span>
                </div>
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard
                label="Reward pool"
                value={campaign.rewardPool}
                icon={Gift}
                accent="gold"
              />
              <StatCard
                label="Reward type"
                value={campaign.rewardType}
                icon={Coins}
                accent="gold"
              />
              <StatCard
                label="Participants"
                value={formatCompactNumber(campaign.participantCount)}
                icon={Users}
              />
              <StatCard
                label="Your points"
                value={campaign.viewer?.joined ? formatCompactNumber(campaign.viewer.points) : "—"}
                icon={Trophy}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
              {/* Left: participation + details */}
              <div className="space-y-4 lg:col-span-3">
                <CampaignActionPanel
                  campaign={campaign}
                  busy={busy}
                  onJoin={async () => {
                    const result = await join();
                    return { ok: result.ok, error: result.error };
                  }}
                  onTrack={async (actionId, options) => {
                    const result = await track(actionId, options);
                    return {
                      ok: result.ok,
                      error: result.error,
                      pointsAwarded: result.pointsAwarded,
                      status: result.status,
                    };
                  }}
                  leaderPoints={leaderPoints}
                />

                <GlassCard className="p-5">
                  <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-muted">How it works</p>
                  <ul className="mt-3 space-y-2">
                    {campaign.rules.map((rule) => (
                      <li key={rule} className="flex gap-2 text-sm leading-relaxed text-muted">
                        <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary" />
                        {rule}
                      </li>
                    ))}
                  </ul>
                </GlassCard>

                <GlassCard className="p-5">
                  <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-muted">Reward</p>
                  <div className="mt-3 flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-gold/[0.18] bg-gold/[0.08]">
                      <Gift className="h-4 w-4 text-gold" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-white">
                        {campaign.rewardPool}
                        {campaign.rewardType ? ` ${campaign.rewardType}` : ""}
                      </p>
                      {campaign.rewardDescription && (
                        <p className="mt-1 text-sm leading-relaxed text-muted">{campaign.rewardDescription}</p>
                      )}
                      {campaign.rewardDistribution && (
                        <p className="mt-1 text-xs text-muted">Distribution: {campaign.rewardDistribution}</p>
                      )}
                      <p className="mt-2 text-[11px] leading-relaxed text-muted/80">
                        Rewards are recorded and distributed manually after the campaign finalizes — nothing is
                        transferred automatically.
                      </p>
                    </div>
                  </div>
                </GlassCard>
              </div>

              {/* Right: leaderboard */}
              <div className="space-y-4 lg:col-span-2">
                {campaign.leaderboardEnabled ? (
                  <GlassCard className="p-5">
                    <div className="mb-4 flex items-center justify-between gap-2">
                      <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-muted">
                        Leaderboard
                      </p>
                      {campaign.finalized && (
                        <span className="rounded-full border border-gold/30 bg-gold/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gold">
                          Final
                        </span>
                      )}
                    </div>
                    {topThree.length > 0 && (
                      <div className="mb-4 grid grid-cols-3 gap-2">
                        {topThree.map((entry, index) => (
                          <div
                            key={entry.wallet}
                            className={`rounded-xl border px-2 py-2.5 text-center ${
                              index === 0
                                ? "border-gold/40 bg-gold/[0.06]"
                                : "border-white/10 bg-white/[0.03]"
                            }`}
                          >
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                              #{entry.rank}
                            </p>
                            <p className="truncate font-mono text-xs font-semibold text-white">
                              {entry.displayName ?? `${entry.wallet.slice(0, 6)}…${entry.wallet.slice(-4)}`}
                            </p>
                            <p className="font-mono text-[11px] tabular-nums text-gold">
                              {formatCompactNumber(entry.points)}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                    {leaderboard.length === 0 ? (
                      <p className="text-sm text-muted">
                        No participants yet — be the first on the board.
                      </p>
                    ) : (
                      <CampaignLeaderboard entries={leaderboard} currentWallet={address} />
                    )}
                    <p className="mt-4 text-[11px] leading-relaxed text-muted/80">
                      Campaign points are tracked per campaign and are separate from global XP and Season Points.
                    </p>
                  </GlassCard>
                ) : (
                  <GlassCard className="p-5">
                    <p className="text-sm text-muted">This campaign does not run a public leaderboard.</p>
                  </GlassCard>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </PageContainer>
    </>
  );
}
