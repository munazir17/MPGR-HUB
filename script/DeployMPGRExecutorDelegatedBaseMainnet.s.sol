// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MPGRExecutorDelegated} from "../contracts/executor/MPGRExecutorDelegated.sol";

interface ISlipstreamRouterViewDelegated {
    function factory() external view returns (address);
    function WETH9() external view returns (address);
}

interface IUniswapV3RouterViewDelegated {
    function WETH9() external view returns (address);
}

interface IERC20ViewDelegated {
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

/// @title DeployMPGRExecutorDelegatedBaseMainnet
/// @notice BASE MAINNET ONLY (chainId 8453). Deploys MPGRExecutorDelegated — the
///         NON-CUSTODIAL delegated autonomous executor. A separate read-only recorder writes
///         the machine-readable artifact only after Forge has mined and returned the receipt.
///
///         WHY THIS CONTRACT AND NOT THE DEPLOYED v1 EXECUTOR:
///         MPGRExecutor (0xD982726e28275661F8aB64054E6b17a70a63505A) pulls tokens ONLY from
///         msg.sender and reverts InvalidRecipient unless p.recipient == msg.sender. It is
///         structurally incapable of executing on behalf of a user: an operator broadcaster
///         calling it would trade its own balance to itself. MPGRExecutorDelegated takes the
///         taker from the RECOVERED Permit2 witness signer and treats msg.sender as a gas-only
///         broadcaster, so the operator never has custody.
///
///         ARCHITECTURE: immutable, NON-upgradeable core with governed configuration and
///         explicitly allowlisted, code-hash-pinned typed swap modules (Design A — see
///         docs/EXECUTOR-ARCHITECTURE-DECISION.md). No proxy, delegatecall or generic target/data
///         call exists. Tokens and existing router kinds are owner-configurable; new venues use
///         a separate executor/router-bound immutable module without replacing the core.
///         The module registry is intentionally empty in this initial deployment.
///
///         THIS SCRIPT PERFORMS NO SWAPS. A deploy script must never touch real user funds.
///         The 1-USDC mainnet canary is a separate, user-signed, operator-run flow: the user
///         signs the bounded Permit2 witness authorization in their own wallet and the server
///         NEVER signs for them.
///
///         SAFETY GATES (all must pass or the script reverts before broadcasting):
///           1. block.chainid == 8453
///           2. TWO independent enable flags: env MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED=true
///              AND committed delegated-deploy-config.json .mainnetDelegatedDeployEnabled
///           3. one-time: the output artifact must not already exist
///           4. one-time: deployer nonce must be 0 (a fresh dedicated key cannot deploy twice)
///           5. deployer != owner, != feeRecipient, != the production broadcaster,
///              != the canary wallet, != any Base Sepolia address
///           6. Permit2, WETH, both routers and all 50 tokens must exist and behave on 8453
///           7. deterministic address: executor == CREATE(deployer, 0)
///           8. post-deploy, EVERY value the runtime later verifies on-chain must already
///              match: owner, pendingOwner==0, feeBps, feeRecipient, MAX_FEE_BPS, PERMIT2,
///              WETH, exact WITNESS_TYPE_STRING, !paused, and the full router/token allowlist
///
/// Env (operator secrets/variables — NEVER pasted in chat, NEVER committed, NEVER printed):
///   BASE_MAINNET_DEPLOYER_PRIVATE_KEY   (secret) fresh dedicated key, nonce 0, pays gas
///   MPGR_EXECUTOR_OWNER                 (var)    must equal config .owner
///   MPGR_EXECUTOR_FEE_RECIPIENT         (var)    must equal config .feeRecipient
///   MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED (var)  must be exactly "true" for production run()
///   MPGR_MAINNET_BROADCASTER_PRIVATE_KEY (secret, OPTIONAL) if present, its derived address
///                                          must differ from the deployer. Only its ADDRESS is
///                                          ever derived; the key itself is never logged.
///
/// Key-free simulation inputs (never mapped to a private key):
///   MPGR_MAINNET_DELEGATED_DEPLOY_SIMULATION (var) exactly "true" to select simulate()
///   BASE_MAINNET_DEPLOYER_ADDRESS            (var) public address from the read-only preflight
///   Both production enable flags must stay exactly false, including the committed config pin.
///   simulateArmed() is the reviewed-arm counterpart: identical view-only validation against
///   the armed committed config (mainnetDelegatedDeployEnabled=true); environment flags stay false.
///
/// Usage (after explicit human approval):
///   forge script script/DeployMPGRExecutorDelegatedBaseMainnet.s.sol \
///     --rpc-url "$BASE_MAINNET_RPC_URL" --broadcast --slow --verify
///   # after confirming the mined receipt, run the read-only recorder described in
///   # script/RecordMPGRExecutorDelegatedBaseMainnet.s.sol to write the deployment artifact
///
/// Read-only plan (no deployer private key, no constructor, no --broadcast):
///   forge script script/DeployMPGRExecutorDelegatedBaseMainnet.s.sol \
///     --rpc-url "$BASE_MAINNET_RPC_URL" --sig 'simulate()'
///   # reviewed armed posture (committed flag true, environment flags false):
///   forge script script/DeployMPGRExecutorDelegatedBaseMainnet.s.sol \
///     --rpc-url "$BASE_MAINNET_RPC_URL" --sig 'simulateArmed()'
contract DeployMPGRExecutorDelegatedBaseMainnet is Script {
    uint256 internal constant BASE_MAINNET_CHAIN_ID = 8453;
    uint16 internal constant FEE_BPS = 25;
    uint16 internal constant EXPECTED_MAX_FEE_BPS = 100;
    uint256 internal constant MIN_DEPLOYER_BALANCE = 0.002 ether;

    /// Fixed holder for read-only balanceOf probes (forge forbids address(this) in scripts).
    address internal constant PROBE_HOLDER = 0x000000000000000000000000000000000000dEaD;

    string internal constant CONFIG_FILE = "deployments/base-mainnet/delegated-deploy-config.json";
    string internal constant OUT_FILE = "deployments/base-mainnet/mpgr-executor-delegated.json";

    // ---- Base Mainnet canonical / production addresses ----
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// Aerodrome Slipstream (Gauges V3): the venue for every USDC <-> B20 stock, tickSpacing 10.
    address internal constant SLIP_ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    address internal constant SLIP_FACTORY = 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef;
    address internal constant SLIP_QUOTER_V2 = 0x514c8B5f54112481E28028F1166Bd78501089259;
    uint256 internal constant SLIP_B20_TICK_SPACING = 10;
    /// Uniswap V3 SwapRouter02: the venue for USDC <-> WETH (pool fee 3000).
    /// NOTE: deliberately allowlisted HERE but NOT on the deployed v1 executor. See
    /// docs/EXECUTOR-ARCHITECTURE-DECISION.md §7 — lib/executor/executor-config.ts declares
    /// this as a production mainnet route, so the delegated executor must accept it or an
    /// autonomous USDC->WETH goal would revert RouterNotAllowed AFTER the user signed.
    address internal constant UNI_V3_ROUTER02 = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant UNI_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address internal constant UNI_V3_QUOTER_V2 = 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a;
    address internal constant UNI_USDC_WETH_POOL = 0x6c561B446416E1A00E8E93E221854d6eA4171372;
    uint256 internal constant UNI_USDC_WETH_POOL_FEE = 3000;

    /// The v1 assisted executor: structurally unsuitable for delegation, must never be reused.
    address internal constant V1_MAINNET_EXECUTOR = 0xD982726e28275661F8aB64054E6b17a70a63505A;

    /// The Phase 5 one-shot canary wallet. Must never be deployer, owner, fee recipient or
    /// broadcaster for production autonomous execution.
    address internal constant CANARY_WALLET = 0xBF6c574b9543967f0D528ae49603b0A7574a280b;

    /// Base Sepolia contracts — must never appear in a mainnet allowlist or role.
    address internal constant SEPOLIA_DELEGATED_EXECUTOR = 0xa9568499D7e58854F2590a56B6D32788DbfA58F9;
    address internal constant SEPOLIA_EXECUTOR = 0xDFcB00fB1Fe83A6333302E55E23feCF6884376C4;
    address internal constant SEPOLIA_UNI_ROUTER02 = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4;
    address internal constant SEPOLIA_UNI_FACTORY = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address internal constant SEPOLIA_UNI_QUOTER_V2 = 0xC5290058841028F1614F3A6F0F5816cAd0df5E27;
    address internal constant SEPOLIA_UNI_NPM = 0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2;
    address internal constant SEPOLIA_TUSD = 0xc5C9F70A7F3EB18FC33406275Bffe31a922fcde5;
    address internal constant SEPOLIA_TSTOCK = 0x9102c5B535d25A9265e2793174701BdaCeEAAfC4;
    address internal constant SEPOLIA_DEPLOYER = 0xb67FCDF437B5FeF64E4b32952dc6d172dc9ec56e;

    /// Must match MPGRExecutorDelegated.WITNESS_TYPE_STRING byte-for-byte. Asserted post-deploy
    /// so a contract change cannot silently invalidate every wallet signature.
    string internal constant EXPECTED_WITNESS_TYPE_STRING =
        "ActionWitness witness)ActionWitness(address owner,address buyToken,uint256 minAmountOut,uint256 deadline,bytes32 actionId,bytes32 policyHash)TokenPermissions(address token,uint256 amount)";

    struct Config {
        uint256 pk;
        address deployer;
        address owner;
        address feeRecipient;
        address broadcaster;
        bool envEnabled;
    }

    struct Pins {
        uint256 chainId;
        bool enabled;
        address owner;
        address feeRecipient;
        uint256 feeBps;
        uint256 maxFeeBps;
        address permit2;
        address weth;
    }

    /// The exact constructor arguments shared by the production run and the no-broadcast plan.
    struct ConstructorArgs {
        address owner;
        address feeRecipient;
        uint16 feeBps;
        address weth;
        address permit2;
        MPGRExecutorDelegated.RouterConfig[] routers;
        address[] tokens;
    }

    // ------------------------------------------------------------------
    // Production token / router set
    // ------------------------------------------------------------------

    /// The UNIVERSAL initial allowlist: USDC, WETH, every ISSUED Coinbase B20 tokenized stock
    /// (the 38 live stocks of lib/trade/tokenized-stocks.ts plus COINc/CRCLc/INTCc, which stay
    /// launch-pending per base/docs#1955 and are refused by every app trade surface until live),
    /// and the official Coinbase wrapped assets (cbBTC, cbETH, cbDOGE, cbXRP, cbLTC, cbADA from
    /// lib/markets/base-pairs.ts plus cbZEC pinned in lib/markets/__tests__/base-pairs.test.ts).
    /// A SUPERSET of the 15 tokens allowlisted on the deployed v1 executor. The 19 announced-
    /// not-live B20 addresses are deliberately excluded until Base lists them live; the owner
    /// adds any future token at RUNTIME via setTokenAllowed(token, true) — one governance
    /// transaction, no redeployment, no address change (docs/EXECUTOR-ARCHITECTURE-DECISION.md
    /// §§1,4). Addresses come ONLY from the committed canonical catalogs — never invented.
    function productionTokens() public pure returns (address[] memory t, string[] memory s) {
        t = new address[](50);
        s = new string[](50);
        (t[0], s[0]) = (USDC, "USDC");
        (t[1], s[1]) = (WETH, "WETH");
        (t[2], s[2]) = (0xb200000000000000000000C2e324d24d7eEcd1fb, "AAPLc");
        (t[3], s[3]) = (0xb200000000000000000000d9192b6B456483C2E8, "AMZNc");
        (t[4], s[4]) = (0xb200000000000000000000c85a31389D71F3ecfb, "COINc");
        (t[5], s[5]) = (0xB20000000000000000000019f6E7C675b73C2e4D, "CRCLc");
        (t[6], s[6]) = (0xb2000000000000000000002D0BA3164cc74f58B7, "GOOGLc");
        (t[7], s[7]) = (0xB2000000000000000000004AFF16039bA04bdFBc, "INTCc");
        (t[8], s[8]) = (0xb2000000000000000000008bC8786B856E61707C, "METAc");
        (t[9], s[9]) = (0xB200000000000000000000Ab99cFa739E253872B, "MSFTc");
        (t[10], s[10]) = (0xb2000000000000000000004884b426556b92883d, "MSTRc");
        (t[11], s[11]) = (0xb20000000000000000000078ee7ce2fE4908108C, "NVDAc");
        (t[12], s[12]) = (0xb200000000000000000000397293Cb8cda9a10c5, "SNDKc");
        (t[13], s[13]) = (0xb2000000000000000000007b9fcbd005511aCBd5, "SPCXc");
        (t[14], s[14]) = (0xb2000000000000000000001e800a7f5189430cD0, "TSLAc");
        (t[15], s[15]) = (0xB2000000000000000000000d8Ce462E99ee7A47B, "AMDc");
        (t[16], s[16]) = (0xB200000000000000000000B1a29cF17A1819288a, "ASTSc");
        (t[17], s[17]) = (0xB200000000000000000000Fc737aeA6196aB5a4c, "AVGOc");
        (t[18], s[18]) = (0xb20000000000000000000016f9dfe862feBA122b, "BEc");
        (t[19], s[19]) = (0xb200000000000000000000f215E4C890CFb7176B, "CAKEc");
        (t[20], s[20]) = (0xb200000000000000000000428E3a3eebBb20692B, "DJTc");
        (t[21], s[21]) = (0xb200000000000000000000A613D12dEAfBBb1Db7, "DUOLc");
        (t[22], s[22]) = (0xb2000000000000000000007790ed6E48e06eD935, "GMEc");
        (t[23], s[23]) = (0xB20000000000000000000043a599976181Bcf336, "HIMSc");
        (t[24], s[24]) = (0xb2000000000000000000002601C5C94F435da168, "HTZc");
        (t[25], s[25]) = (0xB200000000000000000000f1a0F91e34892E4718, "LLYc");
        (t[26], s[26]) = (0xB200000000000000000000e215e9B76ecBA02468, "MRNAc");
        (t[27], s[27]) = (0xB200000000000000000000eC3c4c7395Cc609813, "MRVLc");
        (t[28], s[28]) = (0xb200000000000000000000Fd2f87532B90095211, "MUc");
        (t[29], s[29]) = (0xb20000000000000000000058B8c947e44011dFE6, "NFLXc");
        (t[30], s[30]) = (0xB200000000000000000000C597c476FCf9Aed3a8, "NVAXc");
        (t[31], s[31]) = (0xb200000000000000000000347AFbA223D7B6b63C, "ORCLc");
        (t[32], s[32]) = (0xB20000000000000000000018FE7eC7d6DfeeB528, "PFEc");
        (t[33], s[33]) = (0xb2000000000000000000007d16372840dF4dAbbe, "PLTRc");
        (t[34], s[34]) = (0xB2000000000000000000008FC2A8C23cf5937b66, "PMc");
        (t[35], s[35]) = (0xB2000000000000000000009272A491812842Aa84, "PTONc");
        (t[36], s[36]) = (0xb200000000000000000000450ad3abE5d4846c6E, "PYPLc");
        (t[37], s[37]) = (0xb200000000000000000000CA425ab42e07C35bC3, "QUBTc");
        (t[38], s[38]) = (0xB2000000000000000000005bd7AE89b9E6189Bb5, "RBLXc");
        (t[39], s[39]) = (0xb20000000000000000000066242d4067724cB7A1, "RDDTc");
        (t[40], s[40]) = (0xB2000000000000000000002137743D4a01Fe4e88, "SOUNc");
        (t[41], s[41]) = (0xB200000000000000000000f720C26062Bc3067Da, "TTWOc");
        (t[42], s[42]) = (0xB20000000000000000000044E3CD7a0E1028E57a, "WENc");
        (t[43], s[43]) = (0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf, "cbBTC");
        (t[44], s[44]) = (0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22, "cbETH");
        (t[45], s[45]) = (0xcbD06E5A2B0C65597161de254AA074E489dEb510, "cbDOGE");
        (t[46], s[46]) = (0xcb585250f852C6c6bf90434AB21A00f02833a4af, "cbXRP");
        (t[47], s[47]) = (0xcb17C9Db87B595717C857a08468793f5bAb6445F, "cbLTC");
        (t[48], s[48]) = (0xcbADA732173e39521CDBE8bf59a6Dc85A9fc7b8c, "cbADA");
        (t[49], s[49]) = (0xB2000000000000000000008501b13360000cb2EC, "cbZEC");
    }

    /// Committed decimals pin per productionTokens() index: USDC 6, WETH 18, every issued B20
    /// stock 8 (read live from each contract and consistent across the family), cbBTC 8,
    /// cbETH 18, cbDOGE 8, cbXRP 6, cbLTC 8, cbADA 6 (verified on Basescan per
    /// lib/markets/base-pairs.ts), cbZEC 8 (B20-standard wrapped crypto). The read-only
    /// preflight and the live deploy preflight each re-verify decimals() on 8453 before any
    /// deployment; a mismatch fails closed and nothing is broadcast.
    function productionTokenDecimals() public pure returns (uint8[] memory d) {
        d = new uint8[](50);
        d[0] = 6;
        d[1] = 18;
        d[2] = 8;
        d[3] = 8;
        d[4] = 8;
        d[5] = 8;
        d[6] = 8;
        d[7] = 8;
        d[8] = 8;
        d[9] = 8;
        d[10] = 8;
        d[11] = 8;
        d[12] = 8;
        d[13] = 8;
        d[14] = 8;
        d[15] = 8;
        d[16] = 8;
        d[17] = 8;
        d[18] = 8;
        d[19] = 8;
        d[20] = 8;
        d[21] = 8;
        d[22] = 8;
        d[23] = 8;
        d[24] = 8;
        d[25] = 8;
        d[26] = 8;
        d[27] = 8;
        d[28] = 8;
        d[29] = 8;
        d[30] = 8;
        d[31] = 8;
        d[32] = 8;
        d[33] = 8;
        d[34] = 8;
        d[35] = 8;
        d[36] = 8;
        d[37] = 8;
        d[38] = 8;
        d[39] = 8;
        d[40] = 8;
        d[41] = 8;
        d[42] = 8;
        d[43] = 8;
        d[44] = 18;
        d[45] = 8;
        d[46] = 6;
        d[47] = 8;
        d[48] = 6;
        d[49] = 8;
    }

    /// BOTH production venues. `kind` values mirror the contract's RouterKind enum
    /// (NONE=0, AERODROME_SLIPSTREAM=1, UNISWAP_V3_ROUTER02=2).
    function productionRouters() public pure returns (MPGRExecutorDelegated.RouterConfig[] memory r) {
        r = new MPGRExecutorDelegated.RouterConfig[](2);
        r[0] = MPGRExecutorDelegated.RouterConfig(SLIP_ROUTER, MPGRExecutorDelegated.RouterKind.AERODROME_SLIPSTREAM);
        r[1] = MPGRExecutorDelegated.RouterConfig(UNI_V3_ROUTER02, MPGRExecutorDelegated.RouterKind.UNISWAP_V3_ROUTER02);
    }

    /// Single source of truth for both the deployment transaction and its read-only plan.
    function _constructorArgs(Config memory c) internal pure returns (ConstructorArgs memory args) {
        args.owner = c.owner;
        args.feeRecipient = c.feeRecipient;
        args.feeBps = FEE_BPS;
        args.weth = WETH;
        args.permit2 = PERMIT2;
        args.routers = productionRouters();
        (args.tokens,) = productionTokens();
    }

    /// Addresses that must never hold a role or appear in a mainnet allowlist.
    function deniedAddresses() public pure returns (address[] memory d) {
        d = new address[](10);
        d[0] = CANARY_WALLET;
        d[1] = V1_MAINNET_EXECUTOR;
        d[2] = SEPOLIA_DELEGATED_EXECUTOR;
        d[3] = SEPOLIA_EXECUTOR;
        d[4] = SEPOLIA_UNI_ROUTER02;
        d[5] = SEPOLIA_UNI_FACTORY;
        d[6] = SEPOLIA_UNI_QUOTER_V2;
        d[7] = SEPOLIA_UNI_NPM;
        d[8] = SEPOLIA_TUSD;
        d[9] = SEPOLIA_TSTOCK;
    }

    // ------------------------------------------------------------------
    // Config hooks (overridden only by a fork rehearsal test)
    // ------------------------------------------------------------------

    function _readConfig() internal view virtual returns (Config memory c) {
        c.pk = vm.envUint("BASE_MAINNET_DEPLOYER_PRIVATE_KEY");
        c.deployer = vm.addr(c.pk);
        c.owner = vm.envAddress("MPGR_EXECUTOR_OWNER");
        c.feeRecipient = vm.envAddress("MPGR_EXECUTOR_FEE_RECIPIENT");
        c.envEnabled =
            keccak256(bytes(vm.envOr("MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED", string("")))) == keccak256("true");
        // OPTIONAL: if the operator has already provisioned the production broadcaster key,
        // prove the deployer is not that wallet. Only the ADDRESS is derived; the key is never
        // logged, serialized or written anywhere.
        uint256 bpk = vm.envOr("MPGR_MAINNET_BROADCASTER_PRIVATE_KEY", uint256(0));
        c.broadcaster = bpk == 0 ? address(0) : vm.addr(bpk);
    }

    /// Simulation intentionally reads only a public address. It must never call _readConfig(),
    /// which reads BASE_MAINNET_DEPLOYER_PRIVATE_KEY and the optional broadcaster key.
    function _readSimulationConfig() internal view virtual returns (Config memory c) {
        c.deployer = vm.envAddress("BASE_MAINNET_DEPLOYER_ADDRESS");
        c.owner = vm.envAddress("MPGR_EXECUTOR_OWNER");
        c.feeRecipient = vm.envAddress("MPGR_EXECUTOR_FEE_RECIPIENT");
        c.broadcaster = address(0);
        c.envEnabled = false;
    }

    function _simulationModeEnabled() internal view returns (bool) {
        return
            keccak256(bytes(vm.envOr("MPGR_MAINNET_DELEGATED_DEPLOY_SIMULATION", string(""))))
                == keccak256(bytes("true"));
    }

    function _isLiteralFalse(string memory value) internal pure returns (bool) {
        return keccak256(bytes(value)) == keccak256(bytes("false"));
    }

    function _requireSimulationModeAndDisabledFlags() internal view {
        require(
            _simulationModeEnabled(), "MPGR: set MPGR_MAINNET_DELEGATED_DEPLOY_SIMULATION=true to use simulation mode"
        );

        string memory variableFlag = vm.envOr("MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED", string(""));
        string memory secretFlag = vm.envOr("MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED_SECRET", string(""));
        bool secretConfigured = bytes(secretFlag).length > 0;
        require(_isLiteralFalse(variableFlag), "MPGR: simulation requires environment deployment flag exactly false");
        require(
            !secretConfigured || _isLiteralFalse(secretFlag),
            "MPGR: simulation requires secret deployment flag exactly false"
        );
    }

    function _startBroadcast(uint256 privateKey) internal {
        require(!_simulationModeEnabled(), "MPGR: simulation mode cannot broadcast");
        vm.startBroadcast(privateKey);
    }

    function _readPins() internal view virtual returns (Pins memory p) {
        string memory json = vm.readFile(CONFIG_FILE);
        p.chainId = vm.parseJsonUint(json, ".chainId");
        p.enabled = vm.parseJsonBool(json, ".mainnetDelegatedDeployEnabled");
        p.owner = vm.parseJsonAddress(json, ".owner");
        p.feeRecipient = vm.parseJsonAddress(json, ".feeRecipient");
        p.feeBps = vm.parseJsonUint(json, ".feeBps");
        p.maxFeeBps = vm.parseJsonUint(json, ".maxFeeBps");
        p.permit2 = vm.parseJsonAddress(json, ".permit2");
        p.weth = vm.parseJsonAddress(json, ".weth");
    }

    function _recordExists() internal view virtual returns (bool) {
        return vm.exists(OUT_FILE);
    }

    function _outFile() internal view virtual returns (string memory) {
        return OUT_FILE;
    }

    function _deny(address a, string memory what) internal pure {
        address[] memory d = deniedAddresses();
        for (uint256 i = 0; i < d.length; ++i) {
            require(a != d[i], string.concat("MPGR: denied address used as ", what));
        }
        require(a != SEPOLIA_DEPLOYER, string.concat("MPGR: Base Sepolia deployer used as ", what));
    }

    // ------------------------------------------------------------------
    // Preflight — everything is proven BEFORE any broadcast
    // ------------------------------------------------------------------

    function preflight(Config memory c, Pins memory p) public view virtual {
        _requireBaseMainnetChain();

        // Production deployment remains independently gated by both existing true flags.
        require(
            c.envEnabled, "MPGR: MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED != true - mainnet delegated deploy not enabled"
        );
        require(p.enabled, "MPGR: delegated-deploy-config.json mainnetDelegatedDeployEnabled != true");

        _preflightCommon(c, p);
    }

    /// @notice Simulation counterpart to production preflight. It reuses every non-flag guard
    ///         but requires both deployment flags to remain false and never reads a private key.
    function simulationPreflight(Config memory c, Pins memory p) public view virtual {
        _requireBaseMainnetChain();
        require(!c.envEnabled, "MPGR: simulation requires environment deployment flag false");
        require(!p.enabled, "MPGR: simulation requires committed deployment flag false");
        _preflightCommon(c, p);
    }

    /// @notice Armed-posture counterpart to simulationPreflight for the REVIEWED armed
    ///         committed config. It reuses every non-flag guard, still requires both
    ///         environment flags to remain false, and never reads a private key.
    function simulationPreflightArmed(Config memory c, Pins memory p) public view virtual {
        _requireBaseMainnetChain();
        require(!c.envEnabled, "MPGR: simulation requires environment deployment flag false");
        require(p.enabled, "MPGR: armed simulation requires committed deployment flag true");
        _preflightCommon(c, p);
    }

    function _requireBaseMainnetChain() internal view {
        require(block.chainid == BASE_MAINNET_CHAIN_ID, "MPGR: BASE MAINNET (8453) ONLY - refusing to run");
    }

    /// All guards other than the mode-specific two-flag check are shared verbatim between
    /// production preflight and the no-broadcast simulation path.
    function _preflightCommon(Config memory c, Pins memory p) internal view {
        // (3)/(4) one-time
        require(!_recordExists(), "MPGR: mpgr-executor-delegated.json exists - already deployed");
        require(
            vm.getNonce(c.deployer) == 0,
            "MPGR: deployer nonce != 0 - use a fresh dedicated key (prevents a 2nd deploy)"
        );

        // (5) role separation — the deployer is a one-shot key and must hold no ongoing role
        require(c.owner != address(0) && c.feeRecipient != address(0), "MPGR: owner/fee recipient unset");
        require(c.owner != c.feeRecipient, "MPGR: owner and fee recipient must be separate");
        require(c.owner == p.owner, "MPGR: MPGR_EXECUTOR_OWNER != delegated-deploy-config.json owner");
        require(c.feeRecipient == p.feeRecipient, "MPGR: MPGR_EXECUTOR_FEE_RECIPIENT != config feeRecipient");
        require(p.chainId == BASE_MAINNET_CHAIN_ID, "MPGR: config chainId != 8453");
        require(p.feeBps == FEE_BPS, "MPGR: config feeBps != 25");
        require(p.maxFeeBps == EXPECTED_MAX_FEE_BPS, "MPGR: config maxFeeBps != 100");
        require(p.permit2 == PERMIT2, "MPGR: config permit2 != canonical Permit2");
        require(p.weth == WETH, "MPGR: config weth != Base WETH");
        _validateCommittedDeploymentConfigArrays();
        require(c.deployer != c.owner, "MPGR: deployer must not be the owner");
        require(c.deployer != c.feeRecipient, "MPGR: deployer must not be the fee recipient");
        require(
            c.broadcaster == address(0) || c.deployer != c.broadcaster,
            "MPGR: deployer must not be the production broadcaster"
        );
        _deny(c.deployer, "deployer");
        _deny(c.owner, "owner");
        _deny(c.feeRecipient, "feeRecipient");
        // If the production broadcaster key has already been provisioned, prove it is a
        // separate, non-canary gas-only wallet — never the governance key, fee wallet, v1
        // executor, or any Sepolia/test address. Only the derived ADDRESS is inspected.
        if (c.broadcaster != address(0)) {
            require(c.broadcaster != c.owner, "MPGR: broadcaster must not be the governance owner");
            require(c.broadcaster != c.feeRecipient, "MPGR: broadcaster must not be the fee recipient");
            _deny(c.broadcaster, "production broadcaster");
        }
        require(c.deployer.balance >= MIN_DEPLOYER_BALANCE, "MPGR: deployer needs >= 0.002 ETH on Base Mainnet");

        // (6) live infrastructure
        require(WETH.code.length > 0 && PERMIT2.code.length > 0, "MPGR: WETH/Permit2 missing on 8453");
        require(SLIP_ROUTER.code.length > 0, "MPGR: Slipstream router has no code on 8453");
        require(UNI_V3_ROUTER02.code.length > 0, "MPGR: Uniswap V3 SwapRouter02 has no code on 8453");
        require(
            ISlipstreamRouterViewDelegated(SLIP_ROUTER).factory() == SLIP_FACTORY,
            "MPGR: Slipstream router not bound to the app factory"
        );
        require(
            ISlipstreamRouterViewDelegated(SLIP_ROUTER).WETH9() == WETH, "MPGR: Slipstream router WETH9 != Base WETH"
        );
        require(
            IUniswapV3RouterViewDelegated(UNI_V3_ROUTER02).WETH9() == WETH, "MPGR: Uniswap V3 router WETH9 != Base WETH"
        );
        require(IERC20ViewDelegated(USDC).decimals() == 6, "MPGR: USDC decimals != 6");

        // every token must be a live ERC-20 on 8453 and must never be a denied address
        (address[] memory tokens, string[] memory symbols) = productionTokens();
        for (uint256 i = 0; i < tokens.length; ++i) {
            require(tokens[i].code.length > 0, string.concat("MPGR: ", symbols[i], " has no code on 8453"));
            _deny(tokens[i], symbols[i]);
            bool okDec;
            bool okSup;
            bool okBal;
            try IERC20ViewDelegated(tokens[i]).decimals() returns (uint8) {
                okDec = true;
            } catch {}
            try IERC20ViewDelegated(tokens[i]).totalSupply() returns (uint256) {
                okSup = true;
            } catch {}
            try IERC20ViewDelegated(tokens[i]).balanceOf(PROBE_HOLDER) returns (uint256) {
                okBal = true;
            } catch {}
            require(
                okDec && okSup && okBal,
                string.concat(
                    "MPGR: ", symbols[i], " is not a live ERC-20 on 8453 (decimals/totalSupply/balanceOf failed)"
                )
            );
        }
    }

    /// Verify the complete committed JSON route/token/denylist pins, not just the scalar fields
    /// used by the Solidity constructor. This is shared by production and simulation preflight.
    function _validateCommittedDeploymentConfigArrays() internal view {
        string memory json = vm.readFile(CONFIG_FILE);
        require(
            keccak256(bytes(vm.parseJsonString(json, ".network"))) == keccak256(bytes("base")),
            "MPGR: config network != base"
        );
        require(
            keccak256(bytes(vm.parseJsonString(json, ".contract"))) == keccak256(bytes("MPGRExecutorDelegated")),
            "MPGR: config contract != MPGRExecutorDelegated"
        );
        require(
            keccak256(bytes(vm.parseJsonString(json, ".outFile"))) == keccak256(bytes(OUT_FILE)),
            "MPGR: config artifact path mismatch"
        );
        require(
            vm.parseJsonUint(json, ".moduleRegistrySchemaVersion") == 1, "MPGR: config module registry schema mismatch"
        );
        require(vm.parseJsonStringArray(json, ".typedModules").length == 0, "MPGR: config typedModules must be empty");

        (address[] memory expectedTokens, string[] memory expectedSymbols) = productionTokens();
        uint8[] memory expectedTokenDecimals = productionTokenDecimals();
        require(expectedTokens.length == 50, "MPGR: internal production token pin count mismatch");
        require(
            expectedTokenDecimals.length == expectedTokens.length,
            "MPGR: internal production token decimals pin count mismatch"
        );
        for (uint256 i; i < expectedTokens.length; ++i) {
            string memory tokenPath = string.concat(".tokens[", vm.toString(i), "]");
            require(
                vm.parseJsonAddress(json, string.concat(tokenPath, ".address")) == expectedTokens[i],
                string.concat("MPGR: committed token address mismatch: ", expectedSymbols[i])
            );
            require(
                keccak256(bytes(vm.parseJsonString(json, string.concat(tokenPath, ".symbol"))))
                    == keccak256(bytes(expectedSymbols[i])),
                string.concat("MPGR: committed token symbol mismatch: ", expectedSymbols[i])
            );
            uint256 expectedDecimals = expectedTokenDecimals[i];
            require(
                vm.parseJsonUint(json, string.concat(tokenPath, ".decimals")) == expectedDecimals,
                string.concat("MPGR: committed token decimals mismatch: ", expectedSymbols[i])
            );
        }

        MPGRExecutorDelegated.RouterConfig[] memory expectedRouters = productionRouters();
        require(expectedRouters.length == 2, "MPGR: internal production router pin count mismatch");
        for (uint256 i; i < expectedRouters.length; ++i) {
            string memory routerPath = string.concat(".routers[", vm.toString(i), "]");
            require(
                vm.parseJsonAddress(json, string.concat(routerPath, ".router")) == expectedRouters[i].router,
                "MPGR: committed router address mismatch"
            );
            require(
                vm.parseJsonUint(json, string.concat(routerPath, ".kind")) == uint256(expectedRouters[i].kind),
                "MPGR: committed RouterKind mismatch"
            );
            require(
                vm.parseJsonAddress(json, string.concat(routerPath, ".factory"))
                    == (i == 0 ? SLIP_FACTORY : UNI_V3_FACTORY),
                "MPGR: committed venue factory mismatch"
            );
            require(
                vm.parseJsonAddress(json, string.concat(routerPath, ".quoterV2"))
                    == (i == 0 ? SLIP_QUOTER_V2 : UNI_V3_QUOTER_V2),
                "MPGR: committed venue quoter mismatch"
            );
            if (i == 0) {
                require(
                    keccak256(bytes(vm.parseJsonString(json, string.concat(routerPath, ".kindName"))))
                        == keccak256(bytes("AERODROME_SLIPSTREAM")),
                    "MPGR: committed Slipstream kind name mismatch"
                );
                require(
                    vm.parseJsonUint(json, string.concat(routerPath, ".b20TickSpacing")) == SLIP_B20_TICK_SPACING,
                    "MPGR: committed Slipstream tick spacing mismatch"
                );
            } else {
                require(
                    keccak256(bytes(vm.parseJsonString(json, string.concat(routerPath, ".kindName"))))
                        == keccak256(bytes("UNISWAP_V3_ROUTER02")),
                    "MPGR: committed Uniswap V3 kind name mismatch"
                );
                require(
                    vm.parseJsonUint(json, string.concat(routerPath, ".usdcWethPoolFee")) == UNI_USDC_WETH_POOL_FEE,
                    "MPGR: committed USDC/WETH pool fee mismatch"
                );
                require(
                    vm.parseJsonAddress(json, string.concat(routerPath, ".usdcWethPool")) == UNI_USDC_WETH_POOL,
                    "MPGR: committed USDC/WETH pool mismatch"
                );
            }
        }

        require(
            vm.parseJsonAddress(json, ".denied.canaryWallet") == CANARY_WALLET,
            "MPGR: committed canary denylist mismatch"
        );
        require(
            vm.parseJsonAddress(json, ".denied.v1MainnetExecutor") == V1_MAINNET_EXECUTOR,
            "MPGR: committed v1 executor denylist mismatch"
        );
        address[] memory expectedSepolia = new address[](9);
        expectedSepolia[0] = SEPOLIA_DELEGATED_EXECUTOR;
        expectedSepolia[1] = SEPOLIA_EXECUTOR;
        expectedSepolia[2] = SEPOLIA_UNI_ROUTER02;
        expectedSepolia[3] = SEPOLIA_UNI_FACTORY;
        expectedSepolia[4] = SEPOLIA_UNI_QUOTER_V2;
        expectedSepolia[5] = SEPOLIA_UNI_NPM;
        expectedSepolia[6] = SEPOLIA_TUSD;
        expectedSepolia[7] = SEPOLIA_TSTOCK;
        expectedSepolia[8] = SEPOLIA_DEPLOYER;
        address[] memory pinnedSepolia = vm.parseJsonAddressArray(json, ".denied.sepolia");
        require(pinnedSepolia.length == expectedSepolia.length, "MPGR: committed Sepolia denylist count mismatch");
        for (uint256 i; i < expectedSepolia.length; ++i) {
            require(pinnedSepolia[i] == expectedSepolia[i], "MPGR: committed Sepolia denylist mismatch");
        }
    }

    /// @notice Validate the real Mainnet deployment plan without private-key access,
    ///         contract construction, a CREATE transaction, or any state mutation.
    /// @dev Invoke only with `forge script ... --sig 'simulate()'` and the explicit
    ///      MPGR_MAINNET_DELEGATED_DEPLOY_SIMULATION=true mode flag. The two production
    ///      deployment flags must remain false. This function is view-only and never reaches
    ///      `_startBroadcast` or `new MPGRExecutorDelegated`.
    function simulate() public view returns (address predictedExecutor) {
        _requireSimulationModeAndDisabledFlags();
        Config memory c = _readSimulationConfig();
        Pins memory p = _readPins();
        simulationPreflight(c, p);

        uint256 deployerNonce = vm.getNonce(c.deployer);
        require(deployerNonce == 0, "MPGR: deployer nonce != 0 - use a fresh dedicated key (prevents a 2nd deploy)");
        ConstructorArgs memory args = _constructorArgs(c);
        predictedExecutor = vm.computeCreateAddress(c.deployer, deployerNonce);
        _validateSimulationPlan(c, p, args, predictedExecutor);
        _logSimulationPlan(c, args, deployerNonce, predictedExecutor, p.enabled);
    }

    /// @notice Armed-posture counterpart to simulate(): identical view-only validation of the
    ///         real Mainnet deployment plan against the REVIEWED armed committed config.
    /// @dev Invoke only with `forge script ... --sig 'simulateArmed()'` and the explicit
    ///      MPGR_MAINNET_DELEGATED_DEPLOY_SIMULATION=true mode flag. The environment
    ///      deployment flags must remain false. This function is view-only: it never
    ///      broadcasts, never constructs the executor, never reads a private key, and never
    ///      mutates Mainnet state.
    function simulateArmed() public view returns (address predictedExecutor) {
        _requireSimulationModeAndDisabledFlags();
        Config memory c = _readSimulationConfig();
        Pins memory p = _readPins();
        simulationPreflightArmed(c, p);

        uint256 deployerNonce = vm.getNonce(c.deployer);
        require(deployerNonce == 0, "MPGR: deployer nonce != 0 - use a fresh dedicated key (prevents a 2nd deploy)");
        ConstructorArgs memory args = _constructorArgs(c);
        predictedExecutor = vm.computeCreateAddress(c.deployer, deployerNonce);
        _validateSimulationPlan(c, p, args, predictedExecutor);
        _logSimulationPlan(c, args, deployerNonce, predictedExecutor, p.enabled);
    }

    function _validateSimulationPlan(
        Config memory c,
        Pins memory p,
        ConstructorArgs memory args,
        address predictedExecutor
    ) internal view {
        require(args.owner == c.owner && args.owner == p.owner, "MPGR: simulated constructor owner mismatch");
        require(
            args.feeRecipient == c.feeRecipient && args.feeRecipient == p.feeRecipient,
            "MPGR: simulated constructor fee recipient mismatch"
        );
        require(args.feeBps == FEE_BPS && p.feeBps == FEE_BPS, "MPGR: simulated constructor feeBps mismatch");
        require(p.maxFeeBps == EXPECTED_MAX_FEE_BPS, "MPGR: simulated MAX_FEE_BPS mismatch");
        require(args.weth == WETH && p.weth == WETH, "MPGR: simulated constructor WETH mismatch");
        require(args.permit2 == PERMIT2 && p.permit2 == PERMIT2, "MPGR: simulated constructor Permit2 mismatch");
        require(args.routers.length == 2, "MPGR: simulated router count mismatch");
        require(args.routers[0].router == SLIP_ROUTER, "MPGR: simulated Slipstream router mismatch");
        require(
            args.routers[0].kind == MPGRExecutorDelegated.RouterKind.AERODROME_SLIPSTREAM,
            "MPGR: simulated Slipstream RouterKind mismatch"
        );
        require(args.routers[1].router == UNI_V3_ROUTER02, "MPGR: simulated Uniswap V3 router mismatch");
        require(
            args.routers[1].kind == MPGRExecutorDelegated.RouterKind.UNISWAP_V3_ROUTER02,
            "MPGR: simulated Uniswap V3 RouterKind mismatch"
        );
        require(args.tokens.length == 50, "MPGR: simulated production token count mismatch");
        _deny(predictedExecutor, "predicted executor");
        require(predictedExecutor != args.owner, "MPGR: predicted executor collides with owner");
        require(predictedExecutor != args.feeRecipient, "MPGR: predicted executor collides with fee recipient");
        for (uint256 i = 0; i < args.routers.length; ++i) {
            _deny(args.routers[i].router, "router");
        }
        for (uint256 i = 0; i < args.tokens.length; ++i) {
            _deny(args.tokens[i], "production token");
        }

        // CREATE must target an unused address. If it already has state, the production
        // postflight's zero-balance and one-time-address assumptions would not hold.
        require(predictedExecutor.code.length == 0, "MPGR: predicted executor address already has code");
        require(vm.getNonce(predictedExecutor) == 0, "MPGR: predicted executor address nonce is not zero");
        require(predictedExecutor.balance == 0, "MPGR: predicted executor address already has a balance");
        for (uint256 i; i < args.tokens.length; ++i) {
            require(
                IERC20ViewDelegated(args.tokens[i]).balanceOf(predictedExecutor) == 0,
                "MPGR: predicted executor address already holds a production token balance"
            );
        }

        // These are the constructor-derived initial storage values checked by postflight().
        // No instance is created in this mode: the Foundry regression test separately creates
        // the exact constructor locally and runs the same postflight assertions against it.
        require(args.owner != address(0), "MPGR: simulated initial owner is zero");
        require(args.feeRecipient != address(0), "MPGR: simulated initial fee recipient is zero");
        require(args.feeBps <= EXPECTED_MAX_FEE_BPS, "MPGR: simulated fee exceeds MAX_FEE_BPS");
        require(
            keccak256(bytes(EXPECTED_WITNESS_TYPE_STRING))
                == keccak256(
                    bytes(
                        "ActionWitness witness)ActionWitness(address owner,address buyToken,uint256 minAmountOut,uint256 deadline,bytes32 actionId,bytes32 policyHash)TokenPermissions(address token,uint256 amount)"
                    )
                ),
            "MPGR: expected witness type string pin drifted"
        );
    }

    function _logSimulationPlan(
        Config memory c,
        ConstructorArgs memory args,
        uint256 deployerNonce,
        address predictedExecutor,
        bool committedDeployFlag
    ) internal pure {
        console2.log("[SIMULATION] mode: explicit no-broadcast validation");
        console2.log("[SIMULATION] production environment flag: false");
        console2.log("[SIMULATION] committed deployment flag:", committedDeployFlag);
        console2.log("[SIMULATION] deployer address:", c.deployer);
        console2.log("[SIMULATION] deployer nonce:", deployerNonce);
        console2.log("[SIMULATION] predicted CREATE address:", predictedExecutor);
        console2.log("[SIMULATION] constructor owner:", args.owner);
        console2.log("[SIMULATION] constructor fee recipient:", args.feeRecipient);
        console2.log("[SIMULATION] constructor feeBps:", uint256(args.feeBps));
        console2.log("[SIMULATION] constructor WETH:", args.weth);
        console2.log("[SIMULATION] constructor Permit2:", args.permit2);
        console2.log("[SIMULATION] production router count:", args.routers.length);
        for (uint256 i = 0; i < args.routers.length; ++i) {
            console2.log("[SIMULATION] venue:", i == 0 ? "Aerodrome Slipstream" : "Uniswap V3 SwapRouter02");
            console2.log("[SIMULATION] router address:", args.routers[i].router);
            console2.log("[SIMULATION] RouterKind:", uint256(args.routers[i].kind));
            console2.log("[SIMULATION] router factory:", i == 0 ? SLIP_FACTORY : UNI_V3_FACTORY);
            console2.log("[SIMULATION] router quoter:", i == 0 ? SLIP_QUOTER_V2 : UNI_V3_QUOTER_V2);
            if (i == 0) {
                console2.log("[SIMULATION] B20 tick spacing:", SLIP_B20_TICK_SPACING);
            } else {
                console2.log("[SIMULATION] USDC/WETH pool fee:", UNI_USDC_WETH_POOL_FEE);
                console2.log("[SIMULATION] USDC/WETH pool:", UNI_USDC_WETH_POOL);
            }
        }
        console2.log("[SIMULATION] production token count:", args.tokens.length);
        (address[] memory pinnedTokens, string[] memory symbols) = productionTokens();
        for (uint256 i = 0; i < args.tokens.length; ++i) {
            require(args.tokens[i] == pinnedTokens[i], "MPGR: simulated token constructor list drifted");
            console2.log("[SIMULATION] token symbol:", symbols[i]);
            console2.log("[SIMULATION] token address:", args.tokens[i]);
        }
        console2.log("[SIMULATION] expected posture: pendingOwner=0, paused=false, feeBps=25, cap=100");
        console2.log(
            "[SIMULATION] expected posture: pinned witness type, two built-in routers, empty typed-module registry"
        );
        console2.log("[SIMULATION PASS] no constructor transaction created, no broadcast, no Mainnet state change");
    }

    // ------------------------------------------------------------------
    // Postflight — prove the deployed posture matches EVERY value the
    // runtime will later verify on-chain before it trusts this address.
    // ------------------------------------------------------------------

    function postflight(MPGRExecutorDelegated dex, Config memory c) public view virtual {
        require(address(dex) == vm.computeCreateAddress(c.deployer, 0), "MPGR: executor address != CREATE(deployer, 0)");
        require(dex.owner() == c.owner, "MPGR: owner mismatch");
        require(dex.pendingOwner() == address(0), "MPGR: unexpected pending owner");
        require(dex.feeBps() == FEE_BPS, "MPGR: feeBps mismatch");
        require(dex.MAX_FEE_BPS() == EXPECTED_MAX_FEE_BPS, "MPGR: MAX_FEE_BPS != 100");
        require(dex.feeRecipient() == c.feeRecipient, "MPGR: fee recipient mismatch");
        require(address(dex.PERMIT2()) == PERMIT2, "MPGR: Permit2 mismatch");
        require(address(dex.WETH()) == WETH, "MPGR: WETH mismatch");
        require(!dex.paused(), "MPGR: deployed paused");
        // The witness type string is what every wallet signs over. If it ever drifts, every
        // signature silently becomes invalid — so pin it byte-for-byte here.
        require(
            keccak256(bytes(dex.WITNESS_TYPE_STRING())) == keccak256(bytes(EXPECTED_WITNESS_TYPE_STRING)),
            "MPGR: WITNESS_TYPE_STRING mismatch"
        );

        // Router allowlist: exactly the two production venues, with the right typed adapter.
        MPGRExecutorDelegated.RouterConfig[] memory routers = productionRouters();
        for (uint256 i = 0; i < routers.length; ++i) {
            require(
                dex.routerKind(routers[i].router) == routers[i].kind,
                "MPGR: router not allowlisted with the expected kind"
            );
            require(
                dex.swapModuleForRouter(routers[i].router) == address(0),
                "MPGR: built-in route unexpectedly uses a module"
            );
            require(
                dex.swapModuleCodeHash(routers[i].router) == bytes32(0),
                "MPGR: built-in route has an unexpected module code hash"
            );
        }
        // And nothing else is allowlisted that should not be.
        address[] memory denied = deniedAddresses();
        for (uint256 i = 0; i < denied.length; ++i) {
            require(
                dex.routerKind(denied[i]) == MPGRExecutorDelegated.RouterKind.NONE,
                "MPGR: a denied address is allowlisted as a router"
            );
            require(dex.swapModuleForRouter(denied[i]) == address(0), "MPGR: denied address has a registered module");
            require(!dex.isTokenAllowed(denied[i]), "MPGR: a denied address is allowlisted as a token");
        }
        require(
            dex.routerKind(V1_MAINNET_EXECUTOR) == MPGRExecutorDelegated.RouterKind.NONE,
            "MPGR: the v1 executor must never be an allowlisted router"
        );

        // Token allowlist: every production token allowed, and the executor holds nothing.
        (address[] memory tokens,) = productionTokens();
        for (uint256 i = 0; i < tokens.length; ++i) {
            require(dex.isTokenAllowed(tokens[i]), "MPGR: production token not allowlisted");
            require(IERC20(tokens[i]).balanceOf(address(dex)) == 0, "MPGR: executor holds a balance at deploy time");
        }
        require(address(dex).balance == 0, "MPGR: executor holds native ETH at deploy time");
    }

    // ------------------------------------------------------------------

    function run() external returns (MPGRExecutorDelegated dex) {
        // Simulation is a separate view-only entrypoint. Refuse before reading any key if a
        // caller accidentally selects the production `run()` path in simulation mode.
        require(!_simulationModeEnabled(), "MPGR: simulation mode must use simulate(); production run refused");
        require(block.chainid == BASE_MAINNET_CHAIN_ID, "MPGR: BASE MAINNET (8453) ONLY - refusing to run");
        Config memory c = _readConfig();
        Pins memory p = _readPins();
        preflight(c, p);
        console2.log("preflight: all checks passed");
        console2.log("deployer (dedicated, nonce 0):", c.deployer);
        console2.log("owner (governance):", c.owner);
        console2.log("feeRecipient:", c.feeRecipient);
        console2.log("predicted executor:", vm.computeCreateAddress(c.deployer, 0));

        ConstructorArgs memory args = _constructorArgs(c);
        _startBroadcast(c.pk);
        dex = new MPGRExecutorDelegated(
            args.owner, args.feeRecipient, args.feeBps, args.weth, args.permit2, args.routers, args.tokens
        );
        vm.stopBroadcast();

        postflight(dex, c);
        console2.log("MPGRExecutorDelegated:", address(dex));
        console2.log("postflight: simulated deployment posture verified");
        console2.log("No deployment artifact written here: Forge mines and returns the receipt after run() completes.");
        console2.log("After receipt confirmation, run RecordMPGRExecutorDelegatedBaseMainnet.s.sol.");
        console2.log(
            "Then verify source and pin MPGR_MAINNET_DELEGATED_EXECUTOR; do not enable trading before verification."
        );
    }
}
