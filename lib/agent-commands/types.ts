import type { AgentContext } from "@/lib/agent-context";

// Phase 3A.6 — Advanced Conversational UX.
//
// Commands are a second, deterministic entry point into the Agent
// pipeline, parallel to lib/agent-intelligence.ts's NLP-style intent
// detection — not a replacement for it. A command always resolves
// instantly from the same AgentContext the conversational layer already
// reads from; it never re-derives portfolio/XP/staking figures itself.

export type CommandIconKey =
  | "portfolio"
  | "xp"
  | "holderTier"
  | "premium"
  | "rewards"
  | "staking"
  | "lock"
  | "season"
  | "leaderboard"
  | "profile"
  | "wallet"
  | "token"
  | "history"
  | "help"
  | "clear";

export interface ParsedCommand {
  raw: string;
  name: string;
  args: string[];
}

export type CommandResult =
  | { kind: "message"; text: string; icon?: CommandIconKey }
  | { kind: "navigate"; href: string; text: string; icon?: CommandIconKey }
  | { kind: "error"; text: string };

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;
  icon: CommandIconKey;
  // Some commands (e.g. /help, /token) work without a wallet; most
  // wallet-aware commands (/portfolio, /wallet) require isConnected.
  requiresWallet: boolean;
  execute: (context: AgentContext, args: string[]) => CommandResult;
}
