import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyAuthoritativeRun } from "./authoritative-verifier";

const originalUrl = process.env.GAME_RUN_VERIFIER_URL;
const originalSecret = process.env.GAME_RUN_VERIFIER_SECRET;

const input = {
  sessionId: "12345678-1234-1234-1234-123456789012",
  wallet: "0x1111111111111111111111111111111111111111" as `0x${string}`,
  sessionCreatedAt: "2026-09-10T12:00:00.000Z",
  sessionExpiresAt: "2026-09-10T12:15:00.000Z",
  result: {
    distanceMeters: 100,
    durationMs: 10_000,
    coinsCollected: 1,
    gemsCollected: 0,
    xpOrbsCollected: 0,
    keysCollected: 0,
    chestsCollected: 0,
    powerupsCollected: 0,
    obstaclesPassed: 1,
    checkpointsReached: 0,
    bonusScore: 0,
    hitsTaken: 0,
    collided: false,
    maxSpeedTierReached: 1,
    score: 116,
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  if (originalUrl === undefined) delete process.env.GAME_RUN_VERIFIER_URL;
  else process.env.GAME_RUN_VERIFIER_URL = originalUrl;
  if (originalSecret === undefined) delete process.env.GAME_RUN_VERIFIER_SECRET;
  else process.env.GAME_RUN_VERIFIER_SECRET = originalSecret;
});

describe("authoritative game verifier", () => {
  it("fails closed when configuration is missing", async () => {
    delete process.env.GAME_RUN_VERIFIER_URL;
    delete process.env.GAME_RUN_VERIFIER_SECRET;
    await expect(verifyAuthoritativeRun(input)).resolves.toMatchObject({ verified: false });
  });

  it("requires a valid proof id from the verifier", async () => {
    process.env.GAME_RUN_VERIFIER_URL = "https://verifier.example.test/run";
    process.env.GAME_RUN_VERIFIER_SECRET = "secret";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ verified: true }), { status: 200 })));
    await expect(verifyAuthoritativeRun(input)).resolves.toMatchObject({ verified: false });
  });

  it("accepts only a positive attestation with a proof id", async () => {
    process.env.GAME_RUN_VERIFIER_URL = "https://verifier.example.test/run";
    process.env.GAME_RUN_VERIFIER_SECRET = "secret";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ verified: true, proofId: "proof-12345678" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(verifyAuthoritativeRun(input)).resolves.toEqual({ verified: true, proofId: "proof-12345678" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
