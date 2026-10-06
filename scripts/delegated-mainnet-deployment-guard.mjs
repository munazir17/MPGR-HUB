#!/usr/bin/env node

// Read-only deployment gates for the protected MPGRExecutorDelegated Base Mainnet workflow.
// This helper never creates a wallet client and never sends a transaction. Its prebroadcast
// phase derives only the public deployer address from the environment secret, then verifies
// the exact CREATE target immediately before the single Forge broadcast step.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPublicClient,
  defineChain,
  getAddress,
  getCreateAddress,
  http,
  isAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const BASE_CHAIN_ID = 8453;
export const EXPECTED_DEPLOYER = "0x954BFdf0b3A262D537c825a40F7ba960830be88A";
export const EXPECTED_EXECUTOR = "0x39B1C6Ea88A01e70cbF4899BF3cEfB2c43cD32Bb";
export const EXPECTED_OWNER = "0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e";
export const EXPECTED_FEE_RECIPIENT = "0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4";
export const CANONICAL_WETH = "0x4200000000000000000000000000000000000006";
export const CANONICAL_PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const EXPECTED_OUTPUT = "deployments/base-mainnet/mpgr-executor-delegated.json";
export const MIN_DEPLOYER_BALANCE = 2_000_000_000_000_000n;

export const EXPECTED_TOKENS = [
  ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USDC", 6],
  ["0x4200000000000000000000000000000000000006", "WETH", 18],
  ["0xb200000000000000000000C2e324d24d7eEcd1fb", "AAPLc", 8],
  ["0xb200000000000000000000d9192b6B456483C2E8", "AMZNc", 8],
  ["0xb200000000000000000000c85a31389D71F3ecfb", "COINc", 8],
  ["0xB20000000000000000000019f6E7C675b73C2e4D", "CRCLc", 8],
  ["0xb2000000000000000000002D0BA3164cc74f58B7", "GOOGLc", 8],
  ["0xB2000000000000000000004AFF16039bA04bdFBc", "INTCc", 8],
  ["0xb2000000000000000000008bC8786B856E61707C", "METAc", 8],
  ["0xB200000000000000000000Ab99cFa739E253872B", "MSFTc", 8],
  ["0xb2000000000000000000004884b426556b92883d", "MSTRc", 8],
  ["0xb20000000000000000000078ee7ce2fE4908108C", "NVDAc", 8],
  ["0xb200000000000000000000397293Cb8cda9a10c5", "SNDKc", 8],
  ["0xb2000000000000000000007b9fcbd005511aCBd5", "SPCXc", 8],
  ["0xb2000000000000000000001e800a7f5189430cD0", "TSLAc", 8],
  ["0xB2000000000000000000000d8Ce462E99ee7A47B", "AMDc", 8],
  ["0xB200000000000000000000B1a29cF17A1819288a", "ASTSc", 8],
  ["0xB200000000000000000000Fc737aeA6196aB5a4c", "AVGOc", 8],
  ["0xb20000000000000000000016f9dfe862feBA122b", "BEc", 8],
  ["0xb200000000000000000000f215E4C890CFb7176B", "CAKEc", 8],
  ["0xb200000000000000000000428E3a3eebBb20692B", "DJTc", 8],
  ["0xb200000000000000000000A613D12dEAfBBb1Db7", "DUOLc", 8],
  ["0xb2000000000000000000007790ed6E48e06eD935", "GMEc", 8],
  ["0xB20000000000000000000043a599976181Bcf336", "HIMSc", 8],
  ["0xb2000000000000000000002601C5C94F435da168", "HTZc", 8],
  ["0xB200000000000000000000f1a0F91e34892E4718", "LLYc", 8],
  ["0xB200000000000000000000e215e9B76ecBA02468", "MRNAc", 8],
  ["0xB200000000000000000000eC3c4c7395Cc609813", "MRVLc", 8],
  ["0xb200000000000000000000Fd2f87532B90095211", "MUc", 8],
  ["0xb20000000000000000000058B8c947e44011dFE6", "NFLXc", 8],
  ["0xB200000000000000000000C597c476FCf9Aed3a8", "NVAXc", 8],
  ["0xb200000000000000000000347AFbA223D7B6b63C", "ORCLc", 8],
  ["0xB20000000000000000000018FE7eC7d6DfeeB528", "PFEc", 8],
  ["0xb2000000000000000000007d16372840dF4dAbbe", "PLTRc", 8],
  ["0xB2000000000000000000008FC2A8C23cf5937b66", "PMc", 8],
  ["0xB2000000000000000000009272A491812842Aa84", "PTONc", 8],
  ["0xb200000000000000000000450ad3abE5d4846c6E", "PYPLc", 8],
  ["0xb200000000000000000000CA425ab42e07C35bC3", "QUBTc", 8],
  ["0xB2000000000000000000005bd7AE89b9E6189Bb5", "RBLXc", 8],
  ["0xb20000000000000000000066242d4067724cB7A1", "RDDTc", 8],
  ["0xB2000000000000000000002137743D4a01Fe4e88", "SOUNc", 8],
  ["0xB200000000000000000000f720C26062Bc3067Da", "TTWOc", 8],
  ["0xB20000000000000000000044E3CD7a0E1028E57a", "WENc", 8],
  ["0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", "cbBTC", 8],
  ["0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", "cbETH", 18],
  ["0xcbD06E5A2B0C65597161de254AA074E489dEb510", "cbDOGE", 8],
  ["0xcb585250f852C6c6bf90434AB21A00f02833a4af", "cbXRP", 6],
  ["0xcb17C9Db87B595717C857a08468793f5bAb6445F", "cbLTC", 8],
  ["0xcbADA732173e39521CDBE8bf59a6Dc85A9fc7b8c", "cbADA", 6],
  ["0xB2000000000000000000008501b13360000cb2EC", "cbZEC", 8],
];

export const EXPECTED_ROUTERS = [
  {
    router: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F",
    kind: 1,
    kindName: "AERODROME_SLIPSTREAM",
    factory: "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef",
    quoterV2: "0x514c8B5f54112481E28028F1166Bd78501089259",
    b20TickSpacing: 10,
  },
  {
    router: "0x2626664c2603336E57B271c5C0b26F421741e481",
    kind: 2,
    kindName: "UNISWAP_V3_ROUTER02",
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    usdcWethPoolFee: 3000,
    usdcWethPool: "0x6c561B446416E1A00E8E93E221854d6eA4171372",
  },
];

export const EXPECTED_SEPOLIA_DENYLIST = [
  "0xa9568499D7e58854F2590a56B6D32788DbfA58F9",
  "0xDFcB00fB1Fe83A6333302E55E23feCF6884376C4",
  "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
  "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
  "0xC5290058841028F1614F3A6F0F5816cAd0df5E27",
  "0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2",
  "0xc5C9F70A7F3EB18FC33406275Bffe31a922fcde5",
  "0x9102c5B535d25A9265e2793174701BdaCeEAAfC4",
  "0xb67FCDF437B5FeF64E4b32952dc6d172dc9ec56e",
];

const CONFIG_PATH = "deployments/base-mainnet/delegated-deploy-config.json";
const BROADCAST_PATH = "broadcast/DeployMPGRExecutorDelegatedBaseMainnet.s.sol/8453/run-latest.json";
const CANARY_WALLET = "0xBF6c574b9543967f0D528ae49603b0A7574a280b";
const V1_MAINNET_EXECUTOR = "0xD982726e28275661F8aB64054E6b17a70a63505A";
const PROBE_HOLDER = "0x000000000000000000000000000000000000dEaD";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const EXPECTED_WITNESS_TYPE_STRING =
  "ActionWitness witness)ActionWitness(address owner,address buyToken,uint256 minAmountOut,uint256 deadline,bytes32 actionId,bytes32 policyHash)TokenPermissions(address token,uint256 amount)";

const ERC20_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
];
const SLIPSTREAM_ROUTER_ABI = [
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "WETH9", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
const UNISWAP_ROUTER_ABI = [
  { type: "function", name: "WETH9", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

function normalizedAddress(value) {
  if (typeof value !== "string" || !isAddress(value)) return null;
  try {
    return getAddress(value).toLowerCase();
  } catch {
    return null;
  }
}

function sameAddress(left, right) {
  const a = normalizedAddress(left);
  const b = normalizedAddress(right);
  return a !== null && b !== null && a === b;
}

function addressListMatches(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((address, index) => sameAddress(address, expected[index]));
}

/** Pure config + protected-environment gate check, exported for regression tests. */
export function validateDeploymentConfig(config, { owner, feeRecipient, deployEnabled, artifactExists = false } = {}) {
  const checks = [];
  const add = (ok, name, detail = "") => checks.push({ ok: Boolean(ok), name, detail });
  if (!config || typeof config !== "object") {
    add(false, "deployment_config_read", "missing or invalid config");
    return { ok: false, checks };
  }

  const tokenListMatches = Array.isArray(config.tokens)
    && config.tokens.length === EXPECTED_TOKENS.length
    && config.tokens.every((token, index) => {
      const expected = EXPECTED_TOKENS[index];
      return Boolean(token)
        && sameAddress(token.address, expected[0])
        && token.symbol === expected[1]
        && token.decimals === expected[2];
    });
  const routerListMatches = Array.isArray(config.routers)
    && config.routers.length === EXPECTED_ROUTERS.length
    && config.routers.every((router, index) => {
      const expected = EXPECTED_ROUTERS[index];
      if (!router) return false;
      const common = sameAddress(router.router, expected.router)
        && router.kind === expected.kind
        && router.kindName === expected.kindName
        && sameAddress(router.factory, expected.factory)
        && sameAddress(router.quoterV2, expected.quoterV2);
      return index === 0
        ? common && router.b20TickSpacing === expected.b20TickSpacing
        : common
          && router.usdcWethPoolFee === expected.usdcWethPoolFee
          && sameAddress(router.usdcWethPool, expected.usdcWethPool);
    });
  const sepoliaListMatches = addressListMatches(config.denied?.sepolia, EXPECTED_SEPOLIA_DENYLIST);
  const denied = [CANARY_WALLET, V1_MAINNET_EXECUTOR, ...EXPECTED_SEPOLIA_DENYLIST].map(normalizedAddress);
  const allowlisted = [
    ...(Array.isArray(config.tokens) ? config.tokens.map((token) => normalizedAddress(token?.address)) : []),
    ...(Array.isArray(config.routers) ? config.routers.map((router) => normalizedAddress(router?.router)) : []),
  ];
  const allowlistExcludesDenied = denied.every((address) => address !== null)
    && allowlisted.every((address) => address !== null && !denied.includes(address));
  const ownerAddress = normalizedAddress(owner);
  const feeAddress = normalizedAddress(feeRecipient);

  add(config.chainId === BASE_CHAIN_ID && config.network === "base", "config_chain", "Base Mainnet 8453");
  add(config.contract === "MPGRExecutorDelegated", "config_contract", "delegated executor only");
  add(config.mainnetDelegatedDeployEnabled === true, "config_deploy_flag", "must be true for production run()");
  add(deployEnabled === "true", "environment_deploy_flag", "must be literal true from base-mainnet Environment");
  add(config.owner === EXPECTED_OWNER, "config_owner_pin");
  add(config.feeRecipient === EXPECTED_FEE_RECIPIENT, "config_fee_recipient_pin");
  add(ownerAddress !== null && sameAddress(owner, config.owner), "environment_owner_matches_config");
  add(feeAddress !== null && sameAddress(feeRecipient, config.feeRecipient), "environment_fee_recipient_matches_config");
  add(ownerAddress !== null && feeAddress !== null && ownerAddress !== feeAddress, "owner_fee_recipient_separation");
  add(config.feeBps === 25 && config.maxFeeBps === 100, "config_fee_policy", "25 bps fee; 100 bps cap");
  add(sameAddress(config.weth, CANONICAL_WETH), "config_canonical_weth");
  add(sameAddress(config.permit2, CANONICAL_PERMIT2), "config_canonical_permit2");
  add(config.outFile === EXPECTED_OUTPUT && !artifactExists, "one_time_artifact_guard", "expected path absent");
  add(config.moduleRegistrySchemaVersion === 1, "config_module_registry_schema");
  add(Array.isArray(config.typedModules) && config.typedModules.length === 0, "config_typed_modules", "must be empty initially");
  add(routerListMatches, "config_router_allowlist", "exact Slipstream and Uniswap V3 pins");
  add(tokenListMatches, "config_token_allowlist", "exact 50 production tokens");
  add(sameAddress(config.denied?.canaryWallet, CANARY_WALLET), "config_canary_denylist");
  add(sameAddress(config.denied?.v1MainnetExecutor, V1_MAINNET_EXECUTOR), "config_v1_denylist");
  add(sepoliaListMatches, "config_sepolia_denylist", "exact nine Base Sepolia addresses");
  add(allowlistExcludesDenied, "config_allowlist_excludes_denied_addresses");

  return { ok: checks.every((item) => item.ok), checks };
}

export function predictedExecutorAddress(deployerAddress, nonce = 0n) {
  return getCreateAddress({ from: deployerAddress, nonce });
}

function makeBaseChain(rpcUrl) {
  let parsed;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new Error("invalid RPC URL");
  }
  if (parsed.protocol !== "https:") throw new Error("RPC URL must use HTTPS");
  return defineChain({
    id: BASE_CHAIN_ID,
    name: "Base",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: "Basescan", url: "https://basescan.org" } },
  });
}

function makeClient(rpcUrl) {
  const chain = makeBaseChain(rpcUrl);
  return createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 1, timeout: 20_000 }) });
}

function writeOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string" || /[\r\n]/.test(value)) return;
  appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
}

function logCheck(ok, name, detail = "") {
  const line = `[${ok ? "PASS" : "FAIL"}] ${name}${detail ? `: ${detail}` : ""}`;
  if (ok) console.log(line);
  else console.error(line);
  return Boolean(ok);
}

async function runLiveGuards(phase, config, deployerAddress) {
  const failures = [];
  const check = (ok, name, detail = "") => {
    if (!logCheck(ok, name, detail)) failures.push(name);
    return Boolean(ok);
  };

  const rpcUrl = process.env.BASE_MAINNET_RPC_URL?.trim();
  check(Boolean(rpcUrl), "rpc_secret_presence", "presence only; value hidden");
  if (!rpcUrl) return failures;

  let client;
  try {
    client = makeClient(rpcUrl);
    check(true, "rpc_url_format", "HTTPS; value hidden");
  } catch {
    check(false, "rpc_url_format", "invalid HTTPS URL; value hidden");
    return failures;
  }

  let chainId;
  try {
    chainId = await client.getChainId();
    check(chainId === BASE_CHAIN_ID, "rpc_chain_id", `observed ${chainId}; required 8453`);
  } catch {
    check(false, "rpc_chain_id", "read-only RPC failed; endpoint details hidden");
    return failures;
  }
  if (chainId !== BASE_CHAIN_ID) return failures;

  const predicted = predictedExecutorAddress(deployerAddress, 0n);
  check(sameAddress(predicted, EXPECTED_EXECUTOR), "predicted_create_address", predicted);
  check(sameAddress(deployerAddress, EXPECTED_DEPLOYER), "dedicated_deployer_pin", deployerAddress);

  let blockNumber;
  try {
    blockNumber = await client.getBlockNumber();
    check(true, "rpc_block_number", blockNumber.toString());
  } catch {
    check(false, "rpc_block_number", "read-only RPC failed; endpoint details hidden");
  }

  let latestNonce;
  let pendingNonce;
  try {
    latestNonce = await client.getTransactionCount({ address: deployerAddress, blockTag: "latest" });
    check(latestNonce === 0, "deployer_latest_nonce_zero", `observed ${latestNonce}`);
  } catch {
    check(false, "deployer_latest_nonce_zero", "read-only RPC failed; endpoint details hidden");
  }
  try {
    pendingNonce = await client.getTransactionCount({ address: deployerAddress, blockTag: "pending" });
    check(pendingNonce === 0, "deployer_pending_nonce_zero", `observed ${pendingNonce}`);
  } catch {
    check(false, "deployer_pending_nonce_zero", "read-only RPC failed; endpoint details hidden");
  }
  try {
    const balance = await client.getBalance({ address: deployerAddress });
    check(balance >= MIN_DEPLOYER_BALANCE, "deployer_minimum_balance", `${balance} wei; minimum ${MIN_DEPLOYER_BALANCE} wei`);
  } catch {
    check(false, "deployer_minimum_balance", "read-only RPC failed; endpoint details hidden");
  }

  const roleAddresses = [deployerAddress, config.owner, config.feeRecipient];
  const normalizedRoles = roleAddresses.map(normalizedAddress);
  const normalizedPredicted = normalizedAddress(predicted);
  const protectedAddresses = [...normalizedRoles, normalizedPredicted];
  check(protectedAddresses.every((address) => address !== null), "role_and_prediction_addresses_valid");
  check(new Set(protectedAddresses).size === protectedAddresses.length, "deployer_owner_fee_prediction_separation");
  const denied = [CANARY_WALLET, V1_MAINNET_EXECUTOR, ...EXPECTED_SEPOLIA_DENYLIST].map(normalizedAddress);
  check(
    protectedAddresses.every((address) => address !== null && !denied.includes(address)),
    "deployer_owner_fee_prediction_not_denied",
  );
  check(!sameAddress(deployerAddress, EXPECTED_EXECUTOR), "deployer_not_predicted_executor");

  try {
    const code = await client.getBytecode({ address: predicted });
    check(code === undefined || code === "0x", "predicted_executor_empty_code", `${code === undefined || code === "0x" ? "empty" : "nonempty"}`);
  } catch {
    check(false, "predicted_executor_empty_code", "read-only RPC failed; endpoint details hidden");
  }
  try {
    const nonce = await client.getTransactionCount({ address: predicted, blockTag: "latest" });
    check(nonce === 0, "predicted_executor_nonce_zero", `observed ${nonce}`);
  } catch {
    check(false, "predicted_executor_nonce_zero", "read-only RPC failed; endpoint details hidden");
  }
  try {
    const balance = await client.getBalance({ address: predicted });
    check(balance === 0n, "predicted_executor_native_balance_zero", `${balance} wei`);
  } catch {
    check(false, "predicted_executor_native_balance_zero", "read-only RPC failed; endpoint details hidden");
  }

  const infrastructure = [
    ["WETH", config.weth],
    ["Permit2", config.permit2],
    ...EXPECTED_ROUTERS.flatMap((router) => [
      [router.kindName, router.router],
      [`${router.kindName}_factory`, router.factory],
      [`${router.kindName}_quoter`, router.quoterV2],
      ...(router.usdcWethPool ? [["UNISWAP_V3_USDC_WETH_pool", router.usdcWethPool]] : []),
    ]),
    ...EXPECTED_TOKENS.map((token) => [token[1], token[0]]),
  ];
  for (const [name, address] of infrastructure) {
    try {
      const code = await client.getBytecode({ address });
      check(code !== undefined && code !== "0x", `code_present_${name}`);
    } catch {
      check(false, `code_present_${name}`, "read-only RPC failed; endpoint details hidden");
    }
  }

  const slipstream = EXPECTED_ROUTERS[0];
  const uniswap = EXPECTED_ROUTERS[1];
  try {
    const factory = await client.readContract({ address: slipstream.router, abi: SLIPSTREAM_ROUTER_ABI, functionName: "factory" });
    check(sameAddress(factory, slipstream.factory), "slipstream_factory_matches_config");
  } catch {
    check(false, "slipstream_factory_matches_config", "read-only eth_call failed; details hidden");
  }
  try {
    const weth = await client.readContract({ address: slipstream.router, abi: SLIPSTREAM_ROUTER_ABI, functionName: "WETH9" });
    check(sameAddress(weth, config.weth), "slipstream_weth_matches_config");
  } catch {
    check(false, "slipstream_weth_matches_config", "read-only eth_call failed; details hidden");
  }
  try {
    const weth = await client.readContract({ address: uniswap.router, abi: UNISWAP_ROUTER_ABI, functionName: "WETH9" });
    check(sameAddress(weth, config.weth), "uniswap_weth_matches_config");
  } catch {
    check(false, "uniswap_weth_matches_config", "read-only eth_call failed; details hidden");
  }

  for (const [address, symbol, decimals] of EXPECTED_TOKENS) {
    try {
      const actualDecimals = await client.readContract({ address, abi: ERC20_ABI, functionName: "decimals" });
      check(actualDecimals === decimals, `erc20_${symbol}_decimals_matches_pin`);
    } catch {
      check(false, `erc20_${symbol}_decimals_matches_pin`, "read-only eth_call failed; details hidden");
    }
    try {
      await client.readContract({ address, abi: ERC20_ABI, functionName: "totalSupply" });
      check(true, `erc20_${symbol}_total_supply_readable`);
    } catch {
      check(false, `erc20_${symbol}_total_supply_readable`, "read-only eth_call failed; details hidden");
    }
    try {
      await client.readContract({ address, abi: ERC20_ABI, functionName: "balanceOf", args: [PROBE_HOLDER] });
      check(true, `erc20_${symbol}_balance_probe_readable`);
    } catch {
      check(false, `erc20_${symbol}_balance_probe_readable`, "read-only eth_call failed; details hidden");
    }
    try {
      const balance = await client.readContract({ address, abi: ERC20_ABI, functionName: "balanceOf", args: [predicted] });
      check(balance === 0n, `erc20_${symbol}_predicted_balance_zero`);
    } catch {
      check(false, `erc20_${symbol}_predicted_balance_zero`, "read-only eth_call failed; details hidden");
    }
  }

  if (phase === "prebroadcast") {
    writeOutput("deployer_address", deployerAddress);
    writeOutput("predicted_executor", predicted);
    writeOutput("prebroadcast_block_number", blockNumber === undefined ? "unknown" : blockNumber.toString());
    writeOutput("deployer_latest_nonce", latestNonce === undefined ? "unknown" : String(latestNonce));
    writeOutput("deployer_pending_nonce", pendingNonce === undefined ? "unknown" : String(pendingNonce));
  }
  return failures;
}

function readJsonConfig() {
  try {
    return JSON.parse(readFileSync(resolve(process.cwd(), CONFIG_PATH), "utf8"));
  } catch {
    return null;
  }
}

async function runReconciliation() {
  const rpcUrl = process.env.BASE_MAINNET_RPC_URL?.trim();
  if (!rpcUrl) {
    console.error("[STOP] Broadcast outcome uncertain and RPC secret unavailable; do not retry.");
    process.exitCode = 1;
    return;
  }
  let client;
  try {
    client = makeClient(rpcUrl);
  } catch {
    console.error("[STOP] Broadcast outcome uncertain; reconciliation RPC configuration invalid; do not retry.");
    process.exitCode = 1;
    return;
  }

  try {
    const chainId = await client.getChainId();
    if (chainId !== BASE_CHAIN_ID) {
      console.error(`[STOP] Reconciliation RPC reports chainId ${chainId}; expected 8453. Do not retry.`);
      process.exitCode = 1;
      return;
    }
  } catch {
    console.error("[STOP] Reconciliation chainId read failed; transaction outcome remains uncertain. Do not retry.");
    process.exitCode = 1;
    return;
  }

  let latestNonce = "unavailable";
  let pendingNonce = "unavailable";
  let codeStatus = "unavailable";
  try {
    latestNonce = String(await client.getTransactionCount({ address: EXPECTED_DEPLOYER, blockTag: "latest" }));
  } catch {}
  try {
    pendingNonce = String(await client.getTransactionCount({ address: EXPECTED_DEPLOYER, blockTag: "pending" }));
  } catch {}
  try {
    const code = await client.getBytecode({ address: EXPECTED_EXECUTOR });
    codeStatus = code && code !== "0x" ? "present" : "empty";
  } catch {}
  console.log(`[RECONCILE] deployer latest nonce=${latestNonce}; pending nonce=${pendingNonce}; predicted code=${codeStatus}`);

  let txHash = "";
  try {
    const broadcast = JSON.parse(readFileSync(resolve(process.cwd(), BROADCAST_PATH), "utf8"));
    const transactions = Array.isArray(broadcast.transactions) ? broadcast.transactions : [];
    const creates = transactions.filter((tx) => tx?.transactionType === "CREATE" && tx?.contractName === "MPGRExecutorDelegated");
    if (transactions.length === 1 && creates.length === 1 && typeof creates[0].hash === "string") txHash = creates[0].hash;
  } catch {}
  if (txHash) {
    console.log(`[RECONCILE] inspecting recorded deployment transaction ${txHash}`);
    try {
      const [transaction, receipt] = await Promise.all([
        client.getTransaction({ hash: txHash }),
        client.getTransactionReceipt({ hash: txHash }),
      ]);
      const confirmed = transaction.to === null
        && sameAddress(transaction.from, EXPECTED_DEPLOYER)
        && transaction.nonce === 0
        && receipt.status === "success"
        && sameAddress(receipt.contractAddress, EXPECTED_EXECUTOR);
      console.log(`[RECONCILE] transaction receipt ${confirmed ? "confirmed" : "not-successful"}; block=${receipt.blockNumber}`);
      writeOutput("receipt_confirmed", confirmed ? "true" : "false");
      if (confirmed) {
        console.log("[STOP] Receipt confirmed after a nonzero broadcast exit; continue only with read-only posture verification. Never retry.");
        return;
      }
    } catch {
      console.log("[RECONCILE] transaction or receipt unavailable; outcome remains uncertain.");
    }
  } else {
    console.log("[RECONCILE] no single CREATE transaction record found; transaction outcome remains uncertain.");
  }
  writeOutput("receipt_confirmed", "false");
  console.error("[STOP] Broadcast outcome is unconfirmed. Resolve transaction state manually; never retry automatically.");
  process.exitCode = 1;
}

async function main() {
  const phase = process.argv[2];
  if (phase === "--phase=reconcile") {
    await runReconciliation();
    return;
  }
  if (phase !== "--phase=preflight" && phase !== "--phase=prebroadcast") {
    console.error("[FAIL] phase must be --phase=preflight, --phase=prebroadcast, or --phase=reconcile");
    process.exitCode = 2;
    return;
  }

  const config = readJsonConfig();
  const artifactExists = existsSync(resolve(process.cwd(), EXPECTED_OUTPUT));
  const owner = process.env.MPGR_EXECUTOR_OWNER?.trim();
  const feeRecipient = process.env.MPGR_EXECUTOR_FEE_RECIPIENT?.trim();
  const deployEnabled = process.env.MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED;
  const staticValidation = validateDeploymentConfig(config, { owner, feeRecipient, deployEnabled, artifactExists });
  for (const check of staticValidation.checks) logCheck(check.ok, check.name, check.detail);
  if (!staticValidation.ok) {
    console.error("[STOP] Deployment config/environment gate failed; no RPC transaction method is available and no broadcast was attempted.");
    process.exitCode = 1;
    return;
  }

  let deployerAddress = EXPECTED_DEPLOYER;
  if (phase === "--phase=prebroadcast") {
    const privateKey = process.env.BASE_MAINNET_DEPLOYER_PRIVATE_KEY;
    if (typeof privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      logCheck(false, "deployer_key_format", "expected a protected 32-byte key; value hidden");
      process.exitCode = 1;
      return;
    }
    try {
      // Derive only the public address. Never log, serialize, or pass the key to a wallet client.
      deployerAddress = privateKeyToAccount(privateKey).address;
      logCheck(true, "deployer_public_address_derived", deployerAddress);
    } catch {
      logCheck(false, "deployer_public_address_derived", "key derivation failed; value hidden");
      process.exitCode = 1;
      return;
    }
  }

  const failures = await runLiveGuards(phase === "--phase=prebroadcast" ? "prebroadcast" : "preflight", config, deployerAddress);
  if (failures.length > 0) {
    console.error(`[STOP] ${failures.length} guard(s) failed. No deployment transaction was attempted.`);
    process.exitCode = 1;
    return;
  }
  console.log(`[PASS] ${phase === "--phase=prebroadcast" ? "Immediate pre-broadcast" : "Read-only deployment preflight"} completed.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // Suppress raw errors: provider exceptions may contain credential-bearing URLs.
    console.error("[STOP] Deployment guard terminated unexpectedly; raw error details suppressed.");
    process.exit(1);
  });
}
