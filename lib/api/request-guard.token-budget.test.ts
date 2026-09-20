import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// In-memory store simulating Redis — eval is atomic (no await inside).
const store = new Map<string, string>();

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
  eval: vi.fn(async (script: string, keys: string[], args: string[]) => {
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
  }),
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
    // Defaults that keep request budgets from interfering unless a test overrides them.
    vi.stubEnv("AI_DAILY_REQUESTS_PER_WALLET", "100");
    vi.stubEnv("AI_DAILY_REQUESTS_GLOBAL", "5000");
    vi.stubEnv("AI_DAILY_TOKENS_PER_WALLET", "1000");
    vi.stubEnv("AI_DAILY_TOKENS_GLOBAL", "2000000");
    vi.stubEnv("AI_TOKEN_RESERVE_ESTIMATE", "600");
    mockedWallet = "0x1111111111111111111111111111111111111111";
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("regression: two concurrent requests with wallet limit 1000 and estimate 600 — only one may succeed", async () => {
    // Limit 1000, estimate 600. If the old GET-precheck were used, both would see 0<1000 and both would pass,
    // then both INCRBY 600 => 1200 would exceed the cap. With atomic reserve only one may pass.
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
    expect(Number(store.get(walletKey))).toBe(600);
  });

  it("regression: two concurrent global-only (unauthenticated) requests are also gated atomically", async () => {
    mockedWallet = null;
    vi.stubEnv("AI_DAILY_TOKENS_GLOBAL", "1000");
    // wallet limit irrelevant when unauthenticated
    const r1 = enforceAiDailyBudget(req());
    const r2 = enforceAiDailyBudget(req());
    const [a, b] = await Promise.all([r1, r2]);
    expect([a, b].filter((r) => r === null).length).toBe(1);
    expect([a, b].filter((r) => r && r.status === 429).length).toBe(1);
    const date = new Date().toISOString().slice(0, 10);
    const globalKey = `mpgrhub:ai:budget:daily:tokens:global:${date}`;
    expect(Number(store.get(globalKey))).toBe(600);
  });

  it("rolls back wallet reservation when global token budget would be exceeded", async () => {
    vi.stubEnv("AI_DAILY_TOKENS_PER_WALLET", "5000");
    vi.stubEnv("AI_DAILY_TOKENS_GLOBAL", "1000");
    vi.stubEnv("AI_TOKEN_RESERVE_ESTIMATE", "600");
    // Pre-fill global to 500 so next 600 would exceed 1000 (500+600>1000)
    const date = new Date().toISOString().slice(0, 10);
    store.set(`mpgrhub:ai:budget:daily:tokens:global:${date}`, "500");
    const res = await enforceAiDailyBudget(req());
    expect(res?.status).toBe(429);
    // Wallet reservation must have been rolled back — wallet key should be 0 (or absent), not 600.
    const walletKey = `mpgrhub:ai:budget:daily:tokens:wallet:${mockedWallet!.toLowerCase()}:${date}`;
    expect(Number(store.get(walletKey) ?? 0)).toBe(0);
    // Global remains at 500 (no leak)
    expect(Number(store.get(`mpgrhub:ai:budget:daily:tokens:global:${date}`))).toBe(500);
  });

  it("rolls back token reservation when request budget is exceeded", async () => {
    vi.stubEnv("AI_DAILY_REQUESTS_PER_WALLET", "1");
    vi.stubEnv("AI_DAILY_REQUESTS_GLOBAL", "5000");
    vi.stubEnv("AI_TOKEN_RESERVE_ESTIMATE", "600");
    vi.stubEnv("AI_DAILY_TOKENS_PER_WALLET", "5000");
    vi.stubEnv("AI_DAILY_TOKENS_GLOBAL", "5000000");
    // First request succeeds
    expect(await enforceAiDailyBudget(req())).toBeNull();
    const date = new Date().toISOString().slice(0, 10);
    const tokWallet = `mpgrhub:ai:budget:daily:tokens:wallet:${mockedWallet!.toLowerCase()}:${date}`;
    const tokGlobal = `mpgrhub:ai:budget:daily:tokens:global:${date}`;
    expect(Number(store.get(tokWallet))).toBe(600);
    expect(Number(store.get(tokGlobal))).toBe(600);
    // Second request should be blocked on request count and roll back its token reservation
    const res2 = await enforceAiDailyBudget(req());
    expect(res2?.status).toBe(429);
    expect(Number(store.get(tokWallet))).toBe(600);
    expect(Number(store.get(tokGlobal))).toBe(600);
  });

  it("recordAiTokenUsage adjusts reservation by delta = actual - estimate", async () => {
    vi.stubEnv("AI_TOKEN_RESERVE_ESTIMATE", "1000");
    vi.stubEnv("AI_DAILY_TOKENS_PER_WALLET", "5000");
    vi.stubEnv("AI_DAILY_TOKENS_GLOBAL", "5000000");
    // Reserve 1000
    expect(await enforceAiDailyBudget(req())).toBeNull();
    const date = new Date().toISOString().slice(0, 10);
    const wKey = `mpgrhub:ai:budget:daily:tokens:wallet:${mockedWallet!.toLowerCase()}:${date}`;
    const gKey = `mpgrhub:ai:budget:daily:tokens:global:${date}`;
    expect(Number(store.get(wKey))).toBe(1000);
    // Actual usage 250 => delta -750 => 250
    await recordAiTokenUsage(req(), 250);
    expect(Number(store.get(wKey))).toBe(250);
    expect(Number(store.get(gKey))).toBe(250);
    // Another request reserve 1000 => 1250, then actual 1500 => delta +500 => 1750
    expect(await enforceAiDailyBudget(req())).toBeNull();
    expect(Number(store.get(wKey))).toBe(1250);
    await recordAiTokenUsage(req(), 1500);
    expect(Number(store.get(wKey))).toBe(1750);
    expect(Number(store.get(gKey))).toBe(1750);
  });

  it("recordAiTokenUsage keeps reservation when actual equals estimate (delta 0)", async () => {
    vi.stubEnv("AI_TOKEN_RESERVE_ESTIMATE", "1000");
    expect(await enforceAiDailyBudget(req())).toBeNull();
    const date = new Date().toISOString().slice(0, 10);
    const wKey = `mpgrhub:ai:budget:daily:tokens:wallet:${mockedWallet!.toLowerCase()}:${date}`;
    const before = store.get(wKey);
    await recordAiTokenUsage(req(), 1000);
    expect(store.get(wKey)).toBe(before);
  });
});
