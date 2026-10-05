#!/usr/bin/env node

// Secure-runner, read-only preflight for the immutable delegated Base Mainnet executor.
// This script intentionally has no wallet client and no transaction-writing RPC method.
// It derives one public address from the deployment key, then uses only chain-id,
// block-number, nonce, balance, bytecode and eth_call reads. It never invokes Forge script
// run(), creates a predicted deployment, broadcasts, deploys, activates, or runs a canary.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  defineChain,
  formatEther,
  getAddress,
  http,
  isAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CONFIG_PATH = "deployments/base-mainnet/delegated-deploy-config.json";
const EXPECTED_OUTPUT = "deployments/base-mainnet/mpgr-executor-delegated.json";
const BASE_CHAIN_ID = 8453;
const CANONICAL_PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const CANONICAL_WETH = "0x4200000000000000000000000000000000000006";
const PROBE_HOLDER = "0x000000000000000000000000000000000000dEaD";
const MIN_DEPLOYER_BALANCE = 2_000_000_000_000_000n; // 0.002 ETH, matching deploy-script guard

const EXPECTED_TOKENS = [
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
];

const EXPECTED_ROUTERS = [
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

const EXPECTED_SEPOLIA_DENYLIST = [
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

const ERC20_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
];
const SLIPSTREAM_ROUTER_ABI = [
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "WETH9", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
const UNISWAP_ROUTER_ABI = [
  { type: "function", name: "WETH9", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

const failures = [];
function emit(status, name, detail = "") {
  const line = `[${status}] ${name}${detail ? `: ${detail}` : ""}`;
  if (status === "FAIL") console.error(line);
  else console.log(line);
  if (status === "FAIL") failures.push(name);
}
function check(ok, name, detail = "") {
  emit(ok ? "PASS" : "FAIL", name, detail);
  return Boolean(ok);
}
function addressKey(value) {
  if (typeof value !== "string" || !isAddress(value)) return null;
  return getAddress(value).toLowerCase();
}
function sameAddress(a, b) {
  const aa = addressKey(a);
  const bb = addressKey(b);
  return aa !== null && bb !== null && aa === bb;
}
function hasCode(code) {
  return typeof code === "string" && code !== "0x" && code.length > 2;
}

function loadConfig() {
  try {
    return JSON.parse(readFileSync(resolve(process.cwd(), CONFIG_PATH), "utf8"));
  } catch {
    emit("FAIL", "deployment_config_read", "could not read or parse the committed config");
    return null;
  }
}

function checkStaticConfig(config, environmentOwner, environmentFeeRecipient, environmentDeployFlag) {
  if (!config) return false;
  const tokenListMatches = Array.isArray(config.tokens)
    && config.tokens.length === EXPECTED_TOKENS.length
    && config.tokens.every((token, index) => {
      const expected = EXPECTED_TOKENS[index];
      return Boolean(expected)
        && sameAddress(token.address, expected[0])
        && token.symbol === expected[1]
        && token.decimals === expected[2];
    });
  const routerListMatches = Array.isArray(config.routers)
    && config.routers.length === EXPECTED_ROUTERS.length
    && config.routers.every((router, index) => {
      const expected = EXPECTED_ROUTERS[index];
      if (!expected) return false;
      const optionalKeys = index === 0
        ? ["b20TickSpacing"]
        : ["usdcWethPoolFee", "usdcWethPool"];
      return sameAddress(router.router, expected.router)
        && router.kind === expected.kind
        && router.kindName === expected.kindName
        && sameAddress(router.factory, expected.factory)
        && sameAddress(router.quoterV2, expected.quoterV2)
        && optionalKeys.every((key) => key === "usdcWethPool"
          ? sameAddress(router[key], expected[key])
          : router[key] === expected[key]);
    });
  const deniedSepoliaMatches = Array.isArray(config.denied?.sepolia)
    && config.denied.sepolia.length === EXPECTED_SEPOLIA_DENYLIST.length
    && new Set(config.denied.sepolia.map(addressKey)).size === EXPECTED_SEPOLIA_DENYLIST.length
    && EXPECTED_SEPOLIA_DENYLIST.every((address) => config.denied.sepolia.some((value) => sameAddress(value, address)));

  check(config.chainId === BASE_CHAIN_ID && config.network === "base", "config_chain", "Base Mainnet 8453");
  check(config.contract === "MPGRExecutorDelegated", "config_contract");
  check(config.mainnetDelegatedDeployEnabled === false, "config_deploy_flag", "false; deployment remains disabled");
  check(environmentDeployFlag === "false", "environment_deploy_flag", "false; no enable override");
  check(config.owner === "0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e", "config_owner_pin");
  check(config.feeRecipient === "0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4", "config_fee_recipient_pin");
  check(sameAddress(environmentOwner, config.owner), "environment_owner_matches_config");
  check(sameAddress(environmentFeeRecipient, config.feeRecipient), "environment_fee_recipient_matches_config");
  check(config.feeBps === 25 && config.maxFeeBps === 100, "config_fee_policy", "25 bps fee, 100 bps cap");
  check(sameAddress(config.permit2, CANONICAL_PERMIT2), "config_canonical_permit2");
  check(sameAddress(config.weth, CANONICAL_WETH), "config_canonical_weth");
  check(routerListMatches, "config_router_allowlist", "exact two routers and RouterKinds 1/2");
  check(tokenListMatches, "config_token_allowlist", "exact 15 intended production tokens");
  check(sameAddress(config.denied?.canaryWallet, "0xBF6c574b9543967f0D528ae49603b0A7574a280b"), "config_canary_denylist");
  check(sameAddress(config.denied?.v1MainnetExecutor, "0xD982726e28275661F8aB64054E6b17a70a63505A"), "config_v1_denylist");
  check(deniedSepoliaMatches, "config_sepolia_denylist", "exact nine Base Sepolia addresses");
  check(Array.isArray(config.typedModules) && config.typedModules.length === 0, "config_typed_modules", "empty");
  check(config.moduleRegistrySchemaVersion === 1, "config_module_registry_schema");
  check(config.outFile === EXPECTED_OUTPUT, "config_artifact_path");
  check(!existsSync(resolve(process.cwd(), EXPECTED_OUTPUT)), "one_time_artifact_guard", "no existing delegated Mainnet record");

  if (Array.isArray(config.tokens) && Array.isArray(config.routers) && config.denied) {
    const denied = new Set([
      addressKey(config.denied.canaryWallet),
      addressKey(config.denied.v1MainnetExecutor),
      ...(config.denied.sepolia ?? []).map(addressKey),
    ]);
    const allowed = [
      ...config.tokens.map((token) => addressKey(token.address)),
      ...config.routers.map((router) => addressKey(router.router)),
    ];
    check(allowed.every((address) => address !== null && !denied.has(address)), "config_allowlist_excludes_denied_addresses");
  }

  return failures.length === 0;
}

function deriveDeployerAddress() {
  const raw = process.env.BASE_MAINNET_DEPLOYER_PRIVATE_KEY;
  check(typeof raw === "string" && raw.length > 0, "deployer_key_presence", "present check only; value hidden");
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    emit("FAIL", "deployer_key_format", "expected a 32-byte 0x-prefixed key; value hidden");
    return null;
  }
  try {
    // Retain only the public address; never pass a signer/wallet object to the RPC client.
    const address = privateKeyToAccount(raw).address;
    emit("PASS", "deployer_address_derived", address);
    return address;
  } catch {
    emit("FAIL", "deployer_address_derived", "key could not be used to derive an address; value hidden");
    return null;
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function rpcRead(name, fn, describe = (value) => String(value)) {
  try {
    const value = await fn();
    emit("PASS", name, describe(value));
    return value;
  } catch {
    emit("FAIL", name, "read-only RPC call failed; endpoint details hidden");
    return undefined;
  }
}

async function runLiveChecks(config, deployerAddress) {
  const rpcUrl = process.env.BASE_MAINNET_RPC_URL?.trim();
  check(Boolean(rpcUrl), "base_mainnet_rpc_secret_presence", "present check only; URL hidden");
  if (!rpcUrl || !deployerAddress) return;
  try {
    const parsed = new URL(rpcUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      emit("FAIL", "base_mainnet_rpc_url_format", "URL value hidden");
      return;
    }
    emit("PASS", "base_mainnet_rpc_url_format", "URL value hidden");
  } catch {
    emit("FAIL", "base_mainnet_rpc_url_format", "invalid URL; value hidden");
    return;
  }

  const base = defineChain({
    id: BASE_CHAIN_ID,
    name: "Base",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: "Basescan", url: "https://basescan.org" } },
  });
  const client = createPublicClient({
    chain: base,
    transport: http(rpcUrl, { retryCount: 1, timeout: 20_000 }),
  });

  const chainId = await rpcRead("rpc_reachable_chain_id", () => client.getChainId());
  if (chainId !== undefined) check(chainId === BASE_CHAIN_ID, "rpc_chain_id", `observed ${chainId}; required 8453`);
  if (chainId !== BASE_CHAIN_ID) return;

  await rpcRead("rpc_block_number", () => client.getBlockNumber(), (value) => value.toString());
  const latestNonce = await rpcRead(
    "deployer_latest_nonce",
    () => client.getTransactionCount({ address: deployerAddress, blockTag: "latest" }),
  );
  const pendingNonce = await rpcRead(
    "deployer_pending_nonce",
    () => client.getTransactionCount({ address: deployerAddress, blockTag: "pending" }),
  );
  if (latestNonce !== undefined) check(latestNonce === 0, "deployer_latest_nonce_zero");
  if (pendingNonce !== undefined) check(pendingNonce === 0, "deployer_pending_nonce_zero");
  const balance = await rpcRead(
    "deployer_balance",
    () => client.getBalance({ address: deployerAddress }),
    (value) => `${formatEther(value)} ETH`,
  );
  if (balance !== undefined) check(balance >= MIN_DEPLOYER_BALANCE, "deployer_minimum_balance", "deployment script requires at least 0.002 ETH");

  const infrastructure = [
    ["WETH", config.weth],
    ["Permit2", config.permit2],
    ...config.routers.map((router) => [router.kindName, router.router]),
    ...config.tokens.map((token) => [token.symbol, token.address]),
  ];
  await mapLimit(infrastructure, 4, async ([name, address]) => {
    try {
      const code = await client.getBytecode({ address });
      check(hasCode(code), `code_present_${name}`);
    } catch {
      emit("FAIL", `code_${name}`, "read-only RPC call failed; endpoint details hidden");
    }
  });

  const slipstream = config.routers[0];
  const uniswap = config.routers[1];
  const slipFactory = await rpcRead("slipstream_factory_view", () => client.readContract({
    address: slipstream.router,
    abi: SLIPSTREAM_ROUTER_ABI,
    functionName: "factory",
  }));
  if (slipFactory !== undefined) check(sameAddress(slipFactory, slipstream.factory), "slipstream_factory_matches_config");
  const slipWeth = await rpcRead("slipstream_weth_view", () => client.readContract({
    address: slipstream.router,
    abi: SLIPSTREAM_ROUTER_ABI,
    functionName: "WETH9",
  }));
  if (slipWeth !== undefined) check(sameAddress(slipWeth, config.weth), "slipstream_weth_matches_config");
  const uniWeth = await rpcRead("uniswap_router_weth_view", () => client.readContract({
    address: uniswap.router,
    abi: UNISWAP_ROUTER_ABI,
    functionName: "WETH9",
  }));
  if (uniWeth !== undefined) check(sameAddress(uniWeth, config.weth), "uniswap_weth_matches_config");

  await mapLimit(config.tokens, 3, async (token) => {
    const decimals = await rpcRead(`erc20_${token.symbol}_decimals`, () => client.readContract({
      address: token.address,
      abi: ERC20_ABI,
      functionName: "decimals",
    }));
    if (decimals !== undefined) check(decimals === token.decimals, `erc20_${token.symbol}_decimals_matches_config`);
    const supply = await rpcRead(`erc20_${token.symbol}_total_supply`, () => client.readContract({
      address: token.address,
      abi: ERC20_ABI,
      functionName: "totalSupply",
    }), (value) => `${value > 0n ? "nonzero" : "zero"} (value not logged)`);
    if (supply !== undefined) check(typeof supply === "bigint", `erc20_${token.symbol}_total_supply_readable`);
    const probeBalance = await rpcRead(`erc20_${token.symbol}_balance_probe`, () => client.readContract({
      address: token.address,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [PROBE_HOLDER],
    }), () => "balanceOf read succeeded");
    if (probeBalance !== undefined) check(typeof probeBalance === "bigint", `erc20_${token.symbol}_balance_readable`);
  });
}

async function main() {
  const config = loadConfig();
  if (!config) process.exit(1);

  const environmentOwner = process.env.MPGR_EXECUTOR_OWNER?.trim();
  const environmentFeeRecipient = process.env.MPGR_EXECUTOR_FEE_RECIPIENT?.trim();
  const environmentDeployFlag = process.env.MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED?.trim();

  check(typeof environmentOwner === "string" && environmentOwner.length > 0, "owner_variable_presence");
  check(typeof environmentFeeRecipient === "string" && environmentFeeRecipient.length > 0, "fee_recipient_variable_presence");

  // Static pins, exact allowlists, environment/config agreement, and the deliberately
  // disabled deployment flag. A false flag is an expected safe-stop, not authorization.
  checkStaticConfig(config, environmentOwner, environmentFeeRecipient, environmentDeployFlag);
  if (failures.length > 0) {
    console.error(`[STOP] ${failures.length} static/config preflight check(s) failed; no key derivation or RPC calls made.`);
    process.exit(1);
  }

  const deployerAddress = deriveDeployerAddress();
  if (deployerAddress) {
    const owner = addressKey(environmentOwner);
    const feeRecipient = addressKey(environmentFeeRecipient);
    const deployer = addressKey(deployerAddress);
    const denied = new Set([
      addressKey(config.denied.canaryWallet),
      addressKey(config.denied.v1MainnetExecutor),
      ...config.denied.sepolia.map(addressKey),
    ]);
    check(Boolean(owner) && Boolean(feeRecipient) && Boolean(deployer), "role_addresses_valid");
    if (owner && feeRecipient && deployer) {
      check(owner !== feeRecipient, "owner_fee_recipient_separation");
      check(deployer !== owner, "deployer_owner_separation");
      check(deployer !== feeRecipient, "deployer_fee_recipient_separation");
      check(!denied.has(deployer), "deployer_not_canary_v1_or_sepolia");
      check(!denied.has(owner), "owner_not_canary_v1_or_sepolia");
      check(!denied.has(feeRecipient), "fee_recipient_not_canary_v1_or_sepolia");
    }
  }

  // Stop before RPC if local pins, environment variables, artifact guard, or key checks failed.
  if (failures.length > 0) {
    console.error(`[STOP] ${failures.length} static/role preflight check(s) failed; no RPC calls made.`);
    process.exit(1);
  }

  await runLiveChecks(config, account);
  if (failures.length > 0) {
    console.error(`[STOP] ${failures.length} read-only preflight check(s) failed. No simulation or transaction was run.`);
    process.exit(1);
  }

  console.log("[PASS] Read-only secure-runner preflight checks completed for Base Mainnet 8453.");
  console.log("[STOP] Both deployment-enable flags are false by design. Do not run forge script simulation; no broadcast/deployment was attempted.");
}

main().catch(() => {
  // Provider and account libraries may include a credential-bearing RPC URL in thrown errors.
  // Suppress raw exceptions so neither that URL nor the deployer key can reach Actions logs.
  console.error("[STOP] Read-only preflight terminated unexpectedly; raw error details suppressed.");
  process.exit(1);
});
