// app/api/leaderboard/route.test.ts
//
// Verifies the actual trust boundary: a client-supplied `seasonPoints`
// field must never reach leaderboardStore.upsertEntry — only a value
// the server itself derived via lib/season-points.ts's
// calculateSeasonPoints() from the posted xp/history can. Also verifies
// runtime request validation (wallet/xp/history shape, required fields,
// size limits, malformed JSON) and that a valid seasonOrdinal is always
// passed through to the store.
//
// leaderboardStore is mocked (it throws at import time if Upstash env
// vars are absent, which they are in this sandbox — see
// lib/leaderboard-store.ts) so this test exercises only route.ts's own
// logic, not real Redis.

import { describe, expect, it, vi, beforeEach } from "vitest";

const upsertEntry = vi.fn(async () => {});
const getTopN = vi.fn(async () => []);
const getTotalRankedWallets = vi.fn(async () => 0);
const getWalletStanding = vi.fn(async () => null);

vi.mock("@/lib/leaderboard-store", () => ({
  leaderboardStore: { upsertEntry, getTopN, getTotalRankedWallets, getWalletStanding },
}));

vi.mock("@/lib/referral/referral-store", () => ({
  referralStore: { getReferralCount: vi.fn(async () => 0) },
}));

const WALLET = "0xae4400000000000000000000000000000000c6f9";

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/leaderboard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postRawBody(rawBody: string): Request {
  return new Request("http://localhost/api/leaderboard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  });
}

describe("POST /api/leaderboard — server-authoritative Season Points", () => {
  beforeEach(() => {
    upsertEntry.mockClear();
  });

  it("ignores a client-supplied seasonPoints field entirely and derives it from xp+history", async () => {
    const { POST } = await import("./route");

    await POST(
      postRequest({
        wallet: WALLET,
        xp: 110,
        // A client trying to claim an inflated Season Points directly —
        // this must never reach Redis.
        seasonPoints: 999999,
        history: [{ xp: 20, timestamp: new Date().toISOString() }],
      })
    );

    expect(upsertEntry).toHaveBeenCalledTimes(1);
    const [wallet, xp, seasonPoints, seasonOrdinal] = upsertEntry.mock.calls[0];
    expect(wallet).toBe(WALLET);
    expect(xp).toBe(110);
    // 20 from current-month history + 90 unhistoried (lifetimeXp 110 -
    // historySum 20, no prior-season evidence) = 110. NEVER 999999.
    expect(seasonPoints).toBe(110);
    // A real UTC-month ordinal is always passed through — not asserting
    // an exact value here (that would require pinning "now", which this
    // suite deliberately avoids elsewhere), just that route.ts always
    // supplies one.
    expect(typeof seasonOrdinal).toBe("number");
    expect(Number.isFinite(seasonOrdinal)).toBe(true);
  });

  it("reproduces the reported production wallet: 110 lifetime XP / 20 history-only-this-month -> 110 season", async () => {
    const { POST } = await import("./route");

    await POST(
      postRequest({
        wallet: WALLET,
        xp: 110,
        history: [{ xp: 20, timestamp: new Date().toISOString() }],
      })
    );

    const [, , seasonPoints] = upsertEntry.mock.calls.at(-1)!;
    expect(seasonPoints).toBe(110);
  });

  it("rejects a request with no history field at all (history is required, not optional)", async () => {
    // This is the loophole this requirement exists to close: xp=110
    // with no history at all would, under the legacy-recovery rule,
    // resolve to seasonPoints=110 with nothing to contradict it. Rather
    // than silently accept that shape as "no history known", the route
    // rejects it outright — the one real caller (hooks/useXP.ts) always
    // sends history, so a request missing it entirely is either a bug
    // or a tampered request.
    const { POST } = await import("./route");

    const res = await POST(postRequest({ wallet: WALLET, xp: 50 }));
    expect(res.status).toBe(400);
    expect(upsertEntry).not.toHaveBeenCalled();
  });

  it("accepts an explicitly empty history array (distinct from a missing field)", async () => {
    const { POST } = await import("./route");

    const res = await POST(postRequest({ wallet: WALLET, xp: 50, history: [] }));
    expect(res.status).toBe(200);
    const [, , seasonPoints] = upsertEntry.mock.calls.at(-1)!;
    expect(seasonPoints).toBe(50); // no prior-season evidence -> fully recovered as current season
  });

  it("rejects a malformed wallet address without touching the store", async () => {
    const { POST } = await import("./route");

    const res = await POST(postRequest({ wallet: "not-an-address", xp: 10, history: [] }));
    expect(res.status).toBe(400);
    expect(upsertEntry).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric xp without touching the store", async () => {
    const { POST } = await import("./route");

    const res = await POST(postRequest({ wallet: WALLET, xp: "110", history: [] }));
    expect(res.status).toBe(400);
    expect(upsertEntry).not.toHaveBeenCalled();
  });

  it("rejects negative xp without touching the store", async () => {
    const { POST } = await import("./route");

    const res = await POST(postRequest({ wallet: WALLET, xp: -10, history: [] }));
    expect(res.status).toBe(400);
    expect(upsertEntry).not.toHaveBeenCalled();
  });

  it("rejects a history array longer than the configured max without touching the store", async () => {
    const { POST } = await import("./route");

    const oversized = Array.from({ length: 2001 }, () => ({ xp: 1, timestamp: new Date().toISOString() }));
    const res = await POST(postRequest({ wallet: WALLET, xp: 50, history: oversized }));
    expect(res.status).toBe(400);
    expect(upsertEntry).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON without touching the store", async () => {
    const { POST } = await import("./route");

    const res = await POST(postRawBody("{not valid json"));
    expect(res.status).toBe(400);
    expect(upsertEntry).not.toHaveBeenCalled();
  });

  it("drops a malformed history entry rather than rejecting the whole sync (design choice — see route.ts's isValidShape comment)", async () => {
    const { POST } = await import("./route");

    const res = await POST(
      postRequest({
        wallet: WALLET,
        xp: 30,
        history: [
          { xp: 30, timestamp: new Date().toISOString() },
          { xp: -9999, timestamp: new Date().toISOString() }, // malformed/tampered — excluded, not trusted
        ],
      })
    );
    expect(res.status).toBe(200);
    const [, , seasonPoints] = upsertEntry.mock.calls.at(-1)!;
    expect(seasonPoints).toBe(30);
  });
});
