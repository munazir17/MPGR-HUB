// Authorized PR113 Preview acceptance probe. Anonymous browser GETs only;
// unauthenticated quote POSTs per deployment must refuse before providers.
// No wallet connection, auth cookies, signatures, goal writes or execution.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

const baselineSHA = "bb70ec86cf394f7412b2d053df3f1b4d33475d10";
const repo = process.env.REPO;
assert.equal(repo, "munazir17/MPGR-HUB");
const api = path => JSON.parse(execFileSync("gh", ["api", `repos/${repo}/${path}`], { encoding: "utf8" }));
const deployment = api(`deployments?sha=${baselineSHA}&per_page=10`).find(d => d.environment === "Preview" && d.sha === baselineSHA);
assert.ok(deployment, "Baseline Preview deployment metadata unavailable");
const baselineURL = api(`deployments/${deployment.id}/statuses`).find(s => s.state === "success")?.environment_url;
const currentURL = process.env.CHAT_PREVIEW_URL;
const bypass = process.env.CHAT_PREVIEW_BYPASS;
assert.ok(bypass, "Authorized Preview access is unavailable");
const origins = [baselineURL, currentURL].map(value => {
  assert.match(value ?? "", /^https:\/\/mpgr-hub-ezxs-[a-z0-9]+-munazir-razas-projects\.vercel\.app\/?$/);
  return new URL(value).origin;
});
const output = "p0-preview-evidence";
mkdirSync(output, { recursive: true });
const results = { observedAt: new Date().toISOString(), baselineSHA, currentSHA: process.env.CHAT_HEAD_SHA, deployments: [] };
const browser = await chromium.launch({ args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  for (const [index, origin] of origins.entries()) {
    const label = index === 0 ? "baseline" : "current";
    const get = async path => {
      assert.ok(["/api/auth/session", "/api/agent/autonomy/config", "/api/agent/autonomy/tokens?chainId=8453", "/api/agent/autonomy/goals"].includes(path));
      const response = await fetch(origin + path, { method: "GET", redirect: "manual", headers: { "x-vercel-protection-bypass": bypass }, signal: AbortSignal.timeout(60_000) });
      const body = await response.json().catch(() => null);
      return { response, body };
    };
    const { response: configResponse, body: config } = await get("/api/agent/autonomy/config");
    assert.equal(configResponse.status, 200); assert.equal(config?.enabled, false); assert.equal(config?.productionGate, false);
    const tokens = await get("/api/agent/autonomy/tokens?chainId=8453"); const goals = await get("/api/agent/autonomy/goals");
    const session = await get("/api/auth/session");
    const manualQuotes = [];
    const anonymousRequests = [["/api/trade/quote", { fromToken: "USDC", toToken: "WETH", amount: "1", slippageBps: 100 }],
      ["/api/trade/stocks/quote", { symbol: "AAPLc", side: "BUY", amount: "1" }]];
    if (index === 1) anonymousRequests.push(["/api/trade/token", { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chainId: 8453 }]);
    for (const [path, input] of anonymousRequests) {
      const response = await fetch(origin + path, { method: "POST", redirect: "manual", credentials: "omit",
        headers: { "x-vercel-protection-bypass": bypass, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(input), signal: AbortSignal.timeout(60_000) });
      const body = await response.json().catch(() => null);
      manualQuotes.push({ path, HTTP: response.status, authRequired: body?.code === "AUTH_REQUIRED",
        originRejected: body?.error === "Cross-site request rejected", originUnconfigured: body?.error === "Origin verification is not configured", providerHealthVerified: false });
    }
    const result = { label, commit: index === 0 ? baselineSHA : process.env.CHAT_HEAD_SHA,
      config: { HTTP: configResponse.status, enabled: config.enabled, productionGate: config.productionGate, executionAvailable: config.executionAvailable,
        environment: configResponse.headers.get("x-mpgr-autonomy-deployment-environment") === "preview" ? "preview" : "unknown" },
      tokens: { HTTP: tokens.response.status, disabled: tokens.body?.code === "AUTONOMY_DISABLED" },
      goals: { HTTP: goals.response.status, disabled: goals.body?.code === "AUTONOMY_DISABLED" },
      session: { HTTP: session.response.status, authenticated: session.body?.authenticated === true }, manualQuotes, mobile: [] };
    results.deployments.push(result);
    // Persist status evidence even if a check fails. No raw bodies/cookies/headers.
    writeFileSync(`${output}/results.json`, JSON.stringify(results, null, 2));
    for (const quote of manualQuotes) {
      assert.equal(quote.HTTP, 401, "Anonymous quote must reach the session gate; inspect origin/config if it does not");
      assert.equal(quote.authRequired, true);
    }
    assert.equal(tokens.response.status, 404); assert.equal(goals.response.status, 404);
    for (const [width, height] of [[360, 800], [390, 844]]) {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      // The bypass header is sent ONLY to this allowlisted Preview origin.
      // Block all non-GET browser requests (including analytics/visitors), all
      // external hosts and any RPC/sign-in/authorization attempt.
      await page.route("**/*", route => {
        const request = route.request();
        if (new URL(request.url()).origin !== origin || request.method() !== "GET") return route.abort();
        return route.continue({ headers: { ...request.headers(), "x-vercel-protection-bypass": bypass } });
      });
      await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const launcher = page.getByTestId("agent-trading-launcher"); await expect(launcher).toBeVisible({ timeout: 30_000 });
      if (index === 0) await page.getByTestId("trading-launcher-manual").tap();
      else {
        await expect(page.getByTestId("trading-launcher-manual")).toHaveCount(0);
        await expect(page.getByRole("form", { name: "Prepare a manual swap" })).toHaveCount(0);
        await page.screenshot({ path: `${output}/${label}-${width}-agent-command-first.png`, fullPage: true });
        await page.getByRole("button", { name: "Open menu", exact: true }).tap();
        await page.getByRole("dialog", { name: "MPGR HUB menu", exact: true }).getByRole("link", { name: "MPGR Swap", exact: true }).tap();
        await expect(page).toHaveURL(`${origin}/swap`);
        await expect(page.getByRole("heading", { name: "MPGR Swap", exact: true })).toBeVisible();
        await expect(page.getByText("Limit orders — not available", { exact: true })).toBeVisible();
      }
      const manualForm = page.getByRole("form", { name: "Prepare a manual swap" });
      await expect(manualForm).toHaveCount(1);
      await expect(manualForm.getByLabel("Sell token", { exact: true })).toBeVisible();
      await manualForm.getByLabel("Sell amount", { exact: true }).fill("1");
      await expect(manualForm.getByRole("button", { name: "Connect wallet to prepare", exact: true })).toBeVisible();
      await manualForm.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${output}/${label}-${width}-manual.png`, fullPage: true });
      if (index === 1) await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByTestId("trading-launcher-autonomy").tap();
      const composer = launcher.getByRole("form", { name: "Draft a conditional goal" });
      await expect(composer).toHaveCount(1);
      {
        await composer.getByLabel("USDC per trade").fill("1"); await composer.getByLabel("Trigger price (USD)").fill("200");
        await composer.getByRole("button", { name: "Review local draft", exact: true }).tap();
        await expect(page.getByTestId("agent-autonomy-draft-authorize")).toBeDisabled();
        await expect(page.getByTestId("autonomy-draft-amount")).toHaveValue("1");
        await expect(page.getByTestId("autonomy-draft-price")).toHaveValue("200");
        await page.getByTestId("agent-autonomy-draft-authorize").scrollIntoViewIfNeeded();
      }
      await page.screenshot({ path: `${output}/${label}-${width}-autonomy.png`, fullPage: true });
      result.mobile.push({ width, height, manualFormAvailable: true, manualSurface: index === 1 ? "/swap" : "Agent Manual tab", agentManualControlsRemoved: index === 1, localDraftReviewAvailable: true,
        authorizationButtonDisabled: true, walletConnected: false, signed: false, executed: false });
      await context.close();
    }
  }
} finally {
  await browser.close();
  writeFileSync(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(`::notice title=PR113 deployed user-flow evidence::${JSON.stringify(results)}`);
}
