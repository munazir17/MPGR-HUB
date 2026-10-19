// Regression tests for permissionless token<->token quoting through
// searchSwapPaths. Two dormant defects made such pairs unquotable before
// this change: (1) the evidence validator capped candidate outcomes at 8
// while a non-USDC/WETH pair evaluates every direct + bridged candidate,
// and (2) direct discovery tried only UniV3@3000 / Slipstream@10, missing
// the deep Base pool keys. Offline: mocked RPC reader only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import { BASE_WETH, NATIVE_ETH_SENTINEL } from "@/lib/trade/trade-config";
import type { TradeTokenRef } from "@/lib/trade/trade-types";
import {
  SWAP_FEE_RECIPIENT, SWAP_PATH_EXECUTOR_DEPLOYMENT, SWAP_PATH_VENUES,
  __setSwapPathExecutorForTests, type SwapPathExecutorDeployment,
} from "../swap-executor-config";
import { swapPathRoutingEvidence, type SwapPathRoutedProposal } from "../swap-path-evidence";
import { searchSwapPaths } from "../swap-path-search";
import { swapQuotePolicyError } from "../swap-policy";
import type { SwapRouteReadClient } from "../swap-route-selection";

const EXECUTOR: Address = "0x51000000000000000000000000000000000000aa";
const TOKEN_A: Address = "0xa1000000000000000000000000000000000000aa";
const TOKEN_B: Address = "0xb2000000000000000000000000000000000000bb";
const POOL: Address = "0xc3000000000000000000000000000000000000cc";
const TAKER: Address = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const BLOCK = { number: 100n, hash: ("0x" + "ab".repeat(32)) as Hex };

const deployment: SwapPathExecutorDeployment = {
  chainId: 8453, executor: EXECUTOR, owner: TAKER, weth: BASE_WETH, permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  deployTx: ("0x" + "11".repeat(32)) as Hex, deployBlock: 1, feeBps: 25, maxFeeBps: 100, feeTimelockSeconds: 172800,
  feeRecipient: SWAP_FEE_RECIPIENT, explorerUrl: "https://basescan.org/address/0x51",
  venues: [SWAP_PATH_VENUES.uniswapV2, SWAP_PATH_VENUES.aerodromeClassic, SWAP_PATH_VENUES.uniswapV3, SWAP_PATH_VENUES.slipstream],
  tokens: [BASE_WETH, TOKEN_A, TOKEN_B],
};
const ref = (address: Address, symbol: string): TradeTokenRef => ({ address, symbol, name: symbol, decimals: 18, kind: "erc20", verified: true });

const client = {
  getChainId: async () => 8453,
  getBlockNumber: async () => BLOCK.number,
  getBlock: async () => ({ number: BLOCK.number, hash: BLOCK.hash, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
  getCode: async () => "0x6000" as Hex,
  getBalance: async () => 10n ** 30n,
  readContract: vi.fn(async ({ address, functionName }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
    const at = address.toLowerCase();
    if (at === EXECUTOR.toLowerCase()) {
      if (functionName === "feeBps") return 25;
      if (functionName === "feeRecipient") return SWAP_FEE_RECIPIENT;
      if (functionName === "paused") return false;
    }
    if (functionName === "allowance" || functionName === "balanceOf") return 10n ** 30n;
    // Only the UniV2 direct pool exists in this fixture; every other venue
    // key resolves to no pool, exactly like a long-tail pair on Base.
    if (functionName === "getPair" && at === SWAP_PATH_VENUES.uniswapV2.factory.toLowerCase()) return POOL;
    if (functionName === "getPool" || functionName === "getPair") return ZERO;
    if (functionName === "getAmountsOut" && at === SWAP_PATH_VENUES.uniswapV2.router.toLowerCase()) return [0n, 1000n];
    throw new Error(`Unexpected offline read ${functionName} @ ${address}`);
  }),
  simulateContract: vi.fn(async () => ({ result: 10n ** 24n })),
} as unknown as SwapRouteReadClient;

const search = (from: TradeTokenRef, to: TradeTokenRef) =>
  searchSwapPaths(client, { from, to, fromAmount: "1000000", slippageBps: 100, taker: TAKER }, deployment, BLOCK);

beforeEach(() => __setSwapPathExecutorForTests(deployment));
afterEach(() => __setSwapPathExecutorForTests(SWAP_PATH_EXECUTOR_DEPLOYMENT!));

describe("token<->token pairs through searchSwapPaths", () => {
  it("quotes end-to-end with more than eight evaluated candidates (evidence-cap regression)", async () => {
    const result = await search(ref(TOKEN_A, "A"), ref(TOKEN_B, "B"));
    expect(result).not.toBeNull();
    const p = result!.proposal as SwapPathRoutedProposal;
    expect(p.toAmount).toBe("1000");
    expect(p.agentFee?.amountAtomic).toBe("2500"); // 25 bps of 1,000,000
    const evidence = swapPathRoutingEvidence(p);
    // 13 direct + 6 bridged candidates for a non-USDC/WETH pair.
    expect(evidence!.outcomes.length).toBeGreaterThan(8);
    expect(evidence!.outcomes.find(o => o.key === evidence!.key)).toMatchObject({ state: "quoted", output: "1000" });
    expect(swapQuotePolicyError(p)).toBeNull();
  });

  it("evaluates the deep pool keys while discovering the only existing pool", async () => {
    const result = await search(ref(TOKEN_A, "A"), ref(TOKEN_B, "B"));
    const keys = swapPathRoutingEvidence(result!.proposal as SwapPathRoutedProposal)!.outcomes.map(o => o.key);
    // Slipstream spacing 100 and UniV3 0.05% were evaluated (and honestly
    // rejected: no pool for this fixture pair), not silently skipped.
    expect(keys.some(k => /:100($|>)/.test(k))).toBe(true);
    expect(keys.some(k => /:500($|>)/.test(k))).toBe(true);
  });

  it("still quotes native-ETH input through the typed WETH path", async () => {
    const result = await search(ref(NATIVE_ETH_SENTINEL as Address, "ETH"), ref(TOKEN_B, "B"));
    const p = result!.proposal;
    expect(p.toAmount).toBe("1000");
    expect(p.transaction?.value).toBe("1000000");
    expect(swapQuotePolicyError(p)).toBeNull();
  });
});
