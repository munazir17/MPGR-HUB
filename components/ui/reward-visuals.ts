import { CalendarClock, Zap, TrendingUp, Users, Trophy, type LucideIcon } from "lucide-react";
import type { RewardSource } from "@/lib/rewards-engine";

// Shared between RewardClaimCard and RewardTimeline so every reward source
// renders with a consistent icon across the Rewards page.
export const REWARD_SOURCE_ICON: Record<RewardSource, LucideIcon> = {
  DAILY_CHECK_IN: CalendarClock,
  STREAK: Zap,
  LEVEL: TrendingUp,
  REFERRAL: Users,
  SEASON: Trophy,
};
