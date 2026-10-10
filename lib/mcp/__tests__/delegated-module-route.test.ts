import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, getAddress, keccak256, type Address, type Hex } from "viem";

import { BASE_MAINNET_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID, CANONICAL_PERMIT2, CANONICAL_WETH, RouterKind, type ExecutorDeployment } from "@/lib/executor/executor-config";
import type { ChainReader } from "@/lib/executor/executor-chain";
import { EXECUTOR, FEE_RECIPIENT, OWNER, TEST_SECRET } from "@/lib/mcp/__tests__/fixtures";
import { allowAutonomousEmergencySwitchForTests } from "@/lib/autonomy/emergency-switch";
import { delegateSwap, getQuote } from "@/lib/mcp/mcp-trade-service";
import { DELEGATED_EXECUTOR_ABI } from "@/lib/executor/delegated-executor";
import type { McpDeps } from "@/lib/mcp/mcp-trade-service";

const MODULE_ROUTER = getAddress("0x0000000000000000000000000000000000007001");
const MODULE = getAddress("0x0000000000000000000000000000000000007002");
const TOKEN_IN = getAddress("0x0000000000000000000000000000000000007003");
const TOKEN_OUT = getAddress("0x0000000000000000000000000000000000007004");
const BYTECODE = "0x600160005260206000f3" as Hex;
const MODULE_CODE_HASH = keccak256(BYTECODE);
const TAKER = getAddress("0x0000000000000000000000000000000000007005");
const ACTION_ID = `0x${"ab".repeat(32)}` as Hex;

const deployment: ExecutorDeployment = {
  chainId: BASE_MAINNET_CHAIN_ID,
  network: "base",
  executor: EXECUTOR,
  owner: OWNER,
  feeRecipient: FEE_RECIPIENT,
  feeBps: 25,
  weth: CANONICAL_WETH,
  permit2: CANONICAL_PERMIT2,
  deployTx: `0x${"11".repeat(32)}`,
  deployBlock: 123,
  explorerUrl: "https://basescan.org",
  tokens: [
    { address: TOKEN_IN, symbol: "TIn", decimals: 6 },
    { address: TOKEN_OUT, symbol: "TOut", decimals: 18 },
  ],
  routes: [{
    kind: RouterKind.TYPED_SWAP_MODULE,
    router: MODULE_ROUTER,
    quoter: MODULE,
    moduleAddress: MODULE,
    moduleCodeHash: MODULE_CODE_HASH,
    tokenA: TOKEN_IN,
    tokenB: TOKEN_OUT,
  }],
};

function makeDeps(overrides: { code?: Hex; codeHash?: Hex } = {}): {
  deps: McpDeps;
  calls: Array<{ address: Address; functionName: string; args?: readonly unknown[] }>;
  simulations: Array<{ address: Address; functionName: string; args?: readonly unknown[] }>;
} {
  const calls: Array<{ address: Address; functionName: string; args?: readonly unknown[] }> = [];
  const simulations: Array<{ address: Address; functionName: string; args?: readonly unknown[] }> = [];
  const code = overrides.code ?? BYTECODE;
  const codeHash = overrides.codeHash ?? MODULE_CODE_HASH;
  const reader: ChainReader = {
    chainId: BASE_MAINNET_CHAIN_ID,
    async readContract({ address, functionName, args }) {
      calls.push({ address, functionName, args });
      if (address.toLowerCase() === EXECUTOR.toLowerCase()) {
        switch (functionName) {
          case "feeBps": return 25;
          case "feeRecipient": return FEE_RECIPIENT;
          case "paused": return false;
          case "MAX_FEE_BPS": return 100;
          case "owner": return OWNER;
          case "routerKind": return RouterKind.TYPED_SWAP_MODULE;
          case "swapModuleForRouter": return MODULE;
          case "swapModuleCodeHash": return codeHash;
        }
      }
      if (functionName === "balanceOf") return 20_000_000n;
      throw new Error(`unexpected read ${functionName} on ${address}`);
    },
    async simulateContract({ address, functionName, args }) {
      simulations.push({ address, functionName, args });
      const amountIn = (args as readonly [Address, Address, bigint])[2];
      return { result: amountIn * 2n };
    },
    async getBytecode({ address }) {
      expect(address).toBe(MODULE);
      return code;
    },
    async getBalance() { return 0n; },
    async getTransactionReceipt() { throw new Error("not used"); },
  };

  const deps: McpDeps = {
    registry: { [BASE_MAINNET_CHAIN_ID]: null, [BASE_SEPOLIA_CHAIN_ID]: null },
    delegatedRegistry: { [BASE_MAINNET_CHAIN_ID]: deployment },
    reader: (chainId) => {
      expect(chainId).toBe(BASE_MAINNET_CHAIN_ID);
      return reader;
    },
    nowSeconds: () => 1_800_000_000,
    quoteSecret: TEST_SECRET,
    mainnetEnabled: true,
    mainnetFeeRecipient: null,
  };
  return { deps, calls, simulations };
}

describe("delegated typed-module quoting", () => {
  beforeEach(() => {
    allowAutonomousEmergencySwitchForTests();
    vi.stubEnv("MPGR_MAINNET_DELEGATED_EXECUTOR", EXECUTOR);
    // The delegateSwap broadcast below targets Base mainnet (8453), which is
    // additionally gated by the explicit production flag
    // (AUTONOMOUS_PRODUCTION_ENABLED). This suite proves the typed-module
    // ENCODING path, so it opens the gate exactly the way an operator would.
    // The gate-OFF refusal itself is pinned in
    // lib/autonomy/__tests__/production-gate.test.ts.
    vi.stubEnv("AUTONOMOUS_PRODUCTION_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("simulates quoteExactInput only after live registry and runtime bytecode match", async () => {
    const { deps, calls, simulations } = makeDeps();
    const result = await getQuote(deps, {
      chainId: BASE_MAINNET_CHAIN_ID,
      executor: EXECUTOR,
      taker: TAKER,
      sellToken: TOKEN_IN,
      buyToken: TOKEN_OUT,
      sellAmount: "10000000",
      slippageBps: 100,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.route).toMatchObject({
      venue: "typed-swap-module",
      executor: EXECUTOR,
      router: MODULE_ROUTER,
      moduleAddress: MODULE,
      moduleCodeHash: MODULE_CODE_HASH,
    });
    expect(result.data.swapAmount).toBe("9975000");
    expect(result.data.expectedBuyAmount).toBe("19950000");
    expect(result.data.minBuyAmount).toBe("19750500");
    expect(result.data.authorization).toBe("PERMIT2");
    expect(calls.map((call) => call.functionName)).toContain("swapModuleForRouter");
    expect(calls.map((call) => call.functionName)).toContain("swapModuleCodeHash");
    expect(simulations).toEqual([{
      address: MODULE,
      functionName: "quoteExactInput",
      args: [TOKEN_IN, TOKEN_OUT, 9_975_000n],
    }]);
  });

  it("fails closed before simulation if module runtime code does not match the pinned hash", async () => {
    const { deps, simulations } = makeDeps({ code: "0x600260005260206000f3" as Hex });
    const result = await getQuote(deps, {
      chainId: BASE_MAINNET_CHAIN_ID,
      executor: EXECUTOR,
      taker: TAKER,
      sellToken: TOKEN_IN,
      buyToken: TOKEN_OUT,
      sellAmount: "10000000",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "ROUTE_MISMATCH" } });
    expect(simulations).toHaveLength(0);
  });

  it("encodes only the fixed typed-module executor entrypoint for delegated execution", async () => {
    const { deps } = makeDeps();
    const sent: Array<{ to: Address; data: Hex; chainId: number; value?: bigint }> = [];
    deps.delegatedBroadcaster = async (tx) => {
      sent.push(tx);
      return `0x${"55".repeat(32)}` as Hex;
    };

    const deadline = "2000000000";
    const result = await delegateSwap(deps, {
      chainId: BASE_MAINNET_CHAIN_ID,
      router: MODULE_ROUTER,
      intentId: ACTION_ID,
      expectedFeeAmount: "25000",
      authorization: {
        permit: {
          permitted: { token: TOKEN_IN, amount: "10000000" },
          nonce: "1",
          deadline,
        },
        witness: {
          owner: TAKER,
          buyToken: TOKEN_OUT,
          minAmountOut: "1000",
          deadline: BigInt(deadline),
          actionId: ACTION_ID,
          policyHash: `0x${"cd".repeat(32)}`,
        },
        signature: `0x${"11".repeat(65)}`,
      },
    });

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    const tx = sent[0];
    if (!tx) return;
    expect(tx.to).toBe(EXECUTOR);
    expect(tx.chainId).toBe(BASE_MAINNET_CHAIN_ID);
    expect(tx.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: DELEGATED_EXECUTOR_ABI, data: tx.data });
    expect(decoded.functionName).toBe("swapOnBehalfOfTypedModule");
    expect((decoded.args[0] as { router: Address }).router).toBe(MODULE_ROUTER);
  });

  it("refuses a typed module if quoted without the explicitly pinned delegated executor", async () => {
    const { deps, simulations } = makeDeps();
    deps.registry[BASE_MAINNET_CHAIN_ID] = deployment;
    const result = await getQuote(deps, {
      chainId: BASE_MAINNET_CHAIN_ID,
      taker: TAKER,
      sellToken: TOKEN_IN,
      buyToken: TOKEN_OUT,
      sellAmount: "10000000",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_VENUE" } });
    expect(simulations).toHaveLength(0);
  });
});
