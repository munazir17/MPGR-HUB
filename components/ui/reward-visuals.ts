import { CalendarClock, Zap, TrendingUp, Users, Trophy, Gamepad2, ScrollText, CalendarDays, Gift, type LucideIcon } from "lucide-react";
import type { RewardSource } from "@/lib/rewards-engine";

// Shared between RewardClaimCard and RewardTimeline so every reward source
// renders with a consistent icon across the Rewards page. GAME/QUEST/
// WEEKLY/BONUS were added for the real on-chain Reward Vault module (see
// lib/reward-vault/) — additive only, existing entries are unchanged.
export const REWARD_SOURCE_ICON: Record<RewardSource, LucideIcon> = {
  DAILY_CHECK_IN: CalendarClock,
  STREAK: Zap,
  LEVEL: TrendingUp,
  REFERRAL: Users,
  SEASON: Trophy,
  GAME: Gamepad2,
  QUEST: ScrollText,
  WEEKLY: CalendarDays,
  BONUS: Gift,
};
