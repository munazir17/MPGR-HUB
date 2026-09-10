import { Redis } from "@upstash/redis";
import type { Address } from "viem";
import { XP_ACTIONS, type XPAction } from "@/lib/xp-engine";

const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
if (!url || !token) throw new Error("Upstash Redis environment variables are missing.");
const redis = new Redis({ url, token });

const VERSION = "xp-policy-v2";
const totalKey = (wallet: string) => `mpgrhub:xp:total:${wallet.toLowerCase()}`;
const monthKey = (wallet: string, month: string) => `mpgrhub:xp:month:${month}:${wallet.toLowerCase()}`;
const rankKey = "mpgrhub:xp:rank";
const eventKey = (wallet: string, eventId: string) => `mpgrhub:xp:event:${wallet.toLowerCase()}:${eventId}`;
const indexKey = "mpgrhub:xp:wallets";

export interface XPLedgerEntry { wallet: Address; action: XPAction; xp: number; eventId: string; policyVersion: string; timestamp: string; }

function monthId(date = new Date()) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; }

const AWARD_XP_SCRIPT = `
local created = redis.call("SET", KEYS[1], "1", "NX")
if not created then return 0 end
redis.call("INCRBY", KEYS[2], ARGV[1])
redis.call("INCRBY", KEYS[3], ARGV[1])
redis.call("ZINCRBY", KEYS[4], ARGV[1], ARGV[2])
redis.call("SADD", KEYS[5], ARGV[2])
redis.call("SET", KEYS[6], ARGV[6], "NX")
return 1
`;

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
  const ttl = 60 * 60 * 24 * 400;
  const event = eventKey(normalized, eventId);
  const meta = JSON.stringify({
    wallet: normalized,
    action,
    xp,
    eventId,
    policyVersion: VERSION,
    timestamp: timestamp.toISOString(),
  });

  const result = await redis.eval(
    AWARD_XP_SCRIPT,
    [event, totalKey(normalized), monthKey(normalized, month), rankKey, indexKey, `mpgrhub:xp:event-meta:${normalized}:${eventId}`],
    [String(xp), normalized, "", "", "", meta, String(ttl)],
  );

  if (Number(result) !== 1) {
    const totalXp = await getTotalXP(wallet);
    return { awarded: false, xp: 0, totalXp, seasonPoints: await getSeasonPoints(wallet) };
  }

  return {
    awarded: true,
    xp,
    totalXp: await getTotalXP(wallet),
    seasonPoints: await getSeasonPoints(wallet),
  };
}

export async function getTotalXP(wallet: Address): Promise<number> {
  const value = await redis.get<number>(totalKey(wallet));
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}
export async function getSeasonPoints(wallet: Address, date = new Date()): Promise<number> {
  const value = await redis.get<number>(monthKey(wallet, monthId(date)));
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}
export async function getRankedWallets(n = 50): Promise<Array<{ wallet: string; xp: number; seasonPoints: number }>> {
  const members = await redis.zrange<string[]>(rankKey, 0, Math.max(n * 4 - 1, n - 1), { rev: true });
  const rows = await Promise.all((members ?? []).map(async (wallet: string) => ({ wallet, xp: await getTotalXP(wallet as Address), seasonPoints: await getSeasonPoints(wallet as Address) })));
  return rows.sort((a: { wallet: string; xp: number; seasonPoints: number }, b: { wallet: string; xp: number; seasonPoints: number }) => b.xp - a.xp || b.seasonPoints - a.seasonPoints || a.wallet.localeCompare(b.wallet)).slice(0, n);
}
export async function getServerWalletStanding(wallet: Address): Promise<{ wallet: string; xp: number; seasonPoints: number; rank: number } | null> {
  const xp = await getTotalXP(wallet);
  const rank = await redis.zrevrank(rankKey, wallet.toLowerCase());
  if (rank === null) return null;
  return { wallet: wallet.toLowerCase(), xp, seasonPoints: await getSeasonPoints(wallet), rank: rank + 1 };
}

export async function getRankedWalletCount(): Promise<number> { return await redis.zcard(rankKey); }
