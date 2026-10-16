import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { simulatedExecutorQuote } from "./flow-fixtures";
import { CHAT_REVIEW_TOKENS, chatDraftToForm } from "../../components/features/agent/chat-autonomy-review";
import { buildGoalDraft, detectAutonomousTradeRequest } from "../../lib/autonomy/chat-draft";
import { delegatedActionId } from "../../lib/executor/delegated-executor";
import type { AutonomyGoalView, AutonomyPolicyView, DelegatedSlotView } from "../../hooks/useAgentAutonomy";
const wallet = "0x1111111111111111111111111111111111111111";
const token = (symbol: string) => CHAT_REVIEW_TOKENS.find(t => t.symbol === symbol)!.address;
const prompt = "Buy AAPLc whenever price falls below $200 worth 1 USDC";
const form = chatDraftToForm(buildGoalDraft(detectAutonomousTradeRequest(prompt)!, prompt));
interface FixtureOptions { ready?: boolean; quoteStatus?: number; authExpired?: boolean; shortQuote?: boolean; policyBlocked?: boolean; permissionFailsOnce?: boolean }
async function setup(page: Page, options: FixtureOptions = {}) {
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
    else if (path === "/api/trade/quote") {
      quotes++;
      status = options.quoteStatus ?? (options.authExpired && quotes === 1 ? 401 : 200);
      if (status !== 200) json = { error: "Simulated quote service refusal", code: status === 401 ? "AUTH_REQUIRED" : "PROVIDER_ERROR" };
      else {
        const proposal = simulatedExecutorQuote({ ...form, sell: body.fromToken, buy: body.toToken, sellAmount: body.amount ?? "1", slippageBps: body.slippageBps });
        const now = await page.evaluate(() => Date.now());
        proposal.quotedAt = new Date(now).toISOString(); proposal.expiresAt = new Date(now + (options.shortQuote ? 1600 : 30_000)).toISOString();
        json = { proposal };
      }
    } else if (path.startsWith("/api/agent/autonomy/") && !options.ready) { status = 404; json = { code: "AUTONOMY_DISABLED" }; }
    else if (path === "/api/agent/autonomy/tokens") json = { tokens: CHAT_REVIEW_TOKENS };
    else if (path === "/api/agent/autonomy/policy" && method === "GET") json = { policies };
    else if (path === "/api/agent/autonomy/goals" && method === "GET") json = { goals };
    else if (path === "/api/agent/autonomy/authorization" && method === "GET") json = { slots, walletSigningSupported: true };
    else if (path === "/api/agent/autonomy/policy" && method === "POST") {
      if (options.policyBlocked) { status = 503; json = { code: "PRODUCTION_GATE_DISABLED", error: "Simulated policy refusal" }; }
      else { status = 201; const policy = { ...body, id: "policy-browser", wallet, maxPerTradeRaw: "1000000", maxDailyRaw: "100000000", expiresAt: new Date(Date.now() + 86400_000).toISOString(), revokedAt: null } as AutonomyPolicyView; policies.push(policy); json = { policy }; }
    } else if (path === "/api/agent/autonomy/goals" && method === "POST") {
      status = 201; const goal = { ...body, id: "goal-browser", status: "DRAFT", trade: { sellToken: policies[0].sellToken, buyToken: policies[0].buyToken, sellAmountRaw: "1000000", slippageBps: 100 },
        expiresAt: policies[0].expiresAt, stats: { evaluations: 0, triggered: 0, verified: 0, consecutiveFailures: 0 }, pendingTxHash: null, lastResult: null, updatedAt: new Date().toISOString() } as AutonomyGoalView;
      goals.push(goal); json = { goal };
    } else if (path === "/api/agent/autonomy/authorization" && method === "POST") {
      permissions++;
      expect(body.goalId).toBe(goals[0].id); expect(body.slots).toHaveLength(1);
      expect(body.slots[0].witness.actionId).toBe(delegatedActionId(goals[0].id));
      expect(body.slots[0].permit.amount).toBe("1000000"); expect(BigInt(body.slots[0].witness.minAmountOut)).toBeGreaterThan(0n);
      if (options.permissionFailsOnce && permissions === 1) { status = 503; json = { error: "Simulated permission persistence failure" }; }
      else { status = 201; slots.push({ id: "slot-browser", policyId: body.policyId, goalId: body.goalId } as DelegatedSlotView); json = { ok: true }; }
    } else if (path === "/api/agent/autonomy/goals/goal-browser" && method === "PATCH") {
      expect(slots).toHaveLength(1); expect(slots[0].goalId).toBe(goals[0].id); goals[0].status = "ACTIVE"; json = { goal: goals[0] };
    } else throw new Error(`Unexpected API request: ${method} ${path}`);
    trace.push({ method, path, status });
    await route.fulfill({ status, json, headers: { "Cache-Control": "no-store", "X-MPGR-Autonomy-Deployment-Environment": "preview", "X-MPGR-Autonomy-Runtime-Gate": options.ready ? "enabled" : "disabled", "X-MPGR-Autonomy-Production-Gate": options.ready ? "enabled" : "missing" } });
  });
  await page.goto("/flows.html"); await expect(page.getByTestId("flow-auth")).toHaveText("true");
  return { trace, policies, goals, slots, quoteCount: () => quotes };
}
async function evidence(page: Page, info: TestInfo, trace: unknown) {
  await info.attach("simulated-api-trace", { body: JSON.stringify(trace, null, 2), contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("flow.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
const walletCalls = (page: Page) => page.evaluate(() => (window as unknown as { simulatedWalletCalls?: string[] }).simulatedWalletCalls ?? []);
async function manual(page: Page) { await page.getByTestId("trading-launcher-manual").tap(); await page.getByLabel("Sell amount", { exact: true }).fill("1"); }
async function draft(page: Page) {
  await page.getByTestId("trading-launcher-autonomy").tap(); await page.getByLabel("USDC per trade").fill("1"); await page.getByLabel("Trigger price (USD)").fill("200");
  await page.getByRole("button", { name: "Review local draft", exact: true }).tap();
}
test("Manual: select, quote, refresh, review and explicitly confirm through real controllers; simulated exact approval + Executor swap", async ({ page }, info) => {
  const state = await setup(page); await manual(page);
  await page.getByLabel("Buy token", { exact: true }).selectOption(token("AAPLc"));
  await page.getByRole("button", { name: "Prepare swap", exact: true }).tap(); await expect(page.getByText("Quote ready — not a settlement")).toBeVisible();
  expect(await walletCalls(page)).toEqual([]); await page.getByRole("button", { name: "Refresh quote", exact: true }).tap();
  await expect(page.getByRole("button", { name: "Review swap", exact: true })).toBeEnabled(); expect(state.quoteCount()).toBe(2);
  await page.getByRole("button", { name: "Review swap", exact: true }).tap(); await expect(page.getByRole("heading", { name: "Confirm swap" })).toBeVisible();
  await expect(page.getByText("0.0025 USDC", { exact: false })).toBeVisible(); expect(await walletCalls(page)).toEqual([]);
  await page.getByRole("button", { name: "Confirm & Swap", exact: true }).tap(); await expect(page.getByTestId("flow-state")).toHaveText("SUCCESS");
  expect((await walletCalls(page)).filter(c => c === "simulated-send")).toHaveLength(2); expect(await walletCalls(page)).not.toContain("delegated-signature");
  expect(state.policies).toHaveLength(0); await evidence(page, info, state.trace);
});
test("Manual: expiry, edit invalidation and wallet/network validation prevent stale review and submission", async ({ page }, info) => {
  const state = await setup(page, { shortQuote: true }); await manual(page);
  await page.getByRole("button", { name: "Prepare swap", exact: true }).tap(); await expect(page.getByText("Quote ready — not a settlement")).toBeVisible();
  await expect(page.getByText("Quote expired — refresh before review")).toBeVisible({ timeout: 4000 }); await expect(page.getByRole("button", { name: "Review swap", exact: true })).toBeDisabled();
  await page.getByLabel("Sell amount", { exact: true }).fill("2"); await expect(page.getByRole("button", { name: "Review swap", exact: true })).toHaveCount(0);
  await page.getByLabel("Wallet fixture").selectOption("wrong-network"); await page.getByLabel("Sell amount", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Prepare swap", exact: true }).tap(); await expect(page.getByRole("alert")).toContainText("Switch your wallet"); expect(state.quoteCount()).toBe(1);
  expect(await walletCalls(page)).not.toContain("simulated-send"); await evidence(page, info, state.trace);
});
for (const status of [429, 503]) test(`Manual: real UI exposes quote HTTP ${status}, no review or wallet execution`, async ({ page }, info) => {
  const state = await setup(page, { quoteStatus: status }); await manual(page); await page.getByRole("button", { name: "Prepare swap", exact: true }).tap();
  await expect(page.getByRole("alert")).toContainText(`HTTP ${status}`); await expect(page.getByRole("button", { name: "Review swap", exact: true })).toHaveCount(0);
  expect(await walletCalls(page)).toEqual([]); await evidence(page, info, state.trace);
});
test("Manual: quote 401 requires explicit retry and re-enters existing SIWE even with a cached authenticated session", async ({ page }, info) => {
  const state = await setup(page, { authExpired: true }); await manual(page); await page.getByRole("button", { name: "Prepare swap", exact: true }).tap();
  await expect(page.getByRole("alert")).toContainText("HTTP 401"); expect(await walletCalls(page)).toEqual([]); expect(state.quoteCount()).toBe(1);
  await page.getByRole("button", { name: "Sign in and retry quote", exact: true }).tap(); await expect(page.getByText("Quote ready — not a settlement")).toBeVisible();
  expect(await walletCalls(page)).toEqual(["siwe-signature"]); expect(state.quoteCount()).toBe(2); await evidence(page, info, state.trace);
});
test("Autonomy: gated Preview still permits local draft → real review, but zero policy/permission/activation writes", async ({ page }, info) => {
  const state = await setup(page); await draft(page);
  await expect(page.getByTestId("autonomy-draft-amount")).toHaveValue("1"); await expect(page.getByTestId("autonomy-draft-price")).toHaveValue("200");
  await expect(page.getByTestId("agent-autonomy-draft-authorize")).toBeDisabled(); await expect(page.getByText(/Mainnet autonomous authorization is unavailable in Preview/)).toBeVisible();
  expect(state.trace.filter(t => t.path.startsWith("/api/agent/autonomy/") && t.method !== "GET")).toEqual([]);
  expect(state.goals).toHaveLength(0); expect(state.slots).toHaveLength(0); expect(await walletCalls(page)).toEqual([]); await evidence(page, info, state.trace);
});
test("Autonomy: isolated ready configuration traverses policy → goal → own-goal permission → activation, without swap/broadcast", async ({ page }, info) => {
  const state = await setup(page, { ready: true }); await draft(page); const activate = page.getByTestId("agent-autonomy-draft-authorize"); await expect(activate).toBeEnabled(); await activate.tap();
  await expect.poll(() => state.goals[0]?.status).toBe("ACTIVE"); expect(state.policies).toHaveLength(1); expect(state.goals).toHaveLength(1); expect(state.slots).toHaveLength(1);
  expect(state.slots[0].goalId).toBe(state.goals[0].id); expect(await walletCalls(page)).toEqual(["delegated-signature"]); await evidence(page, info, state.trace);
});
test("Autonomy: server policy refusal stops before goal creation, signing or activation", async ({ page }, info) => {
  const state = await setup(page, { ready: true, policyBlocked: true }); await draft(page); await page.getByTestId("agent-autonomy-draft-authorize").tap();
  await expect(page.getByText("Simulated policy refusal", { exact: false }).first()).toBeVisible(); expect(state.policies).toHaveLength(0); expect(state.goals).toHaveLength(0); expect(state.slots).toHaveLength(0);
  expect(await walletCalls(page)).toEqual([]); await evidence(page, info, state.trace);
});
test("Autonomy: permission persistence failure leaves DRAFT; retry uses same policy/goal and saves own permission before ACTIVE", async ({ page }, info) => {
  const state = await setup(page, { ready: true, permissionFailsOnce: true }); await draft(page); await page.getByTestId("agent-autonomy-draft-authorize").tap();
  await expect(page.getByText("Simulated permission persistence failure", { exact: false }).first()).toBeVisible(); expect(state.goals[0].status).toBe("DRAFT"); expect(state.slots).toHaveLength(0);
  await page.getByTestId("agent-autonomy-draft-authorize").tap(); await expect.poll(() => state.goals[0]?.status).toBe("ACTIVE");
  expect(state.policies).toHaveLength(1); expect(state.goals).toHaveLength(1); expect(state.slots).toHaveLength(1); expect(await walletCalls(page)).not.toContain("simulated-send"); await evidence(page, info, state.trace);
});
for (const scenario of ["wrong-network", "other-wallet"]) test(`Manual: ${scenario} after review is refused by the real execution controller before wallet submission`, async ({ page }, info) => {
  const state = await setup(page); await manual(page); await page.getByRole("button", { name: "Prepare swap", exact: true }).tap();
  await page.getByRole("button", { name: "Review swap", exact: true }).tap(); await expect(page.getByRole("button", { name: "Confirm & Swap", exact: true })).toBeEnabled();
  await page.getByLabel("Wallet fixture").selectOption(scenario);
  await page.getByRole("button", { name: "Confirm & Swap", exact: true }).tap(); await expect(page.getByTestId("flow-state")).toHaveText("ERROR");
  expect(await walletCalls(page)).not.toContain("simulated-send"); expect(state.policies).toHaveLength(0); await evidence(page, info, state.trace);
});
test("Manual: disconnected wallet can edit but cannot request a quote or execute", async ({ page }, info) => {
  const state = await setup(page); await manual(page); await page.getByLabel("Wallet fixture").selectOption("disconnected");
  await page.getByLabel("Sell amount", { exact: true }).fill("1"); await page.getByRole("button", { name: "Connect wallet to prepare", exact: true }).tap();
  expect(state.quoteCount()).toBe(0); expect(await walletCalls(page)).toEqual([]); await evidence(page, info, state.trace);
});
