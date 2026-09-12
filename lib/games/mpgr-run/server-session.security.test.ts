// lib/games/mpgr-run/server-session.security.test.ts
//
// Regression coverage for the server-issued game session's security
// properties beyond heartbeatsCoverDuration() (already covered by
// server-session.test.ts): game-id binding, the per-wallet concurrent
// session cap, and single-use consumption. @upstash/redis is mocked
// entirely, following the same pattern as settlement-lock.test.ts — this
// exercises the module's own logic (which keys it reads/writes, what it
// does with the values it gets back), not a real Redis server.

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();
const zsets = new Map<string, Map<string, number>>();

const redisMock = {
  get: vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
  set: vi.fn(async (key: string, value: unknown, opts?: { nx?: boolean }) => {
    if (opts?.nx && store.has(key)) return null;
    store.set(key, value);
    return "OK";
  }),
  zremrangebyscore: vi.fn(async (key: string, min: number, max: number) => {
    const set = zsets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const [member, score] of set) {
      if (score >= min && score <= max) {
        set.delete(member);
        removed += 1;
      }
    }
    return removed;
  }),
  zcard: vi.fn(async (key: string) => zsets.get(key)?.size ?? 0),
  zadd: vi.fn(async (key: string, entry: { score: number; member: string }) => {
    const set = zsets.get(key) ?? new Map<string, number>();
    const existed = set.has(entry.member);
    set.set(entry.member, entry.score);
    zsets.set(key, set);
    return existed ? 0 : 1;
  }),
  zrem: vi.fn(async (key: string, member: string) => {
    return zsets.get(key)?.delete(member) ? 1 : 0;
  }),
  expire: vi.fn(async () => 1),
};

vi.mock("@upstash/redis", () => ({
  Redis: vi.fn(function () {
    return redisMock;
  }),
}));

process.env.UPSTASH_REDIS_REST_URL = "https://example-test.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";

const WALLET = "0x2222222222222222222222222222222222222222" as `0x${string}`;

describe("server game session security properties", () => {
  beforeEach(() => {
    store.clear();
    zsets.clear();
    vi.clearAllMocks();
  });

  it("issues a cryptographically-sized seed and locks protocol version", async () => {
    const {
      createServerGameSession,
      MPGR_RUN_PROTOCOL_VERSION,
    } = await import("./server-session");

    const session = await createServerGameSession(
      WALLET,
      "mpgr-run",
      "session-seed-a",
    );

    expect(session.protocolVersion).toBe(MPGR_RUN_PROTOCOL_VERSION);
    expect(session.protocolVersion).toBe(1);
    expect(session.seed).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates different seeds for separate sessions", async () => {
    const { createServerGameSession } = await import("./server-session");

    const first = await createServerGameSession(
      WALLET,
      "mpgr-run",
      "session-seed-b",
    );
    const second = await createServerGameSession(
      WALLET,
      "mpgr-run",
      "session-seed-c",
    );

    expect(first.seed).not.toBe(second.seed);
  });

  it("binds the issued seed and protocol version to the stored session", async () => {
    const {
      createServerGameSession,
      getServerGameSession,
      MPGR_RUN_PROTOCOL_VERSION,
    } = await import("./server-session");

    const created = await createServerGameSession(
      WALLET,
      "mpgr-run",
      "session-seed-d",
    );
    const stored = await getServerGameSession(created.sessionId);

    expect(stored).toMatchObject({
      sessionId: created.sessionId,
      wallet: WALLET.toLowerCase(),
      gameId: "mpgr-run",
      seed: created.seed,
      protocolVersion: MPGR_RUN_PROTOCOL_VERSION,
    });
  });

  it("rejects a heartbeat whose session was issued for a different game id", async () => {
    const { createServerGameSession, recordGameHeartbeat } = await import("./server-session");
    const session = await createServerGameSession(WALLET, "some-other-game", "session-a");
    const result = await recordGameHeartbeat(session.sessionId, WALLET, "mpgr-run");
    expect(result).toBeNull();
  });

  it("accepts a heartbeat whose game id matches the session", async () => {
    const { createServerGameSession, recordGameHeartbeat } = await import("./server-session");
    const session = await createServerGameSession(WALLET, "mpgr-run", "session-b");
    const result = await recordGameHeartbeat(session.sessionId, WALLET, "mpgr-run");
    expect(result).not.toBeNull();
  });

  it("fails closed once a wallet already has the maximum number of active sessions", async () => {
    const { createServerGameSession, MAX_CONCURRENT_SESSIONS_PER_WALLET, TooManyActiveSessionsError } = await import(
      "./server-session"
    );
    for (let i = 0; i < MAX_CONCURRENT_SESSIONS_PER_WALLET; i += 1) {
      await createServerGameSession(WALLET, "mpgr-run", `session-${i}`);
    }
    await expect(createServerGameSession(WALLET, "mpgr-run", "session-overflow")).rejects.toBeInstanceOf(
      TooManyActiveSessionsError,
    );
  });

  it("frees the concurrent-session slot once a session is consumed", async () => {
    const { createServerGameSession, consumeGameSession, MAX_CONCURRENT_SESSIONS_PER_WALLET } = await import(
      "./server-session"
    );
    const sessions = [];
    for (let i = 0; i < MAX_CONCURRENT_SESSIONS_PER_WALLET; i += 1) {
      sessions.push(await createServerGameSession(WALLET, "mpgr-run", `session-${i}`));
    }
    await consumeGameSession(sessions[0]);
    // A slot should now be free.
    await expect(createServerGameSession(WALLET, "mpgr-run", "session-after-consume")).resolves.toMatchObject({
      sessionId: "session-after-consume",
    });
  });

  it("rejects a heartbeat on a session that has already been consumed", async () => {
    const { createServerGameSession, consumeGameSession, recordGameHeartbeat } = await import("./server-session");
    const session = await createServerGameSession(WALLET, "mpgr-run", "session-c");
    await consumeGameSession(session);
    const result = await recordGameHeartbeat(session.sessionId, WALLET, "mpgr-run");
    expect(result).toBeNull();
  });

  it("consuming a session twice is a harmless no-op", async () => {
    const { createServerGameSession, consumeGameSession } = await import("./server-session");
    const session = await createServerGameSession(WALLET, "mpgr-run", "session-d");
    await consumeGameSession(session);
    await expect(consumeGameSession(session)).resolves.toBeUndefined();
  });
});
