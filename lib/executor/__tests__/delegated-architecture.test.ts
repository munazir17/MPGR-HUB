// lib/executor/__tests__/delegated-architecture.test.ts
//
// Proves the UNIVERSAL MULTI-CHAIN EXECUTOR ARCHITECTURE DECISION
// (docs/EXECUTOR-ARCHITECTURE-DECISION.md):
//
//   §A  Design A holds at the SOURCE level — the delegated executor is immutable,
//       has no proxy/upgrade/delegatecall/arbitrary-call surface, and exposes a
//       complete owner-governed configuration surface, so no ordinary
//       configuration change requires redeploying it.
//   §B  The committed mainnet deploy config is internally consistent and
//       consistent with the TypeScript route table (the §7 finding: a router the
//       app promises must be a router the contract will accept).
//   §C  The CROSS-CHAIN authorization matrix — mainnet<->Sepolia in both
//       directions, plus a third chain, plus a same-actionId replay attempt.
//   §D  Deployment safety gates exist in the deploy script, and the canary can
//       never hold a production role.
//
// Pure source/data assertions + in-memory authorization logic: no chain, no
// network, no keys, no deployment.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";

import { BASE_MAINNET_EXECUTOR_DEPLOYMENT, RouterKind } from "@/lib/executor/executor-config";
import { delegatedActionId, isDelegatedChainId } from "@/lib/executor/delegated-executor";
import { BASE_PAIRS } from "@/lib/markets/base-pairs";
import { COINBASE_B20_TOKENIZED_STOCKS } from "@/lib/trade/tokenized-stocks";
import {
  delegatedSlotId,
  policyHashFor,
  selectDelegatedSlot,
  validateNewSlotAgainstPolicy,
  type DelegatedAuthorizationSlot,
} from "@/lib/autonomy/delegated-authorization";
import type { AutonomyPolicy } from "@/lib/autonomy/types";

const ROOT = process.cwd();
const CONTRACT = readFileSync(join(ROOT, "contracts/executor/MPGRExecutorDelegated.sol"), "utf8");
const MODULE_INTERFACE = readFileSync(join(ROOT, "contracts/executor/interfaces/IMPGRExecutorSwapModule.sol"), "utf8");
const MODULE_BASE = readFileSync(join(ROOT, "contracts/executor/modules/MPGRExecutorSwapModuleBase.sol"), "utf8");
const DEPLOY_SCRIPT = readFileSync(join(ROOT, "script/DeployMPGRExecutorDelegatedBaseMainnet.s.sol"), "utf8");
const DEPLOYMENT_RECORDER = readFileSync(join(ROOT, "script/RecordMPGRExecutorDelegatedBaseMainnet.s.sol"), "utf8");
const DEPLOY_CONFIG = JSON.parse(
  readFileSync(join(ROOT, "deployments/base-mainnet/delegated-deploy-config.json"), "utf8"),
) as {
  chainId: number;
  contract: string;
  mainnetDelegatedDeployEnabled: boolean;
  owner: string;
  feeRecipient: string;
  feeBps: number;
  maxFeeBps: number;
  permit2: string;
  weth: string;
  moduleRegistrySchemaVersion: number;
  typedModules: Array<{ router: string; module: string; codeHash: string }>;
  routers: Array<{ router: string; kind: number; kindName: string }>;
  tokens: Array<{ address: string; symbol: string; decimals: number }>;
  denied: { canaryWallet: string; sepolia: string[]; v1MainnetExecutor: string };
};

function solidityExecutable(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
}

const CANARY_WALLET = "0xBF6c574b9543967f0D528ae49603b0A7574a280b";
const V1_MAINNET_EXECUTOR = "0xD982726e28275661F8aB64054E6b17a70a63505A";

const USER = getAddress("0x0000000000000000000000000000000000d0e541");
const SELL = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"); // USDC
const BUY = getAddress("0xb200000000000000000000C2e324d24d7eEcd1fb"); // AAPLc
const NOW = new Date("2026-10-01T00:00:00Z");
const DEADLINE = Math.floor(NOW.getTime() / 1000) + 1800;

// ---------------------------------------------------------------------------
// §A — Design A is true at the source level
// ---------------------------------------------------------------------------

describe("§A Design A — immutable executor, governed configuration, no upgrade surface", () => {
  it("has NO proxy, upgrade, delegatecall or arbitrary-call surface", () => {
    // Each of these is a concrete mechanism, not a word in a comment: the file's
    // header legitimately says "No proxy, no upgrade path", so we assert on the
    // mechanisms that would have to exist for upgradeability.
    const executable = solidityExecutable(CONTRACT);
    for (const forbidden of [
      "delegatecall",
      "callcode",
      "selfdestruct(",
      "assembly",
      "Upgradeable",
      "UUPS",
      "ERC1967",
      "Initializable",
      "_disableInitializers",
      "reinitializer",
      "function execute(",
      "function upgradeTo",
      "proxiableUUID",
    ]) {
      expect({ forbidden, present: executable.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  it("rejects native input on every entrypoint (msg.value must be zero)", () => {
    // Three payable entrypoints, each reverting on non-zero value.
    expect(CONTRACT.match(/if \(msg\.value != 0\) revert NativeInputUnsupported\(\);/g)).toHaveLength(3);
    expect(CONTRACT.match(/function swapOnBehalfOf(UniswapV3|Slipstream|TypedModule)\(/g)).toHaveLength(3);
  });

  it("exposes the complete owner-governed configuration surface (=> no redeploy for config changes)", () => {
    const governed = [
      "function setTokenAllowed(address token, bool allowed) external onlyOwner",
      "function setRouter(address router, RouterKind kind) external onlyOwner",
      "function setRouterModule(address router, address module) external onlyOwner",
      "function setFeeBps(uint16 newFeeBps) external onlyOwner",
      "function setFeeRecipient(address newFeeRecipient) external onlyOwner",
      "function pause() external onlyOwner",
      "function unpause() external onlyOwner",
      "function rescueERC20(address token, address to, uint256 amount) external onlyOwner nonReentrant",
      "function rescueNative(address payable to, uint256 amount) external onlyOwner nonReentrant",
    ];
    for (const sig of governed) {
      expect({ signature: sig, present: CONTRACT.includes(sig) }).toEqual({ signature: sig, present: true });
    }
    // Every state-changing admin function is onlyOwner: there is no second,
    // weaker authority (and specifically no broadcaster-controlled admin path).
    const adminFns = CONTRACT.match(/function (set|pause|unpause|rescue)[A-Za-z]*\([^)]*\)[^{;]*/g) ?? [];
    expect(adminFns.length).toBeGreaterThan(0);
    for (const fn of adminFns) {
      expect({ fn, onlyOwner: fn.includes("onlyOwner") }).toEqual({ fn, onlyOwner: true });
    }
  });

  it("has a hard on-chain fee cap and two-step, non-renounceable governance", () => {
    expect(CONTRACT).toContain("uint16 public constant MAX_FEE_BPS = 100;");
    expect(CONTRACT).toContain("is Ownable2Step, Pausable, ReentrancyGuard");
    // renounceOwnership is disabled, so governance can never be abandoned and
    // leave the allowlists permanently frozen.
    expect(CONTRACT).toMatch(/function renounceOwnership\(\) public view override onlyOwner/);
    expect(CONTRACT).toContain("error RenounceDisabled()");
    // Pause is independent of trading and of every other admin action.
    expect(CONTRACT).toMatch(/whenNotPaused/);
  });

  it("supports new venues through a router-bound typed module, never arbitrary target/data", () => {
    expect(CONTRACT).toContain("function setRouterModule(address router, address module) external onlyOwner");
    expect(CONTRACT).toContain("mapping(address router => address module) public swapModuleForRouter");
    expect(CONTRACT).toContain("mapping(address router => bytes32 codeHash) public swapModuleCodeHash");
    expect(CONTRACT).toContain("module.codehash != pinnedCodeHash");
    expect(CONTRACT).toContain("swapExactInput(");
    expect(MODULE_INTERFACE).toContain("function swapExactInput(");
    expect(MODULE_INTERFACE).not.toContain("bytes calldata");
    expect(MODULE_BASE).toContain("address public immutable override executor");
    expect(MODULE_BASE).toContain("address public immutable override router");
    expect(MODULE_BASE).toContain("if (msg.sender != executor) revert UnauthorizedExecutor(msg.sender);");
    expect(MODULE_BASE).toContain("if (recipient != executor) revert InvalidOutputRecipient(recipient);");
    const executableModule = solidityExecutable(MODULE_BASE);
    for (const forbidden of ["delegatecall", "callcode", "execute(address", "bytes calldata data"]) {
      expect({ forbidden, present: executableModule.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  it("takes every chain-varying value as a CONSTRUCTOR ARG (=> one implementation, any chain)", () => {
    expect(CONTRACT).toMatch(/IWETH9 public immutable WETH;/);
    expect(CONTRACT).toMatch(/IPermit2SignatureTransferWitness public immutable PERMIT2;/);
    // WETH/Permit2 are assigned from args, not hardcoded, and validated as contracts.
    expect(CONTRACT).toContain("if (weth.code.length == 0) revert NotAContract(weth);");
    expect(CONTRACT).toContain("if (permit2.code.length == 0) revert NotAContract(permit2);");
    // There is no chain-id constant baked into the contract.
    expect(CONTRACT.includes("block.chainid ==")).toBe(false);
  });

  it("binds the chain through Permit2's own EIP-712 domain (structural, not conventional)", () => {
    // The witness type string is the exact string Permit2 hashes; combined with
    // Permit2's domain ("Permit2", block.chainid, spender) a cross-chain replay
    // cannot recover the signer.
    expect(CONTRACT).toContain("string public constant WITNESS_TYPE_STRING =");
    expect(CONTRACT).toContain("ACTION_WITNESS_STRUCT_TYPE_STRING");
    // The binding fields the user signs over.
    for (const field of ["owner", "buyToken", "minAmountOut", "deadline", "actionId", "policyHash"]) {
      expect({ field, bound: CONTRACT.includes(field) }).toEqual({ field, bound: true });
    }
  });
});

// ---------------------------------------------------------------------------
// §B — the committed mainnet deploy config is consistent
// ---------------------------------------------------------------------------

describe("§B mainnet delegated deploy config ↔ TypeScript route table consistency", () => {
  it("is pinned to Base mainnet with the MPGR fee model and canonical infrastructure", () => {
    expect(DEPLOY_CONFIG.chainId).toBe(8453);
    expect(DEPLOY_CONFIG.feeBps).toBe(25);
    expect(DEPLOY_CONFIG.maxFeeBps).toBe(100);
    expect(DEPLOY_CONFIG.owner).toBe("0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e");
    expect(DEPLOY_CONFIG.feeRecipient).toBe("0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4");
    expect(DEPLOY_CONFIG.permit2).toBe("0x000000000022D473030F116dDEE9F6B43aC78BA3");
    expect(DEPLOY_CONFIG.weth).toBe("0x4200000000000000000000000000000000000006");
    expect(DEPLOY_CONFIG.contract).toBe("MPGRExecutorDelegated");
    expect(DEPLOY_CONFIG.moduleRegistrySchemaVersion).toBe(1);
    expect(DEPLOY_CONFIG.typedModules).toEqual([]);
  });

  it("is explicitly armed in the reviewed deployment config", () => {
    expect(DEPLOY_CONFIG.mainnetDelegatedDeployEnabled).toBe(true);
  });

  it("EVERY router the TypeScript mainnet route table promises is allowlisted in the config", () => {
    // This is the §7 finding turned into a permanent regression guard: if the
    // app can resolve a venue the executor will refuse, an autonomous trade
    // fails AFTER the user signed. Drift must be caught here, not at trade time.
    const configured = new Map(DEPLOY_CONFIG.routers.map((r) => [r.router.toLowerCase(), r.kind]));
    const missing: Array<{ router: string; kind: number }> = [];
    for (const route of BASE_MAINNET_EXECUTOR_DEPLOYMENT.routes) {
      const kind = configured.get(route.router.toLowerCase());
      if (kind === undefined || kind !== route.kind) missing.push({ router: route.router, kind: route.kind });
    }
    expect(missing).toEqual([]);
  });

  it("router kinds in the config match the contract's RouterKind enum exactly", () => {
    expect(RouterKind.AERODROME_SLIPSTREAM).toBe(1);
    expect(RouterKind.UNISWAP_V3_ROUTER02).toBe(2);
    expect(RouterKind.TYPED_SWAP_MODULE).toBe(3);
    for (const r of DEPLOY_CONFIG.routers) {
      expect({ router: r.router, kindName: r.kindName, kind: r.kind }).toEqual({
        router: r.router,
        kindName: r.kindName === "AERODROME_SLIPSTREAM" ? r.kindName : r.kindName,
        kind: r.kindName === "AERODROME_SLIPSTREAM" ? 1 : 2,
      });
      expect([1, 2]).toContain(r.kind);
    }
    // Both production venues are present.
    const names = DEPLOY_CONFIG.routers.map((r) => r.kindName).sort();
    expect(names).toEqual(["AERODROME_SLIPSTREAM", "UNISWAP_V3_ROUTER02"]);
  });

  it("EVERY token the TypeScript mainnet registry uses is allowlisted in the config", () => {
    const configured = new Set(DEPLOY_CONFIG.tokens.map((t) => t.address.toLowerCase()));
    const missing = BASE_MAINNET_EXECUTOR_DEPLOYMENT.tokens.filter((t) => !configured.has(t.address.toLowerCase()));
    expect(missing).toEqual([]);
    expect(DEPLOY_CONFIG.tokens).toHaveLength(50);
    // Decimals agree with the v1 registry for every token the registry carries
    // (a mismatch would mis-scale parsed amounts). Tokens beyond the v1 set are
    // pinned by the canonical-source invariants below.
    for (const t of DEPLOY_CONFIG.tokens) {
      const reg = BASE_MAINNET_EXECUTOR_DEPLOYMENT.tokens.find((x) => x.address.toLowerCase() === t.address.toLowerCase());
      if (!reg) continue;
      expect({ symbol: t.symbol, decimals: reg.decimals }).toEqual({ symbol: t.symbol, decimals: t.decimals });
    }
  });

  it("is UNIVERSAL: every live B20 stock and every official wrapped asset is allowlisted", () => {
    const configured = new Set(DEPLOY_CONFIG.tokens.map((t) => t.address.toLowerCase()));
    // (a) ALL currently live Coinbase B20 tokenized stocks (38) are in the config.
    const liveStocks = BASE_PAIRS.filter((p) => p.kind === "b20-stock" && p.live);
    expect(liveStocks.length).toBeGreaterThan(0);
    expect(liveStocks.filter((p) => !configured.has(p.address.toLowerCase()))).toEqual([]);
    // (b) The three issued-but-launch-pending B20s stay pinned ahead of launch
    //     (refused by every app trade surface until Base lists them live).
    for (const ticker of ["COINc", "CRCLc", "INTCc"]) {
      const pair = BASE_PAIRS.find((p) => p.symbol === ticker);
      expect({ ticker, configured: configured.has(pair!.address.toLowerCase()) }).toEqual({ ticker, configured: true });
    }
    // (c) Every official Coinbase wrapped asset from the typed base-pairs
    //     allowlist (cbBTC, cbETH, cbDOGE, cbXRP, cbLTC, cbADA) plus cbZEC
    //     (official Coinbase announcement 2026-09-02, address pinned in
    //     lib/markets/__tests__/base-pairs.test.ts) is in the config.
    const wrapped = BASE_PAIRS.filter((p) => p.kind === "wrapped");
    expect(wrapped.filter((p) => !configured.has(p.address.toLowerCase()))).toEqual([]);
    const CBZEC = "0xB2000000000000000000008501b13360000cb2EC";
    expect(configured.has(CBZEC.toLowerCase())).toBe(true);
  });

  it("never invents an allowlist address: every config token comes from a canonical repo source", () => {
    const canonical = new Set<string>([
      ...COINBASE_B20_TOKENIZED_STOCKS.map((s) => s.address.toLowerCase()),
      ...BASE_PAIRS.map((p) => p.address.toLowerCase()),
      // cbZEC: committed in lib/markets/__tests__/base-pairs.test.ts with its
      // official Coinbase source; cbHYPE stays a runtime setTokenAllowed candidate.
      "0xB2000000000000000000008501b13360000cb2EC".toLowerCase(),
      // Canonical Base USDC + WETH (the same pins as config.weth, the v1
      // executor registry, executor-config.ts and the deploy script constants).
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase(),
      "0x4200000000000000000000000000000000000006".toLowerCase(),
    ]);
    const invented = DEPLOY_CONFIG.tokens.filter((t) => !canonical.has(t.address.toLowerCase()));
    expect(invented).toEqual([]);
  });

  it("EXCLUDES the 19 announced-not-live B20 addresses until Base lists them live", () => {
    const configured = new Set(DEPLOY_CONFIG.tokens.map((t) => t.address.toLowerCase()));
    const announced = BASE_PAIRS.filter((p) => p.kind === "b20-stock" && !p.live);
    // 22 not-live total: the 3 launch-pending originals are pinned (asserted
    // above); the 19 announced-only addresses must NOT be in the deploy config —
    // they join at launch through the owner-governed runtime setTokenAllowed
    // path, which needs no redeployment.
    const launchPending = new Set(["COINc", "CRCLc", "INTCc"]);
    const announcedOnly = announced.filter((p) => !launchPending.has(p.symbol));
    expect(announcedOnly).toHaveLength(19);
    expect(announcedOnly.filter((p) => configured.has(p.address.toLowerCase()))).toEqual([]);
    // And decimals pins follow the canonical family rules: every 0xb200 token 8.
    for (const t of DEPLOY_CONFIG.tokens) {
      if (t.address.toLowerCase().startsWith("0xb200")) expect({ symbol: t.symbol, decimals: t.decimals }).toEqual({ symbol: t.symbol, decimals: 8 });
    }
  });

  it("the canary wallet, the v1 executor and every Sepolia address are DENIED", () => {
    expect(getAddress(DEPLOY_CONFIG.denied.canaryWallet)).toBe(CANARY_WALLET);
    expect(getAddress(DEPLOY_CONFIG.denied.v1MainnetExecutor)).toBe(V1_MAINNET_EXECUTOR);
    const denied = new Set(
      [DEPLOY_CONFIG.denied.canaryWallet, DEPLOY_CONFIG.denied.v1MainnetExecutor, ...DEPLOY_CONFIG.denied.sepolia].map(
        (a) => a.toLowerCase(),
      ),
    );
    // No denied address may appear in any production role or allowlist.
    for (const a of [DEPLOY_CONFIG.owner, DEPLOY_CONFIG.feeRecipient, ...DEPLOY_CONFIG.routers.map((r) => r.router), ...DEPLOY_CONFIG.tokens.map((t) => t.address)]) {
      expect({ address: a, denied: denied.has(a.toLowerCase()) }).toEqual({ address: a, denied: false });
    }
    // The v1 executor must never be the delegated executor.
    expect(denied.has(V1_MAINNET_EXECUTOR.toLowerCase())).toBe(true);
    // The Sepolia delegated executor is in the denylist, so it can never be
    // allowlisted or used as a role on mainnet.
    expect(DEPLOY_CONFIG.denied.sepolia.map((a) => a.toLowerCase())).toContain(
      "0xa9568499d7e58854f2590a56b6d32788dbfa58f9",
    );
  });
});

// ---------------------------------------------------------------------------
// §C — the cross-chain authorization matrix
// ---------------------------------------------------------------------------

function policyOn(chainId: number, id: string): AutonomyPolicy {
  return {
    id,
    wallet: USER,
    chainId: chainId as 8453 | 84532,
    actions: ["swap"],
    sellToken: SELL,
    buyToken: BUY,
    maxPerTradeRaw: "1000000",
    maxDailyRaw: "5000000",
    maxSlippageBps: 500,
    maxActionsPerDay: 2,
    enabled: true,
    createdAt: new Date(NOW.getTime() - 3600_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 6 * 3600_000).toISOString(),
    authorizedAt: new Date(NOW.getTime() - 3600_000).toISOString(),
    authorizationRef: "arch",
  };
}

/** A slot PERFECT in every respect except the fields the test overrides. */
function slotOn(slotChainId: number, policy: AutonomyPolicy, goalId: string, over: { wallet?: Address } = {}): DelegatedAuthorizationSlot {
  const wallet = (over.wallet ?? USER).toLowerCase() as Address;
  return {
    id: delegatedSlotId(policy.id, goalId, 0),
    wallet,
    chainId: slotChainId as 8453 | 84532,
    policyId: policy.id,
    goalId,
    slotIndex: 0,
    permit: { token: SELL, amount: "1000000", nonce: "7", deadline: DEADLINE },
    witness: {
      owner: wallet,
      buyToken: BUY,
      minAmountOut: "1",
      deadline: DEADLINE,
      actionId: delegatedActionId(goalId),
      policyHash: policyHashFor(policy),
    },
    signature: ("0x" + "ab".repeat(65)) as Hex,
    createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
  };
}

function ctx(policy: AutonomyPolicy) {
  return { now: NOW, policy, sellToken: SELL, buyToken: BUY, sellAmountRaw: "1000000", liveMinBuyAmountRaw: "1" };
}

describe("§C cross-chain authorization matrix", () => {
  const mainnet = policyOn(8453, "pol-mainnet");
  const sepolia = policyOn(84532, "pol-sepolia");
  const GOAL = "goal-arch";

  it("Mainnet slot -> Mainnet policy -> Mainnet executor = ALLOWED", () => {
    expect(isDelegatedChainId(8453)).toBe(true);
    expect(selectDelegatedSlot([slotOn(8453, mainnet, GOAL)], ctx(mainnet)).authorized).toBe(true);
    expect(validateNewSlotAgainstPolicy(slotOn(8453, mainnet, GOAL), mainnet)).toBeNull();
  });

  it("Sepolia slot -> Sepolia policy -> Sepolia executor = ALLOWED", () => {
    expect(isDelegatedChainId(84532)).toBe(true);
    expect(selectDelegatedSlot([slotOn(84532, sepolia, GOAL)], ctx(sepolia)).authorized).toBe(true);
    expect(validateNewSlotAgainstPolicy(slotOn(84532, sepolia, GOAL), sepolia)).toBeNull();
  });

  it("Sepolia slot -> Mainnet policy = REJECTED (CHAIN_MISMATCH)", () => {
    const v = selectDelegatedSlot([slotOn(84532, mainnet, GOAL)], ctx(mainnet));
    expect(v.authorized).toBe(false);
    expect(v.reason).toBe("CHAIN_MISMATCH");
    expect(validateNewSlotAgainstPolicy(slotOn(84532, mainnet, GOAL), mainnet)).toBe("CHAIN_MISMATCH");
  });

  it("Mainnet slot -> Sepolia policy = REJECTED (CHAIN_MISMATCH)", () => {
    const v = selectDelegatedSlot([slotOn(8453, sepolia, GOAL)], ctx(sepolia));
    expect(v.authorized).toBe(false);
    expect(v.reason).toBe("CHAIN_MISMATCH");
    expect(validateNewSlotAgainstPolicy(slotOn(8453, sepolia, GOAL), sepolia)).toBe("CHAIN_MISMATCH");
  });

  it("a mainnet authorization REPLAYED on a non-delegated chain is rejected before selection", () => {
    // The chain must be a delegated chain at all; a third chain (Ethereum, OP,
    // Polygon, an anvil fork) never reaches slot selection.
    for (const chainId of [1, 10, 137, 31337, 84531]) {
      expect({ chainId, delegated: isDelegatedChainId(chainId) }).toEqual({ chainId, delegated: false });
    }
    // And a policy claiming a non-delegated chain is refused outright.
    const foreign = { ...mainnet, chainId: 10 as unknown as 8453 } as AutonomyPolicy;
    expect(selectDelegatedSlot([slotOn(8453, foreign, GOAL)], ctx(foreign)).authorized).toBe(false);
    expect(selectDelegatedSlot([slotOn(8453, foreign, GOAL)], ctx(foreign)).reason).toBe("CHAIN_MISMATCH");
  });

  it("the SAME actionId on another chain is rejected, because the policy hash is chain-specific", () => {
    // actionId is derived from goalId alone, so the SAME goal id yields the SAME
    // actionId on both chains. What stops a cross-chain replay is that the
    // policy hash — which the witness commits to — carries chainId.
    const sameActionIdMainnet = delegatedActionId(GOAL);
    const sameActionIdSepolia = delegatedActionId(GOAL);
    expect(sameActionIdMainnet).toBe(sameActionIdSepolia);

    // A slot built for the mainnet policy carries the MAINNET policy hash.
    const mainnetSlot = slotOn(8453, mainnet, GOAL);
    // Present it against the Sepolia policy: refused on chain first...
    expect(selectDelegatedSlot([mainnetSlot], ctx(sepolia)).reason).toBe("CHAIN_MISMATCH");
    // ...and if the chain field were forged to 84532, the policy hash would then
    // disagree, so it is still refused. Two independent bindings.
    const forged = { ...mainnetSlot, chainId: 84532 as const };
    const forgedVerdict = selectDelegatedSlot([forged], ctx(sepolia));
    expect(forgedVerdict.authorized).toBe(false);
    expect(["POLICY_HASH_MISMATCH", "CHAIN_MISMATCH"]).toContain(forgedVerdict.reason);
    // The hashes really do differ per chain.
    expect(policyHashFor(mainnet)).not.toBe(policyHashFor(sepolia));
  });

  it("a slot owned by a DIFFERENT wallet is rejected even on the correct chain", () => {
    const attacker = getAddress("0x000000000000000000000000000000000000beef");
    const v = selectDelegatedSlot([slotOn(8453, mainnet, GOAL, { wallet: attacker })], ctx(mainnet));
    expect(v.authorized).toBe(false);
    expect(v.reason).toBe("OWNER_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// §D — deployment safety gates
// ---------------------------------------------------------------------------

describe("§D deployment safety gates", () => {
  it("the deploy script is Base-mainnet-only and requires TWO independent enable flags", () => {
    expect(DEPLOY_SCRIPT).toContain('require(block.chainid == BASE_MAINNET_CHAIN_ID, "MPGR: BASE MAINNET (8453) ONLY - refusing to run");');
    expect(DEPLOY_SCRIPT).toContain("MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED");
    expect(DEPLOY_SCRIPT).toContain(".mainnetDelegatedDeployEnabled");
  });

  it("the deploy is ONE-TIME (artifact-exists AND fresh deployer nonce)", () => {
    expect(DEPLOY_SCRIPT).toContain("already deployed");
    expect(DEPLOY_SCRIPT).toMatch(/vm\.getNonce\(c\.deployer\) == 0/);
    expect(DEPLOY_SCRIPT).toMatch(/vm\.computeCreateAddress\(c\.deployer, 0\)/);
  });

  it("the deployer can hold no ongoing role, and the canary/v1/Sepolia addresses are denied", () => {
    expect(DEPLOY_SCRIPT).toContain("deployer must not be the owner");
    expect(DEPLOY_SCRIPT).toContain("deployer must not be the fee recipient");
    expect(DEPLOY_SCRIPT).toContain("deployer must not be the production broadcaster");
    expect(DEPLOY_SCRIPT).toContain(CANARY_WALLET);
    expect(DEPLOY_SCRIPT).toContain(V1_MAINNET_EXECUTOR);
    expect(DEPLOY_SCRIPT).toContain("function _deny(address a, string memory what)");
  });

  it("the deploy script PERFORMS NO SWAPS — it must never touch real user funds", () => {
    expect(DEPLOY_SCRIPT.includes("swapOnBehalfOf")).toBe(false);
    expect(DEPLOY_SCRIPT.includes("vm.sign(")).toBe(false);
    // The only broadcast is the constructor call.
    expect(DEPLOY_SCRIPT.match(/vm\.startBroadcast/g)).toHaveLength(1);
    expect(DEPLOY_SCRIPT).toContain("new MPGRExecutorDelegated(");
  });

  it("postflight asserts EVERY posture value the runtime will later verify on-chain", () => {
    for (const assertion of [
      "dex.owner() == c.owner",
      "dex.pendingOwner() == address(0)",
      "dex.feeBps() == FEE_BPS",
      "dex.MAX_FEE_BPS() == EXPECTED_MAX_FEE_BPS",
      "dex.feeRecipient() == c.feeRecipient",
      "address(dex.PERMIT2()) == PERMIT2",
      "address(dex.WETH()) == WETH",
      "!dex.paused()",
      "WITNESS_TYPE_STRING",
      "dex.isTokenAllowed(tokens[i])",
      "dex.routerKind(routers[i].router) == routers[i].kind",
    ]) {
      expect({ assertion, present: DEPLOY_SCRIPT.includes(assertion) }).toEqual({ assertion, present: true });
    }
    // And it proves the executor holds nothing at deploy time.
    expect(DEPLOY_SCRIPT).toContain("executor holds a balance at deploy time");
    expect(DEPLOY_SCRIPT).toContain("executor holds native ETH at deploy time");
  });

  it("records the mined artifact as NON-proxy so no consumer can mistake it for one", () => {
    expect(DEPLOYMENT_RECORDER).toContain('vm.serializeString(k, "proxy", "none")');
    expect(DEPLOYMENT_RECORDER).toContain('vm.serializeString(k, "implementation", "none")');
    expect(DEPLOYMENT_RECORDER).toContain('vm.serializeString(k, "upgradeAuthority", "none")');
    expect(DEPLOYMENT_RECORDER).toContain("mpgr-executor-delegated.json");
    expect(DEPLOYMENT_RECORDER).toContain("deployment.txHash");
    expect(DEPLOYMENT_RECORDER).toContain("deployment.blockNumber");
    expect(DEPLOYMENT_RECORDER).toContain("PENDING_EXTERNAL_VERIFICATION");
  });

  it("allowlists BOTH production venues, resolving the §7 route-table drift", () => {
    expect(DEPLOY_SCRIPT).toContain("AERODROME_SLIPSTREAM");
    expect(DEPLOY_SCRIPT).toContain("UNISWAP_V3_ROUTER02");
    expect(DEPLOY_SCRIPT).toContain("0x2626664c2603336E57B271c5C0b26F421741e481");
    expect(DEPLOY_SCRIPT).toContain("0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F");
    // The v1 executor must never be allowlisted as a router.
    expect(DEPLOY_SCRIPT).toContain("the v1 executor must never be an allowlisted router");
  });

  it("never prints, serializes or writes a private key", () => {
    // The deployer key is read into a local and used only for vm.addr / broadcast.
    expect(DEPLOY_SCRIPT.includes("console2.log(c.pk")).toBe(false);
    expect(DEPLOY_SCRIPT.includes('serializeUint(k, "pk"')).toBe(false);
    expect(DEPLOY_SCRIPT.match(/vm\.toString\(c\.pk\)/g)).toBeNull();
    // The optional broadcaster key is only ever reduced to an address.
    expect(DEPLOY_SCRIPT).toContain("vm.addr(bpk)");
    expect(DEPLOY_SCRIPT).toContain("the key is never");
  });
});
