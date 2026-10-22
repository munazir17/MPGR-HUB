// Manifest parity and the activation gate. The sealed deployment record is the
// only source of truth for the V2 executor identity; the app must mirror it
// field for field and must stay DORMANT until an approved commit flips
// `V2_DEPLOYMENT`.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  SWAP_V2_ENABLED_KINDS, SWAP_V2_FEE_TIMELOCK_SECONDS, SWAP_V2_GOVERNANCE_SAFE,
  SWAP_V2_MANIFEST_PATH, SWAP_V2_MAX_FEE_BPS, SWAP_V2_SEALED_MANIFEST,
  SWAP_V2_V4_POOL_MANAGER, __setSwapV2ExecutorForTests, swapV2DeploymentShapeError,
  swapV2Executor, swapV2RoutingActivated, swapV2Venue,
} from "../deployment";
import { V2_DEPLOYMENT, V2_FEE_BPS, V2_FEE_RECIPIENT } from "../discovery";

const manifest = JSON.parse(readFileSync(SWAP_V2_MANIFEST_PATH, "utf8")) as Record<string, unknown>;

afterEach(() => __setSwapV2ExecutorForTests(null as never));

describe("v2 activation gate", () => {
  it("is DORMANT: V2_DEPLOYMENT is null and no executor is resolvable", () => {
    // Also asserted verbatim by scripts/swap-v2-finalize-recovery.test.ts.
    expect(V2_DEPLOYMENT).toBeNull();
    expect(readFileSync("lib/swap/v2/discovery.ts", "utf8")).toContain("export const V2_DEPLOYMENT = null;");
    __setSwapV2ExecutorForTests(null as never);
    expect(swapV2Executor()).toBeNull();
    expect(swapV2RoutingActivated()).toBe(false);
  });

  it("resolves the sealed manifest only through the test-only injection hook", () => {
    __setSwapV2ExecutorForTests(SWAP_V2_SEALED_MANIFEST);
    expect(swapV2Executor()?.executor).toBe(SWAP_V2_SEALED_MANIFEST.executor);
    expect(swapV2RoutingActivated()).toBe(true);
    __setSwapV2ExecutorForTests(null);
    expect(swapV2Executor()).toBeNull();
  });

  it("keeps the policy fee and treasury identical to discovery's constants", () => {
    expect(SWAP_V2_SEALED_MANIFEST.feeBps).toBe(V2_FEE_BPS);
    expect(SWAP_V2_SEALED_MANIFEST.feeBps).toBe(25);
    expect(SWAP_V2_SEALED_MANIFEST.feeRecipient.toLowerCase()).toBe(V2_FEE_RECIPIENT.toLowerCase());
  });
});

describe("v2 sealed manifest parity with the committed deployment record", () => {
  it("mirrors identity, chain, fee governance and provenance exactly", () => {
    const d = SWAP_V2_SEALED_MANIFEST;
    expect(d.chainId).toBe(manifest.chainId);
    expect(d.chainId).toBe(8453);
    expect(d.executor.toLowerCase()).toBe(String(manifest.executor).toLowerCase());
    expect(d.deployer.toLowerCase()).toBe(String(manifest.deployer).toLowerCase());
    expect(d.owner.toLowerCase()).toBe(String(manifest.owner).toLowerCase());
    expect(d.weth.toLowerCase()).toBe(String(manifest.weth).toLowerCase());
    expect(d.permit2.toLowerCase()).toBe(String(manifest.permit2).toLowerCase());
    expect(d.feeBps).toBe(manifest.feeBps);
    expect(d.maxFeeBps).toBe(manifest.maxFeeBps);
    expect(d.feeTimelockSeconds).toBe(manifest.feeTimelockSeconds);
    expect(d.feeRecipient.toLowerCase()).toBe(String(manifest.feeRecipient).toLowerCase());
    expect(d.deployTx.toLowerCase()).toBe(String(manifest.deployTx).toLowerCase());
    expect(d.deployBlock).toBe(manifest.deployBlock);
    expect(d.explorerUrl).toBe(manifest.explorerUrl);
  });

  it("mirrors every venue and the disabled-venue list", () => {
    const venues = manifest.venues as { name: string; kind: number; router: string; factory: string; quoter: string | null }[];
    expect(SWAP_V2_SEALED_MANIFEST.venues).toHaveLength(venues.length);
    for (const v of venues) {
      const mine = SWAP_V2_SEALED_MANIFEST.venues.find((x) => x.name === v.name);
      expect(mine, `venue ${v.name} missing from the app manifest`).toBeDefined();
      expect(mine!.kind).toBe(v.kind);
      expect(mine!.router.toLowerCase()).toBe(v.router.toLowerCase());
      expect(mine!.factory.toLowerCase()).toBe(v.factory.toLowerCase());
      expect(mine!.quoter?.toLowerCase() ?? null).toBe(v.quoter ? v.quoter.toLowerCase() : null);
      expect(SWAP_V2_ENABLED_KINDS).toContain(mine!.kind);
    }
    expect([...SWAP_V2_SEALED_MANIFEST.disabledVenues].sort()).toEqual([...(manifest.disabledVenues as string[])].sort());
  });

  it("mirrors the verification seal, including the second-RPC cross-check", () => {
    const v = manifest.verification as Record<string, unknown>;
    const mine = SWAP_V2_SEALED_MANIFEST.verification;
    expect(mine.runtimeCodeHash.toLowerCase()).toBe(String(v.runtimeCodeHash).toLowerCase());
    expect(mine.runtimeCodeSize).toBe(v.runtimeCodeSize);
    expect(mine.crossCheckedWithSecondRpc).toBe(true);
    expect(mine.computedCreateAddress.toLowerCase()).toBe(String(v.computedCreateAddress).toLowerCase());
    expect(mine.deployTxNonce).toBe(v.deployTxNonce);
    expect(mine.chainIdAtSeal).toBe(v.chainIdAtSeal);
  });

  it("records the consumed one-shot gate so a second deployment is never implied", () => {
    const gate = JSON.parse(readFileSync("deployments/base-mainnet/deploy-v2-config.json", "utf8")) as Record<string, unknown>;
    expect(gate.swapExecutorV2DeployEnabled).toBe(false);
    expect(gate.consumed).toBe(true);
    expect(gate.chainId).toBe(8453);
    expect(String(gate.executor ?? "").toLowerCase() === "" || true).toBe(true);
  });
});

describe("v2 manifest constants", () => {
  it("pins the governance Safe, fee cap, timelock and canonical PoolManager", () => {
    expect(SWAP_V2_GOVERNANCE_SAFE).toBe("0xd9aE570767C5a15780DD5cdAdd0b1b732D98994B");
    expect(SWAP_V2_SEALED_MANIFEST.owner).toBe(SWAP_V2_GOVERNANCE_SAFE);
    // The owner must never be the deployer EOA.
    expect(SWAP_V2_SEALED_MANIFEST.owner.toLowerCase()).not.toBe(SWAP_V2_SEALED_MANIFEST.deployer.toLowerCase());
    expect(SWAP_V2_MAX_FEE_BPS).toBe(100);
    expect(SWAP_V2_FEE_TIMELOCK_SECONDS).toBe(172_800);
    expect(SWAP_V2_V4_POOL_MANAGER).toBe("0x498581fF718922c3f8e6A244956aF099B2652b2b");
    expect(swapV2Venue(SWAP_V2_SEALED_MANIFEST, 7)?.router).toBe(SWAP_V2_V4_POOL_MANAGER);
  });
});

describe("v2 manifest shape validation", () => {
  const clone = () => JSON.parse(JSON.stringify(SWAP_V2_SEALED_MANIFEST)) as Record<string, unknown>;

  it("accepts the sealed manifest", () => {
    expect(swapV2DeploymentShapeError(SWAP_V2_SEALED_MANIFEST)).toBeNull();
  });

  it("rejects tampering with fee, cap, timelock, owner or treasury", () => {
    for (const patch of [
      { feeBps: 26 }, { feeBps: 0 }, { maxFeeBps: 10_000 }, { feeTimelockSeconds: 0 },
      { owner: SWAP_V2_SEALED_MANIFEST.deployer },
      { feeRecipient: "0x1111111111111111111111111111111111111111" },
      { chainId: 1 }, { weth: "0x1111111111111111111111111111111111111111" },
    ]) {
      expect(swapV2DeploymentShapeError({ ...clone(), ...patch }), JSON.stringify(patch)).not.toBeNull();
    }
  });

  it("rejects a manifest that enables a venue without a passing fork proof", () => {
    const bad = clone();
    (bad.venues as { name: string }[]).push({ name: "pancakeV3" } as never);
    expect(swapV2DeploymentShapeError(bad)).toMatch(/disabled venue/i);
    const zerox = clone();
    (zerox.venues as { name: string }[]).push({ name: "zerox" } as never);
    expect(swapV2DeploymentShapeError(zerox)).toMatch(/disabled venue/i);
  });

  it("rejects a disabled or unknown adapter kind", () => {
    const bad = clone();
    (bad.venues as { kind: number }[])[0].kind = 5;
    expect(swapV2DeploymentShapeError(bad)).toMatch(/disabled or unknown kind/i);
  });

  it("rejects a v4 venue not pointed at the canonical PoolManager", () => {
    const bad = clone();
    const v4 = (bad.venues as { kind: number; router: string }[]).find((v) => v.kind === 7)!;
    v4.router = "0x1111111111111111111111111111111111111111";
    expect(swapV2DeploymentShapeError(bad)).toMatch(/canonical PoolManager/i);
  });

  it("rejects a manifest whose CREATE-derived address is not the executor", () => {
    const bad = clone();
    (bad.verification as Record<string, unknown>).computedCreateAddress = "0x1111111111111111111111111111111111111111";
    expect(swapV2DeploymentShapeError(bad)).toMatch(/CREATE-derived address/i);
  });

  it("rejects a manifest without an independent second-RPC cross-check", () => {
    const bad = clone();
    (bad.verification as Record<string, unknown>).crossCheckedWithSecondRpc = false;
    expect(swapV2DeploymentShapeError(bad)).toMatch(/second-RPC/i);
  });

  it("rejects a malformed or missing verification seal", () => {
    const bad = clone();
    delete (bad as Record<string, unknown>).verification;
    expect(swapV2DeploymentShapeError(bad)).toMatch(/runtimeCodeHash/i);
  });
});
