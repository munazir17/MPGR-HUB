import { getRedis } from "@/lib/api/redis";
import type { Address } from "viem";
const redis = () => getRedis();
const key = (id: string) => `mpgrhub:games:session:${id}`;
const TTL = 15 * 60;
export interface ServerGameSession { sessionId: string; wallet: Address; gameId: string; createdAt: string; expiresAt: string; }
export async function createServerGameSession(wallet: Address, gameId: string, sessionId: string): Promise<ServerGameSession> {
  const now = new Date(); const session = { sessionId, wallet: wallet.toLowerCase(), gameId, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + TTL * 1000).toISOString() } as ServerGameSession;
  const result = await redis().set(key(sessionId), session, { nx: true, ex: TTL });
  if (result === null) throw new Error("Game session collision");
  return session;
}
export async function getServerGameSession(sessionId: string): Promise<ServerGameSession | null> {
  const value = await redis().get<ServerGameSession>(key(sessionId));
  if (!value) return null;
  if (Date.parse(value.expiresAt) <= Date.now()) return null;
  return value;
}
