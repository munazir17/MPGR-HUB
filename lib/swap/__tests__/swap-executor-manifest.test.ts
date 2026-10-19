// Activation guard: the committed Base Mainnet deployment manifest
// (deployments/base-mainnet/mpgr-swap-executor.json), the production
// SWAP_PATH_EXECUTOR_DEPLOYMENT constant and the typed venue/policy registry
// must never drift apart. The pinned constructor-arguments hex below is the
// tail of the real deployment transaction's input data
// (tx 0x549a54c25a31c0fd47dff625bdfba821c27d892b5cb437473b1decc751efa4cc,
// block 52799525, read back from Basescan), so any edit that moves the app
// away from what was actually deployed on-chain fails here.
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, getAddress, type Address, type Hex } from "viem";
import manifest from "../../../deployments/base-mainnet/mpgr-swap-executor.json";
import {
  SWAP_CHAIN_REGISTRY, SWAP_FEE_BPS, SWAP_FEE_RECIPIENT, SWAP_PATH_EXECUTOR_DEPLOYMENT,
  SWAP_PATH_VENUES, SwapRouterKind, swapPathExecutor, swapPathFeeBps, type SwapVenueName,
} from "../swap-executor-config";
import { swapPathFeeFloor } from "../swap-executor-intent";

/** ABI tail of the deployment tx input after the creation bytecode
 * (kept as a single literal to avoid hand-splitting transcription errors). */
const ONCHAIN_CONSTRUCTOR_ARGS = "0x000000000000000000000000d9ae570767c5a15780dd5cdadd0b1b732d98994b0000000000000000000000004200000000000000000000000000000000000006000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba300000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000001900000000000000000000000096f7fb5c4277bd1190fb6ef4820ebc96ba6964a400000000000000000000000000000000000000000000000000000000000000050000000000000000000000002626664c2603336e57b271c5c0b26f421741e481000000000000000000000000000000000000000000000000000000000000000200000000000000000000000033128a8fc17869897dce68ed026d694621f6fdfd000000000000000000000000698cb2b6dd822994581fea6ea4fc755d1363a92f0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000f8f2eb4940cfe7d13603dddd87f123820fc061ef0000000000000000000000004752ba5dbc23f44d87826276bf6fd6b1c372ad2400000000000000000000000000000000000000000000000000000000000000030000000000000000000000008909dc15e40173ff4699343b6eb8132c65e18ec6000000000000000000000000cf77a3ba9a5ca399b7c97c74d54e5b1beb874e430000000000000000000000000000000000000000000000000000000000000004000000000000000000000000420dd381b31aef6683db6b902084cb0ffece40da0000000000000000000000001b81d678ffb9c0263b24a97847620c99d213eb1400000000000000000000000000000000000000000000000000000000000000050000000000000000000000000bfbcf9fa4f9c56b0f40a671ad40e0805a091865";

const deployment = SWAP_PATH_EXECUTOR_DEPLOYMENT;

describe("MPGRSwapExecutor deployment manifest (Base Mainnet, LIVE)", () => {
  it("activates the production constant and the default accessor", () => {
    expect(deployment).not.toBeNull();
    expect(swapPathExecutor()).toBe(deployment);
    expect(deployment!.chainId).toBe(8453);
  });

  it("matches the sealed deployments/base-mainnet/mpgr-swap-executor.json field-for-field", () => {
    expect(manifest.manifestSchema).toBe("mpgr-swap-executor/v1");
    expect(manifest.chainId).toBe(8453);
    expect(manifest.chainId).toBe(deployment!.chainId);
    expect(manifest.executor).toBe("0xBC4dE809b4b72bCe8f61c87daC6Be12e3F7c6b3E");
    expect(manifest.executor).toBe(deployment!.executor);
    expect(manifest.owner).toBe(deployment!.owner);
    expect(manifest.weth).toBe(deployment!.weth);
    expect(manifest.permit2).toBe(deployment!.permit2);
    expect(manifest.deployTx).toBe(deployment!.deployTx);
    expect(manifest.deployBlock).toBe(deployment!.deployBlock);
    expect(manifest.deployBlock).toBe(52799525);
    expect(manifest.explorerUrl).toBe(deployment!.explorerUrl);
    expect(manifest.feeBps).toBe(deployment!.feeBps);
    expect(manifest.feeBps).toBe(SWAP_FEE_BPS);
    expect(manifest.maxFeeBps).toBe(deployment!.maxFeeBps);
    expect(manifest.maxFeeBps).toBe(100);
    expect(manifest.feeTimelockSeconds).toBe(deployment!.feeTimelockSeconds);
    expect(manifest.feeTimelockSeconds).toBe(172800);
    expect(manifest.feeRecipient).toBe(deployment!.feeRecipient);
    expect(manifest.feeRecipient).toBe(SWAP_FEE_RECIPIENT);
  });

  it("pins a complete, checksummed deployment record", () => {
    expect(manifest.deployTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(manifest.deployBlock).toBeGreaterThan(0);
    expect(manifest.deployReceipt.status).toBe("0x1");
    expect(manifest.deployReceipt.from).toBe(manifest.deployer);
    expect(manifest.deployReceipt.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Number(BigInt(manifest.deployReceipt.gasUsed))).toBeGreaterThan(0);
    // Governance separation: the Safe owns the executor, never the deployer.
    expect(manifest.owner.toLowerCase()).not.toBe(manifest.deployer.toLowerCase());
    for (const a of [manifest.executor, manifest.deployer, manifest.owner, manifest.weth, manifest.permit2, manifest.feeRecipient]) {
      expect(getAddress(a as Address)).toBe(a);
    }
  });

  it("pins all five venues identically in manifest, constant and typed registry", () => {
    expect(manifest.venues).toHaveLength(5);
    expect(deployment!.venues).toHaveLength(5);
    const kinds = new Set<number>();
    for (const v of manifest.venues) {
      const typed = SWAP_PATH_VENUES[v.name as SwapVenueName];
      expect(typed, `venue ${v.name} exists in SWAP_PATH_VENUES`).toBeDefined();
      expect(v.kind).toBe(typed.kind);
      // The manifest is EIP-55 checksummed; a few long-standing registry
      // literals are lowercase. Compare canonicalized on both sides.
      expect(getAddress(v.router as Address)).toBe(getAddress(typed.router));
      expect(getAddress(v.factory as Address)).toBe(getAddress(typed.factory));
      expect(v.quoter === null ? null : getAddress(v.quoter as Address)).toBe(typed.quoter === null ? null : getAddress(typed.quoter));
      expect(getAddress(v.router as Address)).toBe(v.router); // manifest itself is checksummed
      expect(getAddress(v.factory as Address)).toBe(v.factory);
      expect(v.kind).not.toBe(SwapRouterKind.NONE);
      expect(v.kind).not.toBe(SwapRouterKind.ZEROX_SETTLER);
      kinds.add(v.kind);
      const pinned = deployment!.venues.find(x => x.kind === v.kind);
      expect(pinned).toBeDefined();
      expect(getAddress(pinned!.router)).toBe(getAddress(typed.router));
      expect(getAddress(pinned!.factory)).toBe(getAddress(typed.factory));
      expect(pinned!.quoter).toBe(typed.quoter);
    }
    expect(kinds.size).toBe(5);
  });

  it("re-encodes to the exact constructor arguments of the deployment transaction", () => {
    const params = [
      { type: "address" }, { type: "address" }, { type: "address" },
      { type: "tuple[]", components: [{ type: "address" }, { type: "uint8" }, { type: "address" }] },
      { type: "uint16" }, { type: "address" },
    ] as const;
    const encoded = encodeAbiParameters(params, [
      manifest.owner as Address,
      manifest.weth as Address,
      manifest.permit2 as Address,
      manifest.venues.map(v => [v.router as Address, v.kind, v.factory as Address] as const),
      manifest.feeBps,
      manifest.feeRecipient as Address,
    ]);
    expect(encoded.toLowerCase()).toBe(ONCHAIN_CONSTRUCTOR_ARGS.toLowerCase());
  });

  it("keeps the chain registry pointing at the same manifest and infrastructure", () => {
    const base = SWAP_CHAIN_REGISTRY[8453];
    expect(base.manifest).toBe("deployments/base-mainnet/mpgr-swap-executor.json");
    expect(base.weth).toBe(deployment!.weth);
    expect(base.permit2).toBe(deployment!.permit2);
    expect(base.explorerUrl).toBe(deployment!.explorerUrl);
  });

  it("enforces the manifest fee through the shared exact-integer fee floor", () => {
    expect(swapPathFeeBps()).toBe(25);
    expect(swapPathFeeFloor(1_000_000n)).toBe(2_500n);
    expect(swapPathFeeFloor(399n)).toBe(0n); // below the atomic fee floor: routes must reject
    expect(swapPathFeeFloor(400n)).toBe(1n);
  });

  it("exposes the deployment tx as a well-typed hash for explorers", () => {
    expect(deployment!.deployTx).toBe("0x549a54c25a31c0fd47dff625bdfba821c27d892b5cb437473b1decc751efa4cc" as Hex);
  });
});
