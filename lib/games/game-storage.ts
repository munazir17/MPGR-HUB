// lib/games/game-storage.ts
//
// Namespaced localStorage persistence for the Games Platform, keyed per
// wallet address per game — same discipline as lib/xp-engine.ts's own
// storage layer, deliberately kept separate from it (games never write to
// mpgr_xp_v1_* keys, XP-earning still always goes through xp-engine.ts).
//
// Phase swap point: once a real backend exists for authoritative
// leaderboards/anti-cheat, only the bodies of get/save below change to
// fetch() calls — every caller in lib/games/ and components stays the same.

import type { GameId, GameStatsRecord } from "./game-types";

const STORAGE_PREFIX = "mpgrhub:games:v1:";

function storageKey(gameId: GameId, address: string) {
  return `${STORAGE_PREFIX}${gameId}:${address.toLowerCase()}`;
}

function emptyStats(gameId: GameId, address: string): GameStatsRecord {
  return {
    gameId,
    walletAddress: address.toLowerCase(),
    totalRuns: 0,
    totalValidRuns: 0,
    bestScore: 0,
    bestDistance: 0,
    bestCoins: 0,
    bestDurationMs: 0,
    noCollisionRuns: 0,
    totalCoinsCollected: 0,
    maxSpeedTierReached: 0,
    lastPlayedAt: null,
    xpAwardedRunsByDate: {},
    processedSessionIds: [],
  };
}

export function getGameStats(gameId: GameId, address: string): GameStatsRecord {
  if (typeof window === "undefined") return emptyStats(gameId, address);

  try {
    const raw = window.localStorage.getItem(storageKey(gameId, address));

    if (!raw) return emptyStats(gameId, address);

    return {
      ...emptyStats(gameId, address),
      ...(JSON.parse(raw) as Partial<GameStatsRecord>),
    };
  } catch {
    return emptyStats(gameId, address);
  }
}

export function saveGameStats(record: GameStatsRecord): void {
  if (typeof window === "undefined") return;

  try {
    // Cap unbounded arrays so storage can't grow forever across many runs.
    const trimmed: GameStatsRecord = {
      ...record,
      processedSessionIds: record.processedSessionIds.slice(-200),
    };

    window.localStorage.setItem(
      storageKey(record.gameId, record.walletAddress),
      JSON.stringify(trimmed)
    );
  } catch {
    // Storage unavailable (private mode, quota, etc.) — fail silently,
    // consistent with the rest of the app's mock persistence layer.
  }
}

export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}
