import { getRedis } from "@/lib/api/redis";
import type { Address } from "viem";
import { XP_ACTIONS, type XPAction } from "@/lib/xp-engine";
import { DAILY_XP_RUN_CAP } from "@/lib/games/mpgr-run/run-config";

const redis = () => getRedis();

export const XP_POLICY_VERSION = "xp-policy-v2";
const totalKey = (wallet: string) => `mpgrhub:xp:total:${wallet.toLowerCase()}`;
const monthKey = (wallet: string, month: string) => `mpgrhub:xp:month:${month}:${wallet.toLowerCase()}`;
const rankKey = "mpgrhub:xp:rank";
const eventKey = (wallet: string, eventId: string) => `mpgrhub:xp:event:${wallet.toLowerCase()}:${eventId}`;
const metaKey = (wallet: string, eventId: string) => `mpgrhub:xp:event-meta:${wallet.toLowerCase()}:${eventId}`;
const indexKey = "mpgrhub:xp:wallets";
const gameCapKey = (wallet: string, day: string) => `mpgrhub:xp:game-cap:${wallet.toLowerCase()}:${day}`;

export interface XPLedgerEntry {
  wallet: Address;
  action: XPAction;
  xp: number;
  eventId: string;
  policyVersion: string;
  timestamp: string;
}

function monthId(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function utcDayId(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * Atomic idempotent award.
 * KEYS: event, total, month, rank, wallet-index, event-meta.
 * ARGV: xp, wallet, unused, unused, unused, meta-json, ttl-seconds.
 *
 * Must use redis.call (Lua). redis().call is a JS typo and throws at runtime.
 */
export const AWARD_XP_SCRIPT = `
local created = redis.call("SET", KEYS[1], "1", "NX", "EX", ARGV[7])
if not created then return 0 end
redis.call("INCRBY", KEYS[2], ARGV[1])
redis.call("INCRBY", KEYS[3], ARGV[1])
redis.call("ZINCRBY", KEYS[4], ARGV[1], ARGV[2])
redis.call("SADD", KEYS[5], ARGV[2])
redis.call("SET", KEYS[6], ARGV[6], "EX", ARGV[7])
return 1
`;

/**
 * Atomic daily-capped game XP + idempotent event award.
 * KEYS: event, total, month, rank, wallet-index, event-meta, cap.
 * ARGV: xp, wallet, unused, unused, unused, meta-json, ttl-seconds, cap-limit, cap-ttl.
 * Returns 1 awarded, 0 duplicate event, -1 daily cap reached.
 */
export const AWARD_CAPPED_GAME_XP_SCRIPT = `
local cap = redis.call("INCR", KEYS[7])
if tonumber(cap) == 1 then
  redis.call("EXPIRE", KEYS[7], ARGV[9])
end
if tonumber(cap) > tonumber(ARGV[8]) then
  redis.call("DECR", KEYS[7])
  return -1
end
local created = redis.call("SET", KEYS[1], "1", "NX", "EX", ARGV[7])
if not created then
  redis.call("DECR", KEYS[7])
  return 0
end
redis.call("INCRBY", KEYS[2], ARGV[1])
redis.call("INCRBY", KEYS[3], ARGV[1])
redis.call("ZINCRBY", KEYS[4], ARGV[1], ARGV[2])
redis.call("SADD", KEYS[5], ARGV[2])
redis.call("SET", KEYS[6], ARGV[6], "EX", ARGV[7])
return 1
`;

function ledgerMeta(wallet: string, action: XPAction, xp: number, eventId: string, timestamp: Date): string {
  return JSON.stringify({
    wallet: wallet as Address,
    action,
    xp,
    eventId,
    policyVersion: XP_POLICY_VERSION,
    timestamp: timestamp.toISOString(),
  } satisfies XPLedgerEntry);
}

export async function awardServerXP(
  wallet: Address,
  action: XPAction,
  eventId: string,
  timestamp = new Date(),
): Promise<{ awarded: boolean; xp: number; totalXp: number; seasonPoints: number }> {
  const definition = XP_ACTIONS[action];
  if (!definition || !eventId || eventId.length > 160) throw new Error("Invalid XP event.");
  const normalized = wallet.toLowerCase();
  const month = monthId(timestamp);
  const xp = definition.xp;
  const ttl = String(60 * 60 * 24 * 400);
  const meta = ledgerMeta(normalized, action, xp, eventId, timestamp);

  const result = await redis().eval(
    AWARD_XP_SCRIPT,
    [eventKey(normalized, eventId), totalKey(normalized), monthKey(normalized, month), rankKey, indexKey, metaKey(normalized, eventId)],
    [String(xp), normalized, "", "", "", meta, ttl],
  );

  if (Number(result) !== 1) {
    return {
      awarded: false,
      xp: 0,
      totalXp: await getTotalXP(wallet),
      seasonPoints: await getSeasonPoints(wallet),
    };
  }

  return {
    awarded: true,
    xp,
    totalXp: await getTotalXP(wallet),
    seasonPoints: await getSeasonPoints(wallet),
  };
}

export async function awardCappedGameXP(
  wallet: Address,
  sessionId: string,
): Promise<{ awarded: boolean; xp: number; totalXp: number; seasonPoints: number; dailyCapReached: boolean }> {
  const definition = XP_ACTIONS.GAME_MPGR_RUN_COMPLETE;
  const eventId = `game:${sessionId}`;
  if (!sessionId || sessionId.length > 140) throw new Error("Invalid XP event.");
  const timestamp = new Date();
  const normalized = wallet.toLowerCase();
  const month = monthId(timestamp);
  const xp = definition.xp;
  const ttl = String(60 * 60 * 24 * 400);
  const capTtl = String(60 * 60 * 48);
  const meta = ledgerMeta(normalized, "GAME_MPGR_RUN_COMPLETE", xp, eventId, timestamp);

  const result = await redis().eval(
    AWARD_CAPPED_GAME_XP_SCRIPT,
    [
      eventKey(normalized, eventId),
      totalKey(normalized),
      monthKey(normalized, month),
      rankKey,
      indexKey,
      metaKey(normalized, eventId),
      gameCapKey(normalized, utcDayId(timestamp)),
    ],
    [String(xp), normalized, "", "", "", meta, ttl, String(DAILY_XP_RUN_CAP), capTtl],
  );

  const code = Number(result);
  if (code === -1) {
    return {
      awarded: false,
      xp: 0,
      totalXp: await getTotalXP(wallet),
      seasonPoints: await getSeasonPoints(wallet),
      dailyCapReached: true,
    };
  }
  if (code !== 1) {
    return {
      awarded: false,
      xp: 0,
      totalXp: await getTotalXP(wallet),
      seasonPoints: await getSeasonPoints(wallet),
      dailyCapReached: false,
    };
  }
  return {
    awarded: true,
    xp,
    totalXp: await getTotalXP(wallet),
    seasonPoints: await getSeasonPoints(wallet),
    dailyCapReached: false,
  };
}

export async function getTotalXP(wallet: Address): Promise<number> {
  const value = await redis().get<number>(totalKey(wallet));
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export async function getSeasonPoints(wallet: Address, date = new Date()): Promise<number> {
  const value = await redis().get<number>(monthKey(wallet, monthId(date)));
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export async function getRankedWallets(n = 50): Promise<Array<{ wallet: string; xp: number; seasonPoints: number }>> {
  const members = await redis().zrange<string[]>(rankKey, 0, Math.max(n * 4 - 1, n - 1), { rev: true });
  const rows = await Promise.all(
    (members ?? []).map(async (wallet: string) => ({
      wallet,
      xp: await getTotalXP(wallet as Address),
      seasonPoints: await getSeasonPoints(wallet as Address),
    })),
  );
  return rows
    .sort((a, b) => b.xp - a.xp || b.seasonPoints - a.seasonPoints || a.wallet.localeCompare(b.wallet))
    .slice(0, n);
}

export async function getServerWalletStanding(
  wallet: Address,
): Promise<{ wallet: string; xp: number; seasonPoints: number; rank: number } | null> {
  const xp = await getTotalXP(wallet);
  const rank = await redis().zrevrank(rankKey, wallet.toLowerCase());
  if (rank === null) return null;
  return { wallet: wallet.toLowerCase(), xp, seasonPoints: await getSeasonPoints(wallet), rank: rank + 1 };
}

export async function getRankedWalletCount(): Promise<number> {
  return await redis().zcard(rankKey);
}
