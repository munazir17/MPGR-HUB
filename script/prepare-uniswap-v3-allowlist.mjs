#!/usr/bin/env node
// Prepare (NEVER send) the ONE owner transaction that completes the Base
// Mainnet executor route migration: allowlist the official Uniswap V3
// SwapRouter02 on the DEPLOYED MPGR Executor.
//
//   MPGRExecutor.setRouter(router, kind)   kind 2 = UNISWAP_V3_ROUTER02
//
// This script:
//   * reads only committed public config (deployments/base-mainnet/*.json and
//     lib/executor/executor-config.ts constants mirrored below);
//   * re-derives the Uniswap V3 pool address with CREATE2 and checks it against
//     the registered route;
//   * optionally verifies, with READ-ONLY eth_call, that the router is bound to
//     the official Uniswap V3 factory and that the executor's owner matches the
//     committed record (skipped automatically when no RPC is reachable);
//   * prints an UNSIGNED transaction request for the owner's wallet.
//
// It NEVER reads, imports or accepts a private key, never signs, and never
// broadcasts. Running it changes nothing on chain.
//
// Usage:
//   node script/prepare-uniswap-v3-allowlist.mjs            # human report
//   node script/prepare-uniswap-v3-allowlist.mjs --json     # machine report
//   BASE_RPC_URL=https://… node script/prepare-uniswap-v3-allowlist.mjs
//
// After the owner executes the printed transaction, verify with:
//   cast call <executor> 'routerKind(address)(uint8)' <router> --rpc-url <base rpc>
//   -> must return 2

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  createPublicClient,
  http,
} from "viem";
import { base } from "viem/chains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CHAIN_ID = 8453;
const EXECUTOR = getAddress("0xD982726e28275661F8aB64054E6b17a70a63505A");
const OWNER = getAddress("0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e");
const FEE_RECIPIENT = getAddress("0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4");
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const WETH = getAddress("0x4200000000000000000000000000000000000006");

// Official Uniswap V3 deployment on Base (see lib/executor/executor-config.ts).
const UNI_FACTORY = getAddress("0x33128a8fC17869897dcE68Ed026d694621f6FDfD");
const UNI_QUOTER_V2 = getAddress("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a");
const UNI_SWAP_ROUTER02 = getAddress("0x2626664c2603336E57B271c5C0b26F421741e481");
const UNI_POOL_FEE = 3000;
const UNI_WETH_USDC_POOL = getAddress("0x6c561B446416E1A00E8E93E221854d6eA4171372");

// keccak256(UniswapV3Pool creation bytecode) from @uniswap/v3-core@1.0.1.
const POOL_INIT_CODE_HASH = "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";

// RouterKind.UNISWAP_V3_ROUTER02 (contracts/executor/MPGRExecutor.sol).
const ROUTER_KIND_UNISWAP_V3_ROUTER02 = 2;

const SET_ROUTER_ABI = parseAbi(["function setRouter(address router, uint8 kind) external"]);
const ROUTER_KIND_ABI = parseAbi(["function routerKind(address router) view returns (uint8)"]);
const OWNER_ABI = parseAbi(["function owner() view returns (address)"]);
const PERIPHERY_STATE_ABI = parseAbi(["function factory() view returns (address)", "function WETH9() view returns (address)"]);
const POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
]);

function derivePool(factory, tokenA, tokenB, fee) {
  const [token0, token1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
  const salt = keccak256(
    encodeAbiParameters(
      [
        { name: "token0", type: "address" },
        { name: "token1", type: "address" },
        { name: "fee", type: "uint24" },
      ],
      [token0, token1, fee],
    ),
  );
  return getAddress(`0x${keccak256(concat(["0xff", factory, salt, POOL_INIT_CODE_HASH])).slice(26)}`);
}

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(ROOT, relative), "utf8"));
}

async function main() {
  const asJson = process.argv.includes("--json");
  const record = readJson("deployments/base-mainnet/mpgr-executor.json");
  const pins = readJson("deployments/base-mainnet/deploy-config.json");

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: String(detail) });

  // ---------------------------------------------------------------- config
  check("record.chainId == 8453", record.chainId === CHAIN_ID, record.chainId);
  check("record.executor == pinned executor", getAddress(record.executor) === EXECUTOR, record.executor);
  check("record.owner == deploy-config owner", getAddress(record.owner) === OWNER, record.owner);
  check("record.feeBps == 25 (unchanged by this migration)", record.feeBps === 25, record.feeBps);
  check("record.maxFeeBps == 100 (unchanged)", record.maxFeeBps === 100, record.maxFeeBps);
  check("record.feeRecipient == pinned fee recipient", getAddress(record.feeRecipient) === FEE_RECIPIENT, record.feeRecipient);
  check("deploy-config.mainnetDeployEnabled is false (no redeploy)", pins.mainnetDeployEnabled === false, pins.mainnetDeployEnabled);
  check(
    "record.allowedTokens.USDC/WETH match the registry tokens",
    getAddress(record.allowedTokens.USDC) === USDC && getAddress(record.allowedTokens.WETH) === WETH,
    `${record.allowedTokens.USDC} / ${record.allowedTokens.WETH}`,
  );

  // ---------------------------------------------------------------- pool
  const derived = derivePool(UNI_FACTORY, WETH, USDC, UNI_POOL_FEE);
  check("CREATE2 pool (factory, WETH, USDC, 3000) == registered pool", derived === UNI_WETH_USDC_POOL, derived);
  const derivedKnown0500 = derivePool(UNI_FACTORY, WETH, USDC, 500);
  check(
    "CREATE2 derivation cross-check: WETH/USDC 0.05% pool == 0xd0b53D92…9224",
    derivedKnown0500 === getAddress("0xd0b53D9277642d899DF5C87A3966A349A798F224"),
    derivedKnown0500,
  );

  // ---------------------------------------------------------------- tx
  const data = encodeFunctionData({
    abi: SET_ROUTER_ABI,
    functionName: "setRouter",
    args: [UNI_SWAP_ROUTER02, ROUTER_KIND_UNISWAP_V3_ROUTER02],
  });
  const unsignedTransaction = {
    chainId: CHAIN_ID,
    to: EXECUTOR,
    data,
    value: "0",
    from: OWNER, // the owner is the only account that may send it (Ownable2Step)
  };

  // ---------------------------------------------------------------- optional read-only verification
  const rpc = (process.env.BASE_RPC_URL ?? "").trim();
  let liveChecks = null;
  if (!rpc) {
    liveChecks = { skipped: true, reason: "BASE_RPC_URL not set (read-only verification skipped)" };
  } else {
    try {
      const client = createPublicClient({ chain: base, transport: http(rpc, { timeout: 15_000 }) });
      const [liveOwner, liveFactory, liveWeth, liveRouterKind, poolToken0, poolToken1, poolFee] = await Promise.all([
        client.readContract({ address: EXECUTOR, abi: OWNER_ABI, functionName: "owner" }),
        client.readContract({ address: UNI_SWAP_ROUTER02, abi: PERIPHERY_STATE_ABI, functionName: "factory" }),
        client.readContract({ address: UNI_SWAP_ROUTER02, abi: PERIPHERY_STATE_ABI, functionName: "WETH9" }),
        client.readContract({ address: EXECUTOR, abi: ROUTER_KIND_ABI, functionName: "routerKind", args: [UNI_SWAP_ROUTER02] }),
        client.readContract({ address: UNI_WETH_USDC_POOL, abi: POOL_ABI, functionName: "token0" }),
        client.readContract({ address: UNI_WETH_USDC_POOL, abi: POOL_ABI, functionName: "token1" }),
        client.readContract({ address: UNI_WETH_USDC_POOL, abi: POOL_ABI, functionName: "fee" }),
      ]);
      check("live: executor.owner == committed owner", getAddress(liveOwner) === OWNER, liveOwner);
      check("live: SwapRouter02.factory == official Uniswap V3 factory", getAddress(liveFactory) === UNI_FACTORY, liveFactory);
      check("live: SwapRouter02.WETH9 == canonical WETH", getAddress(liveWeth) === WETH, liveWeth);
      check(
        "live: pool token0/token1/fee == (WETH, USDC, 3000)",
        getAddress(poolToken0) === WETH && getAddress(poolToken1) === USDC && Number(poolFee) === UNI_POOL_FEE,
        `${poolToken0}/${poolToken1}/${poolFee}`,
      );
      check(
        `live: executor.routerKind(${UNI_SWAP_ROUTER02}) — 0 = not yet allowlisted (expected BEFORE the owner tx), 2 = already allowlisted`,
        Number(liveRouterKind) === 0 || Number(liveRouterKind) === ROUTER_KIND_UNISWAP_V3_ROUTER02,
        liveRouterKind,
      );
      liveChecks = {
        skipped: false,
        routerKindBefore: Number(liveRouterKind),
        alreadyAllowlisted: Number(liveRouterKind) === ROUTER_KIND_UNISWAP_V3_ROUTER02,
      };
    } catch (error) {
      liveChecks = { skipped: true, reason: `read-only verification failed: ${error?.shortMessage ?? error?.message ?? error}` };
    }
  }

  const report = {
    action: "prepare-only: nothing was signed or broadcast",
    migration: {
      from: { venue: "aerodrome-slipstream", router: record.router?.router ?? null, tickSpacing: 50 }, // the previous executor route: WETH/USDC ts=50
      to: { venue: "uniswap-v3", router: UNI_SWAP_ROUTER02, quoter: UNI_QUOTER_V2, factory: UNI_FACTORY, poolFee: UNI_POOL_FEE, pool: UNI_WETH_USDC_POOL },
      executor: EXECUTOR,
      feeBps: record.feeBps,
      redeploy: false,
    },
    unsignedTransaction,
    executeWith: `cast send ${EXECUTOR} 'setRouter(address,uint8)' ${UNI_SWAP_ROUTER02} ${ROUTER_KIND_UNISWAP_V3_ROUTER02} --rpc-url $BASE_RPC_URL --private-key <OWNER KEY>`,
    verifyAfter: `cast call ${EXECUTOR} 'routerKind(address)(uint8)' ${UNI_SWAP_ROUTER02} --rpc-url $BASE_RPC_URL  # expect 2`,
    checks,
    liveChecks,
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const lines = [
      "MPGR Executor — Base Mainnet route migration: Uniswap V3 router allowlist (PREPARE ONLY)",
      "",
      "Nothing was signed and nothing was broadcast. This script only prints an unsigned",
      "transaction request for the executor OWNER to review and send from their own wallet.",
      "",
      `Executor        : ${EXECUTOR}`,
      `Owner (sender)  : ${OWNER}`,
      `Fee policy      : ${record.feeBps} bps (unchanged — this migration touches the router only)`,
      `New venue       : Uniswap V3 SwapRouter02 ${UNI_SWAP_ROUTER02} (kind ${ROUTER_KIND_UNISWAP_V3_ROUTER02})`,
      `Quoter / factory: ${UNI_QUOTER_V2} / ${UNI_FACTORY}`,
      `Pool            : WETH/USDC fee ${UNI_POOL_FEE} -> ${UNI_WETH_USDC_POOL} (CREATE2-verified)`,
      "",
      "Unsigned transaction request",
      `  chainId : ${unsignedTransaction.chainId}`,
      `  to      : ${unsignedTransaction.to}`,
      `  data    : ${unsignedTransaction.data}`,
      `  value   : ${unsignedTransaction.value}`,
      "",
      "Checks",
      ...checks.map((c) => `  [${c.ok ? "PASS" : "FAIL"}] ${c.name} — ${c.detail}`),
      "",
      liveChecks?.skipped
        ? `Live (read-only) verification: SKIPPED — ${liveChecks.reason}`
        : [
            "Live (read-only) verification",
            `  routerKind(SwapRouter02) on the live executor = ${liveChecks.routerKindBefore}` +
              ` (${liveChecks.alreadyAllowlisted ? "already allowlisted — nothing to do" : "not allowlisted yet — the tx above is required"})`,
          ].join("\n"),
      "",
      "Operator runbook (owner wallet, on their own machine)",
      `  1. send : ${report.executeWith}`,
      `  2. check: ${report.verifyAfter}`,
      "  3. then : re-run this script — it must report routerKind 2.",
      "",
      "Optional follow-up (separate owner decision, NOT prepared here): revoke the old",
      "Aerodrome Slipstream router with setRouter(<old router>, 0) once the new route is proven.",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  }

  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
