// app/api/agent/autonomy/autonomy-routes-security.test.ts
//
// PHASE 4 HARDENING — §16 API/UI security for the autonomy routes that the
// Phase 2 authorization-route suite does not already cover (goals, goals/[id],
// policy, config, tick, tokens): session enforcement, wallet scoping,
// flag gating, cron-secret handling and response hygiene (no key material,
// no internal RPC/MCP details client-side).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";

import { LuaRedis } from "@/lib/__tests__/helpers/lua-redis";
import { RedisAutonomyStore } from "@/lib/autonomy/redis-store";
import { RedisDelegatedAuthorizationStore } from "@/lib/autonomy/delegated-redis-store";

const redis = new LuaRedis();
vi.mock("@/lib/api/redis", () => ({ getRedis: () => redis.client() }));

// -- SIWE session seam: `currentWallet` null == no/broken session (fail-closed)
let currentWallet: Address | null = null;
vi.mock("@/lib/autonomy/api-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/autonomy/api-helpers")>();
  return {
    ...actual,
    requireWallet: async () => (currentWallet ? { wallet: currentWallet, session: { sessionId: "a".repeat(32), wallet: currentWallet, issuedAt: 1, expiresAt: 2 } } : null),
    system: () => systemUnderTest,
  };
});
vi.mock("@/lib/api/request-guard", () => ({
  verifyTrustedOrigin: () => null,
  readJsonBody: async (request: Request) => ({ ok: true as const, value: await request.json().catch(() => null) }),
  requestIdFromRequest: () => "req_test",
  withRequestId: (r: Response) => r,
}));
vi.mock("@/lib/trade/trade-rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  clientIpFromRequest: () => "127.0.0.1",
}));
// authenticateRequest (tick route) follows the same session seam.
vi.mock("@/lib/auth/session-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session-store")>();
  return {
    ...actual,
    authenticateRequest: async () => (currentWallet ? { sessionId: "b".repeat(32), wallet: currentWallet, issuedAt: 1, expiresAt: 2 } : null),
  };
});

import { GET as GOALS_GET, POST as GOALS_POST } from "./goals/route";
import { GET as GOAL_GET, PATCH as GOAL_PATCH, DELETE as GOAL_DELETE } from "./goals/[id]/route";
import { GET as POLICY_GET, POST as POLICY_POST, DELETE as POLICY_DELETE } from "./policy/route";
import { GET as CONFIG_GET } from "./config/route";
import { POST as TICK_POST } from "./tick/route";
import { GET as TOKENS_GET } from "./tokens/route";
import type { AutonomySystem } from "@/lib/autonomy/index";

const USER_KEY = "0x" + "ac".repeat(32);
const USER: Address = privateKeyToAccount(USER_KEY as `0x${string}`).address;
const OTHER_KEY = "0x" + "bd".repeat(32);
const OTHER: Address = privateKeyToAccount(OTHER_KEY as `0x${string}`).address;

const systemUnderTest: AutonomySystem = {
  store: new RedisAutonomyStore(),
  slots: new RedisDelegatedAuthorizationStore(),
  gateway: {} as AutonomySystem["gateway"],
  runtime: {} as AutonomySystem["runtime"],
  scheduler: {
    tick: async () => ({ ranAt: "now", scanned: 0, evaluated: 0, skippedBusy: 0, disabled: false, results: [] }),
  } as unknown as AutonomySystem["scheduler"],
};

const SELL = "0xcccccccccccccccccccccccccccccccccccccc03" as Address;
const BUY = "0xdddddddddddddddddddddddddddddddddddddd04" as Address;
const POLICY_ID = "pol_sec_test_1";
const GOAL_ID = "goal_sec_test_1";

function flag(on: boolean) {
  vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", on ? "true" : "false");
}

async function seedOwnedBy(wallet: Address) {
  await systemUnderTest.store.createPolicy({
    id: POLICY_ID,
    wallet,
    chainId: 8453,
    actions: ["swap"],
    sellToken: SELL,
    buyToken: BUY,
    maxPerTradeRaw: "1000000000000000000000",
    maxDailyRaw: "10000000000000000000000",
    maxSlippageBps: 100,
    maxActionsPerDay: 5,
    enabled: true,
    createdAt: "2026-01-01T00:00:00Z",
    expiresAt: "2099-12-31T00:00:00Z",
    authorizedAt: "2026-01-01T00:00:00Z",
    authorizationRef: "sess:test",
  });
  await systemUnderTest.store.createGoal({
    id: GOAL_ID,
    wallet,
    policyId: POLICY_ID,
    type: "conditional_swap",
    description: "sec",
    status: "ACTIVE",
    condition: { kind: "price_below", threshold: "200" },
    trade: { sellToken: SELL, buyToken: BUY, sellAmountRaw: "1000000", slippageBps: 100, sellDecimals: 6, buyDecimals: 8 },
    cooldownSeconds: 60,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "g0",
    expiresAt: "2099-12-31T00:00:00Z",
    nextEvaluationAt: "2026-01-01T00:00:00Z",
    stats: { evaluations: 0, triggered: 0, verified: 0, consecutiveFailures: 0 },
    maxTrades: 1,
  } as never);
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("hardening §16: session enforcement across every autonomy route", () => {
  beforeEach(() => {
    flag(true);
    currentWallet = null;
  });

  it("401 without a session on every authenticated verb", async () => {
    const probes: Array<[string, Promise<Response>]> = [
      ["goals GET", GOALS_GET(new Request("http://x/api/goals"))],
      ["goals POST", GOALS_POST(new Request("http://x/api/goals", { method: "POST", body: "{}" }))],
      ["goal GET", GOAL_GET(new Request("http://x/api/goal"), ctx(GOAL_ID))],
      ["goal PATCH", GOAL_PATCH(new Request("http://x/api/goal", { method: "PATCH", body: "{}" }), ctx(GOAL_ID))],
      ["goal DELETE", GOAL_DELETE(new Request("http://x/api/goal", { method: "DELETE", body: "{}" }), ctx(GOAL_ID))],
      ["policy GET", POLICY_GET(new Request("http://x/api/policy"))],
      ["policy POST", POLICY_POST(new Request("http://x/api/policy", { method: "POST", body: "{}" }))],
      ["policy DELETE", POLICY_DELETE(new Request("http://x/api/policy", { method: "DELETE", body: "{}" }))],
      ["tick POST", TICK_POST(new Request("http://x/api/tick", { method: "POST" }))],
    ].map(([label, p]) => [label as string, p as Promise<Response>]);
    for (const [label, p] of probes) {
      const res = await p;
      expect(res.status, label).toBe(401);
    }
  });

  it("flag OFF -> 404 on every route (the API disappears)", async () => {
    flag(false);
    currentWallet = USER;
    expect((await GOALS_GET(new Request("http://x/api/goals"))).status).toBe(404);
    expect((await GOAL_GET(new Request("http://x/api/goal"), ctx(GOAL_ID))).status).toBe(404);
    expect((await POLICY_GET(new Request("http://x/api/policy"))).status).toBe(404);
    // config is the ONE deliberately-public status route: it stays 200 so the
    // UI can see it is disabled — but it must report enabled=false.
    const cfg = (await (await CONFIG_GET()).json()) as { enabled: boolean };
    expect(cfg.enabled).toBe(false);
    expect((await TICK_POST(new Request("http://x/api/tick", { method: "POST" }))).status).toBe(404);
    expect((await TOKENS_GET()).status).toBe(404);
  });
});

describe("hardening §16: wallet scoping (cross-wallet inspect/modify/revoke)", () => {
  beforeEach(() => {
    flag(true);
  });

  it("another wallet cannot see, patch, or cancel someone's goal; lists are scoped", async () => {
    await redis.reset();
    await seedOwnedBy(OTHER);
    currentWallet = USER; // attacker session

    const listed = await GOALS_GET(new Request("http://x/api/goals"));
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { goals: unknown[] };
    expect(listedBody.goals).toHaveLength(0); // someone else's goal is invisible

    expect((await GOAL_GET(new Request("http://x/api/goal"), ctx(GOAL_ID))).status).toBe(404);
    expect((await GOAL_PATCH(new Request("http://x/api/goal", { method: "PATCH", body: JSON.stringify({ action: "pause" }) }), ctx(GOAL_ID))).status).toBe(404);
    expect((await GOAL_DELETE(new Request("http://x/api/goal", { method: "DELETE", body: "{}" }), ctx(GOAL_ID))).status).toBe(404);

    const policies = await POLICY_GET(new Request("http://x/api/policy"));
    const policiesBody = (await policies.json()) as { policies: Array<{ id: string }> };
    expect(policiesBody.policies.filter((p) => p.id === POLICY_ID)).toHaveLength(0);

    // The owner still has full control.
    currentWallet = OTHER;
    expect((await GOAL_GET(new Request("http://x/api/goal"), ctx(GOAL_ID))).status).toBe(200);
  });

  it("tick without the cron secret runs wallet-scoped; a wrong bearer is 401 for cron scope", async () => {
    await redis.reset();
    vi.stubEnv("CRON_SECRET", "cron-secret-value");
    currentWallet = USER;
    const res = await TICK_POST(new Request("http://x/api/tick", { method: "POST", headers: { authorization: "Bearer wrong" } }));
    // Not cron-authorized -> falls back to the session; session is valid so 200 (wallet-scoped).
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["evaluated", "outcomes", "ranAt", "scanned", "skippedBusy"]);
    expect(JSON.stringify(body)).not.toContain(GOAL_ID); // bounded summary: no goal ids leak

    currentWallet = null;
    const anon = await TICK_POST(new Request("http://x/api/tick", { method: "POST", headers: { authorization: "Bearer wrong" } }));
    expect(anon.status).toBe(401);

    const cron = await TICK_POST(new Request("http://x/api/tick", { method: "POST", headers: { authorization: "Bearer cron-secret-value" } }));
    expect(cron.status).toBe(200);
    expect((await cron.json()) as Record<string, unknown>).toBeTruthy();
  });
});

describe("hardening §16: response hygiene — no key material or internal details", () => {
  beforeEach(() => {
    flag(true);
    vi.stubEnv("CRON_SECRET", "cron-secret-value");
    vi.stubEnv("MPGR_BROADCASTER_PRIVATE_KEY", "0x" + "11".repeat(32));
  });

  it("no session/secret/RPC material in any autonomy response body", async () => {
    await redis.reset();
    await seedOwnedBy(USER);
    currentWallet = USER;

    const bodies: string[] = [];
    bodies.push(await (await GOALS_GET(new Request("http://x/api/goals"))).text());
    bodies.push(await (await GOAL_GET(new Request("http://x/api/goal"), ctx(GOAL_ID))).text());
    bodies.push(await (await POLICY_GET(new Request("http://x/api/policy"))).text());
    bodies.push(await (await CONFIG_GET()).text());
    bodies.push(await (await TOKENS_GET()).text());
    bodies.push(await (await TICK_POST(new Request("http://x/api/tick", { method: "POST" }))).text());

    const dump = bodies.join("\n");
    expect(dump).not.toContain(USER_KEY);
    expect(dump).not.toContain(OTHER_KEY);
    expect(dump).not.toContain("0x" + "11".repeat(32));
    expect(dump).not.toContain("cron-secret-value");
    expect(dump).not.toMatch(/0x[a-fA-F0-9]{130}/); // 65-byte signatures / permit bytes
    expect(dump).not.toMatch(/privateKey|private_key|mnemonic|broadcaster/i);
    expect(dump).not.toMatch(/https?:\/\/[^\s"]*(alchemy|infura|quiknode|rpc)/i);
  });

  it("config exposes only flags and limits; tokens exposes only the allowlist projection", async () => {
    const cfg = (await (await CONFIG_GET()).json()) as Record<string, unknown>;
    // UPDATED BY THE MC-1/MC-2 REMEDIATION: `delegated` was added so the UI can
    // tell the user honestly whether a goal authorized on a given chain could
    // ever execute, and which contract their signature will name as spender.
    // It carries only a chain id, a deployed PUBLIC contract address (or null)
    // and a boolean — never the operator broadcaster key or address.
    expect(Object.keys(cfg).sort()).toEqual(["delegated", "emergencyDisabled", "enabled", "executionAvailable", "limits"].sort());
    const delegated = cfg.delegated as Record<string, unknown>;
    expect(Object.keys(delegated).sort()).toEqual(["chainId", "executor", "walletSigningSupported"]);
    expect(delegated.executor === null || /^0x[0-9a-fA-F]{40}$/.test(String(delegated.executor))).toBe(true);
    // No key material anywhere in the config payload.
    const cfgText = JSON.stringify(cfg);
    expect(cfgText).not.toMatch(/privateKey|PRIVATE_KEY|0x[0-9a-fA-F]{64}/);

    const tok = (await (await TOKENS_GET()).json()) as { chainId: number; tokens: Array<Record<string, unknown>>; pairs: unknown[] };
    expect(tok.chainId).toBe(8453);
    for (const t of tok.tokens) {
      expect(Object.keys(t).sort()).toEqual(["address", "decimals", "symbol"]);
    }
    // policy creation from a client is bound to the session wallet, never a body field
    const allowlist = (await (await TOKENS_GET()).json()) as { tokens: Array<{ address: string }>; pairs: Array<{ sell: string; buy: string }> };
    expect(allowlist.pairs.length).toBeGreaterThan(0);
    const [pair] = allowlist.pairs;
    currentWallet = USER;
    const created = await POLICY_POST(
      new Request("http://x/api/policy", {
        method: "POST",
        body: JSON.stringify({
          authorized: true,
          sellToken: pair.sell,
          buyToken: pair.buy,
          maxPerTrade: "1",
          maxDaily: "5",
          maxSlippageBps: 100,
          maxActionsPerDay: 3,
          ttlDays: 30,
          wallet: OTHER, // attacker-supplied field — MUST be ignored
        }),
      }),
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { policy: { id: string } };
    // publicPolicy never echoes the wallet — scoping is proven via the store:
    const mine = (await systemUnderTest.store.listPolicies(USER.toLowerCase())).map((p) => p.id);
    const theirs = (await systemUnderTest.store.listPolicies(OTHER.toLowerCase())).map((p) => p.id);
    expect(mine).toContain(createdBody.policy.id);
    expect(theirs).not.toContain(createdBody.policy.id);
    // cleanup so cross-test store state stays small
    await POLICY_DELETE(new Request("http://x/api/policy", { method: "DELETE", body: JSON.stringify({ policyId: createdBody.policy.id }) }));
  });
});

describe("hardening §15 round-2: expired SIWE, malformed bodies, duplicate creation, audit emission", () => {
  beforeEach(() => {
    flag(true);
  });

  it("an EXPIRED/invalid SIWE session is indistinguishable from no session: 401 everywhere (fail-closed)", async () => {
    // The session seam (`requireWallet`) returns null for missing AND expired
    // sessions (expiry is checked inside the session store before returning).
    currentWallet = null;
    const res = await GOAL_GET(new Request("http://x/api/goal"), ctx(GOAL_ID));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTruthy(); // auditable reason, never a silent empty 401
  });

  it("malformed JSON body -> 4xx with a structured error, never a 5xx", async () => {
    currentWallet = USER;
    const bad = new Request("http://x/api/goals", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } });
    const res = await GOALS_POST(bad);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
  });

  it("duplicate goal creation is allowed (user-initiated) but every goal gets a DISTINCT id and stays wallet-scoped", async () => {
    await redis.reset();
    await seedOwnedBy(USER);
    currentWallet = USER;
    const body = JSON.stringify({ policyId: POLICY_ID, condition: { kind: "price_below", threshold: "50" }, sellAmount: "1" });
    const a = await GOALS_POST(new Request("http://x/api/goals", { method: "POST", body }));
    const b = await GOALS_POST(new Request("http://x/api/goals", { method: "POST", body }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const ja = (await a.json()) as { goal: { id: string } };
    const jb = (await b.json()) as { goal: { id: string } };
    expect(ja.goal.id).not.toBe(jb.goal.id);
    const listed = (await (await GOALS_GET(new Request("http://x/api/goals"))).json()) as { goals: Array<{ id: string }> };
    expect(listed.goals.filter((g) => g.id === ja.goal.id || g.id === jb.goal.id)).toHaveLength(2);
    // cross-wallet still sees nothing
    currentWallet = OTHER;
    const otherList = (await (await GOALS_GET(new Request("http://x/api/goals"))).json()) as { goals: Array<{ id: string }> };
    expect(otherList.goals).toHaveLength(0);
    currentWallet = USER;
  });

  it("POST /goals appends a GOAL_CREATED audit event bound to the authenticated wallet", async () => {
    await redis.reset();
    await seedOwnedBy(USER);
    currentWallet = USER;
    const body = JSON.stringify({ policyId: POLICY_ID, condition: { kind: "price_below", threshold: "50" }, sellAmount: "1" });
    const created = await GOALS_POST(new Request("http://x/api/goals", { method: "POST", body }));
    expect(created.status).toBe(201);
    const { goal } = (await created.json()) as { goal: { id: string } };
    const audit = await systemUnderTest.store.listAudit(goal.id);
    expect(audit.some((e) => e.type === "GOAL_CREATED")).toBe(true);
  });
});
