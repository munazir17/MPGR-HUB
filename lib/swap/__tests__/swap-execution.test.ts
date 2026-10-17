import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, type TransactionReceipt } from "viem";
const m = vi.hoisted(() => ({ read: vi.fn(), send: vi.fn(), wait: vi.fn(), balance: vi.fn(), account: vi.fn(), gas: vi.fn() }));
vi.mock("wagmi/actions", () => ({ readContract: m.read, sendTransaction: m.send, waitForTransactionReceipt: m.wait, getBalance: m.balance, getAccount: m.account, getPublicClient: () => ({}), signTypedData: vi.fn() }));
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
