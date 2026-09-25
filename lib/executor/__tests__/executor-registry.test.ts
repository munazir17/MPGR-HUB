import { readFileSync } from "node:fs";
import path from "node:path";

import { decodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import type { ChainReader } from "@/lib/executor/executor-chain";
import {
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_EXECUTOR_DEPLOYMENT,
  BASE_MAINNET_EXECUTOR_DEPLOYMENT,
  MPGR_EXECUTOR_DEPLOYMENTS,
  RouterKind,
  getExecutorDeployment,
} from "@/lib/executor/executor-config";
import { MPGR_EXECUTOR_ABI } from "@/lib/executor/mpgr-executor-abi";
import { buildLlmTxt } from "@/lib/mcp/llm-txt";
import { createMcpDeps, isMcpMainnetEnabled } from "@/lib/mcp/mcp-deps";
import { getCapabilities, getQuote, listTokens, prepareTrade, type McpDeps, type ToolOutcome } from "@/lib/mcp/mcp-trade-service";

/** The deployment record committed from the Base Sepolia deploy workflow. */
const RECORD = JSON.parse(readFileSync(path.resolve(__dirname, "../../../deployments/base-sepolia/mpgr-executor.json"), "utf8")) as {
  chainId: number;
  executor: string;
  owner: string;
  feeRecipient: string;
  feeBps: number;
  weth: string;
  permit2: string;
  uniswapV3SwapRouter02: string;
  uniswapV3QuoterV2: string;
  uniswapV3PoolFee: number;
  testTokenUSD: string;
  testTokenStock: string;
  deployTx: string;
  deployBlock: number;
  allowedTokens: { symbol: string; address: string; decimals: number }[];
};

/** The deployment record committed from the one-time Base Mainnet deploy. */
const MAINNET_RECORD = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../deployments/base-mainnet/mpgr-executor.json"), "utf8"),
) as {
  chainId: number;
  executor: string;
  owner: string;
  feeRecipient: string;
  feeBps: number;
  maxFeeBps: number;
  weth: string;
  permit2: string;
  network: string;
  paused: boolean;
  deployTx: string;
  deployBlock: number;
  router: { kind: string; router: string; quoterV2: string; factory: string };
  allowedTokens: Record<string, string>;
};

const lc = (a: string) => a.toLowerCase();
const d = BASE_SEPOLIA_EXECUTOR_DEPLOYMENT;
const dMain = BASE_MAINNET_EXECUTOR_DEPLOYMENT;

describe("Base Sepolia executor registry", () => {
  it("mirrors the committed deployment record exactly", () => {
    expect(RECORD.chainId).toBe(84532);
    expect(d.chainId).toBe(BASE_SEPOLIA_CHAIN_ID);
    expect(d.executor).toBe(RECORD.executor);
    expect(d.owner).toBe(RECORD.owner);
    expect(d.feeRecipient).toBe(RECORD.feeRecipient);
    expect(d.feeBps).toBe(RECORD.feeBps);
    expect(d.weth).toBe(RECORD.weth);
    expect(d.permit2).toBe(RECORD.permit2);
    expect(d.deployTx).toBe(RECORD.deployTx);
    expect(d.deployBlock).toBe(RECORD.deployBlock);
    expect(d.explorerUrl).toContain(RECORD.executor);
    expect(d.tokens.map((t) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals }))).toEqual(RECORD.allowedTokens);
    for (const r of d.routes) {
      expect(r.kind).toBe(RouterKind.UNISWAP_V3_ROUTER02);
      expect(r.router).toBe(RECORD.uniswapV3SwapRouter02);
      expect(r.quoter).toBe(RECORD.uniswapV3QuoterV2);
      expect(r.poolFee).toBe(RECORD.uniswapV3PoolFee);
    }
    // The two pools the deploy script created: tUSD/tSTOCK and WETH/tUSD.
    expect(d.routes.map((r) => [lc(r.tokenA), lc(r.tokenB)].sort())).toEqual(
      [
        [lc(RECORD.testTokenUSD), lc(RECORD.testTokenStock)].sort(),
        [lc(RECORD.weth), lc(RECORD.testTokenUSD)].sort(),
      ],
    );
  });

  it("uses EIP-55 checksummed addresses and only routes allowlisted tokens", () => {
    const addrs = [d.executor, d.owner, d.feeRecipient, d.weth, d.permit2, ...d.tokens.map((t) => t.address), ...d.routes.flatMap((r) => [r.router, r.quoter, r.tokenA, r.tokenB])];
    for (const a of addrs) expect(getAddress(a)).toBe(a);
    const allowed = new Set(d.tokens.map((t) => lc(t.address)));
    for (const r of d.routes) {
      expect(allowed.has(lc(r.tokenA))).toBe(true);
      expect(allowed.has(lc(r.tokenB))).toBe(true);
    }
    expect(d.tokens.filter((t) => t.isWeth).map((t) => t.address)).toEqual([d.weth]);
    expect(lc(d.feeRecipient)).not.toBe(lc(d.executor));
  });

  it("selects the Sepolia executor for 84532 and the mainnet executor for 8453", () => {
    expect(MPGR_EXECUTOR_DEPLOYMENTS[BASE_SEPOLIA_CHAIN_ID]).toBe(d);
    expect(getExecutorDeployment(BASE_SEPOLIA_CHAIN_ID)?.executor).toBe(RECORD.executor);
    expect(MPGR_EXECUTOR_DEPLOYMENTS[BASE_MAINNET_CHAIN_ID]).toBe(dMain);
    expect(getExecutorDeployment(BASE_MAINNET_CHAIN_ID)?.executor).toBe(MAINNET_RECORD.executor);
  });
});

describe("Base Mainnet executor registry", () => {
  it("mirrors the committed deployment record exactly", () => {
    expect(MAINNET_RECORD.chainId).toBe(8453);
    expect(MAINNET_RECORD.paused).toBe(false);
    expect(dMain.chainId).toBe(BASE_MAINNET_CHAIN_ID);
    expect(dMain.network).toBe("base");
    expect(dMain.executor).toBe(MAINNET_RECORD.executor);
    expect(dMain.owner).toBe(MAINNET_RECORD.owner);
    expect(dMain.feeRecipient).toBe(MAINNET_RECORD.feeRecipient);
    expect(dMain.feeBps).toBe(MAINNET_RECORD.feeBps);
    expect(dMain.weth).toBe(MAINNET_RECORD.weth);
    expect(dMain.permit2).toBe(MAINNET_RECORD.permit2);
    expect(dMain.deployTx).toBe(MAINNET_RECORD.deployTx);
    expect(dMain.deployBlock).toBe(MAINNET_RECORD.deployBlock);
    expect(dMain.explorerUrl).toContain(dMain.executor);
  });

  it("registers ONLY the proven USDC <-> WETH Slipstream route (no invented B20 routes)", () => {
    expect(dMain.tokens.map((t) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals }))).toEqual([
      { symbol: "USDC", address: MAINNET_RECORD.allowedTokens.USDC, decimals: 6 },
      { symbol: "WETH", address: MAINNET_RECORD.allowedTokens.WETH, decimals: 18 },
    ]);
    expect(dMain.routes).toHaveLength(1);
    const r = dMain.routes[0];
    expect(r.kind).toBe(RouterKind.AERODROME_SLIPSTREAM);
    expect(r.router).toBe(MAINNET_RECORD.router.router);
    expect(r.quoter).toBe(MAINNET_RECORD.router.quoterV2);
    expect(r.tickSpacing).toBe(50); // the proven WETH/USDC ts=50 pool (live smoke test 71/71)
    expect([lc(r.tokenA), lc(r.tokenB)].sort()).toEqual([lc(MAINNET_RECORD.allowedTokens.USDC), lc(MAINNET_RECORD.weth)].sort());
    // The contract allowlists 13 B20 tokenized stocks; none may be routable over MCP.
    const b20 = Object.entries(MAINNET_RECORD.allowedTokens).filter(([, a]) => lc(a).startsWith("0xb2"));
    expect(b20.length).toBe(13);
    const registered = new Set(dMain.tokens.map((t) => lc(t.address)));
    for (const [symbol, addr] of b20) expect(registered.has(lc(addr))).toBe(false), expect(symbol).toMatch(/c$/);
  });

  it("uses EIP-55 checksummed addresses and only routes allowlisted tokens", () => {
    const addrs = [
      dMain.executor,
      dMain.owner,
      dMain.feeRecipient,
      dMain.weth,
      dMain.permit2,
      ...dMain.tokens.map((t) => t.address),
      ...dMain.routes.flatMap((r) => [r.router, r.quoter, r.tokenA, r.tokenB]),
    ];
    for (const a of addrs) expect(getAddress(a)).toBe(a);
    const allowed = new Set(dMain.tokens.map((t) => lc(t.address)));
    for (const r of dMain.routes) {
      expect(allowed.has(lc(r.tokenA))).toBe(true);
      expect(allowed.has(lc(r.tokenB))).toBe(true);
    }
    expect(dMain.tokens.filter((t) => t.isWeth).map((t) => t.address)).toEqual([dMain.weth]);
    expect(lc(dMain.feeRecipient)).not.toBe(lc(dMain.executor));
  });
});

// A fake Base Sepolia chain that answers for the REAL deployed addresses.
const TAKER = getAddress("0x1234567890123456789012345678901234567890");
function sepoliaReader(balance = 50_000_000n): ChainReader {
  return {
    chainId: BASE_SEPOLIA_CHAIN_ID,
    async readContract({ address, functionName }) {
      if (lc(address) === lc(d.executor)) {
        const v: Record<string, unknown> = { feeBps: 25, feeRecipient: d.feeRecipient, paused: false, MAX_FEE_BPS: 100, owner: d.owner };
        if (functionName in v) return v[functionName];
      }
      if (functionName === "balanceOf") return balance;
      if (functionName === "allowance") return 0n;
      throw new Error(`unexpected ${functionName} on ${address}`);
    },
    async simulateContract({ address, args }) {
      if (lc(address) !== lc(d.routes[0].quoter)) throw new Error("wrong quoter");
      return { result: [((args as [{ amountIn: bigint }])[0].amountIn * 3n), 0n, 0, 0n] };
    },
    async getBalance() {
      return 0n;
    },
    async getTransactionReceipt() {
      throw new Error("not found");
    },
  };
}

function prodDeps(over: Partial<McpDeps> = {}): McpDeps {
  return {
    registry: MPGR_EXECUTOR_DEPLOYMENTS,
    reader: (chainId) => {
      if (chainId !== BASE_SEPOLIA_CHAIN_ID) throw new Error("mainnet must not be read");
      return sepoliaReader();
    },
    nowSeconds: () => 1_800_000_000,
    quoteSecret: "q".repeat(48),
    mainnetEnabled: false,
    mainnetFeeRecipient: null,
    ...over,
  };
}
function ok(o: ToolOutcome) {
  if (!o.ok) throw new Error(`${o.error.code}: ${o.error.message}`);
  return o.data;
}
function code(o: ToolOutcome) {
  if (o.ok) throw new Error("expected failure");
  return o.error.code;
}

describe("MCP execution path uses the deployed Sepolia executor", () => {
  it("capabilities: Sepolia executor deployed, mainnet deployed but trading disabled", () => {
    const chains = ok(getCapabilities(prodDeps())).chains as Record<string, unknown>[];
    expect(chains[0]).toMatchObject({
      chainId: 84532,
      tradingEnabled: true,
      tradingProviders: ["mpgr-executor"],
      executor: { status: "deployed", address: RECORD.executor, owner: RECORD.owner, feeRecipient: RECORD.feeRecipient, deployTx: RECORD.deployTx },
    });
    expect(chains[1]).toMatchObject({
      chainId: 8453,
      tradingEnabled: false,
      tradingProviders: [],
      executor: {
        status: "deployed",
        address: MAINNET_RECORD.executor,
        owner: MAINNET_RECORD.owner,
        feeRecipient: MAINNET_RECORD.feeRecipient,
        deployTx: MAINNET_RECORD.deployTx,
        deployBlock: MAINNET_RECORD.deployBlock,
      },
      tokens: expect.arrayContaining([
        expect.objectContaining({ symbol: "USDC", address: MAINNET_RECORD.allowedTokens.USDC }),
        expect.objectContaining({ symbol: "WETH", address: MAINNET_RECORD.allowedTokens.WETH }),
      ]),
    });
  });

  it("quote → prepare on the default chain produce a tx to the deployed executor via the recorded router", async () => {
    const deps = prodDeps();
    const q = ok(await getQuote(deps, { taker: TAKER, sellToken: "tUSD", buyToken: "tSTOCK", sellAmountHuman: "10" }));
    expect(q).toMatchObject({ chainId: 84532, executor: RECORD.executor, feeRecipient: RECORD.feeRecipient, feeAmount: "25000" });
    const p = ok(await prepareTrade(deps, { quoteId: q.quoteId, authorization: "APPROVAL" }));
    const steps = p.steps as { step: string; transactionRequest: { to: Address; data: Hex; chainId: number } }[];
    expect(steps[0].step).toBe("sendApprovalTransaction");
    expect(steps[0].transactionRequest.to).toBe(RECORD.testTokenUSD);
    const tx = p.transactionRequest as { to: Address; data: Hex; chainId: number };
    expect(tx).toMatchObject({ to: RECORD.executor, chainId: 84532 });
    const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: tx.data });
    expect(decoded.functionName).toBe("swapUniswapV3ExactInputSingle");
    expect(decoded.args?.[0]).toMatchObject({ router: RECORD.uniswapV3SwapRouter02, recipient: TAKER, expectedFeeAmount: 25_000n });
    expect(decoded.args?.[1]).toBe(RECORD.uniswapV3PoolFee);
  });

  it("Base mainnet stays disabled while the flag is off: no quotes and no chain reads (prodDeps' reader throws for 8453)", async () => {
    const deps = prodDeps();
    expect(
      code(await getQuote(deps, { chainId: 8453, taker: TAKER, sellToken: MAINNET_RECORD.allowedTokens.USDC, buyToken: MAINNET_RECORD.allowedTokens.WETH, sellAmount: "1000000" })),
    ).toBe("BASE_MAINNET_DISABLED");
    // listTokens stays informational: it shows the deployed tokens but tradingEnabled=false.
    const d = ok(listTokens(deps, { chainId: 8453 }));
    expect(d.tradingEnabled).toBe(false);
    expect((d.tokens as Record<string, unknown>[]).map((t) => t.symbol)).toEqual(["USDC", "WETH"]);
    expect((d.pairs as Record<string, unknown>[])).toHaveLength(1);
  });
});

describe("production MCP wiring", () => {
  const prev = process.env.MPGR_MCP_ENABLE_BASE_MAINNET;
  afterEach(() => {
    if (prev === undefined) delete process.env.MPGR_MCP_ENABLE_BASE_MAINNET;
    else process.env.MPGR_MCP_ENABLE_BASE_MAINNET = prev;
  });

  it("uses the real registry and keeps mainnet off unless explicitly enabled", () => {
    delete process.env.MPGR_MCP_ENABLE_BASE_MAINNET;
    const deps = createMcpDeps();
    expect(deps.registry).toBe(MPGR_EXECUTOR_DEPLOYMENTS);
    expect(deps.mainnetEnabled).toBe(false);
    for (const v of ["", "1", "TRUE", "yes", "false"]) {
      process.env.MPGR_MCP_ENABLE_BASE_MAINNET = v;
      expect(isMcpMainnetEnabled()).toBe(false);
    }
  });

  it("/llm.txt advertises BOTH deployed executors, the mainnet route and the operator gate", () => {
    const text = buildLlmTxt();
    expect(text).toContain(`MPGR Executor: ${RECORD.executor}`);
    expect(text).toContain(`MPGR Executor: ${MAINNET_RECORD.executor}`);
    expect(text).toContain(`Fee recipient: ${RECORD.feeRecipient}`);
    expect(text).toContain("aerodrome-slipstream tickSpacing 50");
    expect(text).toContain("MPGR_MCP_ENABLE_BASE_MAINNET=true");
    expect(text).not.toMatch(/chainId 8453[\s\S]{0,200}not deployed/);
  });
});
