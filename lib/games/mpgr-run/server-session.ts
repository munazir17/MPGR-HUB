import { getRedis } from "@/lib/api/redis";
import type { Address } from "viem";

const redis = () => getRedis();
const key = (id: string) => `mpgrhub:games:session:${id}`;
const activeSessionsKey = (wallet: Address) => `mpgrhub:games:active-sessions:${wallet.toLowerCase()}`;
const TTL = 15 * 60;
const HEARTBEAT_MIN_INTERVAL_MS = 3_000;
const HEARTBEAT_MAX_GAP_MS = 25_000;
const SHORT_RUN_GRACE_MS = 8_000;

// A wallet can only have this many *live* (not yet consumed, not yet
// expired) server-issued game sessions at once. This is not anti-cheat by
// itself, but it bounds session-creation abuse (e.g. a script spinning up
// many sessions to probe the reward path) independently of the per-IP/
// per-wallet rate limit already applied at the route layer.
export const MAX_CONCURRENT_SESSIONS_PER_WALLET = 3;

export class TooManyActiveSessionsError extends Error {
  constructor() {
    super("Too many active game sessions for this wallet");
    this.name = "TooManyActiveSessionsError";
  }
}

export interface ServerGameSession {
  sessionId: string;
  wallet: Address;
  gameId: string;
  createdAt: string;
  expiresAt: string;
  heartbeats: number[];
  /**
   * Set once a session has been used to reach a reward decision (accepted
   * or rejected). A consumed session is removed from the wallet's active
   * session slot immediately (rather than waiting for TTL expiry) and can
   * never back a heartbeat or a second reward decision — duplicate reward
   * submissions are already rejected via the sessionId idempotency key in
   * the reward store, so this is defense-in-depth, not the primary
   * duplicate-submission guard.
   */
  consumedAt?: string;
}

function remainingTtlSeconds(session: ServerGameSession): number {
  return Math.max(1, Math.ceil((Date.parse(session.expiresAt) - Date.now()) / 1000));
}

/**
 * Creates a server-issued game session bound to an authenticated wallet and
 * a specific game id. Fails closed (throws TooManyActiveSessionsError) if
 * the wallet already has MAX_CONCURRENT_SESSIONS_PER_WALLET live sessions,
 * so a caller cannot unboundedly mint sessions.
 */
export async function createServerGameSession(wallet: Address, gameId: string, sessionId: string): Promise<ServerGameSession> {
  const normalizedWallet = wallet.toLowerCase() as Address;
  const activeKey = activeSessionsKey(normalizedWallet);

  const activeCount = await redis().scard(activeKey).catch(() => 0);
  if (activeCount >= MAX_CONCURRENT_SESSIONS_PER_WALLET) {
    throw new TooManyActiveSessionsError();
  }

  const now = new Date();
  const session: ServerGameSession = {
    sessionId,
    wallet: normalizedWallet,
    gameId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TTL * 1000).toISOString(),
    heartbeats: [now.getTime()],
  };
  const result = await redis().set(key(sessionId), session, { nx: true, ex: TTL });
  if (result === null) throw new Error("Game session collision");

  await redis().sadd(activeKey, sessionId);
  await redis().expire(activeKey, TTL);

  return session;
}

export async function getServerGameSession(sessionId: string): Promise<ServerGameSession | null> {
  const value = await redis().get<ServerGameSession>(key(sessionId));
  if (!value) return null;
  if (Date.parse(value.expiresAt) <= Date.now()) return null;
  if (!Array.isArray(value.heartbeats)) value.heartbeats = [];
  return value;
}

/**
 * Records a heartbeat using the server's own clock (never a client-supplied
 * timestamp), and verifies the session belongs to both the authenticated
 * wallet AND (when provided) the expected game id — so a session minted for
 * one game can never be used to satisfy the liveness requirement of
 * another. A consumed session (see consumeGameSession) can no longer be
 * heartbeated.
 */
export async function recordGameHeartbeat(sessionId: string, wallet: Address, gameId?: string): Promise<ServerGameSession | null> {
  const session = await getServerGameSession(sessionId);
  if (!session || session.wallet.toLowerCase() !== wallet.toLowerCase()) return null;
  if (gameId && session.gameId !== gameId) return null;
  if (session.consumedAt) return null;
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

/**
 * Marks a session as consumed (it backed a reward decision) and frees its
 * concurrent-session slot immediately. Idempotent: calling this more than
 * once for the same session is a no-op after the first call.
 */
export async function consumeGameSession(session: ServerGameSession): Promise<void> {
  if (session.consumedAt) return;
  const consumed: ServerGameSession = { ...session, consumedAt: new Date().toISOString() };
  await redis().set(key(session.sessionId), consumed, { ex: remainingTtlSeconds(session) });
  await redis().srem(activeSessionsKey(session.wallet), session.sessionId).catch(() => undefined);
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
