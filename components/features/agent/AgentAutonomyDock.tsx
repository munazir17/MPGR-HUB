"use client";

import type { useAgentAutonomy } from "@/hooks/useAgentAutonomy";
import type { AutonomyGoalView, AutonomyTokenOption } from "@/hooks/useAgentAutonomy";

type AutonomyApi = ReturnType<typeof useAgentAutonomy>;

export type AutonomyCommand =
  | { kind: "arm"; armed: boolean }
  | { kind: "remove"; symbol: string | null };

const ACTIVE = new Set(["ACTIVE", "WAITING", "EXECUTING"]);

const TICKER_STOP = new Set([
  "public", "basic", "magic", "music", "topic", "logic", "comic", "cubic",
  "lyric", "panic", "picnic", "plastic", "toxic", "civic", "fabric", "classic",
  "specific",
]);

function tickerIn(rest: string): string | null {
  const match = /\b(cbBTC|cbETH|cbDOGE|cbXRP|cbLTC|cbADA|WETH|USDC|[A-Za-z]{2,8}c)\b/i.exec(rest);
  if (!match) return null;
  const symbol = match[1];
  if (TICKER_STOP.has(symbol.toLowerCase())) return null;
  if (/^[a-z]+c$/.test(symbol) && symbol.length > 6) return null;
  return symbol;
}

/** Chat commands that must not go through the model: on/off and remove. */
export function parseAutonomyCommand(prompt: string): AutonomyCommand | null {
  const text = prompt.trim().replace(/[.!]+$/g, "");
  if (!text || text.length > 120) return null;

  const arm = /^(?:please\s+)?(?:turn\s+)?(?:autonomous(?:\s+goals?)?|autonomy)\s+(on|off)$/i.exec(text)
    ?? /^(?:please\s+)?(enable|disable)\s+autonomous(?:\s+goals?)?$/i.exec(text);
  if (arm) {
    const word = arm[1].toLowerCase();
    return { kind: "arm", armed: word === "on" || word === "enable" };
  }

  if (!/^(?:please\s+)?(?:remove|cancel|delete|stop)\b/i.test(text)) return null;
  const rest = text.replace(/^(?:please\s+)?(?:remove|cancel|delete|stop)\b/i, "").trim();
  const ticker = tickerIn(rest);
  const wipe = /^(?:(?:all|everything)|(?:my\s+|the\s+)?(?:autonomous\s+|autonomy\s+)?goals?|autonomous|autonomy)$/i.test(rest)
    || /\b(?:all|everything)\b/i.test(rest);
  // A ticker wins: "remove all TSLAc goals" cancels that symbol, not every goal.
  if (ticker) return { kind: "remove", symbol: ticker };
  if (wipe) return { kind: "remove", symbol: null };
  return null;
}

function symbolsFor(goal: AutonomyGoalView, tokens: AutonomyTokenOption[]): string[] {
  const byAddress = new Map(tokens.map((token) => [token.address.toLowerCase(), token.symbol]));
  return [goal.trade.sellToken, goal.trade.buyToken]
    .map((address) => byAddress.get(address.toLowerCase()))
    .filter((symbol): symbol is string => Boolean(symbol));
}

export function goalsMatchingRemoval(
  goals: AutonomyGoalView[],
  tokens: AutonomyTokenOption[],
  symbol: string | null,
): AutonomyGoalView[] {
  const open = goals.filter((goal) => !["COMPLETED", "FAILED", "EXPIRED", "CANCELLED"].includes(goal.status));
  if (!symbol) return open;
  const needle = symbol.toLowerCase();
  return open.filter((goal) => {
    if (goal.description.toLowerCase().includes(needle)) return true;
    return symbolsFor(goal, tokens).some((item) => item.toLowerCase() === needle);
  });
}

export function AgentAutonomyDock({
  autonomy,
  connected,
  notice,
}: {
  autonomy: AutonomyApi;
  connected: boolean;
  notice: string | null;
}) {
  const { config, goals, busy, setGoalsArmed } = autonomy;
  const active = goals.filter((goal) => ACTIVE.has(goal.status)).length;
  const paused = goals.filter((goal) => goal.status === "PAUSED").length;
  const armed = active > 0;
  const runtime = !config ? "Checking runtime…" : !config.enabled
    ? "Runtime off"
    : config.emergencyDisabled
      ? "Emergency stop"
      : config.executionAvailable
        ? "Execution live"
        : "Runtime on · checks pending";

  return (
    <div className="mb-2 rounded-xl border border-white/10 bg-white/[0.03] px-2.5 py-1.5" data-testid="agent-autonomy-dock">
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${armed ? "bg-good" : "bg-white/30"}`} aria-hidden="true" />
        <span className="text-[11px] font-semibold text-white">Autonomous goals</span>
        <span className="truncate text-[10px] text-muted">
          {active} on{paused ? ` · ${paused} paused` : ""} · {runtime}
        </span>
        <button
          type="button"
          data-testid="agent-autonomy-toggle"
          disabled={!connected || busy || !config?.enabled || config.emergencyDisabled}
          onClick={() => void setGoalsArmed(!armed)}
          className="ml-auto min-h-[32px] shrink-0 rounded-lg border border-white/15 bg-white/[0.04] px-3 text-[11px] font-medium text-white hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {armed ? "Turn off" : "Turn on"}
        </button>
      </div>
      <p className="pt-1 text-[10px] leading-snug text-muted/80">
        {notice ?? "Set a goal in chat — “buy 10 USDC of TSLAc if it drops 2%”. Say “remove TSLAc” to cancel. Turn off pauses every goal."}
      </p>
    </div>
  );
}
