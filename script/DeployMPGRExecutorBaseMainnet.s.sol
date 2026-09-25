// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MPGRExecutor} from "../contracts/executor/MPGRExecutor.sol";

interface ISlipstreamRouterView {
    function factory() external view returns (address);
    function WETH9() external view returns (address);
}

interface ISlipstreamQuoterView {
    function factory() external view returns (address);
}

interface IERC20View {
    function decimals() external view returns (uint8);
    function balanceOf(address) external view returns (uint256);
}

/// @title  DeployMPGRExecutorBaseMainnet
/// @notice ONE-TIME Base Mainnet (8453) deployment of MPGRExecutor. It deploys the executor
///         and nothing else: no tokens, no pools, no swaps, no app config change.
///
///         Router / token configuration is copied verbatim from the app's existing
///         PRODUCTION trade config and must stay in sync with it:
///           - lib/trade/trade-config.ts        BASE_USDC, BASE_WETH, PERMIT2_ADDRESS,
///                                              AERODROME_SLIPSTREAM_{SWAP_ROUTER,FACTORY,QUOTER_V2}
///           - lib/trade/tokenized-stocks.ts    the 13 Coinbase B20 tokenized stocks
///         Uniswap V3 is NOT part of the production trade config, so it is NOT allowlisted.
///
///         Preflight (all must pass before anything is broadcast):
///           - block.chainid == 8453
///           - explicit, one-deployment enablement: env MPGR_MAINNET_DEPLOY_ENABLED == "true"
///             AND deployments/base-mainnet/deploy-config.json mainnetDeployEnabled == true
///             AND no deployments/base-mainnet/mpgr-executor.json record exists yet
///             AND the dedicated deployer key has never sent a Base Mainnet tx (nonce 0), so
///             a re-run can never deploy a second executor
///           - owner / fee recipient from the environment equal the committed pins
///           - fee 25 bps, contract hard cap 100 bps
///           - the deployer is dedicated: not the owner, not the fee recipient, not the
///             Base Sepolia deployer
///           - no Base Sepolia / test-token address anywhere in the config
///           - every router/token/WETH/Permit2 address has code on 8453, USDC has 6 decimals,
///             the Slipstream router + quoter are bound to the app's factory and WETH
///
///         Environment (populated by .github/workflows/deploy-executor-base-mainnet.yml):
///           BASE_MAINNET_DEPLOYER_PRIVATE_KEY  (secret, base-mainnet environment) never logged
///           MPGR_EXECUTOR_OWNER                (var) must equal deploy-config.json .owner
///           MPGR_EXECUTOR_FEE_RECIPIENT        (var) must equal deploy-config.json .feeRecipient
///           MPGR_MAINNET_DEPLOY_ENABLED        (var) must be "true"
contract DeployMPGRExecutorBaseMainnet is Script {
    uint256 internal constant BASE_MAINNET_CHAIN_ID = 8453;
    uint16 internal constant FEE_BPS = 25;
    uint16 internal constant EXPECTED_MAX_FEE_BPS = 100;
    uint256 internal constant MIN_DEPLOYER_BALANCE = 0.001 ether;

    string internal constant CONFIG_FILE = "deployments/base-mainnet/deploy-config.json";
    string internal constant OUT_FILE = "deployments/base-mainnet/mpgr-executor.json";

    // ---- Base Mainnet production trade config (lib/trade/trade-config.ts) ----
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant SLIP_ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    address internal constant SLIP_FACTORY = 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef;
    address internal constant SLIP_QUOTER = 0x514c8B5f54112481E28028F1166Bd78501089259;
    int24 internal constant B20_TICK_SPACING = 10;

    // ---- Not in the production trade config: must NOT be allowlisted on mainnet ----
    address internal constant MAINNET_UNI_ROUTER02 = 0x2626664c2603336E57B271c5C0b26F421741e481;

    // ---- Base Sepolia / test addresses that must never appear in the mainnet config ----
    // (WETH 0x4200…0006 and Permit2 are canonical predeploys with the same address on
    //  every OP-stack chain; they are validated by code + router binding instead.)
    address internal constant SEPOLIA_EXECUTOR = 0xDFcB00fB1Fe83A6333302E55E23feCF6884376C4;
    address internal constant SEPOLIA_TUSD = 0xc5C9F70A7F3EB18FC33406275Bffe31a922fcde5;
    address internal constant SEPOLIA_TSTOCK = 0x9102c5B535d25A9265e2793174701BdaCeEAAfC4;
    address internal constant SEPOLIA_UNI_ROUTER02 = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4;
    address internal constant SEPOLIA_UNI_FACTORY = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address internal constant SEPOLIA_UNI_QUOTER_V2 = 0xC5290058841028F1614F3A6F0F5816cAd0df5E27;
    address internal constant SEPOLIA_UNI_NPM = 0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2;
    address internal constant SEPOLIA_DEPLOYER = 0xb67FCDF437B5FeF64E4b32952dc6d172dc9ec56e;

    struct Config {
        uint256 pk;
        address deployer;
        address owner;
        address feeRecipient;
        bool envEnabled;
    }

    struct Pins {
        uint256 chainId;
        bool enabled;
        address owner;
        address feeRecipient;
        uint256 feeBps;
        uint256 maxFeeBps;
    }

    // ------------------------------------------------------------------
    // Production token / router set
    // ------------------------------------------------------------------

    function productionTokens() public pure returns (address[] memory t, string[] memory s) {
        t = new address[](15);
        s = new string[](15);
        (t[0], s[0]) = (USDC, "USDC");
        (t[1], s[1]) = (WETH, "WETH");
        // Coinbase B20 tokenized stocks (lib/trade/tokenized-stocks.ts), USDC pairs, tickSpacing 10.
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
    }

    function productionRouters() public pure returns (MPGRExecutor.RouterConfig[] memory r) {
        r = new MPGRExecutor.RouterConfig[](1);
        r[0] = MPGRExecutor.RouterConfig(SLIP_ROUTER, MPGRExecutor.RouterKind.AERODROME_SLIPSTREAM);
    }

    function sepoliaDenylist() public pure returns (address[] memory d) {
        d = new address[](8);
        d[0] = SEPOLIA_EXECUTOR;
        d[1] = SEPOLIA_TUSD;
        d[2] = SEPOLIA_TSTOCK;
        d[3] = SEPOLIA_UNI_ROUTER02;
        d[4] = SEPOLIA_UNI_FACTORY;
        d[5] = SEPOLIA_UNI_QUOTER_V2;
        d[6] = SEPOLIA_UNI_NPM;
        d[7] = SEPOLIA_DEPLOYER;
    }

    // ------------------------------------------------------------------
    // Config hooks (overridden only by the fork test)
    // ------------------------------------------------------------------

    function _readConfig() internal view virtual returns (Config memory c) {
        c.pk = vm.envUint("BASE_MAINNET_DEPLOYER_PRIVATE_KEY");
        c.deployer = vm.addr(c.pk);
        c.owner = vm.envAddress("MPGR_EXECUTOR_OWNER");
        c.feeRecipient = vm.envAddress("MPGR_EXECUTOR_FEE_RECIPIENT");
        c.envEnabled = keccak256(bytes(vm.envOr("MPGR_MAINNET_DEPLOY_ENABLED", string("")))) == keccak256("true");
    }

    function _readPins() internal view virtual returns (Pins memory p) {
        string memory json = vm.readFile(CONFIG_FILE);
        p.chainId = vm.parseJsonUint(json, ".chainId");
        p.enabled = vm.parseJsonBool(json, ".mainnetDeployEnabled");
        p.owner = vm.parseJsonAddress(json, ".owner");
        p.feeRecipient = vm.parseJsonAddress(json, ".feeRecipient");
        p.feeBps = vm.parseJsonUint(json, ".feeBps");
        p.maxFeeBps = vm.parseJsonUint(json, ".maxFeeBps");
    }

    function _recordExists() internal view virtual returns (bool) {
        return vm.exists(OUT_FILE);
    }

    function _outFile() internal view virtual returns (string memory) {
        return OUT_FILE;
    }

    // ------------------------------------------------------------------
    // Preflight
    // ------------------------------------------------------------------

    function _notSepolia(address a, string memory what) internal pure {
        address[] memory d = sepoliaDenylist();
        for (uint256 i = 0; i < d.length; ++i) {
            require(a != d[i], string.concat("MPGR: Base Sepolia/test address used as ", what));
        }
    }

    function preflight(Config memory c, Pins memory p) public view {
        require(block.chainid == BASE_MAINNET_CHAIN_ID, "MPGR: BASE MAINNET (8453) ONLY - refusing to run");

        // Explicit, single-deployment enablement.
        require(c.envEnabled, "MPGR: MPGR_MAINNET_DEPLOY_ENABLED != true - mainnet deploy not enabled");
        require(p.enabled, "MPGR: deploy-config.json mainnetDeployEnabled != true");
        require(p.chainId == BASE_MAINNET_CHAIN_ID, "MPGR: deploy-config.json chainId != 8453");
        require(!_recordExists(), "MPGR: deployments/base-mainnet/mpgr-executor.json exists - already deployed");
        require(vm.getNonce(c.deployer) == 0, "MPGR: deployer nonce != 0 - use a fresh dedicated key (prevents a 2nd deploy)");

        // Owner + fee recipient: environment must equal the committed, reviewed pins.
        require(c.owner != address(0) && c.feeRecipient != address(0), "MPGR: owner/fee recipient unset");
        require(c.owner == p.owner, "MPGR: MPGR_EXECUTOR_OWNER != deploy-config.json owner");
        require(c.feeRecipient == p.feeRecipient, "MPGR: MPGR_EXECUTOR_FEE_RECIPIENT != deploy-config.json feeRecipient");

        // Fee configuration.
        require(p.feeBps == FEE_BPS, "MPGR: deploy-config.json feeBps != 25");
        require(p.maxFeeBps == EXPECTED_MAX_FEE_BPS, "MPGR: deploy-config.json maxFeeBps != 100");

        // Dedicated deployer.
        require(c.deployer != c.owner, "MPGR: deployer must not be the owner");
        require(c.deployer != c.feeRecipient, "MPGR: deployer must not be the fee recipient");
        require(c.deployer != SEPOLIA_DEPLOYER, "MPGR: deployer is the Base Sepolia deployer - use a dedicated mainnet key");
        require(c.deployer.balance >= MIN_DEPLOYER_BALANCE, "MPGR: deployer needs >= 0.001 ETH on Base Mainnet");

        // No Base Sepolia / test address anywhere.
        _notSepolia(c.owner, "owner");
        _notSepolia(c.feeRecipient, "fee recipient");
        (address[] memory tokens,) = productionTokens();
        for (uint256 i = 0; i < tokens.length; ++i) {
            _notSepolia(tokens[i], "token");
            require(tokens[i].code.length > 0, "MPGR: allowlisted token has no code on 8453");
        }
        MPGRExecutor.RouterConfig[] memory routers = productionRouters();
        for (uint256 i = 0; i < routers.length; ++i) {
            _notSepolia(routers[i].router, "router");
            require(routers[i].router.code.length > 0, "MPGR: router has no code on 8453");
        }
        require(WETH.code.length > 0 && PERMIT2.code.length > 0, "MPGR: WETH/Permit2 missing on 8453");

        // Production infrastructure is what the app actually uses.
        require(ISlipstreamRouterView(SLIP_ROUTER).factory() == SLIP_FACTORY, "MPGR: Slipstream router not bound to the app factory");
        require(ISlipstreamRouterView(SLIP_ROUTER).WETH9() == WETH, "MPGR: Slipstream router WETH9 != Base WETH");
        require(ISlipstreamQuoterView(SLIP_QUOTER).factory() == SLIP_FACTORY, "MPGR: Slipstream quoter not bound to the app factory");
        require(IERC20View(USDC).decimals() == 6, "MPGR: USDC decimals != 6");
    }

    // ------------------------------------------------------------------
    // Post-deploy checks
    // ------------------------------------------------------------------

    function postflight(MPGRExecutor ex, Config memory c) public view {
        require(address(ex) == vm.computeCreateAddress(c.deployer, 0), "MPGR: executor address != CREATE(deployer, 0)");
        require(address(ex).code.length > 0, "MPGR: no executor code");
        require(ex.owner() == c.owner, "MPGR: owner mismatch");
        require(ex.pendingOwner() == address(0), "MPGR: unexpected pending owner");
        require(ex.feeRecipient() == c.feeRecipient, "MPGR: fee recipient mismatch");
        require(ex.feeBps() == FEE_BPS, "MPGR: feeBps != 25");
        require(ex.MAX_FEE_BPS() == EXPECTED_MAX_FEE_BPS, "MPGR: MAX_FEE_BPS != 100");
        require(!ex.paused(), "MPGR: paused");
        require(address(ex.WETH()) == WETH, "MPGR: WETH mismatch");
        require(address(ex.PERMIT2()) == PERMIT2, "MPGR: PERMIT2 mismatch");
        require(ex.routerKind(SLIP_ROUTER) == MPGRExecutor.RouterKind.AERODROME_SLIPSTREAM, "MPGR: Slipstream router not allowlisted");
        require(ex.routerKind(MAINNET_UNI_ROUTER02) == MPGRExecutor.RouterKind.NONE, "MPGR: Uniswap V3 unexpectedly allowlisted");
        (address[] memory tokens,) = productionTokens();
        for (uint256 i = 0; i < tokens.length; ++i) {
            require(ex.isTokenAllowed(tokens[i]), "MPGR: production token not allowlisted");
            require(IERC20View(tokens[i]).balanceOf(address(ex)) == 0, "MPGR: executor holds tokens");
        }
        address[] memory d = sepoliaDenylist();
        for (uint256 i = 0; i < d.length; ++i) {
            require(!ex.isTokenAllowed(d[i]), "MPGR: Sepolia address allowlisted as token");
            require(ex.routerKind(d[i]) == MPGRExecutor.RouterKind.NONE, "MPGR: Sepolia address allowlisted as router");
        }
        require(address(ex).balance == 0, "MPGR: executor holds ETH");
        require(ex.owner() != c.deployer, "MPGR: deployer kept ownership");
    }

    // ------------------------------------------------------------------
    // Entry point
    // ------------------------------------------------------------------

    function run() external returns (MPGRExecutor ex) {
        require(block.chainid == BASE_MAINNET_CHAIN_ID, "MPGR: BASE MAINNET (8453) ONLY - refusing to run");
        Config memory c = _readConfig();
        Pins memory p = _readPins();
        preflight(c, p);
        console2.log("preflight: all checks passed");
        console2.log("deployer (dedicated):", c.deployer);
        console2.log("owner:", c.owner);
        console2.log("feeRecipient:", c.feeRecipient);
        console2.log("predicted executor:", vm.computeCreateAddress(c.deployer, 0));

        (address[] memory tokens,) = productionTokens();
        vm.startBroadcast(c.pk);
        ex = new MPGRExecutor(c.owner, c.feeRecipient, FEE_BPS, WETH, PERMIT2, productionRouters(), tokens);
        vm.stopBroadcast();

        postflight(ex, c);
        console2.log("MPGRExecutor:", address(ex));
        _write(ex, c);
    }

    function _write(MPGRExecutor ex, Config memory c) internal {
        (address[] memory tokens, string[] memory symbols) = productionTokens();
        string memory tk = "tokens";
        string memory tokensJson;
        for (uint256 i = 0; i < tokens.length; ++i) {
            tokensJson = vm.serializeAddress(tk, symbols[i], tokens[i]);
        }
        string memory rk = "router";
        vm.serializeAddress(rk, "router", SLIP_ROUTER);
        vm.serializeString(rk, "kind", "AERODROME_SLIPSTREAM");
        vm.serializeAddress(rk, "factory", SLIP_FACTORY);
        vm.serializeAddress(rk, "quoterV2", SLIP_QUOTER);
        string memory routerJson = vm.serializeInt(rk, "b20TickSpacing", B20_TICK_SPACING);

        string memory k = "deployment";
        vm.serializeString(k, "network", "base");
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "executor", address(ex));
        vm.serializeAddress(k, "deployer", c.deployer);
        vm.serializeAddress(k, "owner", ex.owner());
        vm.serializeAddress(k, "feeRecipient", ex.feeRecipient());
        vm.serializeUint(k, "feeBps", ex.feeBps());
        vm.serializeUint(k, "maxFeeBps", ex.MAX_FEE_BPS());
        vm.serializeBool(k, "paused", ex.paused());
        vm.serializeAddress(k, "weth", address(ex.WETH()));
        vm.serializeAddress(k, "permit2", address(ex.PERMIT2()));
        vm.serializeString(k, "router", routerJson);
        address[] memory routerAllowlist = new address[](1);
        routerAllowlist[0] = SLIP_ROUTER;
        vm.serializeAddress(k, "routerAllowlist", routerAllowlist);
        vm.serializeBool(k, "appRoutingEnabled", false);
        string memory out = vm.serializeString(k, "allowedTokens", tokensJson);
        vm.writeJson(out, _outFile());
    }
}
