// lib/games/game-session.ts
//
// Shared session lifecycle helpers. Game-specific state (distance, coins,
// grid, pet, etc.) is layered on top of GameSessionMeta by each game's own
// module — see lib/games/mpgr-run/run-score.ts (RunStats/RunResult) and
// lib/games/mpgr-run/run-rewards.ts for the concrete MPGR Run example.

import type { GameId, GameSessionMeta } from "./game-types";

// Re-exported so callers can `import { type GameSessionMeta } from "game-session"`
// alongside the session helpers, without needing a second import from game-types.
export type { GameSessionMeta };

export const GAME_VERSION = "1.0.0";

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function startSession(
  gameId: GameId,
  walletAddress: string | null
): GameSessionMeta {
  return {
    sessionId: randomId(),
    gameId,
    walletAddress: walletAddress ? walletAddress.toLowerCase() : null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    gameVersion: GAME_VERSION,
    status: "running",
  };
}

export function endSession(session: GameSessionMeta): GameSessionMeta {
  return {
    ...session,
    endedAt: new Date().toISOString(),
    status: "game_over",
  };
}

export function sessionDurationMs(session: GameSessionMeta): number {
  if (!session.endedAt) return 0;

  return (
    new Date(session.endedAt).getTime() -
    new Date(session.startedAt).getTime()
  );
}
