import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// In-memory store simulating Redis — eval is atomic (no await inside).
const store = new Map<string, string>();

const STRICT_TOKEN_RESERVE = 16 * 1024 + 12_000 + 8_000 + 700 + 8192;

async function evalRedisScript(script: string, keys: string[], args: string[]): Promise<unknown> {
  if (script.includes("local delta")) {
    const key = keys[0];
    const delta = Number(args[0]);
    const raw = store.get(key);
    const cur = raw == null ? 0 : Number(raw);
    const next = Math.max(0, (Number.isFinite(cur) ? cur : 0) + delta);
    store.set(key, String(next));
    return next;
  }
  // TOKEN_RESERVE_LUA contains "cur + est > limit"
  if (script.includes("cur + est > limit")) {
    const key = keys[0];
    const est = Number(args[0]);
    const limit = Number(args[1]);
    // ttl = args[2] ignored for test
    const raw = store.get(key);
    const cur = raw == null ? 0 : Number(raw);
    const curNum = Number.isFinite(cur) ? cur : 0;
    if (curNum + est > limit) return 0;
    const next = curNum + est;
    store.set(key, String(next));
    return 1;
  }
  if (script.includes("INCRBY")) {
    const key = keys[0];
    const inc = Number(args[0]);
    const cur = store.get(key) ? Number(store.get(key)) : 0;
    const next = (Number.isFinite(cur) ? cur : 0) + inc;
    store.set(key, String(next));
    return next;
  }
  if (script.includes("INCR")) {
    const key = keys[0];
    const cur = store.get(key) ? Number(store.get(key)) : 0;
    const next = (Number.isFinite(cur) ? cur : 0) + 1;
    store.set(key, String(next));
    return next;
  }
  return null;
}

const fakeRedis = {
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  set: vi.fn(async (key: string, v: string) => {
    store.set(key, v);
    return "OK";
  }),
  incr: vi.fn(async (key: string) => {
    const cur = store.get(key) ? Number(store.get(key)) : 0;
    const next = (Number.isFinite(cur) ? cur : 0) + 1;
    store.set(key, String(next));
    return next;
  }),
  incrby: vi.fn(async (key: string, n: number) => {
    const cur = store.get(key) ? Number(store.get(key)) : 0;
    const next = (Number.isFinite(cur) ? cur : 0) + n;
    store.set(key, String(next));
    return next;
  }),
  expire: vi.fn(async () => 1),
  // Lua evaluator — atomic, synchronous on store.
  eval: vi.fn(evalRedisScript),
};

vi.mock("@/lib/api/redis", () => ({
  getRedis: () => fakeRedis as unknown as ReturnType<typeof import("@/lib/api/redis").getRedis>,
}));

let mockedWallet: string | null = "0x1111111111111111111111111111111111111111";

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    getSessionFromRequest: vi.fn(() => (mockedWallet ? { wallet: mockedWallet, chainId: 8453, issuedAt: 0, expiresAt: 9999999999, sessionId: "test" } : null)),
  };
});

import { enforceAiDailyBudget, recordAiTokenUsage } from "./request-guard";

function req(): Request {
  return new Request("https://mpgrhub.xyz/api/agent/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
}

describe("AI daily token budget — atomic reservation (concurrency fix)", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    fakeRedis.eval.mockImplementation(evalRedisScript);
    // Defaults that keep request budgets from interfering unless a test overrides them.
    vi.stubEnv("AI_DAILY_REQUESTS_PER_WALLET", "100");
    vi.stubEnv("AI_DAILY_REQUESTS_GLOBAL", "5000");
    vi.stubEnv("AI_DAILY_TOKENS_PER_WALLET", String(STRICT_TOKEN_RESERVE + 5000));
    vi.stubEnv("AI_DAILY_TOKENS_GLOBAL", "2000000");
    vi.stubEnv("AI_TOKEN_RESERVE_ESTIMATE", String(STRICT_TOKEN_RESERVE));
    mockedWallet = "0x1111111111111111111111111111111111111111";
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("regression: two concurrent requests with wallet limit below two reservations — only one may succeed", async () => {
    vi.stubEnv("AI_DAILY_TOKENS_PER_WALLET", String(STRICT_TOKEN_RESERVE + 1000));
    // If the old GET-precheck were used, both would see the same balance and both would pass,
    // then both INCRBY the strict reservation and exceed the cap. With atomic reserve only one may pass.
    const r1 = enforceAiDailyBudget(req());
    const r2 = enforceAiDailyBudget(req());
    const [a, b] = await Promise.all([r1, r2]);
    const successes = [a, b].filter((r) => r === null).length;
    const blocked = [a, b].filter((r) => r !== null && r.status === 429).length;
    expect(successes).toBe(1);
    expect(blocked).toBe(1);
    // Store must reflect only one reservation, not overshoot.
    const date = new Date().toISOString().slice(0, 10);
    const walletKey = `mpgrhub:ai:budget:daily:tokens:wallet:${mockedWallet!.toLowerCase()}:${date}`;
    expect(Number(store.get(walletKey))).toBe(STRICT_TOKEN_RESERVE);
  });

  it("regression: two concurrent global-only (unauthenticated) requests are also gated atomically", async () => {
    mockedWallet = null;
    vi.stubEnv("AI_DAILY_TOKENS_GLOBAL", String(STRICT_TOKEN_RESERVE + 1000));
    // wallet limit irrelevant when unauthenticated
    const r1 = enforceAiDailyBudget(req());
    const r2 = enforceAiDailyBudget(req());
    const [a, b] = await Promise.all([r1, r2]);
    expect([a, b].filter((r) => r === null).length).toBe(1);
    expect([a, b].filter((r) => r && r.status === 429).length).toBe(1);
    const date = new Date().toISOString().slice(0, 10);
    const globalKey = `mpgrhub:ai:budget:daily:tokens:global:${date}`;
    expect(Number(store.get(globalKey))).toBe(STRICT_TOKEN_RESERVE);
  });

  it("rolls back wallet reservation when global token budget would be exceeded", async () => {
    vi.stubEnv("AI_DAILY_TOKENS_PER_WALLET", String(STRICT_TOKEN_RESERVE + 5000));
    vi.stubEnv("AI_DAILY_TOKENS_GLOBAL", String(STRICT_TOKEN_RESERVE + 500));
    vi.stubEnv("AI_TOKEN_RESERVE_ESTIMATE", String(STRICT_TOKEN_RESERVE));
    // Pre-fill global so the next strict reservation would exceed the global cap.
    const date = new Date().toISOString().slice(0, 10);
    store.set(`mpgrhub:ai:budget:daily:tokens:global:${date}`, "1000");
    const res = await enforceAiDailyBudget(req());
    expect(res?.status).toBe(429);
    // Wallet reservation must have been rolled back — wallet key should be 0 (or absent), not reserved.
    const walletKey = `mpgrhub:ai:budget:daily:tokens:wallet:${mockedWallet!.toLowerCase()}:${date}`;
    expect(Number(store.get(walletKey) ?? 0)).toBe(0);
    // Global remains unchanged (no leak)
    expect(Number(store.get(`mpgrhub:ai:budget:daily:tokens:global:${date}`))).toBe(1000);
  });

  it("rolls back token reservation when request budget is exceeded", async () => {
    vi.stubEnv("AI_DAILY_REQUESTS_PER_WALLET", "1");
    vi.stubEnv("AI_DAILY_REQUESTS_GLOBAL", "5000");
    vi.stubEnv("AI_TOKEN_RESERVE_ESTIMATE", String(STRICT_TOKEN_RESERVE));
    vi.stubEnv("AI_DAILY_TOKENS_PER_WALLET", String(STRICT_TOKEN_RESERVE * 3));
    vi.stubEnv("AI_DAILY_TOKENS_GLOBAL", "5000000");
    // First request succeeds
    expect(await enforceAiDailyBudget(req())).toBeNull();
    const date = new Date().toISOString().slice(0, 10);
    const tokWallet = `mpgrhub:ai:budget:daily:tokens:wallet:${mockedWallet!.toLowerCase()}:${date}`;
    const tokGlobal = `mpgrhub:ai:budget:daily:tokens:global:${date}`;
    expect(Number(store.get(tokWallet))).toBe(STRICT_TOKEN_RESERVE);
    expect(Number(store.get(tokGlobal))).toBe(STRICT_TOKEN_RESERVE);
    // Second request should be blocked on request count and roll back its token reservation
    const res2 = await enforceAiDailyBudget(req());
    expect(res2?.status).toBe(429);
    expect(Number(store.get(tokWallet))).toBe(STRICT_TOKEN_RESERVE);
    expect(Number(store.get(tokGlobal))).toBe(STRICT_TOKEN_RESERVE);
  });

  it("recordAiTokenUsage adjusts reservation by delta = actual - effective estimate", async () => {
    vi.stubEnv("AI_TOKEN_RESERVE_ESTIMATE", "1000");
    vi.stubEnv("AI_DAILY_TOKENS_PER_WALLET", String(STRICT_TOKEN_RESERVE * 3));
    vi.stubEnv("AI_DAILY_TOKENS_GLOBAL", "5000000");
    // Env asks for 1000, but the effective production reservation is raised to the strict upper bound.
    expect(await enforceAiDailyBudget(req())).toBeNull();
    const date = new Date().toISOString().slice(0, 10);
    const wKey = `mpgrhub:ai:budget:daily:tokens:wallet:${mockedWallet!.toLowerCase()}:${date}`;
    const gKey = `mpgrhub:ai:budget:daily:tokens:global:${date}`;
    expect(Number(store.get(wKey))).toBe(STRICT_TOKEN_RESERVE);
    // Actual usage 250 => reservation is reduced to actual usage
    await recordAiTokenUsage(req(), 250);
    expect(Number(store.get(wKey))).toBe(250);
    expect(Number(store.get(gKey))).toBe(250);
    // Another request reserves the strict bound; recording 1500 leaves cumulative actual usage at 1750.
    expect(await enforceAiDailyBudget(req())).toBeNull();
    expect(Number(store.get(wKey))).toBe(250 + STRICT_TOKEN_RESERVE);
    await recordAiTokenUsage(req(), 1500);
    expect(Number(store.get(wKey))).toBe(1750);
    expect(Number(store.get(gKey))).toBe(1750);
  });

  it("recordAiTokenUsage keeps reservation when actual equals effective estimate (delta 0)", async () => {
    vi.stubEnv("AI_TOKEN_RESERVE_ESTIMATE", String(STRICT_TOKEN_RESERVE));
    expect(await enforceAiDailyBudget(req())).toBeNull();
    const date = new Date().toISOString().slice(0, 10);
    const wKey = `mpgrhub:ai:budget:daily:tokens:wallet:${mockedWallet!.toLowerCase()}:${date}`;
    const before = store.get(wKey);
    await recordAiTokenUsage(req(), STRICT_TOKEN_RESERVE);
    expect(store.get(wKey)).toBe(before);
  });

  it("regression: actual usage above unsafe 1000 env reservation cannot exceed the configured daily limit", async () => {
    vi.stubEnv("AI_TOKEN_RESERVE_ESTIMATE", "1000");
    vi.stubEnv("AI_DAILY_TOKENS_PER_WALLET", String(STRICT_TOKEN_RESERVE + 100));
    vi.stubEnv("AI_DAILY_TOKENS_GLOBAL", "5000000");

    expect(await enforceAiDailyBudget(req())).toBeNull();
    const date = new Date().toISOString().slice(0, 10);
    const wKey = `mpgrhub:ai:budget:daily:tokens:wallet:${mockedWallet!.toLowerCase()}:${date}`;
    expect(Number(store.get(wKey))).toBe(STRICT_TOKEN_RESERVE);

    await recordAiTokenUsage(req(), 1500);
    expect(Number(store.get(wKey))).toBe(1500);
    expect(Number(store.get(wKey))).toBeLessThanOrEqual(STRICT_TOKEN_RESERVE + 100);

    const next = await enforceAiDailyBudget(req());
    expect(next?.status).toBe(429);
  });

  it("rolls back only its own wallet reservation when global reservation fails amid another wallet reservation", async () => {
    vi.stubEnv("AI_DAILY_TOKENS_PER_WALLET", String(STRICT_TOKEN_RESERVE * 3));
    vi.stubEnv("AI_DAILY_TOKENS_GLOBAL", String(STRICT_TOKEN_RESERVE));
    const date = new Date().toISOString().slice(0, 10);
    const walletKey = `mpgrhub:ai:budget:daily:tokens:wallet:${mockedWallet!.toLowerCase()}:${date}`;
    const globalKey = `mpgrhub:ai:budget:daily:tokens:global:${date}`;
    store.set(globalKey, "1");

    const originalEval = fakeRedis.eval.getMockImplementation();
    fakeRedis.eval.mockImplementation(async (script: string, keys: string[], args: string[]) => {
      if (script.includes("cur + est > limit") && keys[0] === globalKey) {
        store.set(walletKey, String((Number(store.get(walletKey) ?? 0) || 0) + STRICT_TOKEN_RESERVE));
      }
      return originalEval?.(script, keys, args) ?? null;
    });

    const res = await enforceAiDailyBudget(req());
    expect(res?.status).toBe(429);
    expect(Number(store.get(walletKey))).toBe(STRICT_TOKEN_RESERVE);
    expect(Number(store.get(globalKey))).toBe(1);
  });

  it("production fails closed instead of falling back to non-atomic token reservation when Lua eval fails", async () => {
    vi.stubEnv("NODE_ENV", "production");
    fakeRedis.eval.mockRejectedValueOnce(new Error("lua unavailable"));

    const res = await enforceAiDailyBudget(req());
    expect(res?.status).toBe(503);
    expect(fakeRedis.incrby).not.toHaveBeenCalled();
    expect([...store.values()]).toHaveLength(0);
  });
});
