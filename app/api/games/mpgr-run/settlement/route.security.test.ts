// app/api/games/mpgr-run/settlement/route.security.test.ts
//
// Task 7 — regression coverage for the settlement route's attestation
// gate (the consumer side of V2):
//   - a week whose eligible players all carry the authoritative
//     attestation (verificationVersion "authoritative-v1" +
//     authoritativeProofId, persisted by the reward route per verified
//     run) settles normally;
//   - a week whose eligible players have NO attestation (the pre-Task-7
//     state, and any unverified history) settles with zero payable
//     players and NEVER calls the vault — fail-closed.
//
// The route's operator gate (gameRewardsAreOperatorEnabled) is mocked
// separately; the flag defaults themselves are covered in
// games-reward-config.test.ts. Storage, the vault client, the season
// lookup, and the settlement lock are mocked at the module boundary;
// the pure settlement math (weights/pool/allocations) runs for real.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { PlayerWeekRecord, WeeklySettlement } from "@/lib/reward-allocation/allocation-types";

const withSettlementLock = vi.fn(async (_weekKey: string, fn: () => Promise<unknown>) => fn());
vi.mock("@/lib/reward-allocation/settlement-lock", () => ({
  withSettlementLock,
}));

vi.mock("@/lib/reward-allocation/settlement-reconciliation", () => ({
  reconcileSettlement: vi.fn(async () => ({ status: "missing", reconciled: false })),
}));

const vaultGetAvailableBalance = vi.fn(async () => 20_000n * 10n ** 18n);
const vaultVerifyRewardManagerAuthorized = vi.fn(async () => true);
const vaultAllocateRewardsBatch = vi.fn(async (_seasonId: bigint, _users: `0x${string}`[], _amounts: bigint[], _rewardTypes: number[]) => ({ rewardIds: [1n], txHash: "0x" + "ab".repeat(32) }));
const vaultGetSignerAddress = vi.fn(() => "0x3333333333333333333333333333333333333333");
vi.mock("@/lib/reward-vault/reward-vault-admin-client", () => ({
  rewardVaultAdminClient: {
    getAvailableBalance: vaultGetAvailableBalance,
    verifyRewardManagerAuthorized: vaultVerifyRewardManagerAuthorized,
    allocateRewardsBatch: vaultAllocateRewardsBatch,
    getSignerAddress: vaultGetSignerAddress,
  },
}));

vi.mock("@/lib/reward-allocation/reward-vault-season-mapping", () => ({
  vaultSeasonLookup: {
    resolveActiveVaultSeasonId: vi.fn(async () => ({ exists: true, finalized: false, seasonId: 3n })),
  },
}));

vi.mock("@/lib/games/games-reward-config", async (importOriginal) => {
  // Only the operator gate is overridden; the real economic constants
  // (caps/weights) are used by the settlement math.
  const actual = await importOriginal<typeof import("@/lib/games/games-reward-config")>();
  return { ...actual, gameRewardsAreOperatorEnabled: () => true };
});

const getWeeklySettlement = vi.fn(async () => null);
const upsertWeeklySettlement = vi.fn(async (settlement: WeeklySettlement) => settlement);
const listEligiblePlayersForWeek = vi.fn(async (): Promise<PlayerWeekRecord[]> => []);
const upsertPlayerWeekRecord = vi.fn(async (record: PlayerWeekRecord) => record);
const getTreasuryLedgerTotal = vi.fn(async () => 0n);
const recordTreasuryLedgerEntryOnce = vi.fn(async () => true);
vi.mock("@/lib/reward-allocation/kv-allocation-store", () => ({
  kvAllocationStore: {
    getWeeklySettlement,
    upsertWeeklySettlement,
    listEligiblePlayersForWeek,
    upsertPlayerWeekRecord,
    getTreasuryLedgerTotal,
    recordTreasuryLedgerEntryOnce,
  },
}));

vi.mock("@/lib/api/request-guard", () => ({
  requestIdFromRequest: () => "test-request-id",
  withRequestId: (response: Response) => response,
}));

const WALLET = "0x2222222222222222222222222222222222222222" as `0x${string}`;

function playerWeekRecord(attested: boolean): PlayerWeekRecord {
  return {
    wallet: WALLET,
    seasonId: null,
    weekKey: "2026-W37",
    validRunCount: 5,
    bestScore: 15_000,
    seasonPointsEarnedThisWeek: 0,
    lastRunAt: "2026-09-01T00:00:00.000Z",
    verificationVersion: attested ? "authoritative-v1" : undefined,
    authoritativeProofId: attested ? "proof-123" : undefined,
    eligibilityStatus: "eligible",
    weight: null,
    allocatedAmountRaw: null,
    rewardId: null,
    allocationTxHash: null,
    allocationStatus: "none",
  };
}

function authorizedRequest(url = "http://localhost/api/games/mpgr-run/settlement"): Request {
  return new Request(url, {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
}

describe("GET /api/games/mpgr-run/settlement — attestation gate (Task 7)", () => {
  const prevCron = process.env.CRON_SECRET;
  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    vi.clearAllMocks();
    getWeeklySettlement.mockResolvedValue(null);
    upsertWeeklySettlement.mockImplementation(async (s: WeeklySettlement) => s);
  });

  afterEach(() => {
    if (prevCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prevCron;
  });

  it("rejects a missing/incorrect CRON_SECRET before doing any work", async () => {
    listEligiblePlayersForWeek.mockResolvedValue([playerWeekRecord(true)]);
    const { GET } = await import("./route");

    const noSecret = new Request("http://localhost/api/games/mpgr-run/settlement");
    const denied = await GET(noSecret);
    expect(denied.status).toBe(401);

    const wrong = new Request("http://localhost/api/games/mpgr-run/settlement", {
      headers: { authorization: "Bearer wrong" },
    });
    expect((await GET(wrong)).status).toBe(401);
    expect(listEligiblePlayersForWeek).not.toHaveBeenCalled();
  });

  it("settles normally when the eligible player carries the authoritative attestation", async () => {
    listEligiblePlayersForWeek.mockResolvedValue([playerWeekRecord(true)]);
    const { GET } = await import("./route");
    const response = await GET(authorizedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("finalized");
    expect(body.settlement.eligiblePlayerCount).toBe(1);
    expect(vaultAllocateRewardsBatch).toHaveBeenCalledTimes(1);
    // The single attested player is the only payee.
    expect(vaultAllocateRewardsBatch.mock.calls[0][1]).toEqual([WALLET]);
    // bigint reward ids are serialized as strings in the HTTP body.
    expect(body.settlement.rewardIds).toEqual(["1"]);
  });

  it("settles with ZERO payable players and never touches the vault when no attestation exists", async () => {
    // The pre-Task-7 state: eligible weekly records that were never
    // attested by a passing authoritative verification.
    listEligiblePlayersForWeek.mockResolvedValue([playerWeekRecord(false), playerWeekRecord(false)]);
    const { GET } = await import("./route");

    const response = await GET(authorizedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("finalized");
    expect(body.settlement.eligiblePlayerCount).toBe(0);
    expect(vaultAllocateRewardsBatch).not.toHaveBeenCalled();
    expect(vaultGetAvailableBalance).not.toHaveBeenCalled();
  });
});
