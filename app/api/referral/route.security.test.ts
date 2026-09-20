// Task 8 — referral abuse hardening (route-level, real handlers).
//
// Drives the REAL POST /api/referral and POST /api/xp handlers against the
// fengari Redis double (same harness as app/api/auth/auth-flow.security.test.ts):
// real session store, real origin check, real rate limiter, real XP ledger.
// Only the clock is pinned (fake timers) so UTC-day counters and the 60 s
// rate-limit windows are deterministic.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

import { LuaRedis } from "@/lib/__tests__/helpers/lua-redis";

const redis = new LuaRedis();
vi.mock("@/lib/api/redis", () => ({ getRedis: () => redis.client() }));

const APP_ORIGIN = "https://mpgrhub.xyz";
vi.stubEnv("AUTH_SESSION_SECRET", "s".repeat(32));
vi.stubEnv("APP_ORIGIN", APP_ORIGIN);

const BASE = Date.parse("2026-09-20T12:00:00.000Z");
let suiteTick = 0;

function addr(body: string): Address {
  const hex = body.padEnd(40, "0").slice(0, 40);
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) throw new Error("bad test address " + body);
  return `0x${hex}` as Address;
}
const A = addr("Aa1111111111111111111111111111111111bB"); // attacker/referrer
const B = addr("2222222222222222222222222222222222222222"); // referred wallet
const C = addr("Cc333333333333333333333333333333333333dD"); // another referrer

async function cookieFor(wallet: Address): Promise<string> {
  const { issueSession } = await import("@/lib/auth/session-store");
  const { value } = await issueSession(wallet);
  return `mpgr_session=${value}`;
}

async function postReferral(cookie: string, referrer: string, extra: Record<string, unknown> = {}): Promise<Response> {
  const { POST } = await import("./route");
  return POST(
    new Request(`${APP_ORIGIN}/api/referral`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN, cookie },
      body: JSON.stringify({ referrer, ...extra }),
    }),
  );
}

async function postReferralRaw(cookie: string, rawBody: string, origin = APP_ORIGIN): Promise<Response> {
  const { POST } = await import("./route");
  return POST(
    new Request(`${APP_ORIGIN}/api/referral`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: rawBody,
    }),
  );
}

async function checkIn(cookie: string): Promise<Response> {
  const { POST } = await import("../xp/route");
  return POST(
    new Request(`${APP_ORIGIN}/api/xp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN, cookie },
      body: JSON.stringify({ action: "DAILY_CHECK_IN" }),
    }),
  );
}

async function getJson(cookie: string, url: string): Promise<Record<string, unknown>> {
  const { GET } = await import("./route");
  const res = await GET(new Request(url, { headers: { cookie } }));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function standing(cookie: string): Promise<{ xp: number; referrals: number }> {
  const { GET } = await import("../xp/route");
  const res = await GET(new Request(`${APP_ORIGIN}/api/xp`, { headers: { cookie } }));
  expect(res.status).toBe(200);
  return (await res.json()) as { xp: number; referrals: number };
}

beforeEach(() => {
  redis.reset();
  suiteTick += 1;
  vi.useFakeTimers();
  // +61 s per test: every test starts in a fresh rate-limit window.
  vi.setSystemTime(new Date(BASE + suiteTick * 61_000));
});

describe("POST /api/referral — sybil farming hardening (Task 8)", () => {
  it("does NOT credit the referrer at registration time (farming window closed)", async () => {
    const aCookie = await cookieFor(A);
    const bCookie = await cookieFor(B);

    // A becomes a real ledger wallet (own check-in: +20 XP).
    expect((await checkIn(aCookie)).status).toBe(200);
    expect((await standing(aCookie)).xp).toBe(20);

    // B arrives through A's link and registers — but has zero activity.
    const res = await postReferral(bCookie, A);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "registered", referrer: A.toLowerCase() });

    // The abuse window this PR closes: registration alone must NOT pay 100 XP.
    expect((await standing(aCookie)).xp).toBe(20);
    expect((await standing(bCookie)).xp).toBe(0);

    // B performs genuine activity (server-awarded daily check-in).
    expect((await checkIn(bCookie)).status).toBe(200);
    expect((await standing(aCookie)).xp).toBe(120); // exactly one +100
    expect((await standing(bCookie)).referrals).toBe(0);
    expect((await standing(aCookie)).referrals).toBe(1);
  });

  it("caps rewarded referrals per referrer per UTC day; attribution itself stays uncapped", async () => {
    const aCookie = await cookieFor(A);
    await checkIn(aCookie); // A: real ledger wallet, +20

    const burners = Array.from({ length: 7 }, (_, i) => addr(`44${i}${"4".repeat(38)}`));
    for (const burner of burners) {
      const cookie = await cookieFor(burner);
      expect((await postReferral(cookie, A)).status).toBe(200); // attribution: unlimited
      expect((await checkIn(cookie)).status).toBe(200); // genuine activity: settle attempt
    }

    // Pre-fix behavior (the vulnerability): 7 * 100 = 700 XP + 20.
    // Post-fix: only the daily cap (default 5) of them may pay.
    expect((await standing(aCookie)).xp).toBe(20 + 5 * 100);
    // All 7 sybils are still attributed — honest referrers never lose credit,
    // the cap applies to REWARDS, not to the ledger of who referred whom.
    expect((await standing(aCookie)).referrals).toBe(7);
  });

  it("the next UTC day unlocks the cap but a paid referral can never be paid twice", async () => {
    const aCookie = await cookieFor(A);
    const bCookie = await cookieFor(B);
    await checkIn(aCookie);
    await postReferral(bCookie, A);
    await checkIn(bCookie); // settles: +100 to A
    expect((await standing(aCookie)).xp).toBe(120);

    // Next UTC day: new cap slot and a fresh (re-issued) session for B —
    // sessions last 8 h, so a day later the client would have re-logged in.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    await checkIn(await cookieFor(B)); // B's second real activity event
    expect((await standing(await cookieFor(A))).xp).toBe(120); // no pending left → no re-pay
  });

  it("replaying a qualified referral (refresh/retry/multiple sessions) is inert", async () => {
    const aCookie = await cookieFor(A);
    const bCookie = await cookieFor(B);
    const bCookie2 = await cookieFor(B); // second concurrent session, same wallet
    await checkIn(aCookie);

    expect(await (await postReferral(bCookie, A)).json()).toEqual({
      status: "registered",
      referrer: A.toLowerCase(),
    });
    const replay = await postReferral(bCookie2, A);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ status: "already-attributed", referrer: A.toLowerCase() });

    await checkIn(bCookie);
    expect((await standing(aCookie)).xp).toBe(20 + 100); // exactly once across two sessions
  });

  it("an attacker cannot steal an existing attribution or siphon its reward", async () => {
    const aCookie = await cookieFor(A);
    const cCookie = await cookieFor(C);
    const bCookie = await cookieFor(B);
    await checkIn(aCookie);

    // B is attributed to A first.
    expect(await (await postReferral(bCookie, A)).json()).toEqual({
      status: "registered",
      referrer: A.toLowerCase(),
    });

    // C tries to hijack B's attribution (possible only if C could present B's
    // session; with their own session they merely attribute themselves).
    const steal = await postReferral(bCookie, C);
    expect(steal.status).toBe(200);
    expect(await steal.json()).toEqual({ status: "already-attributed", referrer: A.toLowerCase() });

    // Anonymous callers with someone else's link get 401 (no unauthenticated
    // first-write claim — the old audit finding #6 stays fixed).
    const { POST } = await import("./route");
    const anon = await POST(
      new Request(`${APP_ORIGIN}/api/referral`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP_ORIGIN },
        body: JSON.stringify({ referrer: A }),
      }),
    );
    expect(anon.status).toBe(401);

    // B's genuine activity pays A — and never C.
    await checkIn(bCookie);
    expect((await standing(aCookie)).xp).toBe(120);
    expect((await standing(cCookie)).xp).toBe(0);
    expect((await getJson(bCookie, `${APP_ORIGIN}/api/referral?wallet=${B}`)).count).toBe(0); // B was referred, not a referrer
  });

  it("self-referral is rejected for every case variant of the same wallet", async () => {
    const aCookie = await cookieFor(A);
    const res = await postReferral(aCookie, A.toUpperCase().replace("0X", "0x"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "self-referral" });
    // No attribution, no pending reward…
    expect(
      redis.keys().filter((k) => /^(mpgrhub:referral:(referredby|referrals|reward-pending):)/.test(k)),
    ).toHaveLength(0);
    // …but the attempt IS counted for operators (abuse counter exists).
    const abuse = redis
      .keys()
      .filter((k) => k.startsWith(`mpgrhub:referral:abuse:${A.toLowerCase()}:`));
    expect(abuse).toHaveLength(1);
    expect(await redis.client().get<number>(abuse[0])).toBe(1);
  });

  it("reward amounts are never client-controlled", async () => {
    const aCookie = await cookieFor(A);
    const bCookie = await cookieFor(B);
    await checkIn(aCookie);
    await postReferral(bCookie, A, { xp: 999999, rewardUsdb: "1000000", amount: -5, fraction: 0.5 });
    await checkIn(bCookie);
    // Exactly the server constant (REFERRAL_SUCCESS = 100), nothing more.
    expect((await standing(aCookie)).xp).toBe(20 + 100);
  });

  it("rejects malformed referrer bodies and hostile origins without touching state", async () => {
    const bCookie = await cookieFor(B);
    expect((await postReferral(bCookie, "0x123")).status).toBe(400);
    expect((await postReferral(bCookie, "vitalik.eth")).status).toBe(400);
    expect((await postReferral(bCookie, "")).status).toBe(400);
    expect((await postReferralRaw(bCookie, JSON.stringify({ referrer: 42 }))).status).toBe(400);
    expect((await postReferralRaw(bCookie, "{oops")).status).toBe(400);
    // CSRF: cross-origin POST is rejected before any referral state exists.
    expect((await postReferralRaw(bCookie, JSON.stringify({ referrer: A }), "https://evil.example"))
      .status).toBe(403);
    expect(redis.keys().filter((k) => k.startsWith("mpgrhub:referral:"))).toHaveLength(0);
  });

  it("Redis failure fails closed: 500, no attribution, no reward anywhere", async () => {
    const aCookie = await cookieFor(A);
    const bCookie = await cookieFor(B);
    await checkIn(aCookie);
    const spy = vi.spyOn(redis, "eval").mockRejectedValue(new Error("redis down"));
    const res = await postReferral(bCookie, A);
    expect(res.status).toBe(500);
    spy.mockRestore();

    // Nothing was persisted: replay after recovery registers normally.
    expect((await postReferral(bCookie, A)).status).toBe(200);
    expect((await standing(aCookie)).xp).toBe(20); // deferred: no XP until B acts
    await checkIn(bCookie);
    expect((await standing(aCookie)).xp).toBe(120);
  });

  it("GET /api/referral keeps its contract: self-only, checksum-tolerant, no data leaks", async () => {
    const aCookie = await cookieFor(A);
    const bCookie = await cookieFor(B);
    await postReferral(bCookie, A);
    await postReferral(bCookie, A); // replay — no double count
    const upper = A.toUpperCase().replace("0X", "0x");
    expect((await getJson(aCookie, `${APP_ORIGIN}/api/referral?wallet=${upper}`)).count).toBe(1);
    // Someone else's wallet: 401 even when the format is valid.
    const { GET } = await import("./route");
    const other = await GET(
      new Request(`${APP_ORIGIN}/api/referral?wallet=${upper}`, { headers: { cookie: bCookie } }),
    );
    expect(other.status).toBe(401);
    const anon = await GET(new Request(`${APP_ORIGIN}/api/referral?wallet=${upper}`));
    expect(anon.status).toBe(401);
    const bad = await GET(new Request(`${APP_ORIGIN}/api/referral?wallet=nope`, { headers: { cookie: bCookie } }));
    expect(bad.status).toBe(400);
  });

  it("legacy pre-Task-8 referrals keep working: attributed, counted, and never double-paid", async () => {
    const aCookie = await cookieFor(A);
    const bCookie = await cookieFor(B);
    await checkIn(aCookie);

    // Simulate data written by the OLD code: attribution keys, ledger award,
    // no pending record at all.
    await redis.client().set(`mpgrhub:referral:referredby:${B.toLowerCase()}`, A.toLowerCase());
    redis.call(["SADD", `mpgrhub:referral:referrals:${A.toLowerCase()}`, B.toLowerCase()]);
    const { awardServerXP } = await import("@/lib/rewards/xp-ledger");
    await awardServerXP(A, "REFERRAL_SUCCESS", `referral:${B.toLowerCase()}`);
    expect((await standing(aCookie)).xp).toBe(120);

    // B's new referral POST → already-attributed; check-ins must not re-pay A.
    expect(await (await postReferral(bCookie, A)).json()).toEqual({
      status: "already-attributed",
      referrer: A.toLowerCase(),
    });
    await checkIn(bCookie);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    await checkIn(await cookieFor(B)); // next day (sessions re-issued) — must not re-pay
    const aFresh = await cookieFor(A);
    expect((await standing(aFresh)).xp).toBe(120);
    expect((await standing(aFresh)).referrals).toBe(1);
  });
});
