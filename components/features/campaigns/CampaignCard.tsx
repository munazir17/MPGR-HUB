"use client";

// components/features/campaigns/CampaignCard.tsx
//
// One campaign tile for the Campaigns grid. Pure presentation over the
// normalized PublicCampaign shape — all status/reward/points logic is
// resolved server-side. Uses the existing GlassCard + badge language
// (same recipe as GameCard) so campaigns feel native to MPGR HUB.

import Link from "next/link";
import { ArrowRight, CalendarDays, Coins, Star, Trophy, Users } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { formatCompactNumber } from "@/lib/format";
import type { CampaignStatus, PublicCampaign } from "@/lib/campaigns/campaign-types";

export function campaignStatusStyles(status: CampaignStatus): { label: string; className: string } {
  switch (status) {
    case "active":
      return { label: "Active", className: "border-primary/30 bg-primary/10 text-primary" };
    case "upcoming":
      return { label: "Upcoming", className: "border-gold/30 bg-gold/10 text-gold" };
    case "paused":
      return { label: "Paused", className: "border-white/15 bg-white/[0.04] text-muted" };
    default:
      return { label: "Completed", className: "border-white/10 bg-white/[0.04] text-muted" };
  }
}

export function formatCampaignDates(startAt: string, endAt: string): string {
  const fmt = (iso: string) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  };
  const start = fmt(startAt);
  const end = fmt(endAt);
  const year = new Date(endAt).getUTCFullYear();
  return start && end ? `${start} – ${end}, ${year}` : "";
}

interface CampaignCardProps {
  campaign: PublicCampaign;
}

export function CampaignCard({ campaign }: CampaignCardProps) {
  const status = campaignStatusStyles(campaign.status);
  const viewer = campaign.viewer;

  return (
    <Link
      href={`/campaigns/${campaign.slug}`}
      className="group block h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 rounded-[14px]"
    >
      <GlassCard
        className={
          campaign.featured && campaign.status === "active"
            ? "h-full p-0 ring-1 ring-gold/40"
            : "h-full p-0"
        }
      >
        {/* Banner */}
        <div className="relative h-32 w-full overflow-hidden sm:h-36">
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
                // Banner is decorative — hide it and keep the gradient.
                event.currentTarget.style.display = "none";
              }}
            />
          )}
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-gradient-to-t from-surface via-surface/40 to-transparent"
          />
          <div className="absolute left-4 top-3 flex items-center gap-2">
            <span
              className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${status.className}`}
            >
              {status.label}
            </span>
            {campaign.featured && campaign.status === "active" && (
              <span className="rounded-full border border-gold/30 bg-gold/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-gold">
                Featured
              </span>
            )}
          </div>
        </div>

        <div className="relative flex flex-1 flex-col p-5">
          <h3 className="text-lg font-bold tracking-tight text-white transition-colors group-hover:text-primary">
            {campaign.title}
          </h3>
          <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted">{campaign.description}</p>

          <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-muted">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">
              <CalendarDays className="h-3 w-3" aria-hidden="true" />
              {formatCampaignDates(campaign.startAt, campaign.endAt)}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">
              <Users className="h-3 w-3" aria-hidden="true" />
              {formatCompactNumber(campaign.participantCount)}{" "}
              {campaign.participantCount === 1 ? "participant" : "participants"}
            </span>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2">
            <span className="flex min-w-0 items-center gap-2 text-xs text-muted">
              <Coins className="h-3.5 w-3.5 shrink-0 text-gold" aria-hidden="true" />
              <span className="truncate">
                <span className="font-semibold text-white">{campaign.rewardPool}</span>
                {campaign.rewardType ? ` ${campaign.rewardType}` : ""}
              </span>
            </span>
            {campaign.leaderboardEnabled && (
              <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted">
                <Trophy className="h-3 w-3 text-gold" aria-hidden="true" />
                Leaderboard
              </span>
            )}
          </div>

          {viewer?.joined && (
            <div className="mt-3 flex items-center gap-3 text-[11px]">
              <span className="inline-flex items-center gap-1.5 text-primary">
                <Star className="h-3 w-3" aria-hidden="true" />
                {formatCompactNumber(viewer.points)} pts
              </span>
              {viewer.rank !== null && (
                <span className="text-gold">Rank #{viewer.rank}</span>
              )}
            </div>
          )}

          <span className="mt-4 inline-flex items-center justify-center gap-2 text-xs font-semibold text-primary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            View campaign
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </span>
        </div>
      </GlassCard>
    </Link>
  );
}
