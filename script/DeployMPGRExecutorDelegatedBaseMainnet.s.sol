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
///         NON-CUSTODIAL delegated autonomous executor — and writes a
///         machine-readable deployment record.
///
///         WHY THIS CONTRACT AND NOT THE DEPLOYED v1 EXECUTOR:
///         MPGRExecutor (0xD982726e28275661F8aB64054E6b17a70a63505A) pulls tokens ONLY from
///         msg.sender and reverts InvalidRecipient unless p.recipient == msg.sender. It is
///         structurally incapable of executing on behalf of a user: an operator broadcaster
///         calling it would trade its own balance to itself. MPGRExecutorDelegated takes the
///         taker from the RECOVERED Permit2 witness signer and treats msg.sender as a gas-only
///         broadcaster, so the operator never has custody.
///
///         ARCHITECTURE: immutable, NON-upgradeable, governed configuration (Design A — see
///         docs/EXECUTOR-ARCHITECTURE-DECISION.md). No proxy, no delegatecall, no upgrade
///         authority exists, so no key in the system can change what a deployed executor does.
///         Routers, tokens, feeBps (capped) and feeRecipient are all owner-governed at
///         runtime, so ordinary configuration changes never require redeployment.
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
///           6. Permit2, WETH, both routers and all 15 tokens must exist and behave on 8453
///           7. deterministic address: executor == CREATE(deployer, 0)
///           8. post-deploy, EVERY value the runtime later verifies on-chain must already
///              match: owner, pendingOwner==0, feeBps, feeRecipient, MAX_FEE_BPS, PERMIT2,
///              WETH, exact WITNESS_TYPE_STRING, !paused, and the full router/token allowlist
///
/// Env (operator secrets/variables — NEVER pasted in chat, NEVER committed, NEVER printed):
///   BASE_MAINNET_DEPLOYER_PRIVATE_KEY   (secret) fresh dedicated key, nonce 0, pays gas
///   MPGR_EXECUTOR_OWNER                 (var)    must equal config .owner
///   MPGR_EXECUTOR_FEE_RECIPIENT         (var)    must equal config .feeRecipient
///   MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED (var)  must be exactly "true"
///   MPGR_MAINNET_BROADCASTER_PRIVATE_KEY (secret, OPTIONAL) if present, its derived address
///                                          must differ from the deployer. Only its ADDRESS is
///                                          ever derived; the key itself is never logged.
///
/// Usage (after explicit human approval):
///   forge script script/DeployMPGRExecutorDelegatedBaseMainnet.s.sol \
///     --rpc-url "$BASE_MAINNET_RPC_URL" --broadcast --slow --verify
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
    /// Uniswap V3 SwapRouter02: the venue for USDC <-> WETH (pool fee 3000).
    /// NOTE: deliberately allowlisted HERE but NOT on the deployed v1 executor. See
    /// docs/EXECUTOR-ARCHITECTURE-DECISION.md §7 — lib/executor/executor-config.ts declares
    /// this as a production mainnet route, so the delegated executor must accept it or an
    /// autonomous USDC->WETH goal would revert RouterNotAllowed AFTER the user signed.
    address internal constant UNI_V3_ROUTER02 = 0x2626664c2603336E57B271c5C0b26F421741e481;

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

    // ------------------------------------------------------------------
    // Production token / router set
    // ------------------------------------------------------------------

    /// USDC, WETH and every Coinbase B20 tokenized stock — identical to the set allowlisted on
    /// the deployed v1 mainnet executor (lib/executor/executor-config.ts).
    function productionTokens() public pure returns (address[] memory t, string[] memory s) {
        t = new address[](15);
        s = new string[](15);
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
    }

    /// BOTH production venues. `kind` values mirror the contract's RouterKind enum
    /// (NONE=0, AERODROME_SLIPSTREAM=1, UNISWAP_V3_ROUTER02=2).
    function productionRouters() public pure returns (MPGRExecutorDelegated.RouterConfig[] memory r) {
        r = new MPGRExecutorDelegated.RouterConfig[](2);
        r[0] = MPGRExecutorDelegated.RouterConfig(SLIP_ROUTER, MPGRExecutorDelegated.RouterKind.AERODROME_SLIPSTREAM);
        r[1] = MPGRExecutorDelegated.RouterConfig(UNI_V3_ROUTER02, MPGRExecutorDelegated.RouterKind.UNISWAP_V3_ROUTER02);
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
        // (1) chain
        require(block.chainid == BASE_MAINNET_CHAIN_ID, "MPGR: BASE MAINNET (8453) ONLY - refusing to run");

        // (2) TWO independent enable flags
        require(c.envEnabled, "MPGR: MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED != true - mainnet delegated deploy not enabled");
        require(p.enabled, "MPGR: delegated-deploy-config.json mainnetDelegatedDeployEnabled != true");

        // (3)/(4) one-time
        require(!_recordExists(), "MPGR: mpgr-executor-delegated.json exists - already deployed");
        require(
            vm.getNonce(c.deployer) == 0,
            "MPGR: deployer nonce != 0 - use a fresh dedicated key (prevents a 2nd deploy)"
        );

        // (5) role separation — the deployer is a one-shot key and must hold no ongoing role
        require(c.owner != address(0) && c.feeRecipient != address(0), "MPGR: owner/fee recipient unset");
        require(c.owner == p.owner, "MPGR: MPGR_EXECUTOR_OWNER != delegated-deploy-config.json owner");
        require(c.feeRecipient == p.feeRecipient, "MPGR: MPGR_EXECUTOR_FEE_RECIPIENT != config feeRecipient");
        require(p.chainId == BASE_MAINNET_CHAIN_ID, "MPGR: config chainId != 8453");
        require(p.feeBps == FEE_BPS, "MPGR: config feeBps != 25");
        require(p.maxFeeBps == EXPECTED_MAX_FEE_BPS, "MPGR: config maxFeeBps != 100");
        require(p.permit2 == PERMIT2, "MPGR: config permit2 != canonical Permit2");
        require(p.weth == WETH, "MPGR: config weth != Base WETH");
        require(c.deployer != c.owner, "MPGR: deployer must not be the owner");
        require(c.deployer != c.feeRecipient, "MPGR: deployer must not be the fee recipient");
        require(c.broadcaster == address(0) || c.deployer != c.broadcaster, "MPGR: deployer must not be the production broadcaster");
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
            ISlipstreamRouterViewDelegated(SLIP_ROUTER).WETH9() == WETH,
            "MPGR: Slipstream router WETH9 != Base WETH"
        );
        require(
            IUniswapV3RouterViewDelegated(UNI_V3_ROUTER02).WETH9() == WETH,
            "MPGR: Uniswap V3 router WETH9 != Base WETH"
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
                string.concat("MPGR: ", symbols[i], " is not a live ERC-20 on 8453 (decimals/totalSupply/balanceOf failed)")
            );
        }
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
        }
        // And nothing else is allowlisted that should not be.
        address[] memory denied = deniedAddresses();
        for (uint256 i = 0; i < denied.length; ++i) {
            require(
                dex.routerKind(denied[i]) == MPGRExecutorDelegated.RouterKind.NONE,
                "MPGR: a denied address is allowlisted as a router"
            );
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
        require(block.chainid == BASE_MAINNET_CHAIN_ID, "MPGR: BASE MAINNET (8453) ONLY - refusing to run");
        Config memory c = _readConfig();
        Pins memory p = _readPins();
        preflight(c, p);
        console2.log("preflight: all checks passed");
        console2.log("deployer (dedicated, nonce 0):", c.deployer);
        console2.log("owner (governance):", c.owner);
        console2.log("feeRecipient:", c.feeRecipient);
        console2.log("predicted executor:", vm.computeCreateAddress(c.deployer, 0));

        (address[] memory tokens,) = productionTokens();
        vm.startBroadcast(c.pk);
        dex = new MPGRExecutorDelegated(c.owner, c.feeRecipient, FEE_BPS, WETH, PERMIT2, productionRouters(), tokens);
        vm.stopBroadcast();

        postflight(dex, c);
        console2.log("MPGRExecutorDelegated:", address(dex));
        console2.log("postflight: posture verified");
        console2.log("NEXT: pin MPGR_MAINNET_DELEGATED_EXECUTOR to the address above");
        _write(dex, c);
    }

    function _write(MPGRExecutorDelegated dex, Config memory c) internal {
        (address[] memory tokens, string[] memory symbols) = productionTokens();
        string memory tk = "tokens";
        string memory tokensJson;
        for (uint256 i = 0; i < tokens.length; ++i) {
            tokensJson = vm.serializeAddress(tk, symbols[i], tokens[i]);
        }

        string memory rk = "routers";
        string memory routersJson;
        MPGRExecutorDelegated.RouterConfig[] memory routers = productionRouters();
        for (uint256 i = 0; i < routers.length; ++i) {
            string memory key = vm.toString(i);
            vm.serializeAddress(string.concat("router", key), "router", routers[i].router);
            vm.serializeUint(string.concat("router", key), "kind", uint256(routers[i].kind));
            routersJson = vm.serializeString(
                rk, key, vm.serializeString(string.concat("router", key), "kindName", _kindName(routers[i].kind))
            );
        }

        address[] memory routerAllowlist = new address[](routers.length);
        for (uint256 i = 0; i < routers.length; ++i) routerAllowlist[i] = routers[i].router;

        string memory k = "deployment";
        vm.serializeString(k, "contract", "MPGRExecutorDelegated");
        vm.serializeString(k, "network", "base");
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "executor", address(dex));
        // No proxy under Design A: these are recorded as null-equivalents so a consumer can
        // never mistake this for a proxy deployment.
        vm.serializeString(k, "proxy", "none");
        vm.serializeString(k, "implementation", "none");
        vm.serializeString(k, "upgradeAuthority", "none");
        vm.serializeAddress(k, "deployer", c.deployer);
        vm.serializeAddress(k, "owner", dex.owner());
        vm.serializeAddress(k, "feeRecipient", dex.feeRecipient());
        vm.serializeUint(k, "feeBps", dex.feeBps());
        vm.serializeUint(k, "maxFeeBps", dex.MAX_FEE_BPS());
        vm.serializeBool(k, "paused", dex.paused());
        vm.serializeAddress(k, "weth", address(dex.WETH()));
        vm.serializeAddress(k, "permit2", address(dex.PERMIT2()));
        vm.serializeString(k, "witnessTypeString", dex.WITNESS_TYPE_STRING());
        vm.serializeAddress(k, "routerAllowlist", routerAllowlist);
        vm.serializeString(k, "routers", routersJson);
        vm.serializeUint(k, "deployedAtBlock", block.number);
        string memory out = vm.serializeString(k, "allowedTokens", tokensJson);

        vm.createDir("deployments/base-mainnet", true);
        vm.writeJson(out, _outFile());
        console2.log("deployment record:", _outFile());
    }

    function _kindName(MPGRExecutorDelegated.RouterKind kind) internal pure returns (string memory) {
        if (kind == MPGRExecutorDelegated.RouterKind.AERODROME_SLIPSTREAM) return "AERODROME_SLIPSTREAM";
        if (kind == MPGRExecutorDelegated.RouterKind.UNISWAP_V3_ROUTER02) return "UNISWAP_V3_ROUTER02";
        return "NONE";
    }
}
