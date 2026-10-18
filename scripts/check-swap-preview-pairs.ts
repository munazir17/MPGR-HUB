// READ ONLY, targeted continuation checks, NOT a repeat of the full audit.
// No keys, wallet client, signatures, overrides, grants, deployments or sends.
import { writeFile } from "node:fs/promises";
import { getTradePublicClient } from "../lib/trade/trade-public-client";
import { parseTradeSwapRequest } from "../lib/trade/trade-request";
import { searchSwapRoutes } from "../lib/swap/swap-route-search";
import { swapRouteIssue } from "../lib/swap/swap-capability";
import { searchSwapTokenHints } from "../lib/swap/swap-token-discovery";
import { MANUAL_SWAP_TOKENS } from "../lib/trade/manual-swap";
import { SwapRouteQualificationError } from "../lib/swap/swap-route-selection";
const known = (symbol: string) => MANUAL_SWAP_TOKENS.find(t => t.symbol === symbol)?.address;
async function main() {
  const output = process.argv[2]; if (!output) throw new Error("Provide an evidence JSON output path");
  const discovery: Record<string, unknown> = {};
  const imported: Record<string, string> = {};
  for (const query of ["AERO", "VIRTUAL", "ZEC", "BNB"]) {
    try {
      const hints = await searchSwapTokenHints(query); discovery[query] = { status: "list-hints-only", hints };
      const exact = hints.find(t => t.symbol.toUpperCase() === query || t.symbol.toUpperCase() === `CB${query}`);
      if (exact) imported[query] = exact.address;
    } catch { discovery[query] = { status: "list-unavailable", hints: null }; }
  }
  const pairs = [
    { from: "ETH", to: "AAPLc", amount: "0.0001", slippageBps: 100 },
    { from: "AAPLc", to: "ETH", amount: "0.001", slippageBps: 100 },
    { from: "USDC", to: "AAPLc", amount: "1", slippageBps: 100 },
    { from: "AAPLc", to: "USDC", amount: "0.001", slippageBps: 100 },
    ...["MPGR", "AERO", "VIRTUAL", "ZEC"].map(from => ({ from, to: "USDC", amount: "1", slippageBps: 100 })),
  ];
  const rows: object[] = []; const client = getTradePublicClient();
  let chain: "unattempted" | "verified" | "unavailable" = "unattempted";
  for (const pair of pairs) {
    const fromToken = imported[pair.from] ?? known(pair.from), toToken = known(pair.to);
    const request = { ...pair, fromToken, toToken };
    if (!fromToken || !toToken) { rows.push({ request, state: "identity-unavailable", permissions: "unknown", liquidity: "unknown" }); continue; }
    const gate = swapRouteIssue(fromToken, toToken);
    if (gate) { rows.push({ request, state: "application-blocked", reason: gate.code, message: gate.message, permissions: "not-read-unknown", liquidity: "not-read-unknown" }); continue; }
    if (chain === "unattempted") { try { chain = await client.getChainId() === 8453 ? "verified" : "unavailable"; } catch { chain = "unavailable"; } }
    if (chain !== "verified") { rows.push({ request, state: "rpc-unavailable", permissions: "unknown", liquidity: "unknown", quote: null, executorSimulation: "not-run" }); continue; }
    const parsed = await parseTradeSwapRequest({ ...request, taker: "0x0000000000000000000000000000000000000001" });
    if (!parsed.ok) { rows.push({ request, state: "metadata-blocked", code: parsed.error.code }); continue; }
    try {
      const result = await searchSwapRoutes(client, parsed.value, true);
      rows.push({ request, state: "quote-only", gross: result.proposal.fromAmount, output: result.proposal.toAmount, minimum: result.proposal.minToAmount,
        blockNumber: String(result.qualified.blockNumber), blockHash: result.qualified.blockHash, settlementVerified: false,
        note: "Public probe address, not the user's wallet; no signatures/overrides/settlement." });
    } catch (e) { rows.push({ request, state: e instanceof SwapRouteQualificationError && e.status !== 503 ? "route-blocked" : "rpc-unavailable", reason: e instanceof SwapRouteQualificationError ? e.reason : "PROVIDER_ERROR" }); }
  }
  const report = { observedAt: new Date().toISOString(), chainId: 8453, scope: "Targeted source-aligned CLI checks, not authenticated Preview HTTP or a user-wallet test",
    signatures: false, broadcasts: false, stateOverrides: false, liveSettlementVerified: false,
    discovery, chainProbe: chain, rows,
    bnb: "No match in this published Base list. Native BNB is not a Base asset. Need an exact verified Base representation contract; no address was guessed." };
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output, chainProbe: chain, cases: rows.length, liveSettlementVerified: false }));
  if (chain !== "verified") process.exitCode = 2;
}
void main().catch(() => { console.error("Targeted read-only checks could not complete; no live execution claim."); process.exitCode = 2; });
