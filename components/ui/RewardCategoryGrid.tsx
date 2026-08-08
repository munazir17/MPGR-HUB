"use client";

import Link from "next/link";
import {
  Gift,
  CalendarDays,
  Lock,
  ListChecks,
  Gamepad2,
  Users,
  Flag,
  Bot,
  Crown,
  Rocket,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";
import { GlassCard } from "./GlassCard";
import { Skeleton } from "./Skeleton";
import { formatTokenBalance } from "@/lib/format";
import type { RewardCategoryKey, RewardCategorySummary } from "@/lib/rewards/reward-types";

const MPGR_DECIMALS = 18;

const CATEGORY_ICON: Record<RewardCategoryKey, LucideIcon> = {
  daily: Gift,
  weekly: CalendarDays,
  staking: Lock,
  quest: ListChecks,
  game: Gamepad2,
  referral: Users,
  season: Flag,
  ai: Bot,
  premium: Crown,
  airdrop: Rocket,
};

function CategorySkeleton() {
  return (
    <GlassCard className="p-4">
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-2.5 w-32" />
        </div>
      </div>
      <Skeleton className="mt-4 h-5 w-20" />
    </GlassCard>
  );
}

interface RewardCategoryGridProps {
  categories: RewardCategorySummary[] | null;
  loading?: boolean;
}

export function RewardCategoryGrid({ categories, loading }: RewardCategoryGridProps) {
  if (loading || !categories) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 10 }).map((_, i) => (
          <CategorySkeleton key={i} />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {categories.map((category) => {
        const Icon = CATEGORY_ICON[category.category];
        return (
          <GlassCard key={category.category} className="p-4">
            <div className="flex items-center gap-3">
              <div
                className={
                  category.isActive
                    ? "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary-glow/20 to-primary/10 ring-1 ring-primary/20"
                    : "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.04] ring-1 ring-white/10"
                }
              >
                <Icon
                  className={category.isActive ? "h-4 w-4 text-primary" : "h-4 w-4 text-muted"}
                  aria-hidden="true"
                />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-white">{category.label}</p>
                {!category.isActive && <p className="text-[11px] text-muted">Coming soon</p>}
              </div>
            </div>

            {category.isActive ? (
              <div className="mt-4 space-y-1">
                <p className="text-lg font-bold tracking-tight text-white">
                  {formatTokenBalance(category.totalEarnedRaw, MPGR_DECIMALS)}{" "}
                  <span className="text-xs font-medium text-muted">MPGR earned</span>
                </p>
                {category.claimableRaw > 0n && (
                  <p className="text-[11px] font-medium text-gold">
                    {formatTokenBalance(category.claimableRaw, MPGR_DECIMALS)} MPGR claimable
                  </p>
                )}
                {category.category === "staking" && category.claimableRaw > 0n && (
                  <Link
                    href="/staking"
                    className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:text-primary-glow"
                  >
                    Claim on Staking
                    <ArrowRight className="h-3 w-3" aria-hidden="true" />
                  </Link>
                )}
              </div>
            ) : (
              <p className="mt-4 text-[11px] text-muted">Not yet available in this build.</p>
            )}
          </GlassCard>
        );
      })}
    </div>
  );
}
