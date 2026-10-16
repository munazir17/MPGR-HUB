import { writeFile } from "node:fs/promises";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { simulatedExecutorQuote } from "./flow-fixtures";
import { CHAT_REVIEW_TOKENS, chatDraftToForm } from "../../components/features/agent/chat-autonomy-review";
import { buildGoalDraft, detectAutonomousTradeRequest } from "../../lib/autonomy/chat-draft";
import { delegatedActionId } from "../../lib/executor/delegated-executor";
import type { AutonomyGoalView, AutonomyPolicyView, DelegatedSlotView } from "../../hooks/useAgentAutonomy";
const wallet = "0x1111111111111111111111111111111111111111";
export const token = (symbol: string) => CHAT_REVIEW_TOKENS.find(t => t.symbol === symbol)!.address;
const prompt = "Buy AAPLc whenever price falls below $200 worth 1 USDC";
const form = chatDraftToForm(buildGoalDraft(detectAutonomousTradeRequest(prompt)!, prompt));
export const importedAddress = "0x1234567890abcdef1234567890abcdef12345678";
export interface FixtureOptions { authExpiresOnRefresh?: boolean; feeSkipped?: boolean; importSymbol?: string; importName?: string; importStatus?: number; ready?: boolean; quoteStatus?: number; authExpired?: boolean; shortQuote?: boolean; policyBlocked?: boolean; permissionFailsOnce?: boolean }
export async function setup(page: Page, options: FixtureOptions = {}) {
  page.on("pageerror", error => { throw error; });
  const trace: { method: string; path: string; status: number }[] = [];
  const policies: AutonomyPolicyView[] = [], goals: AutonomyGoalView[] = [], slots: DelegatedSlotView[] = [];
  let quotes = 0, permissions = 0;
  await page.route((url) => !["127.0.0.1", "localhost"].includes(url.hostname), route => route.abort());
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const body = method === "GET" ? null : request.postDataJSON();
    let status = 200; let json: unknown;
    if (path === "/api/auth/session") json = { authenticated: true, wallet };
    else if (path === "/api/auth/nonce") json = { nonce: "offline", issuedAt: new Date().toISOString(), expirationTime: new Date(Date.now() + 60_000).toISOString(), origin: "http://127.0.0.1:4173", chainId: 8453 };
    else if (path === "/api/auth/verify") json = { authenticated: true };
    else if (path === "/api/agent/autonomy/config") json = { enabled: !!options.ready, emergencyDisabled: false, productionGate: !!options.ready, executionAvailable: !!options.ready,
      delegated: { chainId: options.ready ? 8453 : null, executor: options.ready ? "0x2222222222222222222222222222222222222222" : null, walletSigningSupported: true },
      limits: { maxGoalsPerWallet: 5, minCooldownSeconds: 60, maxPolicyTtlDays: 30, maxPerTradeHuman: "100", maxDailyHuman: "500", maxSlippageBps: 100 } };
    else if (path === "/api/trade/token") {
      expect(body).toEqual({ address: importedAddress, chainId: 8453 });
      status = options.importStatus ?? 200;
      json = status === 200 ? { chainId: 8453, token: { address: importedAddress, symbol: options.importSymbol ?? "NEW", name: options.importName ?? "Simulated imported token", decimals: 6, kind: "erc20", verified: false } } : { code: "PROVIDER_ERROR", error: "Simulated Base metadata unavailable" };
    }
    else if (path === "/api/trade/quote") {
      quotes++;
      status = options.quoteStatus ?? ((options.authExpired && quotes === 1) || (options.authExpiresOnRefresh && quotes === 2) ? 401 : 200);
      if (status !== 200) json = { error: "Simulated quote service refusal", code: status === 401 ? "AUTH_REQUIRED" : "PROVIDER_ERROR" };
      else {
        const proposal = simulatedExecutorQuote({ ...form, sell: body.fromToken, buy: body.toToken, sellAmount: body.amount ?? "1", slippageBps: body.slippageBps });
        const now = await page.evaluate(() => Date.now());
        proposal.quotedAt = new Date(now).toISOString(); proposal.expiresAt = new Date(now + (options.shortQuote && quotes === 1 ? 1600 : 30_000)).toISOString();
        if (options.feeSkipped) { proposal.provider = "cdp-trade-api"; proposal.agentFee = { status: "skipped", bps: null, recipient: null, amountAtomic: "0", displayAmount: null, reason: "Unsupported fee route", collection: null }; }
        await page.evaluate(p => { (window as unknown as { simulatedProposal: typeof p }).simulatedProposal = p; }, proposal);
        json = { proposal };
      }
    } else if (path.startsWith("/api/agent/autonomy/") && !options.ready) { status = 404; json = { code: "AUTONOMY_DISABLED" }; }
    else if (path === "/api/agent/autonomy/tokens") json = { tokens: CHAT_REVIEW_TOKENS };
    else if (path === "/api/agent/autonomy/policy" && method === "GET") json = { policies };
    else if (path === "/api/agent/autonomy/goals" && method === "GET") json = { goals };
    else if (path === "/api/agent/autonomy/authorization" && method === "GET") json = { slots, walletSigningSupported: true };
    else if (path === "/api/agent/autonomy/policy" && method === "POST") {
      if (options.policyBlocked) { status = 503; json = { code: "PRODUCTION_GATE_DISABLED", error: "Simulated policy refusal" }; }
      else { status = 201; const policy = { ...body, id: "policy-browser", wallet, enabled: true, maxPerTradeRaw: "1000000", maxDailyRaw: "100000000", expiresAt: new Date(Date.now() + 86400_000).toISOString(), revokedAt: null } as AutonomyPolicyView; policies.push(policy); json = { policy }; }
    } else if (path === "/api/agent/autonomy/goals" && method === "POST") {
      status = 201; const goal = { ...body, id: "goal-browser", status: "DRAFT", trade: { sellToken: policies[0].sellToken, buyToken: policies[0].buyToken, sellAmountRaw: "1000000", slippageBps: 100 },
        expiresAt: policies[0].expiresAt, stats: { evaluations: 0, triggered: 0, verified: 0, consecutiveFailures: 0 }, pendingTxHash: null, lastResult: null, createdAt: new Date().toISOString(), nextEvaluationAt: new Date().toISOString(), lastEvaluationAt: null, lastAction: null, updatedAt: new Date().toISOString() } as AutonomyGoalView;
      goals.push(goal); json = { goal };
    } else if (path === "/api/agent/autonomy/authorization" && method === "POST") {
      permissions++;
      expect(body.goalId).toBe(goals[0].id); expect(body.slots).toHaveLength(1);
      expect(body.slots[0].witness.actionId).toBe(delegatedActionId(goals[0].id));
      expect(body.slots[0].permit.amount).toBe("1000000"); expect(BigInt(body.slots[0].witness.minAmountOut)).toBeGreaterThan(0n);
      if (options.permissionFailsOnce && permissions === 1) { status = 503; json = { error: "Simulated permission persistence failure" }; }
      else { status = 201; slots.push({ id: "slot-browser", policyId: body.policyId, goalId: body.goalId, slotIndex: 0, chainId: 8453, wallet,
        sellToken: policies[0].sellToken, buyToken: policies[0].buyToken, amountRaw: body.slots[0].permit.amount,
        minAmountOutRaw: body.slots[0].witness.minAmountOut, deadline: body.slots[0].permit.deadline,
        deadlineIso: new Date(body.slots[0].permit.deadline * 1000).toISOString(), status: "active",
        consumedAt: null, consumedByTxHash: null, revokedAt: null, createdAt: new Date().toISOString(), actionId: body.slots[0].witness.actionId }); json = { ok: true }; }
    } else if (path === "/api/agent/autonomy/goals/goal-browser" && method === "PATCH") {
      expect(slots).toHaveLength(1); expect(slots[0].goalId).toBe(goals[0].id); goals[0].status = "ACTIVE"; json = { goal: goals[0] };
    } else throw new Error(`Unexpected API request: ${method} ${path}`);
    trace.push({ method, path, status });
    await route.fulfill({ status, json, headers: { "Cache-Control": "no-store", "X-MPGR-Autonomy-Deployment-Environment": "preview", "X-MPGR-Autonomy-Runtime-Gate": options.ready ? "enabled" : "disabled", "X-MPGR-Autonomy-Production-Gate": options.ready ? "enabled" : "missing" } });
  });
  await page.goto("/flows.html"); await expect(page.getByTestId("flow-auth")).toHaveText("true");
  return { trace, policies, goals, slots, quoteCount: () => quotes };
}
export async function evidence(page: Page, info: TestInfo, trace: unknown) {
  const path = info.outputPath("api-trace.json");
  await writeFile(path, JSON.stringify(trace, null, 2));
  await info.attach("simulated-api-trace", { path, contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("flow.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
export const walletCalls = (page: Page) => page.evaluate(() => ((window as unknown as { simulatedWalletCalls?: string[] }).simulatedWalletCalls ?? []).filter(c => ["simulated-send", "simulated-permit", "siwe-signature", "delegated-signature"].includes(c)));
