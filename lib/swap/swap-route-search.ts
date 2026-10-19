import "server-only";
// Read-only, bounded Swap-only pool comparison. Never signs, sends or grants permissions.
import { BaseError, ContractFunctionRevertedError, decodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { readAllowance, readTokenBalance } from "@/lib/executor/executor-chain";
import { MPGR_EXECUTOR_ABI } from "@/lib/executor/mpgr-executor-abi";
import { isNativeEthSentinel } from "@/lib/trade/trade-config";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as deployment } from "@/lib/executor/executor-config";
import { buildExecutorSwapProposal, type ExecutorQuoteInput } from "@/lib/trade/trade-executor-quote";
import { withTradeQuoteCache } from "@/lib/trade/trade-quote-cache";
import { swapQuoteFresh } from "./swap-lifecycle";
import { SWAP_PATH_EXECUTOR_NOT_DEPLOYED_MESSAGE, swapPathExecutor } from "./swap-executor-config";
import { swapPathCandidatesFor, swapPathPairEligible } from "./swap-path-quote";
import { searchSwapPaths } from "./swap-path-search";
import { swapQuotePolicyError } from "./swap-policy";
import { swapRouteCandidates, swapRouteKey, type SwapRoutedProposal, type SwapRouteOutcome, type SwapRoutingEvidence } from "./swap-route-candidates";
import { qualifySwapRouteCandidate, verifyQualifiedSwapBlock, SwapRouteQualificationError, type SwapRouteReadClient } from "./swap-route-selection";

// Configuration/identity drift is global: no alternative venue can make it safe.
const GLOBAL_BLOCKS = new Set(["FEE_RECIPIENT_CHANGED", "FEE_POLICY_INVALID", "EXECUTOR_POSTURE_CHANGED", "TOKEN_METADATA_UNAVAILABLE", "STALE_BLOCK", "BLOCK_CHANGED", "UNSUPPORTED_NETWORK"]);
const keyOf = (args: unknown) => JSON.stringify(args, (key, v) => key === "abi" ? undefined : typeof v === "bigint" ? v.toString() : v);

/** Share identical immutable-at-this-block reads within THIS request only.
 * Never memoize block identity (reorg checks) or carry permission results across requests. */
function requestReader(client: SwapRouteReadClient): SwapRouteReadClient {
  const reads = new Map<string, Promise<unknown>>();
  const memo = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (!reads.has(key)) reads.set(key, fn());
    return reads.get(key) as Promise<T>;
  };
  return { ...client,
    readContract: args => memo(`read:${keyOf(args)}`, () => client.readContract(args)),
    getCode: args => memo(`code:${keyOf(args)}`, () => client.getCode(args)),
    getBalance: args => memo(`balance:${keyOf(args)}`, () => client.getBalance(args)),
  } as SwapRouteReadClient;
}
/** Actual state only. An unfunded/unapproved wallet can still inspect a quote, but
 * is never labeled simulated. No allowance overrides, fake funding or signatures. */
async function checkReadyExecutor(client: SwapRouteReadClient, qualified: Awaited<ReturnType<typeof qualifySwapRouteCandidate>>, p: SwapRoutedProposal): Promise<SwapRoutingEvidence["executionSimulation"]> {
  const notRun = "not-run-wallet-preflight-required" as const;
  const native = isNativeEthSentinel(p.from.address);
  try {
    const gross = BigInt(p.fromAmount);
    const balance = native ? await qualified.reader.getBalance({ address: p.taker }) : await readTokenBalance(qualified.reader, p.from.address, p.taker);
    if (typeof balance !== "bigint" || balance < gross) return notRun;
    if (!native) {
      const allowance = await readAllowance(qualified.reader, p.from.address, p.taker, deployment.executor);
      if (typeof allowance !== "bigint" || allowance < gross) return notRun;
    }
  } catch { return notRun; }
  const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: p.transaction!.data });
  if (decoded.functionName !== "swapSlipstreamExactInputSingle" && decoded.functionName !== "swapUniswapV3ExactInputSingle") throw new SwapRouteQualificationError("EXECUTOR_SIMULATION_INVALID", "Unsupported assisted execution selector.");
  try {
    const result = await client.simulateContract({ address: deployment.executor, abi: MPGR_EXECUTOR_ABI, functionName: decoded.functionName, args: decoded.args, account: p.taker as Address, value: BigInt(p.transaction!.value), blockNumber: qualified.blockNumber });
    if (typeof result.result !== "bigint" || result.result !== BigInt(p.toAmount) || result.result < BigInt(p.minToAmount)) throw new SwapRouteQualificationError("EXECUTOR_QUOTE_MISMATCH", "Executor simulation did not match this pool quote. No swap was prepared.");
    return "eth-call-succeeded-no-settlement-proof";
  } catch (error) {
    if (error instanceof SwapRouteQualificationError) throw error;
    const reverted = error instanceof BaseError && error.walk(e => e instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError;
    throw new SwapRouteQualificationError(reverted ? "EXECUTOR_SIMULATION_REVERTED" : "EXECUTOR_SIMULATION_UNAVAILABLE", reverted ? "The actual taker's Executor call reverted for this candidate." : "The actual taker's Executor call could not be verified.", reverted ? 422 : 503);
  }
}
export async function searchSwapRoutes(client: SwapRouteReadClient, input: ExecutorQuoteInput, fresh = false) {
  const candidates = swapRouteCandidates(input.from.address, input.to.address);
  if (typeof input.fromAmount !== "string" || !/^[1-9]\d*$/.test(input.fromAmount) || input.fromAmount.length > 78 || BigInt(input.fromAmount) >= 2n ** 256n) throw new SwapRouteQualificationError("INVALID_INPUT", "The gross sell amount must be a positive uint256 atomic integer.");
  if (BigInt(input.fromAmount) * 25n / 10000n === 0n) throw new SwapRouteQualificationError("INVALID_INPUT", "The sell amount is too small to collect the mandatory fee in atomic units.");
  // Fail network verification before metadata/pool simulation. Provider details never reach callers.
  let blockNumber: bigint;
  let hash: Hex;
  try {
    if (await client.getChainId() !== 8453) throw new SwapRouteQualificationError("UNSUPPORTED_NETWORK", "Base Mainnet could not be verified.", 503);
    blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    const block = await client.getBlock({ blockNumber });
    if (block.number !== blockNumber || !block.hash || !/^0x[0-9a-f]{64}$/i.test(block.hash)) throw new SwapRouteQualificationError("STALE_BLOCK", "A fresh Base block identity could not be verified.");
    hash = block.hash;
    await verifyQualifiedSwapBlock(client, { blockNumber, blockHash: hash });
  } catch (error) {
    if (error instanceof SwapRouteQualificationError) throw error;
    throw new SwapRouteQualificationError("ROUTE_VERIFICATION_UNAVAILABLE", "Base route verification is unavailable. No swap was prepared.", 503);
  }
  const pathDeployment = swapPathExecutor();
  const pathEligible = pathDeployment !== null && swapPathPairEligible(input.from.address, input.to.address, pathDeployment);
  if (!candidates.length) {
    if (pathEligible && pathDeployment) {
      const pathResult = await searchSwapPaths(client, { ...input, taker: input.taker as Address }, pathDeployment, { number: blockNumber, hash });
      if (pathResult) return { proposal: pathResult.proposal as SwapRoutedProposal, qualified: { blockNumber: pathResult.blockNumber, blockHash: pathResult.blockHash } as unknown as Awaited<ReturnType<typeof qualifySwapRouteCandidate>> };
    }
    throw new SwapRouteQualificationError(pathEligible ? "LIQUIDITY_UNAVAILABLE" : "FEE_ROUTE_UNREGISTERED", pathEligible ? "No factory-verified pool quoted this pair for this amount. No swap was prepared." : "Exact token registration and Executor allowlist verification are required. Imported metadata cannot authorize execution.");
  }
  const reader = requestReader(client);
  const outcomes: SwapRouteOutcome[] = [];
  let winner: { proposal: SwapRoutedProposal; qualified: Awaited<ReturnType<typeof qualifySwapRouteCandidate>>; gas: string | null } | undefined;
  let firstFailure: SwapRouteQualificationError | undefined;
  const startedAt = Date.now();
  // Five candidates maximum, sequential: bounded provider pressure, stable tie order.
  for (const route of candidates) {
    const key = swapRouteKey(route);
    if (Date.now() - startedAt > 12_000) {
      outcomes.push({ key, state: "unavailable", reason: "SEARCH_BUDGET_EXCEEDED", output: null });
      continue;
    }
    try {
      const qualified = await qualifySwapRouteCandidate(reader, input.from.address, input.to.address, route, blockNumber);
      if (hash !== qualified.blockHash) throw new SwapRouteQualificationError("BLOCK_CHANGED", "Base reorganized during route comparison. Request a fresh quote.");
      const cached = await withTradeQuoteCache(["strict-swap-search-v1", key, blockNumber.toString(), qualified.blockHash, input.taker.toLowerCase(), input.from.address.toLowerCase(), input.to.address.toLowerCase(), input.fromAmount, input.from.decimals, input.to.decimals, input.slippageBps].join(":"), 6000, async () => {
        let gas: string | null = null;
        const pinnedReader = { ...qualified.reader, simulateContract: async (args: Parameters<typeof qualified.reader.simulateContract>[0]) => {
          const result = await qualified.reader.simulateContract(args);
          if (args.functionName === "quoteExactInputSingle" && Array.isArray(result.result) && typeof result.result[3] === "bigint" && result.result[3] > 0n) gas = String(result.result[3]);
          return result;
        } };
        const result = await buildExecutorSwapProposal({ ...input, deployment: { ...deployment, routes: [route] }, reader: pinnedReader, quotedAt: new Date() });
        return { result, gas };
      }, { fresh });
      const result = cached.result;
      if (!result.ok) {
        const provider = result.supported && result.error.code === "PROVIDER_ERROR";
        const reason = result.supported ? result.error.code : "EXECUTION_UNAVAILABLE";
        outcomes.push({ key, state: provider ? "unavailable" : "rejected", reason, output: null });
        firstFailure ??= new SwapRouteQualificationError(reason, provider ? "A compatible pool quote could not be verified. Retry; no swap was prepared." : "No positive, fee-compatible direct quote could be prepared for this amount.", provider ? 503 : 422);
        continue;
      }
      if (!swapQuoteFresh(result.proposal)) throw new SwapRouteQualificationError("STALE_BLOCK", "A candidate quote expired during route comparison. Refresh before signing.");
      const outcome: SwapRouteOutcome = { key, state: "quoted", reason: "QUOTE_ONLY_NOT_EXECUTION_PROOF", output: result.proposal.toAmount };
      const proposal: SwapRoutedProposal = { ...result.proposal, swapRouting: {
        version: 1, hops: 1, route, pool: qualified.pool, blockNumber: String(blockNumber), blockHash: qualified.blockHash,
        calldataHash: keccak256(result.proposal.transaction!.data), selection: "highest-quoted-output", comparisonComplete: false,
        outcomes: candidates.map(r => swapRouteKey(r) === key ? outcome : { key: swapRouteKey(r), state: "unavailable", reason: "NOT_EVALUATED", output: null }), quoterGasUnits: cached.gas, executionSimulation: "not-run-wallet-preflight-required",
      } };
      const invalid = swapQuotePolicyError(proposal);
      if (invalid) throw new SwapRouteQualificationError("QUOTE_POLICY_INVALID", "This candidate failed exact fee/calldata policy validation; no signature was requested.");
      proposal.swapRouting!.executionSimulation = await checkReadyExecutor(reader, qualified, proposal);
      outcomes.push(outcome);
      if (!winner || BigInt(proposal.toAmount) > BigInt(winner.proposal.toAmount)) winner = { proposal, qualified, gas: cached.gas };
    } catch (error) {
      const failure = error instanceof SwapRouteQualificationError ? error : new SwapRouteQualificationError("ROUTE_VERIFICATION_UNAVAILABLE", "Current pool evidence could not be verified. Retry; no swap was prepared.", 503);
      if (GLOBAL_BLOCKS.has(failure.reason)) throw failure;
      firstFailure ??= failure;
      outcomes.push({ key, state: failure.status === 503 ? "unavailable" : "rejected", reason: failure.reason, output: null });
    }
  }
  if (!winner) {
    if (pathEligible && pathDeployment) {
      try {
        const pathResult = await searchSwapPaths(client, { ...input, taker: input.taker as Address }, pathDeployment, { number: blockNumber, hash });
        if (pathResult) return { proposal: pathResult.proposal as SwapRoutedProposal, qualified: { blockNumber: pathResult.blockNumber, blockHash: pathResult.blockHash } as unknown as Awaited<ReturnType<typeof qualifySwapRouteCandidate>> };
      } catch (error) {
        // Opportunistic fallback: its failure must not mask the direct-route
        // diagnosis below — except live fee-posture drift on the Swap
        // executor, which is a global block and always surfaces. No quote is
        // ever returned from a failed fallback (fail-closed).
        if (error instanceof SwapRouteQualificationError && error.reason === "FEE_RECIPIENT_CHANGED") throw error;
      }
    }
    // Do not relabel provider failure as illiquidity. Show an actionable contract limit too.
    const unavailable = outcomes.some(o => o.state === "unavailable");
    const pathNote = swapPathCandidatesFor(input.from.address, input.to.address).length && !pathDeployment ? ` ${SWAP_PATH_EXECUTOR_NOT_DEPLOYED_MESSAGE}` : "";
    throw new SwapRouteQualificationError(unavailable ? "ROUTE_VERIFICATION_UNAVAILABLE" : firstFailure?.reason ?? "NO_QUALIFIED_DIRECT_ROUTE", `${unavailable ? "Some direct-pool evidence is unavailable; retry the quote." : firstFailure?.message ?? "No qualified direct pool was found for this amount."} No route through the reviewed MPGR executors could be prepared for this pair and amount.${pathNote}`, unavailable ? 503 : 422);
  }
  await verifyQualifiedSwapBlock(client, winner.qualified);
  const p = winner.proposal;
  if (!p.transaction || !swapQuoteFresh(p)) throw new SwapRouteQualificationError("QUOTE_EXPIRED", "The selected quote expired during route comparison. Request a fresh quote.");
  p.swapRouting = { version: 1, hops: 1, route: winner.qualified.route, pool: winner.qualified.pool,
    blockNumber: String(blockNumber), blockHash: winner.qualified.blockHash, calldataHash: keccak256(p.transaction.data),
    selection: "highest-quoted-output", comparisonComplete: !outcomes.some(o => o.state === "unavailable"), outcomes,
    quoterGasUnits: winner.gas, executionSimulation: p.swapRouting!.executionSimulation };
  const policy = swapQuotePolicyError(p);
  if (policy) throw new SwapRouteQualificationError("QUOTE_POLICY_INVALID", policy);
  return { proposal: p, qualified: winner.qualified };
}
