// lib/executor/__tests__/delegated-registry.test.ts
//
// Phase 3 — the DELEGATED executor's route registry must mirror the committed
// deployment record exactly and must never overlap the v1 executor's tokens
// (the delegated executor bakes ITS OWN run-fresh token allowlist + pools;
// cross-wiring the two contracts would be fatal at execution time).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT,
  DELEGATED_BASE_SEPOLIA_POOL_USD_STOCK,
  DELEGATED_BASE_SEPOLIA_POOL_WETH_TUSD,
  DELEGATED_BASE_SEPOLIA_TSTOCK,
  DELEGATED_BASE_SEPOLIA_TUSD,
  DELEGATED_EXECUTOR_ADDRESS,
  DELEGATED_EXECUTOR_CHAIN_ID,
  DELEGATED_EXECUTOR_FEE_BPS,
} from "@/lib/executor/delegated-executor";
import {
  BASE_SEPOLIA_EXECUTOR_DEPLOYMENT,
  BASE_SEPOLIA_TSTOCK as V1_TSTOCK,
  BASE_SEPOLIA_TUSD as V1_TUSD,
  BASE_SEPOLIA_UNISWAP_V3,
} from "@/lib/executor/executor-config";

const RECORD_PATH = resolve(__dirname, "../../../deployments/base-sepolia/mpgr-executor-delegated.json");
const record: Record<string, unknown> = JSON.parse(readFileSync(RECORD_PATH, "utf-8"));

describe("delegated executor route registry (Phase 3)", () => {
  it("targets the pinned delegated executor, never the v1 executor", () => {
    expect(BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT.executor).toBe(DELEGATED_EXECUTOR_ADDRESS);
    expect(DELEGATED_EXECUTOR_ADDRESS).not.toBe(BASE_SEPOLIA_EXECUTOR_DEPLOYMENT.executor);
    expect(BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT.chainId).toBe(DELEGATED_EXECUTOR_CHAIN_ID);
    expect(DELEGATED_EXECUTOR_CHAIN_ID).toBe(84532);
  });

  it("keeps the canonical fee/permit2/weth configuration", () => {
    expect(BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT.feeBps).toBe(DELEGATED_EXECUTOR_FEE_BPS);
    expect(BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT.feeBps).toBe(25);
    expect(BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT.permit2).toBe(BASE_SEPOLIA_EXECUTOR_DEPLOYMENT.permit2);
    expect(BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT.weth).toBe(BASE_SEPOLIA_EXECUTOR_DEPLOYMENT.weth);
  });

  it("uses run-fresh tokens that are DISJOINT from the v1 executor's tokens", () => {
    const delegated = BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT.tokens.map((t) => t.address.toLowerCase());
    const v1 = BASE_SEPOLIA_EXECUTOR_DEPLOYMENT.tokens.map((t) => t.address.toLowerCase());
    const weth = BASE_SEPOLIA_EXECUTOR_DEPLOYMENT.weth.toLowerCase();
    const delegatedNonWeth = delegated.filter((a) => a !== weth);
    for (const a of delegatedNonWeth) expect(v1, `delegated token ${a} must not be a v1 token`).not.toContain(a);
    expect(DELEGATED_BASE_SEPOLIA_TUSD.toLowerCase()).not.toBe(V1_TUSD.toLowerCase());
    expect(DELEGATED_BASE_SEPOLIA_TSTOCK.toLowerCase()).not.toBe(V1_TSTOCK.toLowerCase());
  });

  it("registers exactly the two discovered V3 routes, both fee 3000, on the official router/quoter", () => {
    const routes = BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT.routes;
    expect(routes).toHaveLength(2);
    for (const r of routes) {
      expect(r.kind).toBe(2 /* RouterKind.UNISWAP_V3_ROUTER02 */);
      expect(r.router).toBe(BASE_SEPOLIA_UNISWAP_V3.swapRouter02);
      expect(r.quoter).toBe(BASE_SEPOLIA_UNISWAP_V3.quoterV2);
      expect(r.poolFee).toBe(3000);
    }
    const pairs = routes.map((r) => [r.tokenA.toLowerCase(), r.tokenB.toLowerCase()].sort().join("/"));
    expect(pairs).toContain([DELEGATED_BASE_SEPOLIA_TUSD.toLowerCase(), DELEGATED_BASE_SEPOLIA_TSTOCK.toLowerCase()].sort().join("/"));
    expect(pairs).toContain([BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT.weth.toLowerCase(), DELEGATED_BASE_SEPOLIA_TUSD.toLowerCase()].sort().join("/"));
  });

  it("mirrors the committed deployment record field for field", () => {
    expect(record.address).toBe(DELEGATED_EXECUTOR_ADDRESS);
    expect(record.tusd).toBe(DELEGATED_BASE_SEPOLIA_TUSD);
    expect(record.tstock).toBe(DELEGATED_BASE_SEPOLIA_TSTOCK);
    expect(record.poolWethUsd).toBe(DELEGATED_BASE_SEPOLIA_POOL_WETH_TUSD);
    expect(record.poolUsdStock).toBe(DELEGATED_BASE_SEPOLIA_POOL_USD_STOCK);
    expect(record.deploymentTx).toBe(BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT.deployTx);
    expect(record.owner).toBe(BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT.owner);
    expect(record.feeRecipient).toBe(BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT.feeRecipient);
    expect(record.feeBps).toBe(BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT.feeBps);
    expect(record.permit2).toBe(BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT.permit2);
    expect(record.weth).toBe(BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT.weth);
    expect(record.chainId).toBe(BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT.chainId);
    expect((record.poolFeeTiers as Record<string, number>).poolUsdStock).toBe(3000);
    expect((record.poolFeeTiers as Record<string, number>).poolWethUsd).toBe(3000);
  });
});
