import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, type Address, type Hex, type TransactionReceipt } from "viem";
import { BASE_USDC, BASE_WETH } from "@/lib/trade/trade-config";
import type { TradeProposal, TradeTokenRef } from "@/lib/trade/trade-types";
import { MPGR_SWAP_EXECUTOR_ABI } from "../swap-executor-abi";
import { SWAP_FEE_RECIPIENT, SWAP_PATH_EXECUTOR_DEPLOYMENT, SWAP_PATH_VENUES, __setSwapPathExecutorForTests, type SwapPathExecutorDeployment } from "../swap-executor-config";
import { swapPathFeeFloor } from "../swap-executor-intent";
import type { SwapPathRoutingEvidence } from "../swap-path-evidence";
const m = vi.hoisted(() => ({ block: vi.fn(), read: vi.fn(), send: vi.fn(), wait: vi.fn(), balance: vi.fn(), account: vi.fn(), gas: vi.fn() }));
vi.mock("wagmi/actions", () => ({ getBlock: m.block, readContract: m.read, sendTransaction: m.send, waitForTransactionReceipt: m.wait, getBalance: m.balance, getAccount: m.account, getPublicClient: () => ({}), signTypedData: vi.fn() }));
vi.mock("viem/op-stack", () => ({ estimateTotalFee: m.gas }));
vi.mock("@/lib/wagmi", () => ({ config: {} }));
import { executeTrade, type TradeExecutionSafety } from "@/lib/trade/trade-execution";
import { validateSwapWallet } from "../swap-wallet";
import { verifySwapSettlement } from "../swap-policy";
import { simulatedExecutorQuote } from "@/tests/mobile/flow-fixtures";
import { simulatedSwapReceipt } from "@/tests/mobile/swap-receipt-fixture";
import { chatDraftToForm } from "@/components/features/agent/chat-autonomy-review";
import { buildGoalDraft, detectAutonomousTradeRequest } from "@/lib/autonomy/chat-draft";
import { erc20Abi } from "@/lib/erc20-abi";
const prompt = "Buy AAPLc whenever price falls below $200 worth 1 USDC";
const form = chatDraftToForm(buildGoalDraft(detectAutonomousTradeRequest(prompt)!, prompt));
const h1 = `0x${"01".repeat(32)}` as const, h2 = `0x${"02".repeat(32)}` as const;
const p = () => simulatedExecutorQuote(form);
let proposal = p(); let allowance = 0n;
const safety: TradeExecutionSafety = { beforeSignature: validateSwapWallet, verifySettlement: (p, r) => { const proof = verifySwapSettlement(p, r); return proof.verified ? null : { code: "PROVIDER_ERROR", message: proof.reason! }; } };
const run = () => executeTrade({ proposal, currentAccount: proposal.taker, currentChainId: 8453, confirmationState: "READY_FOR_CONFIRMATION", safety }, () => {});
beforeEach(() => {
  vi.resetAllMocks(); proposal = p(); allowance = 0n;
  m.block.mockResolvedValue({ number: 1000n, hash: h2 });
  m.account.mockImplementation(() => ({ isConnected: true, address: proposal.taker, chainId: 8453 }));
  m.balance.mockResolvedValue({ value: 10n ** 18n }); m.gas.mockResolvedValue(10n ** 12n);
  m.read.mockImplementation(async (_c, request) => {
    switch (request.functionName) {
      case "balanceOf": return 100_000_000n;
      case "decimals": return 6;
      case "allowance": return allowance;
      case "feeRecipient": return proposal.agentFee!.recipient;
      case "feeBps": return 25;
      default: throw new Error("Unexpected read");
    }
  });
  m.send.mockResolvedValueOnce(h1).mockResolvedValueOnce(h2);
  m.wait.mockImplementation(async (_c, { hash }) => {
    if (hash === h1 && allowance === 0n) { allowance = BigInt(proposal.fromAmount); return { status: "success", transactionHash: h1, from: proposal.taker, to: proposal.from.address, logs: [] }; }
    return simulatedSwapReceipt(proposal, hash);
  });
});
describe("Swap-only stricter safety on the existing execution controller", () => {
  it("approves exactly gross, verifies receipt and allowance, then swaps once; no fee transfer", async () => {
    expect((await run()).state).toBe("SUCCESS"); expect(m.send).toHaveBeenCalledTimes(2);
    const approval = m.send.mock.calls[0][1]; const decoded = decodeFunctionData({ abi: erc20Abi, data: approval.data });
    expect(decoded).toMatchObject({ functionName: "approve", args: [proposal.permit2Spender, BigInt(proposal.fromAmount)] });
    expect(m.send.mock.calls[1][1]).toMatchObject({ to: proposal.transaction!.to, data: proposal.transaction!.data, value: 0n });
    expect(m.read.mock.calls.filter(([, p]) => p.functionName === "allowance").length).toBeGreaterThanOrEqual(3);
  });
  it("sufficient actual allowance skips an obsolete approval flag", async () => { allowance = BigInt(proposal.fromAmount); m.send.mockReset().mockResolvedValue(h2); expect((await run()).state).toBe("SUCCESS"); expect(m.send).toHaveBeenCalledTimes(1); });
  it("receipt success with still-insufficient allowance stops before swap", async () => { m.wait.mockResolvedValue({ status: "success", transactionHash: h1, from: proposal.taker, to: proposal.from.address }); const result = await run(); expect(result.error?.message).toMatch(/allowance.*insufficient/); expect(m.send).toHaveBeenCalledTimes(1); });
  it("approval rejection is cancelled, not on-chain failure; retry can execute", async () => { m.send.mockReset().mockRejectedValueOnce(new Error("User rejected request")); expect((await run()).error?.message).toMatch(/Approval cancelled/); m.send.mockResolvedValueOnce(h1).mockResolvedValueOnce(h2); expect((await run()).state).toBe("SUCCESS"); });
  it("approval revert stops; keeps approval hash distinct, no swap hash", async () => { m.wait.mockResolvedValue({ status: "reverted", transactionHash: h1, from: proposal.taker, to: proposal.from.address }); const r = await run(); expect(r).toMatchObject({ state: "ERROR", approvalHash: h1, swapHash: null }); expect(m.send).toHaveBeenCalledTimes(1); });
  it("swap rejection retains successful allowance and retry never approves again", async () => {
    m.send.mockReset().mockResolvedValueOnce(h1).mockRejectedValueOnce(new Error("User rejected request")); expect((await run()).error?.message).toMatch(/Swap cancelled/);
    m.send.mockResolvedValueOnce(h2); expect((await run()).state).toBe("SUCCESS"); expect(m.send.mock.calls.filter(([, tx]) => tx.data.startsWith("0x095ea7b3"))).toHaveLength(1);
  });
  it("swap revert is on-chain failure, never collected-fee success", async () => { m.wait.mockImplementation(async (_c, { hash }) => { if (hash === h1) { allowance = BigInt(proposal.fromAmount); return { status: "success", transactionHash: hash, from: proposal.taker, to: proposal.from.address }; } return { ...simulatedSwapReceipt(proposal, hash), status: "reverted" }; }); expect(await run()).toMatchObject({ state: "ERROR", swapHash: h2, error: { code: "SEND_FAILED" } }); });
  it("success receipt without Executor event never proves collection", async () => { allowance = BigInt(proposal.fromAmount); m.send.mockReset().mockResolvedValue(h2); m.wait.mockResolvedValue({ ...simulatedSwapReceipt(proposal, h2), logs: [] }); expect(await run()).toMatchObject({ state: "ERROR", swapHash: h2, error: { code: "PROVIDER_ERROR" } }); });
  it("wrong receipt hash never proves submitted swap", async () => { allowance = BigInt(proposal.fromAmount); m.send.mockReset().mockResolvedValue(h2); m.wait.mockResolvedValue(simulatedSwapReceipt(proposal, h1)); expect((await run()).error?.message).toMatch(/Receipt hash/); });
  it("fee configuration mismatch refuses before approval", async () => { const original = m.read.getMockImplementation()!; m.read.mockImplementation((c, p) => p.functionName === "feeRecipient" ? "0x9999999999999999999999999999999999999999" : original(c, p)); expect((await run()).error?.code).toBe("QUOTE_CHANGED"); expect(m.send).not.toHaveBeenCalled(); });
  it("live balance/read failure cannot use quote-time balance to bypass safety", async () => { m.balance.mockRejectedValue(new Error("RPC failure")); expect((await run()).state).toBe("ERROR"); expect(m.send).not.toHaveBeenCalled(); });
  it("wallet changes after approval stop before swap signature", async () => { const original = m.wait.getMockImplementation()!; m.wait.mockImplementation(async (...args) => { const receipt = await original(...args); m.account.mockReturnValue({ isConnected: true, address: proposal.agentFee!.recipient, chainId: 8453 }); return receipt; }); expect((await run()).error?.code).toBe("WALLET_REQUIRED"); expect(m.send).toHaveBeenCalledTimes(1); });
  it("network changes after approval stop before swap signature", async () => { const original = m.wait.getMockImplementation()!; m.wait.mockImplementation(async (...args) => { const receipt = await original(...args); m.account.mockReturnValue({ isConnected: true, address: proposal.taker, chainId: 1 }); return receipt; }); expect((await run()).error?.code).toBe("UNSUPPORTED_NETWORK"); expect(m.send).toHaveBeenCalledTimes(1); });
  it("quote expires while approval mines: retain approval, require a new review", async () => { const original = m.wait.getMockImplementation()!; m.wait.mockImplementation(async (...args) => { const receipt = await original(...args); proposal.quotedAt = new Date(Date.now() - 31_000).toISOString(); return receipt as TransactionReceipt; }); expect((await run()).error?.code).toBe("QUOTE_EXPIRED"); expect(m.send).toHaveBeenCalledTimes(1); });
});

it("a successful receipt from the wrong approval wallet/token is not an approval proof", async () => {
  m.wait.mockResolvedValue({ status: "success", transactionHash: h1, from: proposal.agentFee!.recipient, to: proposal.from.address });
  expect((await run()).error?.message).toMatch(/receipt does not match/); expect(m.send).toHaveBeenCalledTimes(1);
});
it("critical route warnings cannot reach a wallet signature", async () => {
  proposal.risk = [...proposal.risk, { id: "new-critical", severity: "critical", title: "Blocked", detail: "A critical route warning" }];
  expect((await run()).error?.code).toBe("EXECUTION_UNAVAILABLE"); expect(m.send).not.toHaveBeenCalled();
});
it.each(["approval", "swap"] as const)("unknown allowance fails closed during %s before any wallet prompt", async phase => {
  const original = m.read.getMockImplementation()!;
  m.read.mockImplementation((c, p) => p.functionName === "allowance" ? Promise.reject(new Error("RPC unavailable")) : original(c, p));
  expect((await validateSwapWallet(proposal, phase))?.code).toBe("PROVIDER_ERROR");
  expect((await run()).state).toBe("ERROR"); expect(m.send).not.toHaveBeenCalled();
});
it("allowance becoming sufficient between execution read and approval safety never sends a redundant approval", async () => {
  const original = m.read.getMockImplementation()!; let reads = 0;
  m.read.mockImplementation((c, p) => p.functionName === "allowance" ? Promise.resolve(++reads === 1 ? 0n : BigInt(proposal.fromAmount)) : original(c, p));
  expect((await run()).error?.code).toBe("QUOTE_CHANGED"); expect(m.send).not.toHaveBeenCalled();
});
it.each([undefined, null, -1n, "100000000"])("invalid live allowance %s is not converted into permission", async invalid => {
  const original = m.read.getMockImplementation()!;
  m.read.mockImplementation((c, p) => p.functionName === "allowance" ? Promise.resolve(invalid) : original(c, p));
  expect((await run()).state).toBe("ERROR"); expect(m.send).not.toHaveBeenCalled();
});

// End-to-end through the deployed fixed-fee Swap executor (path proposals):
// the same execution controller must approve THE SWAP EXECUTOR (never the
// legacy Agent executor), re-verify fee posture at the Swap executor before
// signing, then settle on its SwapExecuted + SwapPathExecuted proof.
describe("deployed Swap executor (path) proposals execute end-to-end", () => {
  const EXECUTOR: Address = "0x51000000000000000000000000000000000000aa";
  const TOKEN_A: Address = "0xa1000000000000000000000000000000000000aa";
  const TOKEN_B: Address = "0xb2000000000000000000000000000000000000bb";
  const POOL: Address = "0xc3000000000000000000000000000000000000cc";
  const TAKER: Address = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
  const fake: SwapPathExecutorDeployment = {
    chainId: 8453, executor: EXECUTOR, owner: TAKER, weth: BASE_WETH, permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    deployTx: ("0x" + "11".repeat(32)) as `0x${string}`, deployBlock: 1, feeBps: 25, maxFeeBps: 100, feeTimelockSeconds: 172800, feeRecipient: SWAP_FEE_RECIPIENT, explorerUrl: "https://basescan.org/address/0x51",
    venues: [SWAP_PATH_VENUES.uniswapV2, SWAP_PATH_VENUES.aerodromeClassic, SWAP_PATH_VENUES.uniswapV3, SWAP_PATH_VENUES.slipstream],
    tokens: [BASE_WETH, BASE_USDC, TOKEN_A, TOKEN_B],
  };
  const ref = (address: Address, symbol: string): TradeTokenRef => ({ address, symbol, name: symbol, decimals: 6, kind: "erc20", verified: true });
  const makePath = (): TradeProposal => {
    const gross = 1_000_000n;
    const data = encodeFunctionData({ abi: MPGR_SWAP_EXECUTOR_ABI, functionName: "swapExactInput", args: [{
      router: SWAP_PATH_VENUES.uniswapV2.router, tokenIn: TOKEN_A, tokenOut: TOKEN_B,
      grossAmountIn: gross, expectedFeeAmount: swapPathFeeFloor(gross), amountOutMinimum: 990n,
      recipient: TAKER, deadline: 9999999999n, intentId: keccak256("0x01"), unwrapNativeOut: false,
    }, [{ router: SWAP_PATH_VENUES.uniswapV2.router, tokenOut: TOKEN_B, kind: 3, poolFee: 0, tickSpacing: 0, stable: false, pool: POOL }],
    { kind: 0, deadline: 0n, nonce: 0n, v: 0, r: ("0x" + "0".repeat(64)) as Hex, s: ("0x" + "0".repeat(64)) as Hex, signature: "0x" }] });
    const p: TradeProposal = {
      id: "path1", kind: "swap", network: "base", chainId: 8453, provider: "mpgr-executor", providerLabel: "MPGR Swap executor",
      from: ref(TOKEN_A, "A"), to: ref(TOKEN_B, "B"), fromAmount: "1000000", toAmount: "1000", minToAmount: "990",
      slippageBps: 100, taker: TAKER, liquidityAvailable: true, executionAvailable: true,
      quotedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString(), fees: {},
      agentFee: { status: "applied", bps: 25, recipient: SWAP_FEE_RECIPIENT, amountAtomic: "2500", displayAmount: "0.0025 A", reason: null, collection: "mpgr-executor" },
      issues: { allowance: { currentAllowance: "0", spender: EXECUTOR }, balance: null, simulationIncomplete: true }, transaction: { to: EXECUTOR, data, value: "0" }, permit2: null,
      needsPermit2Approval: true, permit2Spender: EXECUTOR, risk: [], warnings: [], displayFromAmount: "1", displayToAmount: "0.001",
      displayMinToAmount: "0.00099", description: "test", postConfirmationSteps: [], requiresConfirmation: true, phase: "awaiting_signature",
    };
    (p as TradeProposal & { swapPathRouting?: SwapPathRoutingEvidence }).swapPathRouting = {
      version: 2, key: "k", hops: 1, pools: [POOL], blockNumber: "1", blockHash: ("0x" + "ab".repeat(32)) as Hex,
      calldataHash: keccak256(data), outcomes: [{ key: "k", state: "quoted", reason: "QUOTE_ONLY_NOT_EXECUTION_PROOF", output: "1000" }],
      executionSimulation: "not-run-wallet-preflight-required",
    };
    return p;
  };
  const swapLogs = () => [
    { address: EXECUTOR, topics: encodeEventTopics({ abi: MPGR_SWAP_EXECUTOR_ABI, eventName: "SwapExecuted", args: { taker: TAKER, router: SWAP_PATH_VENUES.uniswapV2.router, intentId: keccak256("0x01") } }) as Hex[],
      data: encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "uint16" }, { type: "uint8" }, { type: "uint8" }], [TOKEN_A, TOKEN_B, 1_000_000n, 2500n, 997_500n, 1000n, SWAP_FEE_RECIPIENT, 25, 3, 0]) },
    { address: EXECUTOR, topics: encodeEventTopics({ abi: MPGR_SWAP_EXECUTOR_ABI, eventName: "SwapPathExecuted", args: { intentId: keccak256("0x01"), pathHash: keccak256("0x02") } }) as Hex[],
      data: encodeAbiParameters([{ type: "uint8" }], [1]) },
  ];

  it("approves the Swap executor first, verifies its live fee config, then settles once", async () => {
    __setSwapPathExecutorForTests(fake);
    try {
      const pathProposal = makePath();
      m.account.mockImplementation(() => ({ isConnected: true, address: TAKER, chainId: 8453 }));
      m.wait.mockImplementation(async (_c, { hash }) => {
        if (hash === h1) { allowance = BigInt(pathProposal.fromAmount); return { status: "success", transactionHash: h1, from: TAKER, to: TOKEN_A, logs: [] }; }
        return { status: "success", transactionHash: h2, from: TAKER, to: EXECUTOR, logs: swapLogs() };
      });
      const result = await executeTrade({ proposal: pathProposal, currentAccount: TAKER, currentChainId: 8453, confirmationState: "READY_FOR_CONFIRMATION", safety }, () => {});
      expect(result.state).toBe("SUCCESS"); expect(m.send).toHaveBeenCalledTimes(2);
      const approval = decodeFunctionData({ abi: erc20Abi, data: m.send.mock.calls[0][1].data });
      expect(approval.functionName).toBe("approve");
      expect(approval.args?.[0]?.toLowerCase()).toBe(EXECUTOR);
      expect(approval.args?.[1]).toBe(1_000_000n);
      expect(m.send.mock.calls[1][1]).toMatchObject({ to: EXECUTOR, data: pathProposal.transaction!.data, value: 0n });
      // Fee posture was re-verified at the SWAP executor (never the legacy one).
      const feeReads = m.read.mock.calls.filter(([, r]) => r.functionName === "feeRecipient" || r.functionName === "feeBps");
      expect(feeReads.length).toBeGreaterThanOrEqual(2);
      expect(feeReads.every(([, r]) => r.address?.toLowerCase() === EXECUTOR)).toBe(true);
      // Allowance was only ever read against the Swap executor spender.
      const allowanceReads = m.read.mock.calls.filter(([, r]) => r.functionName === "allowance");
      expect(allowanceReads.length).toBeGreaterThanOrEqual(1);
      expect(allowanceReads.every(([, r]) => r.args?.[1]?.toLowerCase() === EXECUTOR)).toBe(true);
    } finally { __setSwapPathExecutorForTests(SWAP_PATH_EXECUTOR_DEPLOYMENT!); }
  });

  it("a fee-recipient change at the Swap executor refuses before any wallet prompt", async () => {
    __setSwapPathExecutorForTests(fake);
    try {
      const pathProposal = makePath();
      m.account.mockImplementation(() => ({ isConnected: true, address: TAKER, chainId: 8453 }));
      const original = m.read.getMockImplementation()!;
      m.read.mockImplementation((c, r) => r.functionName === "feeRecipient" && r.address?.toLowerCase() === EXECUTOR ? "0x9999999999999999999999999999999999999999" : original(c, r));
      const result = await executeTrade({ proposal: pathProposal, currentAccount: TAKER, currentChainId: 8453, confirmationState: "READY_FOR_CONFIRMATION", safety }, () => {});
      expect(result.error?.code).toBe("QUOTE_CHANGED"); expect(m.send).not.toHaveBeenCalled();
    } finally { __setSwapPathExecutorForTests(SWAP_PATH_EXECUTOR_DEPLOYMENT!); }
  });
});
