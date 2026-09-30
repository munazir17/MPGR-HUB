// lib/autonomy/__tests__/live-delegated.execution.test.ts
//
// PHASE 3 — LIVE Base Sepolia delegated execution through the REAL app path:
// quote (MCP, on-chain QuoterV2) -> user-signed Permit2 witness slots
// (STANDARD EIP-712 wallet-style signing against the redeployed executor) ->
// DelegatedExecutionAdapter -> McpTradeGateway.delegateSwap -> operator
// broadcaster -> MPGRExecutorDelegated (0xa9568499…58F9) -> existing
// verification layer (tx.from == broadcaster AND taker == user, exact 25 bps).
//
// SAFETY / ARMING:
//  * SKIPPED unless MPGR_LIVE_DELEGATED=true (normal suites never run this).
//  * Only ever armed from the tag-gated GitHub workflow, with secrets from the
//    `base-sepolia` environment. Nothing here ever touches Base Mainnet.
//  * The "user" is a DEDICATED TEST keypair (MPGR_LIVE_TEST_USER_PRIVATE_KEY)
//    — never the operator's main wallet, never the broadcaster, never the
//    deployer. Amounts are tiny and hard-capped.
//  * The broadcaster can ONLY broadcast the user-signed bounded slots; all
//    authorization semantics are enforced on-chain by the executor.

import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import {
  CANONICAL_PERMIT2,
  DELEGATED_EXECUTOR_ADDRESS,
  delegatedActionId,
  delegatedPermitNonce,
  delegatedPermitTypedData,
  delegatedPolicyHash,
} from "@/lib/executor/delegated-executor";
import { BASE_SEPOLIA_TSTOCK, BASE_SEPOLIA_TUSD } from "@/lib/executor/executor-config";
import { createDelegatedBroadcaster } from "@/lib/delegated/delegated-broadcaster";
import { DelegatedExecutionAdapter } from "@/lib/autonomy/delegated-execution-adapter";
import { InMemoryDelegatedAuthorizationStore } from "@/lib/autonomy/delegated-authorization";
import { McpTradeGateway } from "@/lib/autonomy/mcp-gateway";
import type { AutonomyPolicy, DelegatedSwapRequest } from "@/lib/autonomy/types";

const LIVE = process.env.MPGR_LIVE_DELEGATED === "true";

/** Hard cap: the live demo never sells more than 10k tUSD of TEST tokens. */
const MAX_SELL_AMOUNT_RAW = 10_000_000_000n; // 10,000 tUSD (6 dp)

interface LiveResult {
  broadcaster: Address;
  testUser: Address;
  buy?: { txHash: Hex; soldRaw: string; boughtRaw: string; feeRaw: string; quoteId: string };
  sell?: { txHash: Hex; soldRaw: string; boughtRaw: string; feeRaw: string; quoteId: string };
}

describe.skipIf(!LIVE)("LIVE delegated execution — Base Sepolia 84532 (armed run only)", () => {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org";
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });

  const broadcasterKey = process.env.MPGR_BROADCASTER_PRIVATE_KEY?.trim();
  const testUserKey = process.env.MPGR_LIVE_TEST_USER_PRIVATE_KEY?.trim();
  const deployerKey = process.env.BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY?.trim();

  it("executes a tiny BUY and SELL through the real adapter/MCP/broadcaster path with exact-fee verification", { timeout: 900_000 }, async () => {
    // ---------------- arming + key hygiene ----------------
    expect(broadcasterKey, "MPGR_BROADCASTER_PRIVATE_KEY must be set").toBeTruthy();
    expect(testUserKey, "MPGR_LIVE_TEST_USER_PRIVATE_KEY must be set").toBeTruthy();
    expect(deployerKey, "BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY must be set (fixture funding)").toBeTruthy();

    const broadcaster = createDelegatedBroadcaster();
    expect(broadcaster.address, "broadcaster must be configured").toBeTruthy();
    const broadcasterAddress = broadcaster.address as Address;
    const testUser: PrivateKeyAccount = privateKeyToAccount(testUserKey! as `0x${string}`);
    const deployer: PrivateKeyAccount = privateKeyToAccount(deployerKey! as `0x${string}`);

    const distinct = new Set([broadcasterAddress, testUser.address, deployer.address].map((a) => a.toLowerCase()));
    expect(distinct.size, "broadcaster, live-test user and deployer must be three distinct wallets").toBe(3);

    const chainId = await client.getChainId();
    expect(chainId, "MUST be Base Sepolia 84532").toBe(84532);

    // ---------------- balances (preflight evidence) ----------------
    const [bBroadcaster, bUser, userUsd] = await Promise.all([
      client.getBalance({ address: broadcasterAddress }),
      client.getBalance({ address: testUser.address }),
      client.readContract({ address: BASE_SEPOLIA_TUSD, abi: erc20Abi, functionName: "balanceOf", args: [testUser.address] }),
    ]);
    console.log(`::notice::LIVE broadcaster=${broadcasterAddress} eth=${Number(bBroadcaster) / 1e18} testUser=${testUser.address} eth=${Number(bUser) / 1e18} tUSD=${userUsd.toString()}`);
    expect(bBroadcaster, "broadcaster needs >= 0.0005 ETH for gas").toBeGreaterThanOrEqual(parseEther("0.0005"));

    // ---------------- amount ----------------
    const sellAmountRaw = BigInt(process.env.MPGR_LIVE_SELL_AMOUNT_RAW?.trim() || "100000000"); // default 100 tUSD
    expect(sellAmountRaw > 0n, "sell amount must be positive").toBe(true);
    expect(sellAmountRaw <= MAX_SELL_AMOUNT_RAW, "sell amount above the hard cap").toBe(true);

    // ---------------- fixture funding (testnet only, NOT the delegated trade) ----------------
    // Deployer tops the test user up with ETH + tUSD + a little tSTOCK when short.
    const deployerWallet = createWalletClient({ account: deployer, chain: baseSepolia, transport: http(rpcUrl) });
    const userStockBefore = await client.readContract({ address: BASE_SEPOLIA_TSTOCK, abi: erc20Abi, functionName: "balanceOf", args: [testUser.address] });
    if (bUser < parseEther("0.001")) {
      await waitFor(client, await deployerWallet.sendTransaction({ to: testUser.address, value: parseEther("0.002") }));
    }
    if (userUsd < sellAmountRaw) {
      await waitFor(client, await deployerWallet.sendTransaction({ to: BASE_SEPOLIA_TUSD, data: encodeTransfer(testUser.address, sellAmountRaw) }));
    }
    if (userStockBefore < parseEther("0.000001")) {
      await waitFor(client, await deployerWallet.sendTransaction({ to: BASE_SEPOLIA_TSTOCK, data: encodeTransfer(testUser.address, parseEther("1")) }));
    }

    // Permit2 allowance for the test user (needed once per token) — the test
    // user approves with their OWN key.
    const testUserWallet = createWalletClient({ account: testUser, chain: baseSepolia, transport: http(rpcUrl) });
    await ensureAllowance(testUserWallet, client, BASE_SEPOLIA_TUSD, sellAmountRaw);
    await ensureAllowance(testUserWallet, client, BASE_SEPOLIA_TSTOCK, await client.readContract({ address: BASE_SEPOLIA_TSTOCK, abi: erc20Abi, functionName: "balanceOf", args: [testUser.address] }));

    // ---------------- the real app stack ----------------
    const gateway = McpTradeGateway.productionWithDelegation();
    const slots = new InMemoryDelegatedAuthorizationStore();
    const runTag = Date.now().toString(36);
    const policies = new Map<string, AutonomyPolicy>();
    const makePolicy = (id: string, sellToken: Address, buyToken: Address): AutonomyPolicy => ({
      id,
      wallet: testUser.address.toLowerCase() as Address,
      chainId: 84532,
      actions: ["swap"],
      sellToken,
      buyToken,
      maxPerTradeRaw: MAX_SELL_AMOUNT_RAW.toString(),
      maxDailyRaw: (MAX_SELL_AMOUNT_RAW * 10n).toString(),
      maxSlippageBps: 500,
      maxActionsPerDay: 5,
      enabled: true,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
      authorizedAt: new Date().toISOString(),
      authorizationRef: "live-test",
    });
    policies.set("live_buy", makePolicy("live_buy", BASE_SEPOLIA_TUSD, BASE_SEPOLIA_TSTOCK));
    policies.set("live_sell", makePolicy("live_sell", BASE_SEPOLIA_TSTOCK, BASE_SEPOLIA_TUSD));

    const adapter = new DelegatedExecutionAdapter({
      slots,
      gateway,
      chain: {
        getBytecode: async (address) => (await client.getBytecode({ address })) ?? null,
        readContract: (args) => client.readContract(args as never) as never,
      },
      getPolicy: async (id) => policies.get(id) ?? null,
    });

    // Adapter posture: executor code + feeBps==25 + canonical Permit2 + witness string, ON-CHAIN.
    const posture = await adapter.verifyOnChain();
    expect(posture.authorized, `adapter on-chain posture failed: ${posture.reason}`).toBe(true);

    const result: LiveResult = { broadcaster: broadcasterAddress, testUser: testUser.address };

    // ================= BUY: tUSD -> tSTOCK =================
    const buyQuote = await gateway.quote({
      chainId: 84532,
      taker: testUser.address,
      sellToken: BASE_SEPOLIA_TUSD,
      buyToken: BASE_SEPOLIA_TSTOCK,
      sellAmount: sellAmountRaw.toString(),
      slippageBps: 300,
    });
    expect(buyQuote.ok, `BUY quote failed: ${buyQuote.ok ? "" : buyQuote.failure.message}`).toBe(true);
    const bq = buyQuote.ok ? buyQuote.data : null;
    expect(BigInt(bq!.minBuyAmountRaw) > 0n, "BUY quote returned a zero floor (pool dead?)").toBe(true);

    const buyGoalId = `live-${runTag}-buy`;
    await signAndStoreSlot(slots, testUser, {
      policy: policies.get("live_buy")!,
      goalId: buyGoalId,
      slotIndex: 0,
      sellToken: BASE_SEPOLIA_TUSD,
      buyToken: BASE_SEPOLIA_TSTOCK,
      sellAmountRaw,
      minAmountOut: bq!.minBuyAmountRaw,
    });

    const buyExec = await adapter.executeSwap({
      goalId: buyGoalId,
      policyId: "live_buy",
      wallet: testUser.address.toLowerCase() as Address,
      chainId: 84532,
      quoteId: bq!.quoteId,
      sellToken: BASE_SEPOLIA_TUSD,
      buyToken: BASE_SEPOLIA_TSTOCK,
      sellAmountRaw: sellAmountRaw.toString(),
      expectedBuyAmountRaw: bq!.expectedBuyAmountRaw,
      minBuyAmountRaw: bq!.minBuyAmountRaw,
      slippageBps: 300,
      idempotencyKey: `${buyGoalId}-exec`,
      steps: [],
      transactionRequest: null,
    } satisfies DelegatedSwapRequest);
    expect(buyExec.ok, `BUY execution failed: ${buyExec.ok ? "" : buyExec.message}`).toBe(true);
    const buyTxHash: Hex = buyExec.ok ? (buyExec.txHash as Hex) : ("0x" as Hex);
    await waitFor(client, buyTxHash);

    const buyVerify = await gateway.verify(bq!.quoteId, buyTxHash, broadcasterAddress);
    expect(buyVerify.ok && buyVerify.data.verified, `BUY verification FAILED: ${JSON.stringify(buyVerify)}`).toBe(true);
    const buyFee = BigInt((buyVerify.ok && buyVerify.data.feeAmountRaw) || "0");
    expect(buyFee, "BUY fee must equal floor(gross * 25 bps)").toBe((sellAmountRaw * 25n) / 10000n);
    result.buy = { txHash: buyTxHash, soldRaw: sellAmountRaw.toString(), boughtRaw: (buyVerify.ok && buyVerify.data.actualBuyAmountRaw) || "0", feeRaw: buyFee.toString(), quoteId: bq!.quoteId };
    console.log(`::notice::LIVE BUY tx=${buyTxHash} feeRaw=${buyFee} out=${result.buy!.boughtRaw}`);

    // ================= SELL: tSTOCK -> tUSD =================
    const stockNow = await client.readContract({ address: BASE_SEPOLIA_TSTOCK, abi: erc20Abi, functionName: "balanceOf", args: [testUser.address] });
    const stockReceived = stockNow - (userStockBefore < parseEther("0.000001") ? 0n : userStockBefore);
    expect(stockReceived > 0n, "BUY produced zero tSTOCK — cannot run the SELL leg").toBe(true);

    const sellQuote = await gateway.quote({
      chainId: 84532,
      taker: testUser.address,
      sellToken: BASE_SEPOLIA_TSTOCK,
      buyToken: BASE_SEPOLIA_TUSD,
      sellAmount: stockReceived.toString(),
      slippageBps: 300,
    });
    expect(sellQuote.ok, `SELL quote failed: ${sellQuote.ok ? "" : sellQuote.failure.message}`).toBe(true);
    const sq = sellQuote.ok ? sellQuote.data : null;
    expect(BigInt(sq!.minBuyAmountRaw) > 0n, "SELL quote returned a zero floor").toBe(true);

    const sellGoalId = `live-${runTag}-sell`;
    await signAndStoreSlot(slots, testUser, {
      policy: policies.get("live_sell")!,
      goalId: sellGoalId,
      slotIndex: 1,
      sellToken: BASE_SEPOLIA_TSTOCK,
      buyToken: BASE_SEPOLIA_TUSD,
      sellAmountRaw: stockReceived,
      minAmountOut: sq!.minBuyAmountRaw,
    });

    const sellExec = await adapter.executeSwap({
      goalId: sellGoalId,
      policyId: "live_sell",
      wallet: testUser.address.toLowerCase() as Address,
      chainId: 84532,
      quoteId: sq!.quoteId,
      sellToken: BASE_SEPOLIA_TSTOCK,
      buyToken: BASE_SEPOLIA_TUSD,
      sellAmountRaw: stockReceived.toString(),
      expectedBuyAmountRaw: sq!.expectedBuyAmountRaw,
      minBuyAmountRaw: sq!.minBuyAmountRaw,
      slippageBps: 300,
      idempotencyKey: `${sellGoalId}-exec`,
      steps: [],
      transactionRequest: null,
    } satisfies DelegatedSwapRequest);
    expect(sellExec.ok, `SELL execution failed: ${sellExec.ok ? "" : sellExec.message}`).toBe(true);
    const sellTxHash: Hex = sellExec.ok ? (sellExec.txHash as Hex) : ("0x" as Hex);
    await waitFor(client, sellTxHash);

    const sellVerify = await gateway.verify(sq!.quoteId, sellTxHash, broadcasterAddress);
    expect(sellVerify.ok && sellVerify.data.verified, `SELL verification FAILED: ${JSON.stringify(sellVerify)}`).toBe(true);
    const sellFee = BigInt((sellVerify.ok && sellVerify.data.feeAmountRaw) || "0");
    expect(sellFee, "SELL fee must equal floor(gross * 25 bps) in tSTOCK").toBe((stockReceived * 25n) / 10000n);
    result.sell = { txHash: sellTxHash, soldRaw: stockReceived.toString(), boughtRaw: (sellVerify.ok && sellVerify.data.actualBuyAmountRaw) || "0", feeRaw: sellFee.toString(), quoteId: sq!.quoteId };
    console.log(`::notice::LIVE SELL tx=${sellTxHash} feeRaw=${sellFee} out=${result.sell!.boughtRaw}`);

    // ---------------- machine-readable evidence ----------------
    const { writeFileSync } = await import("node:fs");
    writeFileSync("live-delegated-results.json", JSON.stringify(result, null, 2));
    console.log(`::notice::LIVE_RESULT executor=${DELEGATED_EXECUTOR_ADDRESS} permit2=${CANONICAL_PERMIT2}`);
    console.log(`::notice::LIVE_RESULT buy=${buyTxHash}`);
    console.log(`::notice::LIVE_RESULT sell=${sellTxHash}`);
    console.log(`::notice::LIVE_RESULT buyFeeRaw=${result.buy!.feeRaw} sellFeeRaw=${result.sell!.feeRaw}`);
  });

  // ---------------- helpers ----------------

  async function waitFor(c: typeof client, hash: Hex): Promise<void> {
    for (let i = 0; i < 40; i++) {
      try {
        const r = await c.getTransactionReceipt({ hash });
        if (r) {
          expect(r.status, `tx ${hash} reverted`).toBe("success");
          return;
        }
      } catch {
        /* not mined yet */
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
    throw new Error(`tx ${hash} not mined in time`);
  }

  function encodeTransfer(to: Address, amount: bigint): Hex {
    // transfer(address,uint256) selector + args
    const selector = "a9059cbb";
    const pad = (h: string) => h.replace(/^0x/, "").padStart(64, "0");
    return ("0x" + selector + pad(to.toLowerCase()) + pad(amount.toString(16))) as Hex;
  }

  interface SendTx {
    sendTransaction(args: { to: Address; data?: Hex; value?: bigint }): Promise<Hex>;
  }

  async function ensureAllowance(wallet: SendTx, c: typeof client, token: Address, amount: bigint): Promise<void> {
    const owner = (wallet as unknown as { account: { address: Address } }).account.address;
    const current = await c.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, CANONICAL_PERMIT2] });
    if (current >= amount) return;
    await waitFor(c, await wallet.sendTransaction({ to: token, data: encodeApprove(CANONICAL_PERMIT2, 10n ** 30n) }));
  }

  function encodeApprove(spender: Address, amount: bigint): Hex {
    const selector = "095ea7b3";
    const pad = (h: string) => h.replace(/^0x/, "").padStart(64, "0");
    return ("0x" + selector + pad(spender.toLowerCase()) + pad(amount.toString(16))) as Hex;
  }

  /** Signs ONE bounded slot with the TEST USER's key — standard wallet-style typed data (the redeployed witness string). */
  async function signAndStoreSlot(
    store: InMemoryDelegatedAuthorizationStore,
    user: PrivateKeyAccount,
    opts: { policy: AutonomyPolicy; goalId: string; slotIndex: number; sellToken: Address; buyToken: Address; sellAmountRaw: bigint; minAmountOut: string },
  ): Promise<void> {
    const deadline = Math.floor(Date.now() / 1000) + 1800;
    const permit = {
      token: opts.sellToken,
      amount: opts.sellAmountRaw.toString(),
      nonce: delegatedPermitNonce(opts.goalId, opts.slotIndex),
      deadline,
    };
    const witness = {
      owner: user.address.toLowerCase() as Address,
      buyToken: opts.buyToken,
      minAmountOut: opts.minAmountOut,
      deadline,
      actionId: delegatedActionId(opts.goalId),
      policyHash: delegatedPolicyHash({
        id: opts.policy.id,
        wallet: opts.policy.wallet,
        chainId: 84532,
        sellToken: opts.policy.sellToken,
        buyToken: opts.policy.buyToken,
        maxPerTradeRaw: opts.policy.maxPerTradeRaw,
        maxSlippageBps: opts.policy.maxSlippageBps,
        expiresAt: opts.policy.expiresAt,
      }),
    };
    const typed = delegatedPermitTypedData({ permit, witness }, 84532, DELEGATED_EXECUTOR_ADDRESS);
    // STANDARD WALLET SIGNING — exactly what eth_signTypedData_v4 produces for
    // the redeployed executor's witness type string.
    const signature = await user.signTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    } as Parameters<typeof user.signTypedData>[0]);
    await store.saveSlots([
      {
        id: `slot-${opts.policy.id}-${opts.goalId}-${opts.slotIndex}`,
        wallet: user.address.toLowerCase() as Address,
        chainId: 84532,
        policyId: opts.policy.id,
        goalId: opts.goalId,
        slotIndex: opts.slotIndex,
        permit,
        witness,
        signature,
        createdAt: new Date().toISOString(),
      },
    ]);
  }
});
