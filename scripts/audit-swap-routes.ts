// READ ONLY. No wallet/client account creation, private keys, signing, sends,
// state overrides or permission writes. Optional --taker is a PUBLIC address
// solely for eth_call; omitting it leaves Executor simulations explicitly unrun.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createPublicClient, decodeFunctionData, http, isAddress, type Address } from "viem";
import { base } from "viem/chains";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as d } from "../lib/executor/executor-config";
import { MPGR_EXECUTOR_ABI } from "../lib/executor/mpgr-executor-abi";
import { buildExecutorIntent, approvalAuthorization, encodeExecutorSwap } from "../lib/executor/executor-intent";
import { quoteSlipstream, quoteUniswapV3 } from "../lib/executor/executor-chain";
import { MANUAL_SWAP_TOKENS } from "../lib/trade/manual-swap";
import { NATIVE_ETH_SENTINEL } from "../lib/trade/trade-config";
import { qualifyRegisteredSwapRoute, type SwapRouteReadClient } from "../lib/swap/swap-route-selection";
import { swapPoolAsset } from "../lib/swap/swap-capability";

export interface CandidateEvidence { asset: string; token: string; pool: string; routeEvidence: string; source: string }
export async function auditSwapRoutes(client: SwapRouteReadClient, candidates: CandidateEvidence[] = [], taker?: Address) {
  if (taker !== undefined && (!isAddress(taker) || /^0x0{40}$/i.test(taker))) throw new Error("--taker must be a nonzero public Base address");
  const tokens = [...new Map([...MANUAL_SWAP_TOKENS.filter(t => t.kind !== "native"), ...d.tokens].map(t => [t.address.toLowerCase(), t])).values()];
  const pairs = d.routes.flatMap(r => [[r.tokenA, r.tokenB], [r.tokenB, r.tokenA]]);
  const wethRoute = d.routes.find(r => r.tokenA.toLowerCase() === d.weth.toLowerCase() || r.tokenB.toLowerCase() === d.weth.toLowerCase())!;
  const counter = wethRoute.tokenA.toLowerCase() === d.weth.toLowerCase() ? wethRoute.tokenB : wethRoute.tokenA;
  pairs.push([NATIVE_ETH_SENTINEL, counter], [counter, NATIVE_ETH_SENTINEL]);
  const report = {
    observedAt: new Date().toISOString(), chainId: 8453, executor: d.executor,
    source: "Attempts read-only RPC with numeric block pin and hash checks; null block identity means no checks succeeded. Historical/discovered pools are not permission or execution proof.",
    blockNumber: null as string | null, blockHash: null as string | null, failure: null as string | null,
    signatures: false, broadcasts: false, stateOverrides: false, liveSettlementVerified: false,
    tokens: tokens.map(t => ({ symbol: t.symbol, address: t.address, registered: d.tokens.some(r => r.address.toLowerCase() === t.address.toLowerCase()), permission: "unknown" as "unknown" | "allowed" | "denied",
      candidate: candidates.find(c => c.token.toLowerCase() === t.address.toLowerCase()) ?? null })),
    routes: pairs.flatMap(([from, to]) => {
      const token = tokens.find(t => t.address.toLowerCase() === swapPoolAsset(from))!;
      const amounts = swapPoolAsset(from) === d.weth.toLowerCase() ? [10n ** 15n, 10n ** 16n] : [10n ** BigInt(token.decimals) / 10n, 10n ** BigInt(token.decimals)];
      return amounts.map(gross => ({ from, to, gross: gross.toString(), fee: (gross * 25n / 10000n).toString(), net: (gross - gross * 25n / 10000n).toString(),
        pool: null as string | null, qualification: "unavailable", quote: "unavailable", output: null as string | null,
        executorSimulation: "not_run", simulationOutput: null as string | null, executionEvidenceComplete: false }));
    }),
  };
  try {
    if (await client.getChainId() !== 8453) throw new Error("Wrong network");
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    const block = await client.getBlock({ blockNumber });
    if (!block.hash || block.number !== blockNumber) throw new Error("Block identity unavailable");
    report.blockNumber = String(blockNumber); report.blockHash = block.hash;
    for (const token of report.tokens) {
      try {
        const allowed = await client.readContract({ address: d.executor, abi: MPGR_EXECUTOR_ABI, functionName: "isTokenAllowed", args: [token.address], blockNumber });
        token.permission = allowed === true ? "allowed" : allowed === false ? "denied" : "unknown";
      } catch { token.permission = "unknown"; }
    }
    for (const row of report.routes) {
      try {
        const q = await qualifyRegisteredSwapRoute(client, row.from, row.to, blockNumber);
        row.pool = q.pool; row.qualification = "permissions_and_pool_identity_checked_not_execution";
        const a = swapPoolAsset(row.from) as Address, b = swapPoolAsset(row.to) as Address;
        const out = q.uni ? await quoteUniswapV3(q.reader, q.route.quoter, a, b, BigInt(row.net), q.route.poolFee!) : await quoteSlipstream(q.reader, q.route.quoter, a, b, BigInt(row.net), q.route.tickSpacing!);
        if (out <= 0n) { row.quote = "no_positive_output"; continue; }
        row.quote = "positive_net_input_quote_only"; row.output = String(out);
        if (!taker) { row.executorSimulation = "not_run_no_public_taker_supplied"; continue; }
        const intent = buildExecutorIntent({ deployment: d, taker, sellToken: a, buyToken: b, sellNative: row.from === NATIVE_ETH_SENTINEL, buyNative: row.to === NATIVE_ETH_SENTINEL,
          sellAmount: BigInt(row.gross), expectedBuyAmount: out, slippageBps: 100, authorization: "APPROVAL", nowSeconds: Math.floor(Date.now() / 1000), quoteId: "readonly-route-audit", feeBps: 25, feeRecipient: d.feeRecipient });
        if (!intent.ok) { row.executorSimulation = "not_run_invalid_intent"; continue; }
        const tx = encodeExecutorSwap(intent.value, approvalAuthorization());
        const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: tx.data });
        if (decoded.functionName !== "swapSlipstreamExactInputSingle" && decoded.functionName !== "swapUniswapV3ExactInputSingle") throw new Error("Unexpected audit selector");
        try {
          const sim = await client.simulateContract({ address: d.executor, abi: MPGR_EXECUTOR_ABI, functionName: decoded.functionName, args: decoded.args, account: taker, value: BigInt(tx.value), blockNumber });
          if (typeof sim.result !== "bigint" || sim.result < BigInt(intent.value.minBuyAmount)) throw new Error("Unverified output");
          row.executorSimulation = "eth_call_succeeded_no_receipt_or_fee_transfer_proof"; row.simulationOutput = String(sim.result);
        } catch { row.executorSimulation = "eth_call_failed_no_execution_claim"; }
      } catch { row.qualification = "unavailable_or_mismatch_no_execution_claim"; }
    }
    const end = await client.getBlock({ blockNumber });
    if (end.hash !== block.hash) throw new Error("Block reorganization");
  } catch {
    report.failure = "Base RPC/block identity unavailable or changed. No current permission, liquidity, execution or settlement claim.";
    report.tokens.forEach(t => { t.permission = "unknown"; });
    report.routes.forEach(r => { r.qualification = "unavailable"; r.quote = "unavailable"; r.output = null; r.executorSimulation = "not_run_or_invalidated"; r.simulationOutput = null; });
  }
  return report;
}

async function runCli() {
  const option = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  const candidates = option("--candidates");
  const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org", { retryCount: 0, timeout: 8000 }) });
  const report = await auditSwapRoutes(client, candidates ? JSON.parse(await readFile(candidates, "utf8")) : [], option("--taker") as Address | undefined);
  const text = JSON.stringify(report, null, 2) + "\n";
  const output = option("--out"); if (output) await writeFile(output, text); else process.stdout.write(text);
  if (report.failure || report.routes.some(r => !r.executionEvidenceComplete)) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("/scripts/audit-swap-routes.ts")) {
  void runCli().catch(() => { console.error("Read-only route audit failed; no execution evidence obtained."); process.exitCode = 2; });
}
