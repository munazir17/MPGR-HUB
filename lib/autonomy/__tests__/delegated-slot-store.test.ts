// DelegatedAuthorizationStore contract + Redis persistence tests (Phase 2).
// The production Redis scripts run for real against the repo's LuaRedis
// double (same approach as goal-store tests): CAS consumption, nonce
// registry, wallet scoping and persistence across instances.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { delegatedActionId } from "@/lib/executor/delegated-executor";
import type { Address, Hex } from "viem";

import { LuaRedis } from "@/lib/__tests__/helpers/lua-redis";
import {
  InMemoryDelegatedAuthorizationStore,
  policyHashFor,
  type DelegatedAuthorizationSlot,
  type DelegatedAuthorizationStore,
} from "@/lib/autonomy/delegated-authorization";
import { RedisDelegatedAuthorizationStore } from "@/lib/autonomy/delegated-redis-store";
import type { AutonomyPolicy } from "@/lib/autonomy/types";

const redis = new LuaRedis();
vi.mock("@/lib/api/redis", () => ({
  getRedis: () => redis.client(),
}));

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01" as Address;
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02" as Address;
const SELL = "0xcccccccccccccccccccccccccccccccccccccc03" as Address;
const BUY = "0xdddddddddddddddddddddddddddddddddddddd04" as Address;

const policy: AutonomyPolicy = {
  id: "pol_dep_1",
  wallet: WALLET,
  chainId: 84532,
  actions: ["swap"],
  sellToken: SELL,
  buyToken: BUY,
  maxPerTradeRaw: "1000000000",
  maxDailyRaw: "10000000000",
  maxSlippageBps: 100,
  maxActionsPerDay: 5,
  enabled: true,
  createdAt: "2026-01-01T00:00:00Z",
  expiresAt: "2099-12-31T00:00:00Z",
  authorizedAt: "2026-01-01T00:00:00Z",
  authorizationRef: "sess:test",
};

export function makeSlot(over: Partial<DelegatedAuthorizationSlot> = {}, index = 0, nonce = `${100 + index}`): DelegatedAuthorizationSlot {
  return {
    id: `slot-pol_dep_1-goal_1-${index}`,
    wallet: WALLET,
    chainId: 84532,
    policyId: "pol_dep_1",
    goalId: "goal_1",
    slotIndex: index,
    permit: { token: SELL, amount: "1000000000", nonce, deadline: 4_100_000_000 },
    witness: {
      owner: WALLET,
      buyToken: BUY,
      minAmountOut: "900000000",
      deadline: 4_100_000_000,
      actionId: delegatedActionId("goal_1"),
      policyHash: policyHashFor(policy),
    },
    signature: ("0x" + "22".repeat(65)) as Hex,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

async function exerciseContract(name: string, make: () => DelegatedAuthorizationStore) {
  describe(`DelegatedAuthorizationStore contract — ${name}`, () => {
    let store: DelegatedAuthorizationStore;
    beforeEach(() => {
      store = make();
    });

    it("save + list scoped by wallet AND policy; getSlot wallet-scoped", async () => {
      await store.saveSlots([makeSlot(), makeSlot({}, 1, "101")]);
      expect(await store.listSlots(WALLET)).toHaveLength(2);
      expect(await store.listSlots(WALLET, "pol_dep_1")).toHaveLength(2);
      expect(await store.listSlots(WALLET, "other")).toHaveLength(0);
      expect(await store.listSlots(OTHER)).toHaveLength(0); // cross-wallet reads nothing
      expect((await store.getSlot("slot-pol_dep_1-goal_1-0", WALLET))?.permit.amount).toBe("1000000000");
      expect(await store.getSlot("slot-pol_dep_1-goal_1-0", OTHER)).toBeNull(); // cross-wallet
      expect(await store.getSlot("../../etc/passwd", WALLET)).toBeNull(); // hostile id
    });

    it("concurrent consumption: exactly one racer wins the CAS", async () => {
      await store.saveSlots([makeSlot()]);
      const [a, b] = await Promise.all([
        store.markConsumed("slot-pol_dep_1-goal_1-0", WALLET, "0xtx1", "2026-06-01T00:00:00Z"),
        store.markConsumed("slot-pol_dep_1-goal_1-0", WALLET, "0xtx2", "2026-06-01T00:00:00Z"),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      const slot = await store.getSlot("slot-pol_dep_1-goal_1-0", WALLET);
      expect(slot?.consumedAt).toBe("2026-06-01T00:00:00Z");
      // the loser did not overwrite the winner's tx hash
      expect(slot?.consumedByTxHash).toBe("0xtx1");
    });

    it("consumption refuses wrong wallet, revoked and already-consumed slots", async () => {
      await store.saveSlots([makeSlot(), makeSlot({}, 1, "101")]);
      expect(await store.markConsumed("slot-pol_dep_1-goal_1-0", OTHER, "0xtx", "t")).toBe(false);
      expect(await store.markConsumed("slot-pol_dep_1-goal_1-1", WALLET, "0xtx", "t")).toBe(true);
      expect(await store.markConsumed("slot-pol_dep_1-goal_1-1", WALLET, "0xtx2", "t2")).toBe(false);
    });

    it("revocation is wallet-scoped, single-shot, and blocks consumption", async () => {
      await store.saveSlots([makeSlot()]);
      expect(await store.markRevoked("slot-pol_dep_1-goal_1-0", OTHER, "t")).toBe(false);
      expect(await store.markRevoked("slot-pol_dep_1-goal_1-0", WALLET, "2026-06-01T00:00:00Z")).toBe(true);
      expect(await store.markRevoked("slot-pol_dep_1-goal_1-0", WALLET, "t2")).toBe(false); // already revoked
      expect(await store.markConsumed("slot-pol_dep_1-goal_1-0", WALLET, "0xtx", "t3")).toBe(false); // revoked cannot run
    });

    it("nonce reuse is refused (same store); distinct nonces are fine", async () => {
      await store.saveSlots([makeSlot({}, 0, "777")]);
      await expect(store.saveSlots([makeSlot({ id: "slot-other" }, 3, "777")])).rejects.toThrow(/duplicate permit nonce/);
      expect(await store.saveSlots([makeSlot({}, 1, "778")])).toBe(1);
    });
  });
}

describe("RedisDelegatedAuthorizationStore (LuaRedis)", () => {
  beforeEach(() => redis.reset());

  exerciseContract("redis", () => new RedisDelegatedAuthorizationStore());

  it("persists across store instances (Redis is the source of truth)", async () => {
    const first = new RedisDelegatedAuthorizationStore();
    await first.saveSlots([makeSlot({}, 0, "555"), makeSlot({}, 1, "556")]);
    await first.markRevoked("slot-pol_dep_1-goal_1-1", WALLET, "2026-06-01T00:00:00Z");

    const second = new RedisDelegatedAuthorizationStore();
    const listed = await second.listSlots(WALLET, "pol_dep_1");
    expect(listed).toHaveLength(2);
    expect(listed[0].permit.nonce).toBe("555");
    expect(listed[1].revokedAt).toBe("2026-06-01T00:00:00Z");
    // consumption through the second instance is visible to the first
    expect(await second.markConsumed("slot-pol_dep_1-goal_1-0", WALLET, "0xdead", "t")).toBe(true);
    expect((await first.getSlot("slot-pol_dep_1-goal_1-0", WALLET))?.consumedByTxHash).toBe("0xdead");
  });

  it("never exposes slots across wallets even with colliding ids", async () => {
    const store = new RedisDelegatedAuthorizationStore();
    await store.saveSlots([makeSlot()]);
    const impostor = makeSlot({ wallet: OTHER, witness: { ...makeSlot().witness, owner: OTHER } }, 0, "901");
    impostor.id = "slot-pol_dep_1-goal_1-0"; // SAME id, different wallet
    await store.saveSlots([impostor]);
    // id collision overwrote the record, but the meta CAS keeps ownership sane:
    const asOriginal = await store.getSlot("slot-pol_dep_1-goal_1-0", WALLET);
    expect(asOriginal).toBeNull(); // meta now names the impostor wallet
    expect((await store.getSlot("slot-pol_dep_1-goal_1-0", OTHER))?.wallet).toBe(OTHER.toLowerCase());
  });
});

describe("InMemoryDelegatedAuthorizationStore (parity)", () => {
  exerciseContract("memory", () => new InMemoryDelegatedAuthorizationStore());
});
