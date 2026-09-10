import { Redis } from "@upstash/redis";
import type { Address } from "viem";
const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
if (!url || !token) throw new Error("Upstash Redis environment variables are missing.");
const redis = new Redis({ url, token });
const key = (id: string) => `mpgrhub:games:session:${id}`;
const TTL = 15 * 60;
export interface ServerGameSession { sessionId: string; wallet: Address; gameId: string; createdAt: string; expiresAt: string; }
export async function createServerGameSession(wallet: Address, gameId: string, sessionId: string): Promise<ServerGameSession> {
  const now = new Date(); const session = { sessionId, wallet: wallet.toLowerCase(), gameId, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + TTL * 1000).toISOString() } as ServerGameSession;
  const result = await redis.set(key(sessionId), session, { nx: true, ex: TTL });
  if (result === null) throw new Error("Game session collision");
  return session;
}
export async function getServerGameSession(sessionId: string): Promise<ServerGameSession | null> {
  const value = await redis.get<ServerGameSession>(key(sessionId));
  if (!value) return null;
  if (Date.parse(value.expiresAt) <= Date.now()) return null;
  return value;
}
