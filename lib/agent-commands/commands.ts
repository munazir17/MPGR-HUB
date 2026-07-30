import { agentCommandRegistry } from "./command-registry";
import { lookupToken, listKnownTokenSymbols } from "./token-registry";
import { formatCompactNumber } from "@/lib/format";
import type { CommandResult, SlashCommand } from "./types";

// Phase 3A.6 — the concrete command set. Each command reads only from
// the AgentContext already built in lib/agent-context.ts (same object
// lib/agent-intelligence.ts reads from) — no new data source, no new
// hook, matching the exact "presentation on top of existing state"
// principle lib/agent-actions.ts documents for Phase 3A.3.
//
// Routes mirror lib/agent-actions.ts's verified route list exactly —
// Season Pass status -> /season-pass, XP/season points -> /season,
// Token Lock -> /app/token-lock.

const NOT_CONNECTED: CommandResult = {
  kind: "error",
  text: "Connect your wallet first — this command needs your on-chain data.",
};

const commandDefs: SlashCommand[] = [
  {
    name: "portfolio",
    aliases: ["holdings"],
    description: "Show your full portfolio summary",
    usage: "/portfolio",
    icon: "portfolio",
    requiresWallet: true,
    execute: (ctx): CommandResult => {
      if (!ctx.portfolio) return NOT_CONNECTED;
      const p = ctx.portfolio;
      return {
        kind: "message",
        icon: "portfolio",
        text: `Wallet: ${formatCompactNumber(p.walletBalance)} · Staked: ${formatCompactNumber(
          p.stakedBalance
        )} · Locked: ${formatCompactNumber(p.lockedBalance)} · Total: ${formatCompactNumber(
          p.totalHoldings
        )} MPGR. Claimable rewards: ${formatCompactNumber(p.claimableRewards)}.`,
      };
    },
  },
  {
    name: "xp",
    aliases: ["level"],
    description: "Check your XP and level progress",
    usage: "/xp",
    icon: "xp",
    requiresWallet: true,
    execute: (ctx): CommandResult => {
      if (!ctx.xp) return NOT_CONNECTED;
      const xp = ctx.xp;
      return {
        kind: "message",
        icon: "xp",
        text: `Level ${xp.level} · ${formatCompactNumber(xp.xp)} XP · ${xp.xpIntoLevel}/${xp.xpNeededForLevel} into next level · ${xp.streak}-day streak.`,
      };
    },
  },
  {
    name: "holdertier",
    aliases: ["tier"],
    description: "Check your Holder Tier status",
    usage: "/holdertier",
    icon: "holderTier",
    requiresWallet: true,
    execute: (ctx): CommandResult => {
      if (!ctx.holderTier) return NOT_CONNECTED;
      const h = ctx.holderTier;
      return {
        kind: "message",
        icon: "holderTier",
        text: `${h.tierLabel ?? "Unranked"} · Score ${formatCompactNumber(h.totalScore)}${
          h.nextTierLabel ? ` · ${Math.round(h.progressToNextTier * 100)}% to ${h.nextTierLabel}` : ""
        }.`,
      };
    },
  },
  {
    name: "premium",
    description: "Check your Premium status",
    usage: "/premium",
    icon: "premium",
    requiresWallet: true,
    execute: (ctx): CommandResult => {
      if (!ctx.premium) return NOT_CONNECTED;
      const pr = ctx.premium;
      return {
        kind: "message",
        icon: "premium",
        text: pr.isPremium
          ? `${pr.tierLabel} · ${pr.xpMultiplier}x XP · ${pr.rewardsMultiplier}x rewards.`
          : `Not Premium yet. Upgrade to unlock XP and rewards multipliers.`,
      };
    },
  },
  {
    name: "rewards",
    description: "Check claimable rewards",
    usage: "/rewards",
    icon: "rewards",
    requiresWallet: true,
    execute: (ctx): CommandResult => {
      if (!ctx.rewards) return NOT_CONNECTED;
      return {
        kind: "message",
        icon: "rewards",
        text: `Claimable: ${formatCompactNumber(ctx.rewards.claimableTotal)} MPGR · Claimed so far: ${formatCompactNumber(
          ctx.rewards.totalClaimed
        )} MPGR.`,
      };
    },
  },
  {
    name: "staking",
    aliases: ["stake"],
    description: "Check your staking summary",
    usage: "/staking",
    icon: "staking",
    requiresWallet: true,
    execute: (ctx): CommandResult => {
      if (!ctx.staking) return NOT_CONNECTED;
      const s = ctx.staking;
      return {
        kind: "message",
        icon: "staking",
        text: `${formatCompactNumber(s.totalStaked)} MPGR staked across ${s.activePositionsCount} position${
          s.activePositionsCount === 1 ? "" : "s"
        } · ${formatCompactNumber(s.claimableRewards)} claimable.`,
      };
    },
  },
  {
    name: "wallet",
    description: "Show wallet connection status",
    usage: "/wallet",
    icon: "wallet",
    requiresWallet: false,
    execute: (ctx): CommandResult => ({
      kind: "message",
      icon: "wallet",
      text: ctx.isConnected ? "Wallet connected." : "No wallet connected. Tap the wallet button to connect.",
    }),
  },
  {
    name: "token",
    aliases: ["lookup"],
    description: "Look up a token (e.g. /token mpgr)",
    usage: "/token <symbol>",
    icon: "token",
    requiresWallet: false,
    execute: (_ctx, args): CommandResult => {
      const symbol = args[0];
      if (!symbol) {
        return {
          kind: "message",
          icon: "token",
          text: `Usage: /token <symbol>. Known tokens: ${listKnownTokenSymbols().join(", ")}.`,
        };
      }
      const info = lookupToken(symbol);
      if (!info) {
        return { kind: "error", text: `Unknown token "${symbol}". Known tokens: ${listKnownTokenSymbols().join(", ")}.` };
      }
      return {
        kind: "message",
        icon: "token",
        text: `${info.name} (${info.symbol}) on ${info.chain}. ${info.description}`,
      };
    },
  },
  {
    name: "staking-page",
    aliases: ["gostaking"],
    description: "Open the Staking page",
    usage: "/staking-page",
    icon: "staking",
    requiresWallet: false,
    execute: (): CommandResult => ({ kind: "navigate", href: "/staking", text: "Opening Staking...", icon: "staking" }),
  },
  {
    name: "lock",
    description: "Open the Token Lock page",
    usage: "/lock",
    icon: "lock",
    requiresWallet: false,
    execute: (): CommandResult => ({ kind: "navigate", href: "/app/token-lock", text: "Opening Token Lock...", icon: "lock" }),
  },
  {
    name: "season",
    description: "Open the Season page",
    usage: "/season",
    icon: "season",
    requiresWallet: false,
    execute: (): CommandResult => ({ kind: "navigate", href: "/season", text: "Opening Season...", icon: "season" }),
  },
  {
    name: "leaderboard",
    description: "Open the Leaderboard",
    usage: "/leaderboard",
    icon: "leaderboard",
    requiresWallet: false,
    execute: (): CommandResult => ({ kind: "navigate", href: "/leaderboard", text: "Opening Leaderboard...", icon: "leaderboard" }),
  },
  {
    name: "profile",
    description: "Open your Profile",
    usage: "/profile",
    icon: "profile",
    requiresWallet: false,
    execute: (): CommandResult => ({ kind: "navigate", href: "/profile", text: "Opening Profile...", icon: "profile" }),
  },
  {
    name: "help",
    aliases: ["commands", "?"],
    description: "List all available commands",
    usage: "/help",
    icon: "help",
    requiresWallet: false,
    execute: (): CommandResult => ({
      kind: "message",
      icon: "help",
      text: agentCommandRegistry
        .list()
        .map((c) => c.usage)
        .join("  ·  "),
    }),
  },
];

for (const def of commandDefs) {
  agentCommandRegistry.register(def);
}
