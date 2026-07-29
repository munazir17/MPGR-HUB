import type { LucideIcon } from "lucide-react";
import { PieChart, Flame, Gauge, Crown, Gift, Coins, Lock, Award, User, Trophy } from "lucide-react";
import type { AgentIconKey } from "@/lib/agent-actions";

// Phase 3A.3 — resolves the string icon keys stored on AgentAction /
// AgentHighlight (lib/agent-actions.ts) to actual Lucide components. This
// map is intentionally the ONLY place that does this resolution — it lives
// here (UI layer), not in lib/, because AgentAction/AgentHighlight get
// persisted to localStorage as part of AgentMessage (lib/agent-engine.ts),
// and a live component reference wouldn't survive that JSON round-trip.
//
// Icon choices reuse the same icon already used for that concept elsewhere
// in the app where one exists (Coins for staking matches
// lib/agent-config.ts's AGENT_PROMPT_SUGGESTIONS "staking" entry; Crown
// for premium matches components/ui/PremiumBadge.tsx's icon language).
export const AGENT_ICON_MAP: Record<AgentIconKey, LucideIcon> = {
  portfolio: PieChart,
  xp: Flame,
  flame: Flame,
  holderTier: Gauge,
  gauge: Gauge,
  premium: Crown,
  rewards: Gift,
  staking: Coins,
  lock: Lock,
  season: Award,
  profile: User,
  leaderboard: Trophy,
};
