// scripts/phase5-reconcile.mjs
//
// PHASE 5 — post-test RECONCILIATION for the guarded Base Sepolia readiness
// run. READ-ONLY: verifies the armed run's evidence against the chain.
//   * receipts for both legs (status, block, gas)
//   * broadcaster gas spent + remaining ETH
//   * test-user balances (ETH / tUSD / tSTOCK)
//   * fee-recipient identity + tUSD balance (read from the frozen executor)
//   * Permit2 single-use nonce bitmap: both legs' nonces MUST be consumed
//   * run-evidence invariants: exact 25 bps fees, runtime goal COMPLETED,
//     EXECUTION_VERIFIED present in the audit trail
// All contract addresses come from the run's own evidence JSON (which the
// harness derived from source constants) — nothing is hand-typed here.
// Emits `::error::RECONCILE_*` annotations (the API-readable channel) and
// writes phase5-reconciliation.json. Exits non-zero on ANY failed check.
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, erc20Abi, formatEther, getAddress } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const resultsPath = process.argv[2] ?? "live-delegated-results.json";
const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org";
const broadcasterKey = process.env.MPGR_BROADCASTER_PRIVATE_KEY?.trim();
const results = JSON.parse(readFileSync(resultsPath, "utf8"));

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, detail: String(detail) });
  console.error(`::error::RECONCILE_${ok ? "OK" : "FAIL"} ${name} ${detail}`);
};

const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });

const broadcasterAddress = getAddress(results.broadcaster);
const testUser = getAddress(results.testUser);
const TUSD = getAddress(results.tokens.tusd);
const TSTOCK = getAddress(results.tokens.tstock);
const EXECUTOR = getAddress(results.tokens.executor);
const PERMIT2 = getAddress(results.tokens.permit2);

async function main() {
  check("run.evidence-present", !!results.buy?.txHash && !!results.sell?.txHash, `buy=${results.buy?.txHash} sell=${results.sell?.txHash}`);

  if (broadcasterKey) {
    const derived = privateKeyToAccount(broadcasterKey).address.toLowerCase();
    check("broadcaster.identity-matches-run", derived === broadcasterAddress.toLowerCase(), `derived=${derived} run=${broadcasterAddress}`);
  } else {
    check("broadcaster.identity-key-not-provided", true, "skipped (read-only reconcile)");
  }

  const [bEth, uEth, uUsd, uStock, feeRecipient, feeBps] = await Promise.all([
    client.getBalance({ address: broadcasterAddress }),
    client.getBalance({ address: testUser }),
    client.readContract({ address: TUSD, abi: erc20Abi, functionName: "balanceOf", args: [testUser] }),
    client.readContract({ address: TSTOCK, abi: erc20Abi, functionName: "balanceOf", args: [testUser] }),
    client.readContract({ address: EXECUTOR, abi: [{ type: "function", name: "feeRecipient", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }], functionName: "feeRecipient" }),
    client.readContract({ address: EXECUTOR, abi: [{ type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] }], functionName: "feeBps" }),
  ]);
  const feeRecipientUsd = await client.readContract({ address: TUSD, abi: erc20Abi, functionName: "balanceOf", args: [getAddress(feeRecipient)] });
  check("executor.feeBps-still-25", Number(feeBps) === 25, `feeBps=${feeBps}`);
  check("executor.feeRecipient-readable", typeof feeRecipient === "string" && feeRecipient.startsWith("0x"), `feeRecipient=${feeRecipient} tUSD=${feeRecipientUsd}`);

  let gasSpent = 0n;
  for (const [leg, txHash] of [["buy", results.buy.txHash], ["sell", results.sell.txHash]]) {
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    check(`${leg}.receipt-success`, receipt.status === "success", `status=${receipt.status} block=${receipt.blockNumber} logs=${receipt.logs.length}`);
    const gas = receipt.gasUsed * receipt.effectiveGasPrice;
    gasSpent += gas;
    check(`${leg}.gas-accounted`, gas > 0n, `gasUsed=${receipt.gasUsed} gasCostWei=${gas}`);
  }

  // Permit2 single-use nonces MUST be consumed (bit flipped in the bitmap).
  for (const [leg, nonceStr] of [["buy", results.buy.nonce], ["sell", results.sell.nonce]]) {
    const nonce = BigInt(nonceStr);
    const wordPos = nonce >> 8n;
    const bitPos = nonce & 255n;
    const bitmap = await client.readContract({ address: PERMIT2, abi: [{ type: "function", name: "nonceBitmap", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "wordPos", type: "uint256" }], outputs: [{ type: "uint256" }] }], functionName: "nonceBitmap", args: [testUser, wordPos] });
    const consumed = ((bitmap >> bitPos) & 1n) === 1n;
    check(`${leg}.permit2-nonce-consumed`, consumed, `nonce=${nonceStr} wordPos=${wordPos} bitPos=${bitPos} consumed=${consumed}`);
  }

  // Exact-fee invariants from the run's own evidence.
  check("buy.fee-25bps-exact", BigInt(results.buy.feeRaw) === (BigInt(results.buy.soldRaw) * 25n) / 10000n, `feeRaw=${results.buy.feeRaw} soldRaw=${results.buy.soldRaw}`);
  check("sell.fee-25bps-exact", BigInt(results.sell.feeRaw) === (BigInt(results.sell.soldRaw) * 25n) / 10000n, `feeRaw=${results.sell.feeRaw} soldRaw=${results.sell.soldRaw}`);

  // Runtime chain evidence: goal COMPLETED + full audit trail.
  check("runtime.goal-completed", results.runtime?.goalStatus === "COMPLETED", `status=${results.runtime?.goalStatus}`);
  const audit = results.runtime?.auditEvents ?? [];
  check(
    "runtime.audit-complete",
    ["QUOTE_CREATED", "CONDITION_MET", "POLICY_APPROVED", "TRANSACTION_SUBMITTED", "EXECUTION_VERIFIED"].every((e) => audit.includes(e)),
    `events=${audit.join(">")}`,
  );

  const reconciliation = {
    ranAt: new Date().toISOString(),
    broadcaster: broadcasterAddress,
    broadcasterEthWei: bEth.toString(),
    broadcasterGasSpentWei: gasSpent.toString(),
    broadcasterGasSpentEth: formatEther(gasSpent),
    testUser,
    testUserEthWei: uEth.toString(),
    testUserTusdRaw: uUsd.toString(),
    testUserTstockRaw: uStock.toString(),
    feeRecipient: getAddress(feeRecipient),
    feeRecipientTusdRaw: feeRecipientUsd.toString(),
    buy: results.buy,
    sell: results.sell,
    runtime: results.runtime ?? null,
    checks,
    allPassed: checks.every((c) => c.ok),
  };
  writeFileSync("phase5-reconciliation.json", JSON.stringify(reconciliation, null, 2));
  console.error(
    `::error::RECONCILE_SUMMARY allPassed=${reconciliation.allPassed} broadcasterGasEth=${reconciliation.broadcasterGasSpentEth} userTusdRaw=${uUsd} userTstockRaw=${uStock} feeRecipientTusdRaw=${feeRecipientUsd}`,
  );
  if (!reconciliation.allPassed) process.exit(1);
}

main().catch((error) => {
  console.error(`::error::RECONCILE_ABORTED ${error?.message ?? error}`);
  process.exit(1);
});
