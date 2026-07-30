import { PieChart, Flame, Gauge, Crown, Award, Coins, Lock, Trophy, User, Wallet, Coins as TokenIcon, History, HelpCircle, Eraser, type LucideIcon } from "lucide-react";
import type { CommandIconKey } from "@/lib/agent-commands/types";

// Phase 3A.6 — resolves CommandIconKey -> LucideIcon component, same
// serialization-safety reasoning as components/features/agent/agent-icon-map.ts
// (Phase 3A.3): CommandResult/ActionHistoryEntry never carry a component
// reference, only this string key. Kept as its own file rather than
// extending agent-icon-map.ts's AgentIconKey union, so 3A.3's file and
// type stay completely untouched.
export const AGENT_COMMAND_ICON_MAP: Record<CommandIconKey, LucideIcon> = {
  portfolio: PieChart,
  xp: Flame,
  holderTier: Gauge,
  premium: Crown,
  rewards: Award,
  staking: Coins,
  lock: Lock,
  season: Award,
  leaderboard: Trophy,
  profile: User,
  wallet: Wallet,
  token: TokenIcon,
  history: History,
  help: HelpCircle,
  clear: Eraser,
};
