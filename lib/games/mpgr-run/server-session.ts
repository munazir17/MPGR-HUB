import { getRedis } from "@/lib/api/redis";
import type { Address } from "viem";

const redis = () => getRedis();
const key = (id: string) => `mpgrhub:games:session:${id}`;
const TTL = 15 * 60;
const HEARTBEAT_MIN_INTERVAL_MS = 3_000;
const HEARTBEAT_MAX_GAP_MS = 25_000;
const SHORT_RUN_GRACE_MS = 8_000;

export interface ServerGameSession {
  sessionId: string;
  wallet: Address;
  gameId: string;
  createdAt: string;
  expiresAt: string;
  heartbeats: number[];
}

function remainingTtlSeconds(session: ServerGameSession): number {
  return Math.max(1, Math.ceil((Date.parse(session.expiresAt) - Date.now()) / 1000));
}

export async function createServerGameSession(wallet: Address, gameId: string, sessionId: string): Promise<ServerGameSession> {
  const now = new Date();
  const session: ServerGameSession = {
    sessionId,
    wallet: wallet.toLowerCase() as Address,
    gameId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TTL * 1000).toISOString(),
    heartbeats: [now.getTime()],
  };
  const result = await redis().set(key(sessionId), session, { nx: true, ex: TTL });
  if (result === null) throw new Error("Game session collision");
  return session;
}

export async function getServerGameSession(sessionId: string): Promise<ServerGameSession | null> {
  const value = await redis().get<ServerGameSession>(key(sessionId));
  if (!value) return null;
  if (Date.parse(value.expiresAt) <= Date.now()) return null;
  if (!Array.isArray(value.heartbeats)) value.heartbeats = [];
  return value;
}

export async function recordGameHeartbeat(sessionId: string, wallet: Address): Promise<ServerGameSession | null> {
  const session = await getServerGameSession(sessionId);
  if (!session || session.wallet.toLowerCase() !== wallet.toLowerCase()) return null;
  const now = Date.now();
  const beats = session.heartbeats ?? [];
  const last = beats[beats.length - 1];
  if (!last || now - last >= HEARTBEAT_MIN_INTERVAL_MS) {
    beats.push(now);
  }
  session.heartbeats = beats.slice(-180);
  await redis().set(key(sessionId), session, { ex: remainingTtlSeconds(session) });
  return session;
}

export function heartbeatsCoverDuration(session: ServerGameSession, durationMs: number): boolean {
  if (!Number.isFinite(durationMs) || durationMs < 0) return false;
  if (durationMs <= SHORT_RUN_GRACE_MS) return true;
  const created = Date.parse(session.createdAt);
  if (!Number.isFinite(created)) return false;
  const beats = [created, ...(session.heartbeats ?? []).filter((value) => Number.isFinite(value)), Date.now()].sort((a, b) => a - b);
  for (let i = 1; i < beats.length; i += 1) {
    if (beats[i] - beats[i - 1] > HEARTBEAT_MAX_GAP_MS) return false;
  }
  return beats[beats.length - 1] - beats[0] + 2_000 >= durationMs;
}

export { HEARTBEAT_MAX_GAP_MS, HEARTBEAT_MIN_INTERVAL_MS };
